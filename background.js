const CAPTURE_MESSAGE = "X_SHOT_CAPTURE";
const MIN_CAPTURE_INTERVAL_MS = 650;
const QUOTA_RETRY_DELAY_MS = 1100;
let captureInProgress = false;
let lastCaptureCallAt = -Infinity;

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
  if (captureInProgress) throw new Error("已有截取任务正在进行");
  captureInProgress = true;
  let recordingStarted = false;

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

      const dataUrl = await captureVisibleFrame(windowId);
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
      type: "X_SHOT_FINISH",
      forVideo: prepared.hasVideo
    });
    if (!result?.ok || !result.dataUrl) throw new Error(result?.error || "无法生成最终图片");

    if (prepared.hasVideo) {
      await notify(tabId, "progress", "正在准备低画质 MP4 录制…");
      const layout = await chrome.tabs.sendMessage(tabId, {
        type: "X_SHOT_VIDEO_POSITION",
        capture
      });
      if (!layout?.ok) throw new Error(layout?.error || "无法定位视频");
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const started = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "X_SHOT_RECORD_BEGIN",
        streamId,
        still: result.dataUrl,
        capture,
        layout
      });
      if (!started?.ok) throw new Error(started?.error || "无法开始录制 MP4");
      recordingStarted = true;
      if (!started.hasAudioTrack) throw new Error("无法取得标签页音轨，已取消录制");
      const playing = await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_VIDEO_PLAY" });
      if (!playing?.ok) throw new Error(playing?.error || "无法从头播放视频");
      await notify(tabId, "progress", "正在录制视频，最长 30 秒…");
      const waited = await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_VIDEO_WAIT", maxDurationMs: 30000 });
      if (!waited?.ok) throw new Error(waited?.error || "视频播放中断");
      await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_VIDEO_STOP" });
      const recording = await chrome.runtime.sendMessage({ target: "offscreen", type: "X_SHOT_RECORD_FINISH" });
      recordingStarted = false;
      if (!recording?.ok || !recording.dataUrl) throw new Error(recording?.error || "无法完成 MP4 编码");
      const filename = `X-Post-Video/x-post-${Date.now()}.mp4`;
      const downloadId = await chrome.downloads.download({ url: recording.dataUrl, filename, saveAs: false, conflictAction: "uniquify" });
      await waitForDownload(downloadId);
      let shown = true;
      try { chrome.downloads.show(downloadId); } catch { shown = false; }
      await notify(tabId, "success", recording.truncated
        ? `视频达到大小上限，已截短并保存至下载目录/${filename}；${shown ? "请在文件管理器按 Ctrl+C" : "请手动找到文件并复制"}`
        : `MP4 已保存至下载目录/${filename}；${shown ? "请在文件管理器按 Ctrl+C" : "请手动找到文件并复制"}`);
      return;
    }

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
    if (recordingStarted) {
      await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_VIDEO_STOP" }).catch(() => {});
      await chrome.runtime.sendMessage({ target: "offscreen", type: "X_SHOT_RECORD_ABORT" }).catch(() => {});
    }
    await chrome.tabs.sendMessage(tabId, { type: "X_SHOT_RESTORE" }).catch(() => {});
    captureInProgress = false;
  }
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("MP4 下载超时")), 120000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error); else resolve();
    }
    function onChanged(change) {
      if (change.id !== id || !change.state) return;
      if (change.state.current === "complete") finish();
      if (change.state.current === "interrupted") finish(new Error("MP4 下载中断"));
    }
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === "complete") finish();
      if (item?.state === "interrupted") finish(new Error("MP4 下载中断"));
    }).catch(finish);
  });
}

async function captureVisibleFrame(windowId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const waitMs = Math.max(0, lastCaptureCallAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastCaptureCallAt = Date.now();

    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(error?.message || "") || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
    }
  }
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "USER_MEDIA"],
    justification: "拼接帖子截图，并在用户选择视频时录制带音轨的 MP4"
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
