const MAX_SIDE = 16000;
const MAX_PIXELS = 100_000_000;
let job = null;
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
    job = {
      capture: message.capture,
      canvas: null,
      context: null,
      outputScale: null,
      sourceScale: null,
      frameCount: 0,
      lastDestinationBottom: 0
    };
    return { ok: true };
  }
  if (message.type === "X_SHOT_FRAME") return addFrame(message.dataUrl, message.frame);
  if (message.type === "X_SHOT_FINISH") return finish(Boolean(message.forVideo));
  if (message.type === "X_SHOT_RECORD_BEGIN") return beginRecording(message);
  if (message.type === "X_SHOT_RECORD_FINISH") return finishRecording();
  if (message.type === "X_SHOT_RECORD_ABORT") { abortRecording(); return { ok: true }; }
  return { ok: false, error: "未知的图片处理请求" };
}

async function addFrame(dataUrl, frame) {
  if (!job) throw new Error("截图任务不存在");
  const image = await loadImage(dataUrl);

  if (!job.canvas) initializeCanvas(image, frame);
  const sourceScaleX = image.naturalWidth / frame.viewportWidth;
  const sourceScaleY = image.naturalHeight / frame.viewportHeight;
  const cropTop = frame.contentTop - frame.scrollY;
  const cropHeight = frame.contentBottom - frame.contentTop;
  const destinationY = frame.contentTop - job.capture.top;
  const destinationBottomY = frame.contentBottom - job.capture.top;
  let destinationTop = Math.max(0, Math.floor(destinationY * job.outputScale));
  const destinationBottom = Math.min(
    job.canvas.height,
    Math.ceil(destinationBottomY * job.outputScale)
  );

  // Adjacent CSS-pixel slices can land on fractional device pixels. Drawing
  // each slice on integer boundaries with a one-pixel overlap prevents the
  // prefilled canvas background from showing through as a hairline seam.
  if (job.frameCount > 0) {
    destinationTop = Math.max(0, Math.min(destinationTop, job.lastDestinationBottom) - 1);
  }
  const destinationHeight = Math.max(1, destinationBottom - destinationTop);

  job.context.drawImage(
    image,
    job.capture.left * sourceScaleX,
    cropTop * sourceScaleY,
    job.capture.width * sourceScaleX,
    cropHeight * sourceScaleY,
    0,
    destinationTop,
    job.canvas.width,
    destinationHeight
  );
  job.frameCount += 1;
  job.lastDestinationBottom = destinationBottom;
  return { ok: true };
}

function initializeCanvas(image, frame) {
  const sourceScale = image.naturalWidth / frame.viewportWidth;
  const rawWidth = job.capture.width * sourceScale;
  const rawHeight = job.capture.height * sourceScale;
  const limitScale = Math.min(
    1,
    MAX_SIDE / rawWidth,
    MAX_SIDE / rawHeight,
    Math.sqrt(MAX_PIXELS / (rawWidth * rawHeight))
  );

  job.sourceScale = sourceScale;
  job.outputScale = sourceScale * limitScale;
  job.canvas = document.createElement("canvas");
  job.canvas.width = Math.max(1, Math.ceil(job.capture.width * job.outputScale));
  job.canvas.height = Math.max(1, Math.ceil(job.capture.height * job.outputScale));
  job.context = job.canvas.getContext("2d", { alpha: false });
  job.context.fillStyle = "#ffffff";
  job.context.fillRect(0, 0, job.canvas.width, job.canvas.height);
  job.context.imageSmoothingEnabled = true;
  job.context.imageSmoothingQuality = "high";
}

async function finish(forVideo = false) {
  if (!job?.canvas) throw new Error("没有可复制的截图内容");
  let output = job.canvas;
  if (forVideo) {
    const ratio = Math.min(0.5, VIDEO_LIMITS.width / output.width, VIDEO_LIMITS.height / output.height);
    const reduced = document.createElement("canvas");
    reduced.width = Math.max(2, Math.floor(output.width * ratio / 2) * 2);
    reduced.height = Math.max(2, Math.floor(output.height * ratio / 2) * 2);
    reduced.getContext("2d").drawImage(output, 0, 0, reduced.width, reduced.height);
    output = reduced;
  }
  const dataUrl = output.toDataURL("image/png");
  if (!dataUrl || dataUrl === "data:,") throw new Error("PNG 编码失败");

  const result = {
    ok: true,
    dataUrl,
    width: output.width,
    height: output.height,
    scaled: job.outputScale < job.sourceScale - 0.001
  };
  job = null;
  return result;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取当前截图"));
    image.src = dataUrl;
  });
}

