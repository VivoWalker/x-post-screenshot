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
    liveCrop: { x: 100, y: 100, width: 500, height: 250 },
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

test('uncertain image ownership records over the complete original post layout', () => {
  const context = loadOffscreen();
  const capture = { width: 600, height: 1000 };
  const layout = {
    preservePostLayout: true,
    backgroundColor: '#000',
    documentVideoRect: { left: 100, top: 200, width: 400, height: 250 },
    videoRect: { width: 400, height: 250 },
    mediaTop: 200,
    footerTop: 850,
    photoRects: [{ left: 100, top: 600, width: 150, height: 200 }]
  };
  const draws = [];
  const base = { tag: 'still', naturalWidth: 300, naturalHeight: 500 };
  const live = { tag: 'live-video', readyState: 2, videoWidth: 800, videoHeight: 600 };
  const composition = context.createVideoComposition(capture, layout, { width: 720, height: 1280 }, 300);
  context.fixture = {
    base, capture, layout, composition, tabVideo: live,
    liveCrop: { x: 150, y: 100, width: 400, height: 250 },
    context: {
      fillRect() {},
      drawImage(...args) { draws.push({ source: args[0].tag, x: args[5], y: args[6], width: args[7], height: args[8] }); }
    }
  };
  vm.runInContext('recording = fixture; drawRecordingFrame()', context);

  assert.deepEqual([composition.width, composition.height], [300, 500]);
  assert.deepEqual(draws, [
    { source: 'still', x: 0, y: 0, width: 300, height: 500 },
    { source: 'live-video', x: 50, y: 100, width: 200, height: 125 }
  ]);
});

test('calibrated live crop excludes text and controls when the tab stream has margins', () => {
  const context = loadOffscreen();
  const width = 1000;
  const height = 700;
  const pixels = new Uint8ClampedArray(width * height * 4);
  function marker(x, y, color) {
    for (let py = y; py < y + 24; py += 1) {
      for (let px = x; px < x + 24; px += 1) {
        const offset = (py * width + px) * 4;
        pixels.set([...color, 255], offset);
      }
    }
  }
  // CSS viewport 800 x 600 maps to pixels x = 100 + cssX, y = 50 + cssY.
  marker(108, 58, [255, 0, 255]);
  marker(868, 618, [0, 255, 255]);
  const calibration = context.calibrateTabStream({ data: pixels, width, height }, {
    first: { x: 20, y: 20 }, second: { x: 780, y: 580 }
  });
  const crop = context.mapVideoRectToStream(
    { left: 200, top: 150, width: 300, height: 250 }, calibration
  );
  assert.deepEqual(JSON.parse(JSON.stringify(crop)), { x: 300, y: 200, width: 300, height: 250 });
});

test('calibration rejects a stream without both visible markers', () => {
  const context = loadOffscreen();
  const pixels = new Uint8ClampedArray(100 * 100 * 4);
  assert.throws(() => context.calibrateTabStream({ data: pixels, width: 100, height: 100 }, {
    first: { x: 16, y: 16 }, second: { x: 84, y: 84 }
  }), /校准/);
});

test('calibration rejects similarly colored page pixels outside the markers', () => {
  const context = loadOffscreen();
  const width = 800;
  const height = 600;
  const pixels = new Uint8ClampedArray(width * height * 4);
  function marker(x, y, size, color) {
    for (let py = y; py < y + size; py += 1) {
      for (let px = x; px < x + size; px += 1) pixels.set([...color, 255], (py * width + px) * 4);
    }
  }
  marker(8, 8, 24, [255, 0, 255]);
  marker(768, 568, 24, [0, 255, 255]);
  marker(160, 120, 8, [255, 0, 255]);
  assert.throws(() => context.calibrateTabStream({ data: pixels, width, height }, {
    first: { x: 20, y: 20 }, second: { x: 780, y: 580 }
  }), /校准/);
});

