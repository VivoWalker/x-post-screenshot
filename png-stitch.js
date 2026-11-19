class XShotPngStitcher {
  constructor() {
    this.job = null;
  }

  begin(capture) {
    this.abort();
    this.job = {
      capture,
      canvas: null,
      context: null,
      outputScale: null,
      sourceScale: null,
      lastDestinationBottom: 0
    };
    return { ok: true };
  }

  async addFrame(dataUrl, frame) {
    const job = this.job;
    if (!job) throw new Error("截图任务不存在");
    const image = await this.loadImage(dataUrl);
    if (job !== this.job) throw new Error("截图任务已取消");
    if (!job.canvas) this.initializeCanvas(image, frame);

    const sourceScaleX = image.naturalWidth / frame.viewportWidth;
    const sourceScaleY = image.naturalHeight / frame.viewportHeight;
    if (sourceScaleX !== job.sourceScale || sourceScaleY !== job.sourceScaleY) {
      throw new Error("截屏缩放比例变化，请重试");
    }
    // Each CSS boundary maps to exactly one output row for both neighbours.
    const region = job.capture.regions?.[frame.regionIndex] || job.capture;
    const outputTop = frame.outputTop || 0;
    const outputBottom = outputTop + (frame.contentBottom - region.top);
    const lastRegion = !job.capture.regions || frame.regionIndex === job.capture.regions.length - 1;
    const destinationTop = job.lastDestinationBottom;
    const destinationBottom = lastRegion && frame.contentBottom >= region.top + region.height
      ? job.canvas.height : Math.round(outputBottom * job.outputScale);
    const destinationHeight = destinationBottom - destinationTop;
    if (destinationHeight === 0) return { ok: true };
    // Map the rounded destination back into the source. Stretching an unrounded
    // source interval over integer rows otherwise blurs alternating pixel rows.
    const sourceY = (row) => (region.top - frame.scrollY + row / job.outputScale - outputTop) * sourceScaleY;
    const sourceTop = Math.max(0, (region.top - frame.scrollY) * sourceScaleY, sourceY(destinationTop));
    const sourceBottom = Math.min(image.naturalHeight, sourceY(destinationBottom),
      (region.top + region.height - frame.scrollY) * sourceScaleY);
    job.context.drawImage(
      image,
      region.left * sourceScaleX,
      sourceTop,
      region.width * sourceScaleX,
      sourceBottom - sourceTop,
      0,
      destinationTop,
      Math.min(job.canvas.width, Math.ceil(region.width * job.outputScale)),
      destinationHeight
    );
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
    job.sourceScaleY = image.naturalHeight / frame.viewportHeight;
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
    try {
      if (!job?.canvas) throw new Error("没有可复制的截图内容");
      const dataUrl = job.canvas.toDataURL("image/png");
      if (!dataUrl || dataUrl === "data:,") throw new Error("PNG 编码失败");
      return {
        ok: true, dataUrl,
        width: job.canvas.width, height: job.canvas.height,
        scaled: job.outputScale < job.sourceScale - 0.001
      };
    } finally {
      this.abort();
    }
  }

  abort() {
    if (this.job?.canvas) this.job.canvas.width = this.job.canvas.height = 0;
    this.job = null;
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
