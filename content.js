function xShotFooterTop(article, mediaBottom, scrollY, captureTop) {
  const actionTops = Array.from(article?.querySelectorAll('[data-testid="reply"]') || [])
    .map((button) => button.closest('[role="group"]'))
    .filter(Boolean)
    .map((group) => group.getBoundingClientRect().top + scrollY - captureTop)
    .filter((top) => Number.isFinite(top) && top >= mediaBottom);
  return actionTops.length ? Math.max(...actionTops) : mediaBottom;
}

function xShotVideoMediaSources(article, video, expandedMedia) {
  const mainLink = article?.querySelector('time')?.closest('a[href*="/status/"]');
  const mainStatusId = mainLink?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
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

(() => {
  if (globalThis.__xShotLoaded) return;
  globalThis.__xShotLoaded = true;

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
    originalScrollY: 0,
    toastTimer: null
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "X_SHOT_ENTER") {
      enterSelection();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "X_SHOT_PREPARE") {
      prepareCapture(message.selection).then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_SCROLL") {
      scrollAndSettle(message.y).then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_COPY") {
      copyImageToClipboard(message.dataUrl).then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_VIDEO_POSITION") {
      positionVideo(message.capture).then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_VIDEO_PLAY") {
      playVideo().then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_VIDEO_MARKERS") {
      sendResponse(readCalibrationMarkers());
      return;
    }
    if (message?.type === "X_SHOT_VIDEO_READY") {
      readyVideo().then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_VIDEO_WAIT") {
      waitForVideoEnd(message.maxDurationMs).then(sendResponse);
      return true;
    }
    if (message?.type === "X_SHOT_VIDEO_STOP") {
      state.recordingVideo?.pause();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "X_SHOT_RESTORE") {
      restorePage();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "X_SHOT_NOTICE") {
      showToast(message.text, message.kind);
      sendResponse({ ok: true });
    }
  });

  function enterSelection() {
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
    const article = event.target.closest?.(ARTICLE_SELECTOR);
    if (article === state.hovered) return;
    state.hovered?.classList.remove("x-shot-hovered");
    state.hovered = article || null;
    state.hovered?.classList.add("x-shot-hovered");
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    exitSelection();
    showToast("已取消", "info");
  }

  function onClick(event) {
    if (!state.hovered) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const selection = describeSelection(state.hovered);
    exitSelection();
    showToast("正在准备帖子内容…", "progress");
    chrome.runtime.sendMessage({ type: "X_SHOT_SELECTION", selection })
      .then((result) => {
        if (!result?.ok) showToast(`截图失败：${result?.error || "后台没有返回结果"}`, "error");
      })
      .catch((error) => showToast(`截图失败：${error?.message || String(error)}`, "error"));
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
    if (selectedIndex >= 0 && selectedId === pageId && selectedIndex > 0) {
      startIndex = 0;
    } else if (selectedIndex > focalIndex && focalIndex >= 0) {
      startIndex = focalIndex;
    }

    const selectedArticles = articles.slice(startIndex, selectedIndex + 1);
    const ids = selectedArticles.map(getStatusId).filter(Boolean);
    state.selectedArticles = selectedArticles;
    return { ids, selectedId, includeConversation: selectedArticles.length > 1 };
  }

  async function prepareCapture(selection) {
    const primary = document.querySelector(PRIMARY_SELECTOR) || document;
    const all = Array.from(primary.querySelectorAll(ARTICLE_SELECTOR)).filter(isVisible);
    let targets = selection.ids
      .map((id) => all.find((article) => getStatusId(article) === id))
      .filter(Boolean);

    if (!targets.length && state.selectedArticles.length) targets = state.selectedArticles.filter(document.contains.bind(document));
    if (!targets.length) return { ok: false, error: "所选帖子已经不在页面中" };

    state.originalScrollY = window.scrollY;
    state.selectedArticles = targets;
    state.recordingVideo = targets.at(-1)?.querySelector("video") || null;
    state.videos = Array.from(new Set(targets.flatMap((article) => Array.from(article.querySelectorAll("video")))))
      .map((video) => ({ video, muted: video.muted, volume: video.volume, time: video.currentTime, paused: video.paused }));
    for (const { video } of state.videos) {
      video.pause();
      video.muted = true;
    }
    if (state.recordingVideo) {
      let ancestor = state.recordingVideo.parentElement;
      while (ancestor && ancestor !== targets.at(-1)) {
        if (ancestor.scrollWidth > ancestor.clientWidth + 4) {
          state.originalMediaScrolls.push({ element: ancestor, left: ancestor.scrollLeft });
        }
        ancestor = ancestor.parentElement;
      }
      try { await seekToStart(state.recordingVideo); } catch { /* a live source may not seek */ }
      state.recordingVideo.scrollIntoView({ block: "center", behavior: "instant" });
    }
    targets.forEach((article) => article.classList.add("x-shot-target"));
    document.documentElement.classList.add("x-shot-capturing");
    hideTransientUi();
    await expandScrollableMedia(targets);
    const refreshedVideo = targets.at(-1)?.querySelector("video") || null;
    if (refreshedVideo && refreshedVideo !== state.recordingVideo) {
      state.recordingVideo = refreshedVideo;
      state.videos.push({ video: refreshedVideo, muted: refreshedVideo.muted, volume: refreshedVideo.volume, time: refreshedVideo.currentTime, paused: refreshedVideo.paused });
      refreshedVideo.pause();
      refreshedVideo.muted = true;
    }
    if (!refreshedVideo) state.recordingVideo = null;
    await waitForImages();
    await animationFrames(2);

    const rects = targets.map((article) => article.getBoundingClientRect());
    const galleryRects = state.expandedMedia.map(({ gallery }) => gallery.getBoundingClientRect());
    const captureRects = rects.concat(galleryRects);
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...captureRects.map((rect) => rect.top + window.scrollY));
    const bottom = Math.max(...captureRects.map((rect) => rect.bottom + window.scrollY));

    return {
      ok: true,
      hasVideo: Boolean(state.recordingVideo),
      capture: {
        left,
        top,
        width: right - left,
        height: bottom - top,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight
      }
    };
  }

  async function scrollAndSettle(y) {
    window.scrollTo({ top: y, behavior: "instant" });
    await animationFrames(2);
    await waitForImages();
    await new Promise((resolve) => setTimeout(resolve, 120));
    // X may recreate its blue "new posts" pill after any scroll.
    hideTransientUi();
    await animationFrames(1);
    return {
      ok: true,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }

  async function copyImageToClipboard(dataUrl) {
    try {
      if (!document.hasFocus()) throw new Error("X 标签页当前没有获得焦点");
      const blob = await fetch(dataUrl).then((response) => response.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function restorePage() {
    removeCalibrationMarkers();
    clearInterval(state.unmuteTimer);
    state.unmuteTimer = null;
    for (const { video, muted, volume, time } of state.videos) {
      video.pause();
      video.muted = muted;
      video.volume = volume;
      try { video.currentTime = time; } catch { /* live streams may not seek */ }
    }
    document.documentElement.classList.remove("x-shot-capturing");
    state.selectedArticles.forEach((article) => article.classList.remove("x-shot-target"));
    state.expandedMedia.forEach(({ original, scroller, gallery, scrollLeft }) => {
      original.classList.remove("x-shot-original-media-hidden");
      scroller.scrollLeft = scrollLeft;
      gallery.remove();
    });
    state.originalMediaScrolls.forEach(({ element, left }) => { element.scrollLeft = left; });
    state.hiddenTransient.forEach((element) => element.classList.remove("x-shot-transient-hidden"));
    window.scrollTo({ top: state.originalScrollY, behavior: "instant" });
    state.selectedArticles = [];
    state.expandedMedia = [];
    state.originalMediaScrolls = [];
    state.hiddenTransient = [];
    state.videos = [];
    state.recordingVideo = null;
    state.recordingGeometry = null;
  }

  async function positionVideo(capture) {
    const video = state.recordingVideo;
    if (!video || !document.contains(video)) return { ok: false, error: "所选视频已离开页面" };
    video.pause();
    video.muted = true;
    try { await seekToStart(video); } catch { return { ok: false, error: "该视频不支持从开头播放" }; }
    video.scrollIntoView({ block: "center", behavior: "instant" });
    await animationFrames(2);
    hideTransientUi();
    showCalibrationMarkers();
    await animationFrames(2);
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

  async function readyVideo() {
    removeCalibrationMarkers();
    await animationFrames(2);
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

  async function playVideo() {
    const video = state.recordingVideo;
    if (!video) return { ok: false, error: "视频已不存在" };
    try {
      video.volume = 1;
      video.muted = false;
      await video.play();
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

  async function waitForVideoEnd(maxDurationMs) {
    const video = state.recordingVideo;
    if (!video) return { ok: false, error: "视频已不存在" };
    const boundedMs = Math.min(30000, Math.max(1000, maxDurationMs || 30000));
    const result = await new Promise((resolve) => {
      let timer;
      let monitor;
      const finish = (value) => {
        clearTimeout(timer);
        clearInterval(monitor);
        video.removeEventListener("ended", done);
        resolve(value);
      };
      const done = () => finish({ ok: true });
      const check = () => {
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
    video.pause();
    clearInterval(state.unmuteTimer);
    state.unmuteTimer = null;
    return result;
  }

  function seekToStart(video) {
    video.currentTime = 0;
    if (!video.seeking) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
      const timer = setTimeout(done, 1500);
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

  async function expandScrollableMedia(articles) {
    const processedScrollers = new Set();
    const processedBlocks = new Set();
    for (const article of articles) {
      const mediaItems = article.querySelectorAll('a[href*="/photo/"] img, img[src*="pbs.twimg.com/media"], video');
      for (const item of mediaItems) {
        const scroller = findHorizontalScroller(item, article);
        if (!scroller || processedScrollers.has(scroller)) continue;
        processedScrollers.add(scroller);

        const originalScrollLeft = scroller.scrollLeft;
        const items = await collectCarouselImages(scroller);
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
        await waitForImageElements(Array.from(gallery.querySelectorAll("img")), 3000);
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

  async function collectCarouselImages(scroller) {
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
      await animationFrames(2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      collectVisible();

      const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (position >= maximum - 1) break;
      position = Math.min(maximum, position + step);
    }
    return Array.from(collected.values());
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

  function getStatusId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const id = link.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1];
      if (id) return id;
    }
    return null;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function waitForImages() {
    const images = state.selectedArticles.flatMap((article) => Array.from(article.querySelectorAll("img")));
    return waitForImageElements(images, 1500);
  }

  function waitForImageElements(images, timeout) {
    const pending = images.filter((image) => !image.complete).map((image) => new Promise((resolve) => {
      const done = () => resolve();
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
      setTimeout(done, timeout);
    }));
    return Promise.all(pending);
  }

  function animationFrames(count) {
    return new Promise((resolve) => {
      const next = () => count-- > 0 ? requestAnimationFrame(next) : resolve();
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