test('calibration rejects a substantially covered marker', () => {
  const context = loadOffscreen();
  const width = 800;
  const height = 600;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < 32; y += 1) {
    for (let x = 8; x < 20; x += 1) pixels.set([255, 0, 255, 255], (y * width + x) * 4);
  }
  for (let y = 568; y < 592; y += 1) {
    for (let x = 768; x < 792; x += 1) pixels.set([0, 255, 255, 255], (y * width + x) * 4);
  }
  assert.throws(() => context.calibrateTabStream({ data: pixels, width, height }, {
    first: { x: 20, y: 20 }, second: { x: 780, y: 580 }
  }), /校准/);
});

test('calibrated crop rejects invalid video geometry instead of drawing outside the stream', () => {
  const context = loadOffscreen();
  const calibration = { scaleX: 1, scaleY: 1, offsetX: 100, offsetY: 50, width: 1000, height: 700 };
  assert.throws(() => context.mapVideoRectToStream({ left: 200, top: 150, width: NaN, height: 250 }, calibration), /录屏区域/);
});

test('recording stops if tab stream dimensions change after calibration', () => {
  const context = loadOffscreen();
  let stops = 0;
  context.fixture = {
    tabVideo: { readyState: 2, videoWidth: 1200, videoHeight: 700 },
    calibration: { width: 1000, height: 700 },
    recorder: { state: 'recording', stop() { stops += 1; } },
    context: { fillRect() {}, drawImage() {} },
    capture: { width: 600, height: 900 },
    layout: { backgroundColor: '#000' },
    liveCrop: { x: 0, y: 0, width: 100, height: 100 },
    composition: { width: 600, height: 900, top: { height: 0 }, video: { x: 0, y: 0, width: 600, height: 900 }, thumbnails: [], footer: { height: 0 } }
  };
  vm.runInContext('recording = fixture; drawRecordingFrame()', context);
  assert.match(context.fixture.error.message, /录屏尺寸/);
  assert.equal(stops, 1);
});

test('composition keeps half-resolution screenshot pixels instead of dropping to CSS pixels', () => {
  const context = loadOffscreen();
  const composition = context.createVideoComposition(
    { width: 600, height: 1000 },
    { mediaTop: 200, footerTop: 800, videoRect: { width: 500, height: 250 }, photoRects: [] },
    { width: 1440, height: 2560 },
    1200
  );
  assert.equal(composition.width, 1200);
  assert.equal(composition.video.width, 1200);
  assert.equal(composition.height, 1400);
});

test('video still is halved from stitched screenshot with safe side caps', async () => {
  const context = loadOffscreen();
  const canvas = { width: 2400, height: 3600, toDataURL() { return 'data:image/png;base64,AAAA'; } };
  let reduced;
  context.document = {
    createElement() {
      reduced = { width: 0, height: 0, getContext() { return { drawImage() {} }; }, toDataURL() { return 'data:image/png;base64,BBBB'; } };
      return reduced;
    }
  };
  context.fixture = { canvas, outputScale: 1, sourceScale: 1 };
  vm.runInContext('job = fixture', context);
  const result = await context.finish(true);
  assert.equal(result.width, 1200);
  assert.equal(result.height, 1800);
});

