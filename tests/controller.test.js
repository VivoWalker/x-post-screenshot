const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
function event() {
  const listeners = new Set();
  return { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f),
    fire(...args) { for (const f of listeners) f(...args); }, listeners };
}

function fixture() {
  const capture = { top: 0, left: 0, width: 100, height: 240, viewportHeight: 120,
    viewportWidth: 200, documentHeight: 240, scrollY: 0 };
  const trace = [];
  const chrome = {
    windows: { onFocusChanged: event(), onRemoved: event(), get: async () => ({ focused: true }) },
    action: { onClicked: event() }, commands: { onCommand: event() },
    tabs: { onActivated: event(), onRemoved: event(), onUpdated: event(), onDetached: event(),
      query: async () => [{ id: 3 }],
      captureVisibleTab: async () => "frame",
      sendMessage: async (id, message) => {
        assert.equal(id, 3);
        trace.push(message);
        if (message.type === "X_SHOT_PREPARE") return { ok: true, capture };
        if (message.type === "X_SHOT_SCROLL") return { ok: true, viewportWidth: 200, viewportHeight: 120, scrollY: message.y };
        return { ok: true };
      } },
    offscreen: {
      createDocument: async () => { chrome.offscreen.open = true; },
      closeDocument: async () => { chrome.offscreen.open = false; } },
    runtime: { onMessage: event(), getContexts: async () => chrome.offscreen.open ? [{}] : [], getURL: (name) => 'chrome-extension://test/' + name,
      sendMessage: async (message) => { trace.push(message); return { ok: true, dataUrl: "png" }; } }
  };
  const context = vm.createContext({ chrome, AbortController, setTimeout, clearTimeout,
    importScripts: (name) => vm.runInContext(source(name), context) });
  vm.runInContext(source("background.js"), context);
  const send = (type, jobId = "one", fields = {}, sender = { tab: { id: 3, windowId: 8 } }) =>
    new Promise((resolve) => chrome.runtime.onMessage.fire({ type, jobId, ...fields }, sender, resolve));
  return { chrome, trace, context, send, start: (jobId) => send("X_SHOT_SELECTION", jobId, { selection: {} }) };
}

test("frame boundaries are contiguous and page is restored after repeated captures", async () => {
  const f = fixture();
  for (const id of ["first", "second"]) {
    assert.equal((await f.start(id)).ok, true);
    const frames = f.trace.filter((m) => m.jobId === id && m.type === "X_SHOT_FRAME");
    assert.deepEqual(frames.map((m) => [m.frame.contentTop, m.frame.contentBottom]), [[0, 120], [120, 222], [222, 240]]);
    assert.equal(f.chrome.offscreen.open, false);
    assert.equal(f.trace.at(-1).type, "X_SHOT_RESTORE");
  }
});

for (const [name, invalidate] of Object.entries({
  "switch away and back": (f) => { for (const tabId of [4, 3]) f.chrome.tabs.onActivated.fire({ tabId, windowId: 8 }); },
  "navigation": (f) => f.chrome.tabs.onUpdated.fire(3, { status: "loading" }),
  "tab removal": (f) => f.chrome.tabs.onRemoved.fire(3),
  "window focus loss": (f) => f.chrome.windows.onFocusChanged.fire(-1),
  "tab moved": (f) => f.chrome.tabs.onDetached.fire(3),
  "window removed": (f) => f.chrome.windows.onRemoved.fire(8),
  "Escape": (f) => f.send("X_SHOT_CANCEL"),
  "query sees another active tab": (f) => { f.chrome.tabs.query = async () => [{ id: 5 }]; }
})) {
  test(name + " during capture discards the pending frame", async () => {
    const f = fixture();
    f.chrome.tabs.captureVisibleTab = async () => { invalidate(f); return "wrong"; };
    assert.equal((await f.start()).ok, false);
    assert.ok(!f.trace.some((m) => ["X_SHOT_FRAME", "X_SHOT_COPY"].includes(m.type)));
    assert.equal(f.trace.at(-1).type, "X_SHOT_RESTORE");
    assert.equal(f.chrome.offscreen.open, false);
  });
}

