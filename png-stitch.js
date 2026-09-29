class XShotPngStitcher {
  constructor() {
    this.job = null;
  }

  begin(capture) {
    this.job = {
      capture,
      canvas: null,
      context: null,
      outputScale: null,
      sourceScale: null,
      frameCount: 0,
      lastDestinationBottom: 0
    };
    return { ok: true };
  }

  async addFrame(dataUrl, frame) {
    const job = this.job;
    if (!job) throw new Error("截图任务不存在");
    const image = await this.loadImage(dataUrl);
    if (!job.canvas) this.initializeCanvas(image, frame);

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

    // Integer pixel boundaries and a one-pixel overlap prevent white seams.
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

  initializeCanvas(image, frame) {
    const job = this.job;
    const sourceScale = image.naturalWidth / frame.viewportWidth;
    const rawWidth = job.capture.width * sourceScale;
    const rawHeight = job.capture.height * sourceScale;
    const limitScale = Math.min(
      1,
      16000 / rawWidth,
      16000 / rawHeight,
      Math.sqrt(100000000 / (rawWidth * rawHeight))
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

  finish() {
    const job = this.job;
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
    this.job = null;
    return result;
  }

  loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取当前截图"));
      image.src = dataUrl;
    });
  }
}

globalThis.XShotPngStitcher = XShotPngStitcher;