function createRecordingHarness() {
  const context = loadOffscreen();
  const audioTrack = { stop() {} };
  const tabVideoTrack = { stop() {} };
  const canvasVideoTrack = { stop() {} };
  let recorder;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) { this.options = options; this.state = 'inactive'; this.stopCalls = 0; this.listeners = {}; recorder = this; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener(event); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.stopCalls += 1; }
  }
  context.MediaRecorder = FakeRecorder;
  context.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
  context.navigator = { mediaDevices: { async getUserMedia() {
    return { getAudioTracks: () => [audioTrack], getTracks: () => [audioTrack, tabVideoTrack] };
  } } };
  const markerPixels = new Uint8ClampedArray(800 * 600 * 4);
  for (const [x0, y0, color] of [[8, 8, [255, 0, 255]], [768, 568, [0, 255, 255]]]) {
    for (let y = y0; y < y0 + 24; y += 1) {
      for (let x = x0; x < x0 + 24; x += 1) markerPixels.set([...color, 255], (y * 800 + x) * 4);
    }
  }
  context.document = { createElement(type) {
    if (type === 'video') return { readyState: 2, videoWidth: 800, videoHeight: 600, async play() {} };
    return {
      width: 0,
      height: 0,
      getContext() { return { fillRect() {}, drawImage() {}, getImageData() { return { data: markerPixels, width: 800, height: 600 }; } }; },
      captureStream() { return { getVideoTracks: () => [canvasVideoTrack], getTracks: () => [canvasVideoTrack] }; }
    };
  } };
  context.setInterval = () => 1;
  context.clearInterval = () => {};
  context.fixtureImage = { naturalWidth: 1200, naturalHeight: 2000 };
  vm.runInContext('loadImage = async () => fixtureImage', context);
  const layout = {
    mediaTop: 200,
    footerTop: 800,
    viewport: { width: 800, height: 600 },
    videoRect: { left: 100, top: 100, width: 500, height: 250 },
    documentVideoRect: { left: 0, top: 200, width: 500, height: 250 },
    photoRects: []
  };
  return {
    context,
    start: () => context.beginRecording({ streamId: 'test-stream', still: 'data:image/png;base64,AAAA', capture: { width: 600, height: 1000 }, layout }),
    recorder: () => recorder
  };
}

test('recorder requests about 8000 kbps for the MP4 video track', async () => {
  const harness = createRecordingHarness();
  await harness.start();
  assert.equal(harness.recorder().options.videoBitsPerSecond, 8_000_000);
  harness.context.abortRecording();
});

test('recording waits for post-capture marker calibration before it starts', async () => {
  const harness = createRecordingHarness();
  await harness.start();
  assert.throws(() => harness.context.startRecording({ left: 100, top: 100, width: 500, height: 250 }), /校准/);
  await harness.context.calibrateRecording({ first: { x: 20, y: 20 }, second: { x: 780, y: 580 } });
  assert.equal(harness.context.startRecording({ left: 100, top: 100, width: 500, height: 250 }).ok, true);
  harness.context.abortRecording();
});

test('recording continues below 40 MB and stops after crossing that cap', async () => {
  const harness = createRecordingHarness();
  await harness.start();
  await harness.context.calibrateRecording({ first: { x: 20, y: 20 }, second: { x: 780, y: 580 } });
  harness.context.startRecording({ left: 100, top: 100, width: 500, height: 250 });
  const recorder = harness.recorder();
  recorder.ondataavailable({ data: { size: 35_000_000 } });
  assert.equal(recorder.stopCalls, 0);
  recorder.ondataavailable({ data: { size: 6_000_000 } });
  assert.equal(recorder.stopCalls, 1);
  harness.context.abortRecording();
});

test('size-limited MP4 waits for the final data chunk after recorder becomes inactive', async () => {
  const harness = createRecordingHarness();
  harness.context.Blob = class {
    constructor(chunks) { this.size = chunks.reduce((sum, chunk) => sum + chunk.size, 0); }
  };
  harness.context.FileReader = class {
    readAsDataURL() { this.result = 'data:video/mp4;base64,AAAA'; this.onload(); }
  };
  await harness.start();
  await harness.context.calibrateRecording({ first: { x: 20, y: 20 }, second: { x: 780, y: 580 } });
  harness.context.startRecording({ left: 100, top: 100, width: 500, height: 250 });
  const recorder = harness.recorder();
  recorder.stop = () => {
    recorder.state = 'inactive';
    recorder.stopCalls += 1;
    queueMicrotask(() => {
      recorder.ondataavailable({ data: { size: 1_000_000 } });
      recorder.dispatch('stop');
    });
  };
  recorder.ondataavailable({ data: { size: 41_000_000 } });
  const result = await harness.context.finishRecording();
  assert.equal(result.bytes, 42_000_000);
});
