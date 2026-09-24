const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createCaptureHarness({ height = 1800, quotaFailures = 0, captureError = null } = {}) {
  let now = 10_000;
  let failuresLeft = quotaFailures;
  let lastCaptureAt = -Infinity;
  const captureTimes = [];
  const messages = [];
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (message.type === 'X_SHOT_FINISH') return { ok: true, dataUrl: 'data:image/png;base64,AAAA' };
        return { ok: true };
      }
    },
    offscreen: { async hasDocument() { return true; } },
    tabs: {
      async sendMessage(_tabId, message) {
        messages.push(message.type);
        if (message.type === 'X_SHOT_PREPARE') {
          return { ok: true, capture: {
            left: 0, top: 0, width: 600, height,
            viewportWidth: 800, viewportHeight: 800, documentHeight: height
          } };
        }
        if (message.type === 'X_SHOT_SCROLL') {
          return { ok: true, scrollY: message.y, viewportWidth: 800, viewportHeight: 800 };
        }
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
    setTimeout(callback, milliseconds) { now += milliseconds; callback(); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
  return { capture: () => context.captureSelection(1, 1, { ids: ['123'] }), captureTimes, messages };
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
