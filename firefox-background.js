installCaptureController(async (job, selection) => {
  const prepared = await job.page("X_SHOT_PREPARE", { selection, stillOnly: true }, 90000);
  const stitcher = new XShotPngStitcher();
  try {
    stitcher.begin(prepared.capture);
    await captureFrames(job, prepared.capture, (url, frame) => stitcher.addFrame(url, frame));
    const result = stitcher.finish();
    await copyPng(job, result.dataUrl);
    const success = prepared.hasVideo ? "视频帖已复制静态截图（Firefox 版暂不录制视频）"
      : result.scaled ? `已缩放至 ${result.width} × ${result.height} 并复制` : "已复制到剪贴板";
    await notify(job.tabId, "success", success);
  } finally {
    stitcher.abort();
  }
});

async function copyPng(job, dataUrl) {
  const clipboard = globalThis.browser?.clipboard;
  if (clipboard?.setImageData) {
    const bytes = await job.step(async () => (await fetch(dataUrl)).arrayBuffer());
    await ensureSelectedTab(job);
    const copied = await job.step(() => clipboard.setImageData(bytes, "png").then(() => true, () => false));
    if (copied) return;
  }
  await ensureSelectedTab(job);
  await job.page("X_SHOT_COPY", { dataUrl });
}
