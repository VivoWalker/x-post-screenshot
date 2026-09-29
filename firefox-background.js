const MIN_CAPTURE_INTERVAL_MS = 650;
const QUOTA_RETRY_DELAY_MS = 1100;
let captureInProgress = false;
let lastCaptureCallAt = -Infinity;
let activeCapture = null;

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (activeCapture?.windowId === windowId && activeCapture.tabId !== tabId) {
    activeCapture.cancelled = true;
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCapture?.tabId === tabId) activeCapture.cancelled = true;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (activeCapture?.tabId === tabId && (changeInfo.url || changeInfo.status === "loading")) {
    activeCapture.cancelled = true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "start-capture") await enterSelectionMode();
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
      target: { tabId: activeTab.id }, files: ["content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId: activeTab.id }, files: ["content.css"]
    });
    await chrome.tabs.sendMessage(activeTab.id, { type: "X_SHOT_ENTER" });
  }
}

async function captureSelection(tabId, windowId, selection) {
  if (captureInProgress) throw new Error("已有截取任务正在进行");
  captureInProgress = true;
  activeCapture = { tabId, windowId, cancelled: false };
  try {
    const prepared = await chrome.tabs.sendMessage(tabId, {
      type: "X_SHOT_PREPARE", selection, stillOnly: true
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "无法确定截图范围");
    const capture = prepared.capture;
    const stitcher = new XShotPngStitcher();
    stitcher.begin(capture);
    const targetBottom = capture.top + capture.height;
    let nextY = capture.top;
    let frameCount = 0;

    while (nextY < targetBottom - 0.5) {
      const topInset = Math.min(96, capture.viewportHeight * 0.15);
      const desiredScrollY = Math.max(0, Math.min(
        nextY - topInset, capture.documentHeight - capture.viewportHeight
      ));
      const position = await chrome.tabs.sendMessage(tabId, {
        type: "X_SHOT_SCROLL", y: desiredScrollY
      });
      if (!position?.ok) throw new Error("页面滚动失败");
      const visibleTop = Math.max(capture.top, position.scrollY);
      const visibleBottom = Math.min(targetBottom, position.scrollY + position.viewportHeight);
      if (visibleBottom <= nextY + 0.5) throw new Error("无法继续截取页面底部内容");

      const dataUrl = await captureVisibleFrame(windowId, tabId);
      await stitcher.addFrame(dataUrl, {
        viewportWidth: position.viewportWidth,
        viewportHeight: position.viewportHeight,
        scrollY: position.scrollY,
        contentTop: Math.max(nextY, visibleTop),
        contentBottom: visibleBottom
      });
      nextY = visibleBottom;
      frameCount += 1;
      await notify(tabId, "progress", `正在截取第 ${frameCount} 段…`);
    }

    const result = stitcher.finish();
    await ensureSelectedTab(tabId, windowId);
    const copied = await chrome.tabs.sendMessage(tabId, {
      type: "X_SHOT_COPY", dataUrl: result.dataUrl
    });
    if (!copied?.ok) throw new Error(copied?.error || "无法写入剪贴板");
    const success = prepared.hasVideo
      ? "视频帖已复制静态截图（Firefox 版暂不录制视频）"
      : result.scaled
        ? `已缩放至 ${result.width} × ${result.height} 并复制`
        : "已复制到剪贴板";
    await notify(tabId, "success", success);
  } finally {
    await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_RESTORE" }).catch(() => {});
    activeCapture = null;
    captureInProgress = false;
  }
}

async function ensureSelectedTab(tabId, windowId) {
  if (activeCapture?.cancelled) throw new Error("标签页已切换，截图已取消");
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (activeCapture?.cancelled || activeTab?.id !== tabId) {
    throw new Error("标签页已切换，截图已取消");
  }
}

async function captureVisibleFrame(windowId, tabId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const waitMs = Math.max(0, lastCaptureCallAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await ensureSelectedTab(tabId, windowId);
    lastCaptureCallAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      await ensureSelectedTab(tabId, windowId);
      return dataUrl;
    } catch (error) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(error?.message || "") || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
    }
  }
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
