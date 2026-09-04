const MAX_SIDE = 16000;
const MAX_PIXELS = 100_000_000;
let job = null;

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
  if (message.type === "X_SHOT_FINISH") return finish();
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

async function finish() {
  if (!job?.canvas) throw new Error("没有可复制的截图内容");
  const dataUrl = job.canvas.toDataURL("image/png");
  if (!dataUrl || dataUrl === "data:,") throw new Error("PNG 编码失败");

  const result = {
    ok: true,
    dataUrl,
    width: job.canvas.width,
    height: job.canvas.height,
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
