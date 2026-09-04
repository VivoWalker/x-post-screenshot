const CAPTURE_MESSAGE = "X_SHOT_CAPTURE";
let captureInProgress = false;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-capture") return;
  await enterSelectionMode();
});

chrome.action.onClicked.addListener(enterSelectionMode);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "X_SHOT_SELECTION" || !sender.tab?.id) return;

  captureSelection(sender.tab.id, sender.tab.windowId, message.selection)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      notify(sender.tab.id, "error", readableError(error));
      sendResponse({ ok: false, error: readableError(error) });
    });
  return true;
});

async function enterSelectionMode(tab) {
  const [activeTab] = tab?.id
    ? [tab]
    : await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) return;

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "X_SHOT_ENTER" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId: activeTab.id },
      files: ["content.css"]
    });
    await chrome.tabs.sendMessage(activeTab.id, { type: "X_SHOT_ENTER" });
  }
}

async function captureSelection(tabId, windowId, selection) {
  if (captureInProgress) throw new Error("已有截图任务正在进行");
  captureInProgress = true;

  try {
    const prepared = await chrome.tabs.sendMessage(tabId, {
      type: "X_SHOT_PREPARE",
      selection
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "无法确定截图范围");

    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "X_SHOT_BEGIN",
      capture: prepared.capture
    });

    const capture = prepared.capture;
    const targetBottom = capture.top + capture.height;
    let nextY = capture.top;
    let frameCount = 0;

    while (nextY < targetBottom - 0.5) {
      // Leave the next uncaptured row below X's sticky navigation area.
      const topInset = Math.min(96, capture.viewportHeight * 0.15);
      const desiredScrollY = Math.max(
        0,
        Math.min(nextY - topInset, capture.documentHeight - capture.viewportHeight)
      );
      const position = await chrome.tabs.sendMessage(tabId, {
        type: "X_SHOT_SCROLL",
        y: desiredScrollY
      });
      if (!position?.ok) throw new Error("页面滚动失败");

      const visibleTop = Math.max(capture.top, position.scrollY);
      const visibleBottom = Math.min(targetBottom, position.scrollY + position.viewportHeight);
      if (visibleBottom <= nextY + 0.5) throw new Error("无法继续截取页面底部内容");

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const added = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "X_SHOT_FRAME",
        dataUrl,
        frame: {
          viewportWidth: position.viewportWidth,
          viewportHeight: position.viewportHeight,
          scrollY: position.scrollY,
          contentTop: Math.max(nextY, visibleTop),
          contentBottom: visibleBottom
        }
      });
      if (!added?.ok) throw new Error(added?.error || "图片拼接失败");

      nextY = visibleBottom;
      frameCount += 1;
      await notify(tabId, "progress", `正在截取第 ${frameCount} 段…`);
    }

    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "X_SHOT_FINISH"
    });
    if (!result?.ok || !result.dataUrl) throw new Error(result?.error || "无法生成最终图片");

    // Offscreen documents cannot receive focus, so Chrome rejects their
    // Clipboard API calls. Return the PNG to the focused X tab for copying.
    const copied = await chrome.tabs.sendMessage(tabId, {
      type: "X_SHOT_COPY",
      dataUrl: result.dataUrl
    });
    if (!copied?.ok) throw new Error(copied?.error || "无法写入剪贴板");

    await notify(
      tabId,
      "success",
      result.scaled ? `已缩放至 ${result.width} × ${result.height} 并复制` : "已复制到剪贴板"
    );
  } finally {
    await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_RESTORE" }).catch(() => {});
    captureInProgress = false;
  }
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "拼接长截图并生成最终 PNG"
  });
}

function notify(tabId, kind, text) {
  return chrome.tabs.sendMessage(tabId, { type: "X_SHOT_NOTICE", kind, text }).catch(() => {});
}

function isSupportedUrl(url = "") {
  return /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url);
}

function readableError(error) {
  return error?.message || String(error || "未知错误");
}
