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
