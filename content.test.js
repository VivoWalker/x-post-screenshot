const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContent() {
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8'), context);
  return context;
}

function replyAt(top) {
  return { closest() { return { getBoundingClientRect() { return { top }; } }; } };
}

test('footer starts at the last tweet action row, not the video overlay row', () => {
  const content = loadContent();
  const article = { querySelectorAll() { return [replyAt(100), replyAt(140)]; } };
  assert.equal(typeof content.xShotFooterTop, 'function');
  assert.equal(content.xShotFooterTop(article, 90, 0, 0), 140);
});

test('footer never starts inside video media when no tweet action row is below it', () => {
  const content = loadContent();
  const article = { querySelectorAll() { return [replyAt(70)]; } };
  assert.equal(typeof content.xShotFooterTop, 'function');
  assert.equal(content.xShotFooterTop(article, 90, 0, 0), 90);
});

function transientElement(testId, role) {
  const classes = new Set();
  return {
    getAttribute(name) { return name === 'data-testid' ? testId : name === 'role' ? role : null; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

test('capture hides floating profile previews but preserves the tweet author', () => {
  const content = loadContent();
  const profilePreview = transientElement('HoverCard', null);
  const tooltipPreview = transientElement(null, 'tooltip');
  const tweetAuthor = transientElement('User-Name', null);
  const documentRoot = { querySelectorAll() { return [profilePreview, tooltipPreview, tweetAuthor]; } };
  const hidden = [];

  content.xShotHideProfilePreviews(documentRoot, hidden);

  assert.equal(profilePreview.classList.contains('x-shot-transient-hidden'), true);
  assert.equal(tooltipPreview.classList.contains('x-shot-transient-hidden'), true);
  assert.equal(tweetAuthor.classList.contains('x-shot-transient-hidden'), false);
  assert.deepEqual(hidden, [profilePreview, tooltipPreview]);
});

test('video geometry check detects a same-size stream whose page video moved', () => {
  const content = loadContent();
  const expected = { left: 100, top: 200, width: 300, height: 400, viewportWidth: 800, viewportHeight: 600 };
  assert.equal(content.xShotVideoGeometryChanged(expected, { ...expected, top: 201.2 }), true);
  assert.equal(content.xShotVideoGeometryChanged(expected, { ...expected, top: 200.4 }), false);
  assert.equal(content.xShotVideoGeometryChanged(expected, { ...expected, viewportHeight: 590 }), true);
});

function mediaNode(parentElement, { href = null, quote = false } = {}) {
  return {
    parentElement,
    href,
    quote,
    getAttribute(name) { return name === 'href' ? href : null; },
    contains(target) {
      for (let node = target; node; node = node.parentElement) if (node === this) return true;
      return false;
    },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '[data-testid="quoteTweet"]' && node.quote) return node;
        if (selector === 'a[href*="/status/"]' && node.href?.includes('/status/')) return node;
      }
      return null;
    }
  };
}

test('video media keeps quoted photos inside their quoted card instead of thumbnailing them', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const body = mediaNode(article);
  const video = mediaNode(body);
  const mainPhoto = mediaNode(mediaNode(body, { href: '/main/status/111/photo/1' }));
  const quoteCard = mediaNode(body, { quote: true });
  const quotePhoto = mediaNode(mediaNode(quoteCard, { href: '/other/status/222/photo/1' }));
  const quotedGallery = mediaNode(quoteCard);
  const quotedGalleryPhoto = mediaNode(quotedGallery);
  const mainTime = { closest() { return mediaNode(null, { href: '/main/status/111' }); } };
  article.querySelector = () => mainTime;
  article.querySelectorAll = () => [mainPhoto, quotePhoto];
  quotedGallery.querySelectorAll = () => [quotedGalleryPhoto];

  const result = content.xShotVideoMediaSources(article, video, [{ original: quotePhoto, gallery: quotedGallery }]);
  assert.deepEqual(Array.from(result.photoImages), [mainPhoto]);
  assert.deepEqual(Array.from(result.quoteCards), [quoteCard]);
});

test('video media recognizes a quoted status even without the quoteTweet marker', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const body = mediaNode(article);
  const video = mediaNode(body);
  const quoteCard = mediaNode(body);
  const quotePhoto = mediaNode(mediaNode(quoteCard, { href: '/other/status/222/photo/1' }));
  article.querySelector = () => ({ closest() { return mediaNode(null, { href: '/main/status/111' }); } });
  article.querySelectorAll = () => [quotePhoto];

  const result = content.xShotVideoMediaSources(article, video, []);
  assert.equal(result.photoImages.length, 0);
  assert.deepEqual(Array.from(result.quoteCards), [quoteCard]);
});

test('quoted card below a video becomes the static footer boundary', () => {
  const content = loadContent();
  const article = { querySelectorAll() { return [replyAt(850)]; } };
  const quoteCard = { getBoundingClientRect() { return { top: 500 }; } };
  assert.equal(content.xShotVideoFooterTop(article, [quoteCard], 400, 0, 0), 500);
  assert.equal(content.xShotVideoFooterTop(article, [quoteCard], 600, 0, 0), 850);
});

test('an unmarked image without a main-post timestamp preserves the whole post layout', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const body = mediaNode(article);
  const video = mediaNode(body);
  const photo = mediaNode(mediaNode(body, { href: '/other/status/222/photo/1' }));
  article.querySelector = () => null;
  article.querySelectorAll = () => [photo];

  const result = content.xShotVideoMediaSources(article, video, []);
  assert.equal(result.preservePostLayout, true);
});

test('a second tweet text preserves the quoted card even when image links are ambiguous', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const video = mediaNode(article);
  const photo = mediaNode(article);
  article.querySelector = () => ({ closest() { return mediaNode(null, { href: '/main/status/111' }); } });
  article.querySelectorAll = (selector) => selector === '[data-testid="tweetText"]' ? [{}, {}] : [photo];

  const result = content.xShotVideoMediaSources(article, video, []);
  assert.equal(result.preservePostLayout, true);
});

test('confirmed main-post photos keep the thumbnail composition', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const video = mediaNode(article);
  const photo = mediaNode(mediaNode(article, { href: '/main/status/111/photo/1' }));
  article.querySelector = () => ({ closest() { return mediaNode(null, { href: '/main/status/111' }); } });
  article.querySelectorAll = (selector) => selector === '[data-testid="tweetText"]' ? [{}] : [photo];

  const result = content.xShotVideoMediaSources(article, video, []);
  assert.equal(result.preservePostLayout, false);
  assert.deepEqual(Array.from(result.photoImages), [photo]);
});

test('a different quoted status link preserves its card even when photo links look like the main post', () => {
  const content = loadContent();
  const article = mediaNode(null);
  const video = mediaNode(article);
  const photo = mediaNode(mediaNode(article, { href: '/main/status/111/photo/1' }));
  const mainLink = mediaNode(article, { href: '/main/status/111' });
  const quoteLink = mediaNode(article, { href: '/other/status/222' });
  article.querySelector = () => ({ closest() { return mainLink; } });
  article.querySelectorAll = (selector) => {
    if (selector === '[data-testid="tweetText"]') return [{}];
    if (selector === 'a[href*="/status/"]') return [mainLink, quoteLink];
    return [photo];
  };

  const result = content.xShotVideoMediaSources(article, video, []);
  assert.equal(result.preservePostLayout, true);
});
