importScripts("capture-controller.js");

installCaptureController(async (job, selection) => {
  const { tabId } = job;
  const prepared = await job.page("X_SHOT_PREPARE", { selection }, 90000);
  await job.step(ensureOffscreenDocument);
  const offscreen = (type, fields = {}, ms) => job.step(() =>
    chrome.runtime.sendMessage({ target: "offscreen", type, jobId: job.id, ...fields }), ms).then(requireSuccess);
  const capture = prepared.capture;
  await offscreen("X_SHOT_BEGIN", { capture });
  await captureFrames(job, capture, (dataUrl, frame) => offscreen("X_SHOT_FRAME", { dataUrl, frame }));
  const result = await offscreen("X_SHOT_FINISH", { forVideo: prepared.hasVideo });
  if (prepared.hasVideo) {
    await notify(tabId, "progress", "正在准备 MP4 录制…");
    const layout = await job.page("X_SHOT_VIDEO_POSITION", { capture });
    const streamId = await job.step(() => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));
    const started = await offscreen("X_SHOT_RECORD_BEGIN", { streamId,
      capture,
      layout }, 70000);
    if (!started.hasAudioTrack) throw new Error("无法取得标签页音轨，已取消录制");
    const markers = await job.page("X_SHOT_VIDEO_MARKERS");
    await offscreen("X_SHOT_RECORD_CALIBRATE", { markers: markers.markers });
    const ready = await job.page("X_SHOT_VIDEO_READY");
    await offscreen("X_SHOT_RECORD_START", { videoRect: ready.videoRect });
    await job.page("X_SHOT_VIDEO_PLAY");
    await notify(tabId, "progress", "正在录制视频，最长 30 秒…");
    await job.page("X_SHOT_VIDEO_WAIT", { maxDurationMs: 30000 }, 35000);
    await job.page("X_SHOT_VIDEO_STOP");
    const recording = await offscreen("X_SHOT_RECORD_FINISH");
    if (!recording?.ok || !recording.dataUrl) throw new Error(recording?.error || "无法完成 MP4 编码");
    const filename = `X-Post-Video/x-post-${Date.now()}.mp4`;
    const downloadId = await chrome.downloads.download({ url: recording.dataUrl, filename, saveAs: false, conflictAction: "uniquify" });
    await waitForDownload(downloadId);
    let shown = true;
    try { await chrome.downloads.show(downloadId); } catch { shown = false; }
    await notify(tabId, "success", recording.truncated
      ? `视频达到大小上限，已截短并保存至下载目录/${filename}；${shown ? "请在文件管理器按 Ctrl+C" : "请手动找到文件并复制"}`
      : `MP4 已保存至下载目录/${filename}；${shown ? "请在文件管理器按 Ctrl+C" : "请手动找到文件并复制"}`);
    return;
  }

  // Offscreen documents cannot receive focus, so Chrome rejects their
  // Clipboard API calls. Return the PNG to the focused X tab for copying.
  await ensureSelectedTab(job);
  await job.page("X_SHOT_COPY", { dataUrl: result.dataUrl });

  await notify(
    tabId,
    "success",
    result.scaled ? `已缩放至 ${result.width} × ${result.height} 并复制` : "已复制到剪贴板"
  );
}, async () => {
  if (await bounded(chrome.offscreen.hasDocument(), 3000)) await bounded(chrome.offscreen.closeDocument(), 3000);
});

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

async function ensureOffscreenDocument() {
  // A previous worker may have stopped while it owned this document.
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "USER_MEDIA"],
    justification: "拼接帖子截图，并在用户选择视频时录制带音轨的 MP4"
  });
}
