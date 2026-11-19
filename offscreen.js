let jobId = null;
let heartbeat = null;
let videoBase = null;
const pngStitcher = new XShotPngStitcher();
let recording = null;
const VIDEO_LIMITS = { width: 1440, height: 2560, fps: 24, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 96_000, maxBytes: 40_000_000 };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function handleMessage(message) {
  if (message.type === "X_SHOT_BEGIN") {
    if (jobId || !message.jobId) throw new Error("截图任务冲突");
    jobId = message.jobId;
    heartbeat = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ type: "X_SHOT_ALIVE", jobId });
        if (status?.alive) return;
      } catch { /* The worker or extension context has gone away. */ }
      dispose();
      window.close();
    }, 5000);
    return pngStitcher.begin(message.capture);
  }
  if (!jobId || jobId !== message.jobId) throw new Error("截图任务已结束");
  if (message.type === "X_SHOT_FRAME") return pngStitcher.addFrame(message.dataUrl, message.frame);
  if (message.type === "X_SHOT_FINISH") return finish(Boolean(message.forVideo));
  if (message.type === "X_SHOT_RECORD_BEGIN") return beginRecording(message);
  if (message.type === "X_SHOT_RECORD_CALIBRATE") return calibrateRecording(message.markers);
  if (message.type === "X_SHOT_RECORD_START") return startRecording(message.videoRect);
  if (message.type === "X_SHOT_RECORD_FINISH") return finishRecording();
  if (message.type === "X_SHOT_RECORD_ABORT") { abortRecording(); return { ok: true }; }
  return { ok: false, error: "未知的图片处理请求" };
}

function dispose() {
  clearInterval(heartbeat);
  jobId = null;
  abortRecording();
  pngStitcher.abort();
  if (videoBase) videoBase.width = videoBase.height = 0;
  videoBase = null;
}
window.addEventListener("pagehide", dispose);

function finish(forVideo) {
  try {
    if (!forVideo) return pngStitcher.finish();
    const source = pngStitcher.job?.canvas;
    if (!source) throw new Error("没有可录制的截图内容");
    const ratio = Math.min(0.5, VIDEO_LIMITS.width / source.width, VIDEO_LIMITS.height / source.height);
    videoBase = document.createElement("canvas");
    videoBase.width = Math.max(2, Math.floor(source.width * ratio / 2) * 2);
    videoBase.height = Math.max(2, Math.floor(source.height * ratio / 2) * 2);
    videoBase.getContext("2d").drawImage(source, 0, 0, videoBase.width, videoBase.height);
    return { ok: true };
  } finally {
    pngStitcher.abort();
  }
}

async function beginRecording({ streamId, capture, layout }) {
  if (recording) throw new Error("已有视频录制任务");
  // Let Chrome select an AVC profile/level for the actual output dimensions.
  // isTypeSupported() does not guarantee that the device encoder can start.
  const mimeTypes = ["video/mp4", "video/mp4;codecs=avc1,mp4a.40.2"]
    .filter((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeTypes.length) throw new Error("当前 Chrome 不支持 MP4 录制，请更新浏览器");
  const base = videoBase;
  const owner = jobId;
  if (!base) throw new Error("缺少录制底图");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
  });
  let drawingStream = null;
  const tabVideo = document.createElement("video");
  try {
    if (!owner || jobId !== owner) throw new Error("录制已取消");
    tabVideo.muted = true;
    tabVideo.srcObject = tabStream;
    await tabVideo.play();
    if (!tabStream.getAudioTracks().length) throw new Error("无法取得标签页音轨，已取消录制");
    const profiles = [
      VIDEO_LIMITS,
      { ...VIDEO_LIMITS, width: 720, height: 1280, videoBitsPerSecond: 4_000_000 },
      { ...VIDEO_LIMITS, width: 480, height: 854, videoBitsPerSecond: 2_000_000 }
    ];
    let recorder = null;
    let composition = null;
    let encoderError = null;
    for (const limits of profiles) {
      composition = createVideoComposition(capture, layout, limits, base.width);
      canvas.width = composition.width;
      canvas.height = composition.height;
      const drawProbeFrame = () => context.drawImage(base, 0, 0, canvas.width, canvas.height);
      drawProbeFrame();
      drawingStream = canvas.captureStream(limits.fps);
      const combined = new MediaStream([...drawingStream.getVideoTracks(), ...tabStream.getAudioTracks()]);
      for (const mimeType of mimeTypes) {
        const options = {
          mimeType,
          videoBitsPerSecond: limits.videoBitsPerSecond,
          audioBitsPerSecond: limits.audioBitsPerSecond
        };
        try {
          // Discard the probe recording; the exported MP4 starts only after calibration.
          await probeMp4Encoding(combined, options, drawProbeFrame);
          recorder = new MediaRecorder(combined, options);
          break;
        } catch (error) { encoderError = error; }
      }
      if (recorder) break;
      drawingStream.getTracks().forEach((track) => track.stop());
      drawingStream = null;
    }
    if (!recorder) {
      throw new Error("当前浏览器无法启动 MP4 编码，已尝试降低分辨率和码率。请更新 Chrome 后重试。", { cause: encoderError });
    }
    if (owner !== jobId) throw new Error("录制已取消");
    const chunks = [];
    const current = { base, canvas, context, tabStream, drawingStream, tabVideo, recorder, chunks, capture, layout, composition, calibration: null, tooLarge: false, error: null, drawTimer: null, stopPromise: null };
    current.stopPromise = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
      if (chunks.reduce((sum, chunk) => sum + chunk.size, 0) > VIDEO_LIMITS.maxBytes) {
        current.tooLarge = true;
        if (recorder.state !== "inactive") recorder.stop();
      }
    };
    recorder.onerror = (event) => { current.error = event.error || new Error("MP4 编码失败"); };
    recording = current;
    return { ok: true, width: canvas.width, height: canvas.height, hasAudioTrack: tabStream.getAudioTracks().length > 0 };
  } catch (error) {
    if (recording) abortRecording();
    else {
      drawingStream?.getTracks().forEach((track) => track.stop());
      tabStream.getTracks().forEach((track) => track.stop());
      tabVideo.srcObject = null;
    }
    throw error;
  }
}

