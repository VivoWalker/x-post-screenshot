const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadOffscreen() {
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'offscreen.js'), 'utf8'), context);
  return context;
}

test('video composition places full-width video between text and image thumbnails', () => {
  const context = loadOffscreen();
  const create = context.createVideoComposition;
  assert.equal(typeof create, 'function');
  const composition = create(
    { width: 600, height: 1000 },
    {
      mediaTop: 200,
      footerTop: 800,
      videoRect: { width: 500, height: 250 },
      photoRects: [{ left: 0, top: 500, width: 250, height: 200 }, { left: 300, top: 500, width: 250, height: 200 }]
    },
    { width: 720, height: 1280 }
  );
  assert.deepEqual(JSON.parse(JSON.stringify({
    width: composition.width,
    height: composition.height,
    textBottom: composition.top.y + composition.top.height,
    video: composition.video,
    thumbnails: composition.thumbnails.map(({ x, y, width, height }) => ({ x, y, width, height })),
    footerTop: composition.footer.y
  })), {
    width: 600,
    height: 832,
    textBottom: 200,
    video: { x: 0, y: 200, width: 600, height: 300 },
    thumbnails: [
      { x: 0, y: 500, width: 298, height: 132 },
      { x: 302, y: 500, width: 298, height: 132 }
    ],
    footerTop: 632
  });
});

test('video composition stays within output limits even with long text and tall video', () => {
  const context = loadOffscreen();
  const create = context.createVideoComposition;
  assert.equal(typeof create, 'function');
  const composition = create(
    { width: 600, height: 3000 },
    {
      mediaTop: 1400,
      footerTop: 2900,
      videoRect: { width: 400, height: 700 },
      photoRects: Array.from({ length: 4 }, () => ({ left: 0, top: 2200, width: 200, height: 200 }))
    },
    { width: 720, height: 1280 }
  );
  assert.ok(composition.width <= 720);
  assert.ok(composition.height <= 1280);
  assert.equal(composition.video.width, composition.width);
  assert.ok(composition.thumbnails[0].y >= composition.video.y + composition.video.height);
  assert.ok(composition.footer.y >= composition.thumbnails.at(-1).y + composition.thumbnails.at(-1).height);
  assert.ok(composition.footer.y <= composition.height);
  assert.equal(composition.footer.y + composition.footer.height, composition.height);
});

test('video and thumbnails align to the tweet text column instead of the avatar gutter', () => {
  const context = loadOffscreen();
  const composition = context.createVideoComposition(
    { width: 600, height: 1000 },
    {
      mediaTop: 200,
      footerTop: 800,
      contentArea: { left: 60, width: 500 },
      videoRect: { width: 400, height: 200 },
      photoRects: [{ left: 60, top: 500, width: 200, height: 160 }, { left: 310, top: 500, width: 200, height: 160 }]
    },
    { width: 720, height: 1280 }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(composition.video)), { x: 60, y: 200, width: 500, height: 250 });
  assert.deepEqual(composition.thumbnails.map(({ x, width }) => [x, width]), [[60, 248], [312, 248]]);
});

test('recorded frame draws text, moving video, thumbnails, then interactions', () => {
  const context = loadOffscreen();
  const capture = { width: 600, height: 1000 };
  const layout = {
    mediaTop: 200,
    footerTop: 800,
    backgroundColor: '#000',
    viewport: { width: 800, height: 600 },
    videoRect: { left: 100, top: 100, width: 500, height: 250 },
    documentVideoRect: { left: 0, top: 200, width: 500, height: 250 },
    photoRects: [{ left: 0, top: 500, width: 250, height: 200 }, { left: 300, top: 500, width: 250, height: 200 }]
  };
  const draws = [];
  const base = { tag: 'still', naturalWidth: 600, naturalHeight: 1000 };
  const live = { tag: 'live-video', readyState: 2, videoWidth: 800, videoHeight: 600 };
  context.fixture = {
    base,
    capture,
    layout,
    composition: context.createVideoComposition(capture, layout, { width: 720, height: 1280 }),
    tabVideo: live,
    context: {
      fillRect() {},
      drawImage(...args) { draws.push({ source: args[0].tag, x: args[5], y: args[6], width: args[7], height: args[8] }); }
    }
  };
  vm.runInContext('recording = fixture; drawRecordingFrame()', context);
  assert.deepEqual(draws.map(({ source }) => source), ['still', 'live-video', 'still', 'still', 'still']);
  assert.deepEqual(draws[1], { source: 'live-video', x: 0, y: 200, width: 600, height: 300 });
  assert.deepEqual(draws.slice(2, 4).map(({ y }) => y), [500, 500]);
  assert.equal(draws[4].y, 632);
});