test("Escape after first frame cancels a multi-frame capture; stale cancel cannot affect retry", async () => {
  const f = fixture();
  const send = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = async (m) => {
    const result = await send(m);
    if (m.type === "X_SHOT_FRAME" && m.jobId === "one") f.send("X_SHOT_CANCEL");
    if (m.jobId === "two") void f.send("X_SHOT_CANCEL", "one");
    return result;
  };
  assert.equal((await f.start()).ok, false);
  assert.equal(f.trace.filter((m) => m.type === "X_SHOT_FRAME").length, 1);
  assert.equal((await f.start("two")).ok, true);
});

test("stitch failure releases offscreen owner and does not copy", async () => {
  const f = fixture();
  const send = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = (m) => m.type === "X_SHOT_FRAME" ? { ok: false, error: "decode" } : send(m);
  assert.equal((await f.start()).error, "decode");
  assert.equal(f.chrome.offscreen.open, false);
  assert.ok(!f.trace.some((m) => m.type === "X_SHOT_COPY"));
  f.chrome.runtime.sendMessage = send;
  assert.equal((await f.start("retry")).ok, true);
});

test("encoder failure interrupts pending playback and restores the tab", async () => {
  const f = fixture();
  const send = f.chrome.tabs.sendMessage;
  f.chrome.tabCapture = { getMediaStreamId: async () => "stream" };
  f.chrome.tabs.sendMessage = async (id, m) => {
    const result = await send(id, m);
    if (m.type === "X_SHOT_PREPARE") { result.hasVideo = true; result.capture.height = 90; }
    if (m.type === "X_SHOT_VIDEO_WAIT") {
      f.chrome.runtime.onMessage.fire({ type: "X_SHOT_RECORD_ERROR", jobId: m.jobId, error: "encoder failed" },
        { url: f.chrome.runtime.getURL("offscreen.html") }, () => {});
      return new Promise(() => {});
    }
    return result;
  };
  assert.equal((await f.start()).error, "encoder failed");
  assert.equal(f.trace.at(-1).type, "X_SHOT_RESTORE");
  assert.equal(f.chrome.offscreen.open, false);
});

test("download completion and interruption both remove listeners", async () => {
  const f = fixture();
  const changed = event();
  f.chrome.downloads = { onChanged: changed, search: async () => [{ state: "in_progress" }] };
  for (const state of ["complete", "interrupted"]) {
    const waiting = vm.runInContext("waitForDownload(42)", f.context);
    changed.fire({ id: 42, state: { current: state } });
    if (state === "complete") await waiting;
    else await assert.rejects(waiting, /中断/);
    assert.equal(changed.listeners.size, 0);
  }
});

for (const mode of ["native", "unavailable", "rejected"]) {
  test("Firefox static video PNG clipboard path: " + mode, async () => {
    const messages = [];
    const files = [];
    const success = [];
    const ctx = vm.createContext({
      browser: mode === "unavailable" ? {} : { clipboard: {
        async setImageData(buffer, format) {
          assert.equal(format, "png");
          assert.equal(buffer.byteLength, 1);
          if (mode === "rejected") throw Error("unavailable");
          files.push(format);
        }
      } },
      fetch, XShotPngStitcher: class {
        begin() {} finish() { return { dataUrl: "data:image/png;base64,AA==" }; } abort() {}
      },
      captureFrames: async () => {}, ensureSelectedTab: async () => {},
      notify: (id, kind, text) => success.push(text),
      installCaptureController: (f) => { ctx.run = f; }
    });
    vm.runInContext(source("firefox-background.js"), ctx);
    await ctx.run({ tabId: 3, step: (f) => f(), page: (type, fields) => {
      messages.push(type);
      if (type === "X_SHOT_PREPARE") {
        assert.equal(fields.stillOnly, true);
        return { ok: true, hasVideo: true, capture: {} };
      }
      return { ok: true };
    } }, {});
    assert.equal(files.length, mode === "native" ? 1 : 0);
    assert.equal(messages.includes("X_SHOT_COPY"), mode !== "native");
    assert.match(success[0], /静态/);
  });
}