async function probeMp4Encoding(stream, options, drawFrame) {
  const recorder = new MediaRecorder(stream, options);
  await new Promise((resolve, reject) => {
    let bytes = 0;
    let error = null;
    let settled = false;
    const requestFrame = () => {
      drawFrame();
      stream.getVideoTracks().forEach((track) => track.requestFrame?.());
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(frameTimer);
      clearTimeout(timeout);
      clearTimeout(stopTimeout);
      recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      if (error || !bytes) reject(error || new Error("MP4 编码测试未产生视频数据"));
      else resolve();
    };
    const frameTimer = setInterval(requestFrame, 40);
    const timeout = setTimeout(() => {
      // Some MP4 muxers emit their first bytes only when stopped/flushed.
      if (recorder.state !== "inactive") recorder.stop();
    }, 2500);
    const stopTimeout = setTimeout(() => {
      error ||= new Error("MP4 编码器未能正常停止");
      finish();
    }, 3000);
    recorder.ondataavailable = (event) => {
      bytes += event.data?.size || 0;
      if (bytes && recorder.state !== "inactive") recorder.stop();
    };
    recorder.onerror = (event) => {
      error = event.error || new Error("MP4 编码测试失败");
      if (recorder.state !== "inactive") recorder.stop();
    };
    recorder.onstop = finish;
    try {
      recorder.start(100);
      requestFrame();
    } catch (startError) {
      error = startError;
      finish();
    }
  });
}

async function calibrateRecording(markers) {
  if (!recording || recording.drawTimer) throw new Error("录制状态异常");
  recording.calibration = await waitForTabCalibration(recording.tabVideo, markers);
  return { ok: true };
}