async function beginRecording({ streamId, still, capture, layout }) {
  if (recording) throw new Error("已有视频录制任务");
  const mimeType = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4"
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("当前 Chrome 不支持 MP4 录制，请更新浏览器");
  const base = await loadImage(still);
  const composition = createVideoComposition(capture, layout, VIDEO_LIMITS, base.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = composition.width;
  canvas.height = composition.height;
  const context = canvas.getContext("2d", { alpha: false });
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
  });
  try {
    const tabVideo = document.createElement("video");
    tabVideo.muted = true;
    tabVideo.srcObject = tabStream;
    await tabVideo.play();
    const drawingStream = canvas.captureStream(VIDEO_LIMITS.fps);
    const combined = new MediaStream([...drawingStream.getVideoTracks(), ...tabStream.getAudioTracks()]);
    const chunks = [];
    const recorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: VIDEO_LIMITS.videoBitsPerSecond,
      audioBitsPerSecond: VIDEO_LIMITS.audioBitsPerSecond
    });
    const current = { base, canvas, context, tabStream, drawingStream, tabVideo, recorder, chunks, capture, layout, composition, tooLarge: false, error: null, drawTimer: null, stopPromise: null };
    current.stopPromise = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.addEventListener("error", resolve, { once: true });
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
    drawRecordingFrame();
    current.drawTimer = setInterval(drawRecordingFrame, 1000 / VIDEO_LIMITS.fps);
    recorder.start(1000);
    return { ok: true, width: canvas.width, height: canvas.height, hasAudioTrack: tabStream.getAudioTracks().length > 0 };
  } catch (error) {
    if (recording) abortRecording();
    else tabStream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

function createVideoComposition(capture, layout, limits, sourceWidth = capture.width) {
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
  const { base, context, capture, layout, composition } = current;
  context.fillStyle = layout.backgroundColor || "#000";
  context.fillRect(0, 0, composition.width, composition.height);
  if (composition.top.height > 0) {
    context.drawImage(base, 0, 0, base.naturalWidth, composition.top.sourceHeight / capture.height * base.naturalHeight,
      0, 0, composition.width, composition.top.height);
  }
  const destination = composition.video;
  if (current.tabVideo.readyState >= 2) {
    const source = layout.videoRect;
    const sx = source.left / layout.viewport.width * current.tabVideo.videoWidth;
    const sy = source.top / layout.viewport.height * current.tabVideo.videoHeight;
    const sw = source.width / layout.viewport.width * current.tabVideo.videoWidth;
    const sh = source.height / layout.viewport.height * current.tabVideo.videoHeight;
    context.drawImage(current.tabVideo, sx, sy, sw, sh, destination.x, destination.y, destination.width, destination.height);
  } else {
    const source = layout.documentVideoRect;
    context.drawImage(base, source.left / capture.width * base.naturalWidth, source.top / capture.height * base.naturalHeight,
      source.width / capture.width * base.naturalWidth, source.height / capture.height * base.naturalHeight,
      destination.x, destination.y, destination.width, destination.height);
  }
  for (const thumb of composition.thumbnails) {
    const photo = thumb.source;
    const sx = photo.left / capture.width * base.naturalWidth;
    const sy = photo.top / capture.height * base.naturalHeight;
    const sw = photo.width / capture.width * base.naturalWidth;
    const sh = photo.height / capture.height * base.naturalHeight;
    const fitted = Math.min(thumb.width / sw, thumb.height / sh);
    context.fillStyle = "#000";
    context.fillRect(thumb.x, thumb.y, thumb.width, thumb.height);
    context.drawImage(base, sx, sy, sw, sh,
      thumb.x + (thumb.width - sw * fitted) / 2, thumb.y + (thumb.height - sh * fitted) / 2,
      sw * fitted, sh * fitted);
  }
  if (composition.footer.height > 0 && composition.footer.sourceHeight > 0) {
    context.drawImage(base, 0, composition.footer.sourceTop / capture.height * base.naturalHeight,
      base.naturalWidth, composition.footer.sourceHeight / capture.height * base.naturalHeight,
      0, composition.footer.y, composition.width, composition.footer.height);
  }
}

async function finishRecording() {
  const current = recording;
  if (!current) throw new Error("视频录制任务不存在");
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
