// Shared background logic. Only the browser-specific controller owns the output.
const extensionApi = globalThis.browser ?? chrome;
let activeCapture = null;
let lastCaptureCallAt = -Infinity;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(promise, ms, signal) {
  let timer;
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    timer = setTimeout(() => reject(new Error("任务等待超时，请重试")), ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}

function installCaptureController(run, cleanup) {
  extensionApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (activeCapture?.windowId === windowId && activeCapture.tabId !== tabId) cancelCapture();
  });
  extensionApi.tabs.onRemoved.addListener((id) => { if (activeCapture?.tabId === id) cancelCapture(); });
  extensionApi.tabs.onDetached.addListener((id) => { if (activeCapture?.tabId === id) cancelCapture(); });
  extensionApi.tabs.onUpdated.addListener((id, change) => {
    if (activeCapture?.tabId === id && (change.url || change.status === "loading" || change.discarded)) cancelCapture();
  });
  extensionApi.windows.onRemoved.addListener((id) => { if (activeCapture?.windowId === id) cancelCapture(); });
  extensionApi.windows.onFocusChanged.addListener((id) => {
    if (activeCapture && activeCapture.windowId !== id) cancelCapture();
  });

  function activate(tab) {
    enterSelectionMode(tab).catch((error) => {
      if (tab?.id != null) notify(tab.id, "error", readableError(error));
    });
  }
  extensionApi.action.onClicked.addListener(activate);
  extensionApi.commands.onCommand.addListener((command) => { if (command === "start-capture") activate(); });
  extensionApi.runtime.onMessage.addListener((message, sender, respond) => {
    const job = activeCapture;
    if (message?.type === "X_SHOT_ALIVE") {
      respond({ alive: Boolean(job && job.id === message.jobId && !job.controller.signal.aborted) });
      return;
    }
    if (message?.type === "X_SHOT_CANCEL" && sender.tab?.id === job?.tabId && job?.id === message.jobId) {
      cancelCapture("截图已取消");
      respond({ ok: true });
      return;
    }
    if (message?.type !== "X_SHOT_SELECTION" || sender.tab?.id == null || !message.jobId) return;
    captureSelection(sender.tab, message, run, cleanup)
      .then(() => respond({ ok: true }), (error) => respond({ ok: false, error: readableError(error) }));
    return true;
  });
}

function cancelCapture(reason = "标签页或窗口已变化，截图已取消") {
  if (activeCapture && !activeCapture.downloading) activeCapture.controller.abort(new Error(reason));
}

async function captureSelection(tab, message, run, cleanup) {
  if (activeCapture) throw new Error("已有截取任务正在进行");
  const controller = new AbortController();
  const job = {
    id: message.jobId, tabId: tab.id, windowId: tab.windowId, controller,
    step(fn, ms = 15000) {
      controller.signal.throwIfAborted();
      return bounded(fn(), ms, controller.signal);
    },
    page(type, fields = {}, ms) {
      return this.step(() => extensionApi.tabs.sendMessage(tab.id, { type, jobId: this.id, ...fields }), ms)
        .then(requireSuccess);
    }
  };
  activeCapture = job;
  try {
    const origin = await job.step(() => extensionApi.windows.get(tab.windowId));
    if (!origin.focused || origin.state === "minimized") throw new Error("请在当前窗口重新选择帖子");
    await ensureSelectedTab(job);
    await run(job, message.selection);
  } finally {
    controller.abort(new Error("截图任务已结束"));
    try {
      await Promise.allSettled([
        bounded(extensionApi.tabs.sendMessage(tab.id, { type: "X_SHOT_RESTORE", jobId: job.id }), 3000),
        cleanup?.(job)
      ]);
    } finally { activeCapture = null; }
  }
}

function requireSuccess(result) {
  if (!result?.ok) throw new Error(result?.error || "处理请求失败，请重试");
  return result;
}

async function ensureSelectedTab(job) {
  const [tab] = await job.step(() => extensionApi.tabs.query({ active: true, windowId: job.windowId }));
  if (tab?.id !== job.tabId) throw new Error("标签页已切换，截图已取消");
  job.controller.signal.throwIfAborted();
}

async function captureVisibleFrame(job) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureCallAt + 550 - Date.now();
    if (wait > 0) await job.step(() => delay(wait));
    await ensureSelectedTab(job);
    lastCaptureCallAt = Date.now();
    try {
      const url = await job.step(() => extensionApi.tabs.captureVisibleTab(job.windowId, { format: "png" }));
      await ensureSelectedTab(job);
      return url;
    } catch (error) {
      if (attempt === 2 || !/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(readableError(error))) throw error;
      await job.step(() => delay(1100));
    }
  }
}

async function captureFrames(job, capture, addFrame) {
  const bottom = capture.top + capture.height;
  let next = capture.top;
  let scrollY = capture.scrollY;
  for (let index = 1; next < bottom; index++) {
    const inset = Math.min(96, capture.viewportHeight * 0.15);
    const fits = next >= scrollY + inset && bottom <= scrollY + capture.viewportHeight;
    const y = fits ? scrollY : Math.max(0, Math.min(next - inset, capture.documentHeight - capture.viewportHeight));
    const position = await job.page("X_SHOT_SCROLL", { y });
    scrollY = position.scrollY;
    const viewportBottom = scrollY + position.viewportHeight;
    const end = bottom <= viewportBottom + 0.5 ? bottom : viewportBottom;
    if (scrollY > next + 0.5 || end <= next || position.viewportWidth !== capture.viewportWidth ||
        position.viewportHeight !== capture.viewportHeight) throw new Error("页面尺寸或滚动位置变化，请重试");
    const url = await captureVisibleFrame(job);
    await job.page("X_SHOT_VERIFY", { position });
    await job.step(() => addFrame(url, { viewportWidth: position.viewportWidth, viewportHeight: position.viewportHeight,
      scrollY, contentTop: next, contentBottom: end }));
    next = end;
    await job.step(() => notify(job.tabId, "progress", `正在截取第 ${index} 段…`));
  }
}

async function enterSelectionMode(tab) {
  const [activeTab] = tab?.id
    ? [tab]
    : await extensionApi.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) return;

  try {
    await extensionApi.tabs.sendMessage(activeTab.id, { type: "X_SHOT_ENTER" });
  } catch {
    await extensionApi.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content.js"]
    });
    await extensionApi.scripting.insertCSS({
      target: { tabId: activeTab.id },
      files: ["content.css"]
    });
    await extensionApi.tabs.sendMessage(activeTab.id, { type: "X_SHOT_ENTER" });
  }
}

function notify(tabId, kind, text) {
  return bounded(extensionApi.tabs.sendMessage(tabId, { type: "X_SHOT_NOTICE", kind, text }), 1500).catch(() => {});
}

function isSupportedUrl(url = "") {
  return /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url);
}

function readableError(error) {
  return error?.message || String(error || "未知错误");
}
