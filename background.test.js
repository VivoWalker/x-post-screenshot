const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createCaptureHarness({ height = 1800, quotaFailures = 0, captureError = null, hasVideo = false, videoPlayError = null } = {}) {
  let now = 10_000;
  let failuresLeft = quotaFailures;
  let lastCaptureAt = -Infinity;
  const captureTimes = [];
  const messages = [];
  const events = [];
  let downloaded = null;
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        events.push(message.type);
        if (message.type === 'X_SHOT_FINISH') return { ok: true, dataUrl: 'data:image/png;base64,AAAA' };
        if (message.type === 'X_SHOT_RECORD_BEGIN') return { ok: true, hasAudioTrack: true };
        if (message.type === 'X_SHOT_RECORD_FINISH') return { ok: true, dataUrl: 'data:video/mp4;base64,AAAA' };
        return { ok: true };
      }
    },
    offscreen: { async hasDocument() { return true; } },
    tabCapture: { async getMediaStreamId() { events.push('STREAM_ID'); return 'stream-id'; } },
    downloads: {
      onChanged: { addListener() {}, removeListener() {} },
      async download(options) { downloaded = options; events.push('DOWNLOAD'); return 7; },
      async search() { return [{ state: 'complete' }]; },
      async show() { events.push('SHOW_FILE'); }
    },
    tabs: {
      async sendMessage(_tabId, message) {
        messages.push(message.type);
        events.push(message.type);
        if (message.type === 'X_SHOT_PREPARE') {
          return { ok: true, hasVideo, capture: {
            left: 0, top: 0, width: 600, height,
            viewportWidth: 800, viewportHeight: 800, documentHeight: height
          } };
        }
        if (message.type === 'X_SHOT_SCROLL') {
          return { ok: true, scrollY: message.y, viewportWidth: 800, viewportHeight: 800 };
        }
        if (message.type === 'X_SHOT_VIDEO_PLAY' && videoPlayError) return { ok: false, error: videoPlayError };
        return { ok: true };
      },
      async captureVisibleTab() {
        captureTimes.push(now);
        if (captureError) throw captureError;
        if (failuresLeft-- > 0 || now - lastCaptureAt < 500) {
          throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
        }
        lastCaptureAt = now;
        return 'data:image/png;base64,AAAA';
      }
    }
  };
  const context = vm.createContext({
    chrome,
    Date: { now: () => now },
    setTimeout(callback, milliseconds) { if (milliseconds < 120000) { now += milliseconds; callback(); } return 1; },
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
  return { capture: () => context.captureSelection(1, 1, { ids: ['123'] }), captureTimes, messages, events, getDownloaded: () => downloaded };
}

test('long captures respect Chrome screenshot quota across every frame', async () => {
  const harness = createCaptureHarness();
  await harness.capture();
  assert.equal(harness.captureTimes.length, 3);
  assert.ok(harness.captureTimes[1] - harness.captureTimes[0] >= 500);
  assert.ok(harness.captureTimes[2] - harness.captureTimes[1] >= 500);
  assert.ok(harness.messages.includes('X_SHOT_COPY'));
});

test('a quota error from Chrome is retried after a cooldown', async () => {
  const harness = createCaptureHarness({ height: 400, quotaFailures: 1 });
  await harness.capture();
  assert.equal(harness.captureTimes.length, 2);
  assert.ok(harness.captureTimes[1] - harness.captureTimes[0] >= 500);
  assert.ok(harness.messages.includes('X_SHOT_COPY'));
});

test('separate captures started immediately also respect the quota', async () => {
  const harness = createCaptureHarness({ height: 400 });
  await harness.capture();
  await harness.capture();
  assert.equal(harness.captureTimes.length, 2);
  assert.ok(harness.captureTimes[1] - harness.captureTimes[0] >= 500);
});

test('persistent quota errors stop after bounded retries and restore the page', async () => {
  const harness = createCaptureHarness({ height: 400, quotaFailures: 3 });
  await assert.rejects(harness.capture(), /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
  assert.equal(harness.captureTimes.length, 3);
  assert.equal(harness.messages.at(-1), 'X_SHOT_RESTORE');
});

test('unrelated screenshot errors are not retried and the page is restored', async () => {
  const harness = createCaptureHarness({ height: 400, captureError: new Error('capture unavailable') });
  await assert.rejects(harness.capture(), /capture unavailable/);
  assert.equal(harness.captureTimes.length, 1);
  assert.equal(harness.messages.at(-1), 'X_SHOT_RESTORE');
});

test('video capture records after tab audio capture, downloads MP4, and does not copy PNG', async () => {
  const harness = createCaptureHarness({ height: 400, hasVideo: true });
  await harness.capture();
  assert.ok(harness.events.indexOf('STREAM_ID') < harness.events.indexOf('X_SHOT_VIDEO_PLAY'));
  assert.ok(harness.events.indexOf('X_SHOT_RECORD_BEGIN') < harness.events.indexOf('X_SHOT_VIDEO_PLAY'));
  assert.equal(harness.events.includes('X_SHOT_RECORD_SLIDES'), false);
  assert.ok(harness.events.indexOf('X_SHOT_VIDEO_STOP') < harness.events.indexOf('X_SHOT_RECORD_FINISH'));
  assert.ok(harness.events.indexOf('DOWNLOAD') < harness.events.indexOf('SHOW_FILE'));
  assert.equal(harness.getDownloaded().filename.startsWith('X-Post-Video/'), true);
  assert.equal(harness.messages.includes('X_SHOT_COPY'), false);
  assert.equal(harness.messages.at(-1), 'X_SHOT_RESTORE');
});

test('video playback failure aborts capture and restores the page', async () => {
  const harness = createCaptureHarness({ height: 400, hasVideo: true, videoPlayError: 'blocked' });
  await assert.rejects(harness.capture(), /blocked/);
  assert.ok(harness.events.includes('X_SHOT_RECORD_ABORT'));
  assert.equal(harness.messages.at(-1), 'X_SHOT_RESTORE');
  assert.equal(harness.getDownloaded(), null);
});
