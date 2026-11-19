function getStatusId(article) {
  const ids = new Set();
  const timestamps = new Set();
  for (const link of article.querySelectorAll('a[href*="/status/"]')) {
    if (link.closest("article") !== article ||
        link.parentElement?.closest('[data-testid="quoteTweet"], [role="link"]') ||
        link.closest('[data-testid="tweetText"]')) continue;
    const url = new URL(link.href, location.href);
    if (!["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(url.hostname)) continue;
    const match = url.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/);
    if (!match) continue;
    if (link.querySelector("time")) {
      if (link.closest('[data-testid="User-Name"]')) return match[1];
      timestamps.add(match[1]);
    }
    ids.add(match[1]);
  }
  if (timestamps.size === 1) return [...timestamps][0];
  return ids.size === 1 ? [...ids][0] : null;
}

function xShotFooterTop(article, mediaBottom, scrollY, captureTop) {
  const actionTops = Array.from(article?.querySelectorAll('[data-testid="reply"]') || [])
    .map((button) => button.closest('[role="group"]'))
    .filter(Boolean)
    .map((group) => group.getBoundingClientRect().top + scrollY - captureTop)
    .filter((top) => Number.isFinite(top) && top >= mediaBottom);
  return actionTops.length ? Math.max(...actionTops) : mediaBottom;
}

function xShotVideoMediaSources(article, video, expandedMedia) {
  const mainStatusId = article && getStatusId(article);
  const quoteCards = new Set();
  let preservePostLayout = (article?.querySelectorAll('[data-testid="tweetText"]')?.length || 0) > 1;
  if (mainStatusId) {
    preservePostLayout ||= Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .some((link) => {
        const linkedId = link.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
        return linkedId && linkedId !== mainStatusId;
      });
  }
  const classifyMedia = (element) => {
    const markedCard = element.closest('[data-testid="quoteTweet"]');
    if (markedCard) return { owner: 'quote', card: markedCard };
    const mediaLink = element.closest('a[href*="/status/"]') || element.querySelector?.('a[href*="/status/"]');
    const mediaStatusId = mediaLink?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
    if (!mainStatusId || !mediaStatusId) return { owner: 'unknown' };
    if (mainStatusId === mediaStatusId) return { owner: 'main' };
    let card = element;
    while (card.parentElement && card.parentElement !== article && !card.parentElement.contains(video)) {
      card = card.parentElement;
    }
    return { owner: 'quote', card };
  };
  const galleries = expandedMedia.filter(({ gallery }) => article?.contains(gallery));
  const mainGalleryImages = galleries.flatMap(({ original, gallery }) => {
    const classification = classifyMedia(original);
    if (classification.owner === 'main') return Array.from(gallery.querySelectorAll('img'));
    preservePostLayout = true;
    if (classification.card) quoteCards.add(classification.card);
    return [];
  });
  const directPhotos = Array.from(article?.querySelectorAll('a[href*="/photo/"] img, img[src*="pbs.twimg.com/media"]') || [])
    .filter((image) => {
      const classification = classifyMedia(image);
      if (classification.owner === 'main') return true;
      preservePostLayout = true;
      if (classification.card) quoteCards.add(classification.card);
      return false;
    });
  return { photoImages: mainGalleryImages.length ? mainGalleryImages : directPhotos,
    quoteCards: Array.from(quoteCards), preservePostLayout };
}

function xShotVideoFooterTop(article, quoteCards, mediaBottom, scrollY, captureTop) {
  const actionTop = xShotFooterTop(article, mediaBottom, scrollY, captureTop);
  const quoteTops = quoteCards
    .map((card) => card.getBoundingClientRect().top + scrollY - captureTop)
    .filter((top) => Number.isFinite(top) && top >= mediaBottom);
  return quoteTops.length ? Math.min(actionTop, ...quoteTops) : actionTop;
}

function xShotHideProfilePreviews(root, hiddenTransient) {
  const previews = root.querySelectorAll('[data-testid*="hovercard" i], [role="tooltip"]');
  for (const preview of previews) {
    const testId = preview.getAttribute("data-testid")?.toLowerCase() || "";
    if (!testId.includes("hovercard") && preview.getAttribute("role") !== "tooltip") continue;
    if (preview.classList.contains("x-shot-transient-hidden")) continue;
    preview.classList.add("x-shot-transient-hidden");
    hiddenTransient.push(preview);
  }
}

function xShotVideoGeometryChanged(expected, current) {
  if (!expected || !current) return true;
  if (expected.viewportWidth !== current.viewportWidth || expected.viewportHeight !== current.viewportHeight) return true;
  return ["left", "top", "width", "height"].some((key) =>
    !Number.isFinite(expected[key]) || !Number.isFinite(current[key]) || Math.abs(expected[key] - current[key]) > 1
  );
}

function xShotPrepareVideo(video, stillOnly) {
  const snapshot = {
    video, muted: video.muted, volume: video.volume,
    time: video.currentTime, paused: video.paused, loop: video.loop
  };
  video.pause();
  if (!stillOnly) video.muted = true;
  return snapshot;
}

function xShotRestoreVideo({ video, muted, volume, time, paused, loop }) {
  video.pause();
  video.muted = muted;
  video.volume = volume;
  video.loop = loop;
  if (Number.isFinite(time) && video.currentTime !== time) {
    try { video.currentTime = time; } catch { /* Some live sources cannot seek. */ }
  }
  if (!paused && video.isConnected) {
    try { Promise.resolve(video.play()).catch(() => {}); } catch { /* Autoplay policy. */ }
  }
}

(() => {
  if (globalThis.__xShotLoaded) return;
  globalThis.__xShotLoaded = true;
  const runtime = (globalThis.browser ?? chrome).runtime;

  const ARTICLE_SELECTOR = 'article[data-testid="tweet"], article';
  const PRIMARY_SELECTOR = '[data-testid="primaryColumn"]';
  const state = {
    selecting: false,
    hovered: null,
    selectedArticles: [],
    expandedMedia: [],
    originalMediaScrolls: [],
    hiddenTransient: [],
    videos: [],
    recordingVideo: null,
    recordingGeometry: null,
    calibrationMarkers: [],
    unmuteTimer: null,
    job: null,
    originalScroll: null,
    toastTimer: null
  };

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "X_SHOT_ENTER") {
      enterSelection();
      sendResponse({ ok: true });
      return;
    }
    const job = state.job;
    if (message?.jobId) {
      if (!job || job.id !== message.jobId || job.controller.signal.aborted) {
        sendResponse({ ok: false, error: "截图任务已结束" });
        return;
      }
      const signal = job.controller.signal;
      const dispatch = async () => {
        switch (message.type) {
          case "X_SHOT_PREPARE": return prepareCapture(message.selection, Boolean(message.stillOnly), signal);
          case "X_SHOT_SCROLL": return scrollAndSettle(message.y, signal);
          case "X_SHOT_VERIFY": return verifyPosition(message.position);
          case "X_SHOT_COPY": return copyImageToClipboard(message.dataUrl, signal);
          case "X_SHOT_VIDEO_POSITION": return positionVideo(message.capture, signal);
          case "X_SHOT_VIDEO_PLAY": return playVideo(signal);
          case "X_SHOT_VIDEO_MARKERS": return readCalibrationMarkers();
          case "X_SHOT_VIDEO_READY": return readyVideo(signal);
          case "X_SHOT_VIDEO_WAIT": return waitForVideoEnd(message.maxDurationMs, signal);
          case "X_SHOT_VIDEO_STOP": state.recordingVideo?.pause(); break;
          case "X_SHOT_RESTORE": restorePage(job); break;
          default: throw new Error("未知的截图请求");
        }
        return { ok: true };
      };
      dispatch().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "X_SHOT_NOTICE") {
      showToast(message.text, message.kind);
      sendResponse({ ok: true });
    }
  });

  function enterSelection() {
    if (state.job) return;
    if (state.selecting) {
      exitSelection();
      return;
    }
    state.selecting = true;
    document.documentElement.classList.add("x-shot-selecting");
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    showToast("移动鼠标选择帖子，单击截图；Esc 取消", "info");
  }

  function exitSelection() {
    state.selecting = false;
    state.hovered?.classList.remove("x-shot-hovered");
    state.hovered = null;
    document.documentElement.classList.remove("x-shot-selecting");
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function onMouseMove(event) {
    let article = event.target.closest?.(ARTICLE_SELECTOR);
    while (article?.parentElement.closest("article")) article = article.parentElement.closest("article");
    if (article === state.hovered) return;
    state.hovered?.classList.remove("x-shot-hovered");
    state.hovered = article || null;
    state.hovered?.classList.add("x-shot-hovered");
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (state.job) cancelPageJob();
    else exitSelection();
    showToast("已取消", "info");
  }

  function onClick(event) {
    if (!state.hovered) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const selection = describeSelection(state.hovered);
    exitSelection();
    showToast("正在准备帖子内容…", "progress");
    const job = { id: crypto.randomUUID(), controller: new AbortController() };
    state.job = job;
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pagehide", cancelPageJob);
    job.heartbeat = setInterval(async () => {
      try {
        const result = await runtime.sendMessage({ type: "X_SHOT_ALIVE", jobId: job.id });
        if (!result?.alive) restorePage(job);
      } catch { restorePage(job); }
    }, 5000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    runtime.sendMessage({ type: "X_SHOT_SELECTION", jobId: job.id, selection })
      .then((result) => {
        if (!result?.ok) showToast(`截图失败：${result?.error || "后台没有返回结果"}`, "error");
      })
      .catch((error) => showToast(`截图失败：${error?.message || String(error)}`, "error"))
      .finally(() => restorePage(job));
  }

  function onVisibilityChange() {
    if (document.hidden) cancelPageJob();
  }

  function cancelPageJob() {
    const job = state.job;
    if (!job) return;
    restorePage(job);
    runtime.sendMessage({ type: "X_SHOT_CANCEL", jobId: job.id }).catch(() => {});
  }

  function describeSelection(selected) {
    const primary = selected.closest(PRIMARY_SELECTOR) || document.querySelector(PRIMARY_SELECTOR);
    const articles = Array.from((primary || document).querySelectorAll(ARTICLE_SELECTOR))
      .filter(isVisible);
    const selectedIndex = articles.indexOf(selected);
    const selectedId = getStatusId(selected);
    const pageId = location.pathname.match(/\/status\/(\d+)/)?.[1] || null;
    const focalIndex = pageId ? articles.findIndex((article) => getStatusId(article) === pageId) : -1;

    let startIndex = selectedIndex;
    if (pageId && selectedId === pageId && selectedIndex > 0) {
      startIndex = 0;
    } else if (selectedIndex > focalIndex && focalIndex >= 0) {
      startIndex = focalIndex;
    }

    const selectedArticles = articles.slice(startIndex, selectedIndex + 1);
    const ids = selectedArticles.map(getStatusId);
    state.selectedArticles = selectedArticles;
    return { ids, selectedId, includeConversation: selectedArticles.length > 1 };
  }

  async function prepareCapture(selection, stillOnly, signal) {
    const primary = document.querySelector(PRIMARY_SELECTOR) || document;
    const all = Array.from(primary.querySelectorAll(ARTICLE_SELECTOR)).filter(isVisible);
    const targets = selection.ids.map((id, i) => {
      const original = state.selectedArticles[i];
      if (all.includes(original) && getStatusId(original) === id) return original;
      return id && all.find((article) => getStatusId(article) === id);
    });
    if (!targets.length || targets.some((target) => !target)) {
      throw new Error("所选帖子已经变化，请重新选择");
    }

    state.originalScroll = { top: window.scrollY, left: window.scrollX };
    state.selectedArticles = targets;
    state.recordingVideo = targets.at(-1)?.querySelector("video") || null;
    state.videos = Array.from(new Set(targets.flatMap((article) => Array.from(article.querySelectorAll("video")))))
      .map((video) => xShotPrepareVideo(video, stillOnly));
    if (state.recordingVideo) {
      let ancestor = state.recordingVideo.parentElement;
      while (ancestor && ancestor !== targets.at(-1)) {
        if (ancestor.scrollWidth > ancestor.clientWidth + 4) {
          state.originalMediaScrolls.push({ element: ancestor, left: ancestor.scrollLeft });
        }
        ancestor = ancestor.parentElement;
      }
      if (!stillOnly) {
        try { await seekToStart(state.recordingVideo, signal); } catch { /* a live source may not seek */ }
      }
      signal.throwIfAborted();
      state.recordingVideo.scrollIntoView({ block: "center", behavior: "instant" });
    }
    targets.forEach((article) => article.classList.add("x-shot-target"));
    document.documentElement.classList.add("x-shot-capturing");
    hideTransientUi();
    await expandScrollableMedia(targets, signal);
    signal.throwIfAborted();
    const refreshedVideo = targets.at(-1)?.querySelector("video") || null;
    if (refreshedVideo && refreshedVideo !== state.recordingVideo) {
      state.recordingVideo = refreshedVideo;
      state.videos.push(xShotPrepareVideo(refreshedVideo, stillOnly));
    }
    if (!refreshedVideo) state.recordingVideo = null;
    // Eager images can still determine the full post height before capture.
    await waitForImages(false, signal);
    await animationFrames(2, signal);
    signal.throwIfAborted();

    state.bounds = captureBounds();
    return { ok: true, hasVideo: Boolean(state.recordingVideo), capture: {
      ...state.bounds, scrollY: window.scrollY, viewportWidth: innerWidth,
      viewportHeight: innerHeight, documentHeight: document.documentElement.scrollHeight
    } };
  }

  function captureBounds() {
    const targets = state.selectedArticles;
    if (targets.some((article) => !article.isConnected)) throw new Error("所选帖子已经变化，请重试");
    const rects = targets.map((article) => article.getBoundingClientRect());
    const all = rects.concat(state.expandedMedia.map(({ gallery }) => gallery.getBoundingClientRect()));
    const top = Math.min(...all.map((rect) => rect.top));
    const bottom = Math.max(...all.map((rect) => rect.bottom));
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    if (bottom <= top || right <= left || left < -0.5 || right > innerWidth + 0.5) {
      throw new Error("帖子超出可截取范围，请调整窗口后重试");
    }
    return { top: top + scrollY, left, width: right - left, height: bottom - top };
  }

  function verifyPosition(position) {
    const bounds = captureBounds();
    if (position.scrollY !== scrollY || position.viewportWidth !== innerWidth ||
        position.viewportHeight !== innerHeight ||
        Object.keys(bounds).some((key) => Math.abs(bounds[key] - state.bounds[key]) > 0.5)) {
      throw new Error("截图期间页面布局发生变化，请重试");
    }
    return { ok: true };
  }

  async function scrollAndSettle(y, signal) {
    const previousScrollY = window.scrollY;
    window.scrollTo({ top: y, behavior: "instant" });
    await animationFrames(2, signal);
    signal.throwIfAborted();
    // Image loading and X's scroll rendering can settle at the same time.
    // An unchanged viewport only needs the paint frames, without a scroll delay.
    await Promise.all([
      waitForImages(true, signal),
      Math.abs(window.scrollY - previousScrollY) > 0.5
        ? new Promise((resolve) => setTimeout(resolve, 120))
        : Promise.resolve()
    ]);
    signal.throwIfAborted();
    // X may recreate its blue "new posts" pill after any scroll.
    hideTransientUi();
    await animationFrames(1, signal);
    signal.throwIfAborted();
    return {
      ok: true,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }

  async function copyImageToClipboard(dataUrl, signal) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("当前浏览器不支持写入 PNG 剪贴板，请更新浏览器");
      }
      const blob = await fetch(dataUrl).then((response) => response.blob());
      signal.throwIfAborted();
      if (!document.hasFocus()) throw new Error("X 标签页当前没有获得焦点");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function restorePage(job) {
    if (state.job !== job) return;
    state.job = null;
    clearInterval(job.heartbeat);
    job.controller.abort();
    window.removeEventListener("pagehide", cancelPageJob);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("keydown", onKeyDown, true);
    const toast = document.getElementById("x-shot-toast");
    if (toast?.dataset.kind === "progress") toast.classList.remove("visible");
    removeCalibrationMarkers();
    clearInterval(state.unmuteTimer);
    state.unmuteTimer = null;
    for (const snapshot of state.videos) xShotRestoreVideo(snapshot);
    document.documentElement.classList.remove("x-shot-capturing");
    state.selectedArticles.forEach((article) => article.classList.remove("x-shot-target"));
    state.expandedMedia.forEach(({ original, scroller, gallery, scrollLeft }) => {
      original.classList.remove("x-shot-original-media-hidden");
      scroller.scrollLeft = scrollLeft;
      gallery.remove();
    });
    state.originalMediaScrolls.reverse().forEach(({ element, left }) => { element.scrollLeft = left; });
    state.hiddenTransient.forEach((element) => element.classList.remove("x-shot-transient-hidden"));
    if (state.originalScroll) window.scrollTo({ ...state.originalScroll, behavior: "instant" });
    state.originalScroll = null;
    state.selectedArticles = [];
    state.bounds = null;
    state.expandedMedia = [];
    state.originalMediaScrolls = [];
    state.hiddenTransient = [];
    state.videos = [];
    state.recordingVideo = null;
    state.recordingGeometry = null;
  }

  async function positionVideo(capture, signal) {
    const video = state.recordingVideo;
    if (!video || !document.contains(video)) return { ok: false, error: "所选视频已离开页面" };
    video.pause();
    video.muted = true;
    try { await seekToStart(video, signal); } catch { return { ok: false, error: "该视频不支持从开头播放" }; }
    signal.throwIfAborted();
    video.scrollIntoView({ block: "center", behavior: "instant" });
    await animationFrames(2, signal);
    signal.throwIfAborted();
    hideTransientUi();
    showCalibrationMarkers();
    await animationFrames(2, signal);
    signal.throwIfAborted();
    const rect = video.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
      return { ok: false, error: "视频无法完整显示在当前窗口；请扩大窗口后重试" };
    }
    const selected = state.selectedArticles.at(-1);
    const { photoImages, quoteCards, preservePostLayout } = xShotVideoMediaSources(selected, video, state.expandedMedia);
    const photoRects = photoImages
      .map((image) => image.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => ({ left: box.left + scrollX - capture.left, top: box.top + scrollY - capture.top, width: box.width, height: box.height }));
    const textRect = selected?.querySelector('[data-testid="tweetText"]')?.getBoundingClientRect();
    const contentLeft = Math.max(capture.left - scrollX, Math.min(rect.left, textRect?.left ?? rect.left));
    const contentRight = Math.min(capture.left - scrollX + capture.width, Math.max(rect.right, textRect?.right ?? rect.right));
    const videoTop = rect.top + scrollY - capture.top;
    const mediaTop = Math.min(videoTop, ...photoRects.map((photo) => photo.top));
    const mediaBottom = Math.max(videoTop + rect.height, ...photoRects.map((photo) => photo.top + photo.height));
    return {
      ok: true,
      viewport: { width: innerWidth, height: innerHeight },
      videoRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      documentVideoRect: { left: rect.left + scrollX - capture.left, top: rect.top + scrollY - capture.top, width: rect.width, height: rect.height },
      photoRects,
      preservePostLayout,
      contentArea: { left: contentLeft + scrollX - capture.left, width: contentRight - contentLeft },
      mediaTop,
      footerTop: xShotVideoFooterTop(selected, quoteCards, mediaBottom, scrollY, capture.top),
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#000"
    };
  }

  function removeCalibrationMarkers() {
    state.calibrationMarkers.forEach((marker) => marker.remove());
    state.calibrationMarkers = [];
  }

  function showCalibrationMarkers() {
    removeCalibrationMarkers();
    const definitions = [
      ["left:8px;top:8px", "#ff00ff"],
      ["right:8px;bottom:8px", "#00ffff"]
    ];
    for (const [position, color] of definitions) {
      const marker = document.createElement("div");
      marker.style.cssText = `position:fixed!important;${position};width:24px!important;height:24px!important;background:${color}!important;z-index:2147483647!important;pointer-events:none!important;opacity:1!important;border:0!important;box-shadow:none!important;mix-blend-mode:normal!important`;
      document.body.appendChild(marker);
      state.calibrationMarkers.push(marker);
    }
  }

  function readCalibrationMarkers() {
    if (state.calibrationMarkers.length !== 2 || state.calibrationMarkers.some((marker) => !document.contains(marker))) {
      return { ok: false, error: "录屏校准点已消失" };
    }
    const [first, second] = state.calibrationMarkers.map((marker) => {
      const rect = marker.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    return { ok: true, markers: { first, second } };
  }

  async function readyVideo(signal) {
    removeCalibrationMarkers();
    await animationFrames(2, signal);
    signal.throwIfAborted();
    const video = state.recordingVideo;
    if (!video || !document.contains(video)) return { ok: false, error: "所选视频已离开页面" };
    const rect = video.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
      return { ok: false, error: "视频无法完整显示在当前窗口；请扩大窗口后重试" };
    }
    const videoRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    state.recordingGeometry = { ...videoRect, viewportWidth: innerWidth, viewportHeight: innerHeight };
    return { ok: true, videoRect };
  }

  async function playVideo(signal) {
    const video = state.recordingVideo;
    if (!video) return { ok: false, error: "视频已不存在" };
    try {
      video.loop = false;
      video.volume = 1;
      video.muted = false;
      await video.play();
      signal.throwIfAborted();
      clearInterval(state.unmuteTimer);
      state.unmuteTimer = setInterval(() => {
        if (!document.contains(video)) return;
        video.muted = false;
        video.volume = 1;
      }, 250);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `视频无法播放：${error?.message || error}` };
    }
  }

  async function waitForVideoEnd(maxDurationMs, signal) {
    const video = state.recordingVideo;
    if (!video) return { ok: false, error: "视频已不存在" };
    const boundedMs = Math.min(30000, Math.max(1000, maxDurationMs || 30000));
    const result = await new Promise((resolve) => {
      let timer;
      let monitor;
      const finish = (value) => {
        clearTimeout(timer);
        clearInterval(monitor);
        signal.removeEventListener("abort", abort);
        video.removeEventListener("ended", done);
        resolve(value);
      };
      const done = () => finish({ ok: true });
      const abort = () => finish({ ok: false, error: "录制已取消" });
      signal.addEventListener("abort", abort, { once: true });
      let lastTime = video.currentTime;
      let lastProgress = performance.now();
      const check = () => {
        if (video.ended) return done();
        if (video.error || video.paused || video.seeking) return finish({ ok: false, error: "视频播放中断，请重试" });
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          lastProgress = performance.now();
        } else if (performance.now() - lastProgress > 3000) {
          return finish({ ok: false, error: "视频缓冲时间过长，请等待加载后重试" });
        }
        if (!document.contains(video)) return finish({ ok: false, error: "视频在录制中离开页面" });
        const rect = video.getBoundingClientRect();
        const current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight };
        if (xShotVideoGeometryChanged(state.recordingGeometry, current)) {
          finish({ ok: false, error: "视频位置在录制中变化，已停止以避免画面重影；请重试" });
        }
      };
      timer = setTimeout(done, boundedMs);
      monitor = setInterval(check, 100);
      video.addEventListener("ended", done, { once: true });
      if (video.ended) done();
      else check();
    });
    signal.throwIfAborted();
    video.pause();
    clearInterval(state.unmuteTimer);
    state.unmuteTimer = null;
    return result;
  }

  function seekToStart(video, signal) {
    video.currentTime = 0;
    if (!video.seeking && video.currentTime <= 0.1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        signal.removeEventListener("abort", done);
        if (signal.aborted || video.seeking || video.currentTime > 0.1) reject(new Error("视频定位失败"));
        else resolve();
      };
      const timer = setTimeout(done, 1500);
      signal.addEventListener("abort", done, { once: true });
      video.addEventListener("seeked", done, { once: true });
    });
  }

  function hideTransientUi() {
    xShotHideProfilePreviews(document, state.hiddenTransient);
    const newPostPattern = /(?:有新(?:的)?帖(?:子|文)|查看新帖(?:子|文)|show\s+(?:\d+\s+)?new posts?|see new posts?|new posts? available|新しいポスト|nuevas publicaciones|nouveaux posts)/i;
    const immersiveTranslateOverlays = document.querySelectorAll('#immersive-translate-popup');
    for (const overlay of immersiveTranslateOverlays) {
      if (overlay.classList.contains("x-shot-transient-hidden")) continue;
      overlay.classList.add("x-shot-transient-hidden");
      state.hiddenTransient.push(overlay);
    }

    const candidates = document.querySelectorAll('button, [role="button"], [data-testid="toast"]');
    for (const candidate of candidates) {
      const isToast = candidate.matches('[data-testid="toast"]');
      const text = candidate.textContent?.replace(/\s+/g, " ").trim() || "";
      const accessibleText = [
        text,
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title")
      ].filter(Boolean).join(" ");
      if (!isToast && !newPostPattern.test(accessibleText)) continue;
      if (candidate.classList.contains("x-shot-transient-hidden")) continue;
      candidate.classList.add("x-shot-transient-hidden");
      state.hiddenTransient.push(candidate);
    }
  }

  async function expandScrollableMedia(articles, signal) {
    const processedScrollers = new Set();
    const processedBlocks = new Set();
    for (const article of articles) {
      const mediaItems = article.querySelectorAll('a[href*="/photo/"] img, img[src*="pbs.twimg.com/media"], video');
      for (const item of mediaItems) {
        const scroller = findHorizontalScroller(item, article);
        if (!scroller || processedScrollers.has(scroller)) continue;
        processedScrollers.add(scroller);

        const originalScrollLeft = scroller.scrollLeft;
        state.originalMediaScrolls.push({ element: scroller, left: originalScrollLeft });
        const items = await collectCarouselImages(scroller, signal);
        signal.throwIfAborted();
        scroller.scrollLeft = originalScrollLeft;
        if (items.length < 2 && !scroller.querySelector("video")) continue;
        if (!items.length) continue;

        const mediaBlock = findMediaBlock(scroller, article);
        if (processedBlocks.has(mediaBlock)) continue;
        processedBlocks.add(mediaBlock);
        const gallery = buildMediaGallery(items);
        // Mixed carousels must keep the playable video visible in the post.
        if (!mediaBlock.querySelector("video")) mediaBlock.classList.add("x-shot-original-media-hidden");
        mediaBlock.insertAdjacentElement("afterend", gallery);
        state.expandedMedia.push({
          original: mediaBlock,
          scroller,
          gallery,
          scrollLeft: originalScrollLeft
        });
        await waitForImageElements(Array.from(gallery.querySelectorAll("img")), 3000, signal);
        signal.throwIfAborted();
      }
    }
  }

  function findMediaBlock(scroller, article) {
    let block = scroller;
    while (block.parentElement && block.parentElement !== article) {
      const parent = block.parentElement;
      const containsTweetText = Boolean(parent.querySelector('[data-testid="tweetText"]'));
      const containsActions = Boolean(parent.querySelector('[role="group"]'));
      if (containsTweetText || containsActions) break;
      block = parent;
    }

    // Never replace a wrapper that also owns the tweet's text or controls.
    if (
      block === article ||
      block.matches('[data-testid="tweetText"]') ||
      block.querySelector('[data-testid="tweetText"], [role="group"]')
    ) {
      return scroller;
    }
    return block;
  }

  function findHorizontalScroller(mediaElement, article) {
    let node = mediaElement.parentElement;
    while (node && node !== article) {
      if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 4) {
        const style = getComputedStyle(node);
        if (["auto", "scroll", "hidden"].includes(style.overflowX)) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  async function collectCarouselImages(scroller, signal) {
    const collected = new Map();
    const collectVisible = () => {
      for (const image of scroller.querySelectorAll("img")) {
        const src = image.currentSrc || image.src;
        const photoLink = image.closest('a[href*="/photo/"]');
        if (!src || (!photoLink && !/pbs\.twimg\.com\/media\//i.test(src))) continue;
        const key = src.replace(/[?&]name=[^&]+/i, "").replace(/[?&]$/, "");
        if (!collected.has(key)) {
          collected.set(key, {
            src,
            alt: image.alt || "帖子图片",
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height
          });
        }
      }
    };

    const step = Math.max(1, Math.floor(scroller.clientWidth * 0.8));
    let position = 0;
    for (let pass = 0; pass < 30; pass += 1) {
      scroller.scrollTo({ left: position, behavior: "instant" });
      await animationFrames(2, signal);
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      signal.throwIfAborted();
      collectVisible();

      const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (position >= maximum - 1) return Array.from(collected.values());
      position = Math.min(maximum, position + step);
    }
    throw new Error("横向图库过长，无法完整截取");
  }

  function buildMediaGallery(items) {
    const gallery = document.createElement("div");
    gallery.className = "x-shot-media-gallery";
    gallery.dataset.count = String(items.length);

    items.forEach((item, index) => {
      const cell = document.createElement("div");
      cell.className = "x-shot-media-cell";
      const image = document.createElement("img");
      image.src = item.src;
      image.alt = item.alt;
      image.decoding = "sync";
      image.dataset.index = String(index + 1);
      if (item.width && item.height) image.style.aspectRatio = `${item.width} / ${item.height}`;
      cell.appendChild(image);
      gallery.appendChild(cell);
    });
    return gallery;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return !element.parentElement.closest("article") && rect.width > 0 && rect.height > 0;
  }

  function waitForImages(visibleOnly, signal) {
    // Wait for offscreen lazy images when their segment enters the viewport.
    // Eager images also settle layout during preparation; hidden gallery
    // originals never contribute to either the layout or the current frame.
    const images = state.selectedArticles.flatMap((article) => Array.from(article.querySelectorAll("img")))
      .filter((image) => {
        const rect = image.getBoundingClientRect();
        if (!image.getClientRects().length) return false;
        if (!visibleOnly && image.loading !== "lazy") return true;
        return rect.bottom >= 0 && rect.top < window.innerHeight &&
          rect.right >= 0 && rect.left < window.innerWidth;
      });
    return waitForImageElements(images, 1500, signal);
  }

  async function waitForImageElements(images, timeout, signal) {
    signal.throwIfAborted();
    const pending = images.filter((image) => !image.complete);
    if (pending.length) {
      await new Promise((resolve, reject) => {
        const remaining = new Set(pending);
        const timer = setTimeout(done, timeout);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          for (const image of pending) {
            image.removeEventListener("load", loaded);
            image.removeEventListener("error", loaded);
          }
          if (signal.aborted) reject(signal.reason);
          else resolve();
        }
        function loaded(event) {
          remaining.delete(event.target);
          if (!remaining.size) done();
        }
        signal.addEventListener("abort", done, { once: true });
        for (const image of pending) {
          image.addEventListener("load", loaded);
          image.addEventListener("error", loaded);
        }
      });
    }
    if (images.some((image) => !image.complete || !image.naturalWidth)) {
      throw new Error("帖子图片未完整加载，请等待图片显示后重试");
    }
  }

  function animationFrames(count, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let frame;
      const abort = () => {
        cancelAnimationFrame(frame);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      const next = () => {
        if (count-- > 0) frame = requestAnimationFrame(next);
        else {
          signal.removeEventListener("abort", abort);
          resolve();
        }
      };
      next();
    });
  }

  function showToast(text, kind = "info") {
    let toast = document.getElementById("x-shot-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "x-shot-toast";
      document.documentElement.appendChild(toast);
    }
    toast.dataset.kind = kind;
    toast.textContent = text;
    toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    if (kind !== "progress") {
      state.toastTimer = setTimeout(
        () => toast.classList.remove("visible"),
        kind === "error" ? 12000 : 2600
      );
    }
  }
})();
