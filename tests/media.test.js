const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
function context(extra = {}) {
  const messages = [];
  const ctx = vm.createContext({ messages, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { addEventListener() {} }, chrome: { runtime: { onMessage: { addListener() {} },
      sendMessage: async (m) => messages.push(m) } }, ...extra });
  for (const file of ["png-stitch.js", "offscreen.js"]) vm.runInContext(source(file), ctx);
  return ctx;
}

test("late image decode cannot allocate into a replacement stitch job", async () => {
  const ctx = context();
  await vm.runInContext(`(async () => {
    const s = new XShotPngStitcher();
    let decoded;
    s.loadImage = () => new Promise(r => { decoded = r; });
    s.begin({});
    const adding = s.addFrame("old", {});
    s.abort(); s.abort(); s.begin({});
    decoded({});
    await adding;
  })()`, ctx).then(() => assert.fail("accepted stale frame"), (e) => assert.match(e.message, /取消/));
});

test("size threshold requests one stop; oversized final flush cannot produce a download", () => {
  const ctx = context();
  vm.runInContext(`recording = { chunks: [], bytes: 0, recorder: {
    state: "recording", stop() { this.state = "inactive"; }
  } };
  appendChunk(recording, { size: 38_000_000 });
  appendChunk(recording, { size: 500 });
  appendChunk(recording, { size: 2_000_000 });`, ctx);
  assert.deepEqual(ctx.messages.map((m) => m.type), ["X_SHOT_RECORD_LIMIT", "X_SHOT_RECORD_ERROR"]);
  assert.equal(vm.runInContext("recording.chunks.length", ctx), 0);
});

test("encoder probe accepts delayed flush and rejects empty or failed encoders", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const mode of ["slow flush", "no data", "error", "hung"]) {
    const ctx = context({ MediaRecorder: class {
      state = "inactive";
      start() { this.state = "recording"; if (mode === "error") throw Error("encoder"); }
      stop() {
        this.state = "inactive";
        if (mode === "hung") return;
        setTimeout(() => { this.ondataavailable?.({ data: { size: mode === "no data" ? 0 : 9 } }); this.onstop?.(); }, 1300);
      }
    } });
    const result = vm.runInContext('probeMp4Encoding({ getVideoTracks: () => [] }, {}, () => {})', ctx);
    t.mock.timers.tick(2500);
    t.mock.timers.tick(1300);
    if (mode === "slow flush") await result;
    else {
      t.mock.timers.tick(5000);
      await assert.rejects(result, /encoder|未产生|停止/);
    }
  }
});

test("real profile selection falls back after failed probes and stops all tracks", async () => {
  const stopped = [];
  const optionsSeen = [];
  const track = (name) => ({ stop: () => stopped.push(name), addEventListener() {} });
  const audio = track("audio");
  const tab = track("tab");
  let profile = 0;
  const ctx = context({
    document: { createElement: (type) => type === "video" ? { play: async () => {} } : {
      getContext: () => ({ drawImage() {} }), captureStream: () => {
        const video = track(++profile);
        return { getVideoTracks: () => [video], getTracks: () => [video] };
      }
    } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [audio, tab], getAudioTracks: () => [audio] }) } },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks.slice(0, 1); } },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor(stream, opts) { this.opts = opts; this.state = "inactive"; optionsSeen.push(opts.videoBitsPerSecond); }
      addEventListener() {}
      start() {
        if (this.opts.videoBitsPerSecond > 4e6) throw Error("encoder");
        this.state = "recording";
        queueMicrotask(() => this.ondataavailable({ data: { size: 1 } }));
      }
      stop() { this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
    }
  });
  await vm.runInContext(`jobId = "j"; jobController = new AbortController(); videoBase = { width: 100, height: 100 };
    beginRecording({ capture: { width: 100, height: 100 }, layout: { preservePostLayout: true,
      documentVideoRect: { left: 0, top: 0, width: 80, height: 80 } } })`, ctx);
  vm.runInContext("abortRecording(); abortRecording()", ctx);
  assert.deepEqual(optionsSeen, [8e6, 8e6, 4e6, 4e6]);
  assert.deepEqual(stopped, [1, 2, "audio", "tab"]);
});

test("Firefox package is self-contained and both manifests reference shipped files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-shot-build-"));
  try {
    execFileSync(process.execPath, [path.join(root, "build-firefox.js"), dir]);
    for (const [where, manifest] of [[dir, "manifest.firefox.json"], [root, "manifest.json"]]) {
      const config = JSON.parse(source(manifest));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(where, "manifest.json"))), config);
      const files = [...(config.background.scripts || [config.background.service_worker]), config.options_ui.page,
        ...config.content_scripts.flatMap((c) => [...c.js, ...c.css])];
      for (const file of files) assert.equal(fs.readFileSync(path.join(where, file), "utf8"), source(file));
      assert.equal(config.manifest_version, 3);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ["capture-controller.js", "content.css", "content.js", "firefox-background.js",
      "manifest.json", "options.css", "options.html", "options.js", "png-stitch.js"]);
    assert.ok(!/chrome\.(offscreen|tabCapture|downloads)/.test(source("firefox-background.js") + source("capture-controller.js")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("recorder duration deadline stops at 30 seconds even without page acknowledgement", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const ctx = context();
  vm.runInContext(`recording = {
    layout: {}, calibration: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, width: 40, height: 40 },
    composition: { preservePostLayout: true, width: 40, height: 40, video: {x:0, y:0, width:40, height:40} },
    context: {fillRect() {}, drawImage() {}}, base: {width:40,height:40},
    tabVideo: { readyState: 4, videoWidth: 40, videoHeight: 40 },
    recorder: { state: 'inactive', start() { this.state='recording' }, stop() { this.state='inactive' } }
  };
  startRecording({left:0,top:0,width:40,height:40});`, ctx);
  t.mock.timers.tick(29999);
  assert.equal(vm.runInContext("recording.recorder.state", ctx), "recording");
  t.mock.timers.tick(1);
  assert.equal(vm.runInContext("recording.timeLimit", ctx), true);
  assert.equal(ctx.messages.at(-1).type, "X_SHOT_RECORD_LIMIT");
});

test("changed calibrated stream dimensions signal an immediate error", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const ctx = context();
  vm.runInContext(`recording = {
    layout: {}, calibration: { scaleX:1,scaleY:1,offsetX:0,offsetY:0,width:40,height:40 },
    composition: { preservePostLayout:true,width:40,height:40,video:{x:0,y:0,width:40,height:40} },
    context: {fillRect() {},drawImage() {}}, base:{width:40,height:40},
    tabVideo: {readyState:4,videoWidth:40,videoHeight:40},
    recorder: {state:'inactive',start(){this.state='recording'},stop(){this.state='inactive'}}
  };
  startRecording({left:0,top:0,width:40,height:40});
  recording.tabVideo.videoHeight=60`, ctx);
  t.mock.timers.tick(100);
  assert.equal(ctx.messages.at(-1).type, "X_SHOT_RECORD_ERROR");
  assert.match(ctx.messages.at(-1).error, /尺寸/);
});

test("PNG encoder failure frees the canvas even before the caller retries", () => {
  const ctx = context();
  vm.runInContext(`pngStitcher.begin({});
    globalThis.canvas = { width: 300, height: 200, toDataURL: () => "data:," };
    pngStitcher.job.canvas = canvas;`, ctx);
  assert.throws(() => vm.runInContext("pngStitcher.finish()", ctx), /PNG/);
  assert.equal(ctx.canvas.width, 0);
  assert.equal(vm.runInContext("pngStitcher.job", ctx), null);
});