async function waitForTabCalibration(tabVideo, markers) {
  if (!markers?.first || !markers?.second) throw new Error("缺少录屏校准点");
  const probe = document.createElement("canvas");
  const probeContext = probe.getContext("2d", { willReadFrequently: true });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (tabVideo.videoWidth > 0 && tabVideo.videoHeight > 0 && tabVideo.readyState >= 2) {
      probe.width = tabVideo.videoWidth;
      probe.height = tabVideo.videoHeight;
      probeContext.drawImage(tabVideo, 0, 0);
      try {
        return calibrateTabStream(probeContext.getImageData(0, 0, probe.width, probe.height), markers);
      } catch { /* Wait until both calibration markers reach the tab stream. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("无法校准录屏位置，请重试");
}

function calibrateTabStream(imageData, markers) {
  const { data, width, height } = imageData;
  function locate(kind) {
    const first = kind === "first";
    const fromX = first ? 0 : Math.floor(width * 0.65);
    const toX = first ? Math.ceil(width * 0.35) : width;
    const fromY = first ? 0 : Math.floor(height * 0.65);
    const toY = first ? Math.ceil(height * 0.35) : height;
    let count = 0;
    let totalX = 0;
    let totalY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = fromY; y < toY; y += 1) {
      for (let x = fromX; x < toX; x += 1) {
        const offset = (y * width + x) * 4;
        const [red, green, blue] = [data[offset], data[offset + 1], data[offset + 2]];
        const matches = first
          ? red > 190 && green < 75 && blue > 190
          : red < 75 && green > 190 && blue > 190;
        if (!matches) continue;
        count += 1;
        totalX += x + 0.5;
        totalY += y + 0.5;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (count < 16) throw new Error("无法校准录屏位置：校准点不可见");
    return {
      x: totalX / count,
      y: totalY / count,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      coverage: count / ((maxX - minX + 1) * (maxY - minY + 1))
    };
  }
  const first = locate("first");
  const second = locate("second");
  const scaleX = (second.x - first.x) / (markers.second.x - markers.first.x);
  const scaleY = (second.y - first.y) / (markers.second.y - markers.first.y);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new Error("无法校准录屏位置：坐标无效");
  }
  for (const marker of [first, second]) {
    const widthRatio = marker.width / (24 * scaleX);
    const heightRatio = marker.height / (24 * scaleY);
    if (widthRatio < 0.8 || widthRatio > 1.2 || heightRatio < 0.8 || heightRatio > 1.2 || marker.coverage < 0.8) {
      throw new Error("无法校准录屏位置：校准点被遮挡或混入页面颜色");
    }
  }
  return { scaleX, scaleY, offsetX: first.x - markers.first.x * scaleX, offsetY: first.y - markers.first.y * scaleY, width, height };
}

function mapVideoRectToStream(rect, calibration) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error("录屏区域无效，请重新选择帖子");
  }
  const x = Math.round(calibration.offsetX + rect.left * calibration.scaleX);
  const y = Math.round(calibration.offsetY + rect.top * calibration.scaleY);
  const right = Math.round(calibration.offsetX + (rect.left + rect.width) * calibration.scaleX);
  const bottom = Math.round(calibration.offsetY + (rect.top + rect.height) * calibration.scaleY);
  if (x < 0 || y < 0 || right > calibration.width || bottom > calibration.height || right <= x || bottom <= y) {
    throw new Error("录屏区域超出画面，请重新选择帖子");
  }
  return { x, y, width: right - x, height: bottom - y };
}

function startRecording(videoRect) {
  const current = recording;
  if (!current || current.recorder.state !== "inactive" || current.drawTimer) throw new Error("录制状态异常");
  if (!current.calibration) throw new Error("录屏尚未校准");
  current.layout.videoRect = videoRect;
  current.liveCrop = mapVideoRectToStream(videoRect, current.calibration);
  drawRecordingFrame();
  current.drawTimer = setInterval(drawRecordingFrame, 1000 / VIDEO_LIMITS.fps);
  current.recorder.start(1000);
  return { ok: true };
}

function createVideoComposition(capture, layout, limits, sourceWidth = capture.width) {
  if (layout.preservePostLayout) {
    const scale = Math.min(sourceWidth / capture.width, limits.width / capture.width, limits.height / capture.height);
    const width = Math.max(2, Math.floor(capture.width * scale / 2) * 2);
    const height = Math.max(2, Math.floor(capture.height * width / capture.width / 2) * 2);
    const actualScale = width / capture.width;
    const source = layout.documentVideoRect;
    const x = Math.round(source.left * actualScale);
    const y = Math.round(source.top * actualScale);
    return {
      preservePostLayout: true,
      width,
      height,
      video: {
        x, y,
        width: Math.min(width - x, Math.round(source.width * actualScale)),
        height: Math.min(height - y, Math.round(source.height * actualScale))
      }
    };
  }
  const mediaTop = Math.max(0, Math.min(capture.height, layout.mediaTop ?? layout.documentVideoRect.top));
  const footerTop = Math.max(mediaTop, Math.min(capture.height, layout.footerTop ?? capture.height));
  const contentLeft = Math.max(0, Math.min(capture.width, layout.contentArea?.left ?? 0));
  const contentWidth = Math.max(1, Math.min(capture.width - contentLeft, layout.contentArea?.width ?? capture.width));
  const videoHeight = contentWidth * layout.videoRect.height / layout.videoRect.width;
  const rowHeight = contentWidth * 0.22;
  const rowCount = Math.ceil(layout.photoRects.length / 2);
  const photoHeight = rowCount ? rowCount * rowHeight + (rowCount - 1) * 4 : 0;
  const totalHeight = mediaTop + videoHeight + photoHeight + capture.height - footerTop;
  const scale = Math.min(sourceWidth / capture.width, limits.width / capture.width, limits.height / totalHeight);
  const width = Math.max(2, Math.floor(capture.width * scale / 2) * 2);
  const actualScale = width / capture.width;
  const height = Math.max(2, Math.floor(totalHeight * actualScale / 2) * 2);
  const topHeight = Math.round(mediaTop * actualScale);
  const videoBottom = Math.round((mediaTop + videoHeight) * actualScale);
  const videoX = Math.round(contentLeft * actualScale);
  const videoWidth = Math.min(width - videoX, Math.round(contentWidth * actualScale));
  const video = { x: videoX, y: topHeight, width: videoWidth, height: videoBottom - topHeight };
  const gap = Math.max(1, Math.round(4 * actualScale));
  const thumbHeight = Math.round(rowHeight * actualScale);
  const thumbWidth = Math.floor((videoWidth - gap) / 2);
  const thumbnails = layout.photoRects.map((source, index) => ({
    source,
    x: index % 2 ? videoX + videoWidth - thumbWidth : videoX,
    y: videoBottom + Math.floor(index / 2) * (thumbHeight + gap),
    width: thumbWidth,
    height: thumbHeight
  }));
  const footerY = rowCount ? thumbnails.at(-1).y + thumbHeight : videoBottom;
  return {
    width,
    height,
    top: { y: 0, height: topHeight, sourceHeight: mediaTop },
    video,
    thumbnails,
    footer: { y: footerY, height: Math.max(0, height - footerY), sourceTop: footerTop, sourceHeight: capture.height - footerTop }
  };
}

function drawRecordingFrame() {
  const current = recording;
  if (!current) return;
  if (current.calibration && current.tabVideo.readyState >= 2 &&
      (current.tabVideo.videoWidth !== current.calibration.width || current.tabVideo.videoHeight !== current.calibration.height)) {
    current.error = new Error("录屏尺寸在录制中发生变化，请重试");
    if (current.recorder.state !== "inactive") current.recorder.stop();
    return;
  }
  const { base, context, capture, layout, composition } = current;
  context.fillStyle = layout.backgroundColor || "#000";
  context.fillRect(0, 0, composition.width, composition.height);
  if (composition.preservePostLayout) {
    context.drawImage(base, 0, 0, base.width, base.height,
      0, 0, composition.width, composition.height);
  } else if (composition.top.height > 0) {
    context.drawImage(base, 0, 0, base.width, composition.top.sourceHeight / capture.height * base.height,
      0, 0, composition.width, composition.top.height);
  }
  const destination = composition.video;
  if (current.tabVideo.readyState >= 2) {
    const source = current.liveCrop;
    context.drawImage(current.tabVideo, source.x, source.y, source.width, source.height,
      destination.x, destination.y, destination.width, destination.height);
  } else {
    const source = layout.documentVideoRect;
    context.drawImage(base, source.left / capture.width * base.width, source.top / capture.height * base.height,
      source.width / capture.width * base.width, source.height / capture.height * base.height,
      destination.x, destination.y, destination.width, destination.height);
  }
  if (composition.preservePostLayout) return;
  for (const thumb of composition.thumbnails) {
    const photo = thumb.source;
    const sx = photo.left / capture.width * base.width;
    const sy = photo.top / capture.height * base.height;
    const sw = photo.width / capture.width * base.width;
    const sh = photo.height / capture.height * base.height;
    const fitted = Math.min(thumb.width / sw, thumb.height / sh);
    context.fillStyle = "#000";
    context.fillRect(thumb.x, thumb.y, thumb.width, thumb.height);
    context.drawImage(base, sx, sy, sw, sh,
      thumb.x + (thumb.width - sw * fitted) / 2, thumb.y + (thumb.height - sh * fitted) / 2,
      sw * fitted, sh * fitted);
  }
  if (composition.footer.height > 0 && composition.footer.sourceHeight > 0) {
    context.drawImage(base, 0, composition.footer.sourceTop / capture.height * base.height,
      base.width, composition.footer.sourceHeight / capture.height * base.height,
      0, composition.footer.y, composition.width, composition.footer.height);
  }
}

async function finishRecording() {
  const current = recording;
  if (!current) throw new Error("视频录制任务不存在");
  if (!current.drawTimer) throw new Error("视频录制尚未开始");
  try {
    if (current.recorder.state !== "inactive") current.recorder.stop();
    await current.stopPromise;
    if (current.error) throw current.error;
    const blob = new Blob(current.chunks, { type: "video/mp4" });
    if (!blob.size) throw new Error("录制结果为空");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法读取录制结果"));
      reader.readAsDataURL(blob);
    });
    return { ok: true, dataUrl, bytes: blob.size, truncated: current.tooLarge, width: current.canvas.width, height: current.canvas.height };
  } finally {
    abortRecording();
  }
}

function abortRecording() {
  if (!recording) return;
  clearInterval(recording.drawTimer);
  if (recording.recorder.state !== "inactive") recording.recorder.stop();
  recording.drawingStream.getTracks().forEach((track) => track.stop());
  recording.tabStream.getTracks().forEach((track) => track.stop());
  recording.tabVideo.srcObject = null;
  recording = null;
}

