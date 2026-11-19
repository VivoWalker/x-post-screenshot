"""Run with Python Playwright and an installed Chromium (CHROMIUM may specify its path)."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE = """<meta charset="utf-8"><style>article{width:300px;min-height:140px}
body{min-height:2000px}img{width:30px;height:30px}</style>
<main data-testid="primaryColumn"><article id="parent"><a href="/a/status/1"><time>1</time></a></article>
<article id="reply"><div data-testid="quoteTweet"><a href="/q/status/55"><time>quote</time></a></div>
<a href="/b/status/2"><time>2</time></a><a href="/b/status/2/photo/1">photo</a></article></main>"""


class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=os.getenv("CHROMIUM") or shutil.which("chromium"),
            args=["--autoplay-policy=no-user-gesture-required"])
        print("Chromium", cls.browser.version, flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.ctx = self.browser.new_context()
        self.page = self.ctx.new_page()
        self.page.route("https://x.com/**", lambda r: r.fulfill(content_type="text/html", body=PAGE))
        self.page.goto("https://x.com/b/status/2")
        self.page.evaluate("""() => {
          window.chrome = {runtime: {
            onMessage: {addListener(f) { window.respond = m => new Promise(r => f(m, {}, r)); }},
            sendMessage(m) {
              if (m.type === 'X_SHOT_SELECTION') {
                window.selection = m;
                return new Promise(r => { window.complete = r; });
              }
              return Promise.resolve({alive: true});
            }
          }};
          window.request = (type, extra = {}) => respond({type, jobId: selection.jobId, ...extra});
        }""")

    def tearDown(self):
        self.ctx.close()

    def script(self, name):
        self.page.add_script_tag(path=str(ROOT / name))

    def select(self):
        self.script("content.js")
        self.page.evaluate("respond({type:'X_SHOT_ENTER'})")
        self.page.locator("#reply").hover()
        self.page.locator("#reply").click()
        self.assertEqual(self.page.evaluate("selection.selection.ids"), ["1", "2"])

    def test_hover_across_cells_and_replaced_article(self):
        self.page.add_style_tag(path=str(ROOT / "content.css"))
        self.page.evaluate("""() => {
          const cell=document.createElement('div'); cell.dataset.testid='cellInnerDiv';
          cell.style.position='relative'; reply.before(cell); cell.append(reply);
          const hit=document.createElement('div'); hit.id='hit';
          hit.style='position:absolute;inset:0'; cell.append(hit);
        }""")
        self.script("content.js")
        self.page.evaluate("respond({type:'X_SHOT_ENTER'})")
        self.page.locator("#parent").hover()
        self.page.locator("#hit").hover(position={"x": 80, "y": 50})
        self.page.wait_for_function("""() => {
          const mark=document.querySelector('.x-shot-hover-box') || document.querySelector('.x-shot-hovered');
          return mark && !mark.hidden && mark.getBoundingClientRect().top === reply.getBoundingClientRect().top;
        }""", timeout=1200)
        self.page.evaluate("reply.replaceWith(reply.cloneNode(true)); reply.style.marginTop='8px'")
        self.page.wait_for_function("""() => document.querySelector('.x-shot-hover-box')?.getBoundingClientRect().top
          === reply.getBoundingClientRect().top""")
        self.page.keyboard.press("Escape")
        self.assertEqual(self.page.locator(".x-shot-selection-box").count(), 0)

    def test_multi_capture_only_picked_posts(self):
        self.page.set_viewport_size({"width": 800, "height": 420})
        self.page.add_style_tag(path=str(ROOT / "content.css"))
        self.page.evaluate("""() => {
          const first=document.querySelector('#parent');
          first.style='background:red;height:600px';
          reply.style='background:blue;height:300px';
          const last=document.createElement('article');
          last.id='last'; last.style='background:lime;width:200px;margin-left:30px';
          last.innerHTML='<a href="/c/status/3"><time>3</time></a><video width="10" height="10"></video>';
          reply.after(last);
        }""")
        for script in ["content.js", "capture-controller.js", "png-stitch.js"]:
            self.script(script)
        self.page.evaluate("respond({type:'X_SHOT_ENTER'})")
        self.page.locator("#last").click(modifiers=["Shift"])
        self.page.locator("#reply").click()
        self.page.locator("#reply").click()
        self.page.locator("#parent").click()
        self.page.evaluate("last.replaceWith(last.cloneNode(true))")
        self.page.keyboard.press("Enter")
        self.assertEqual(self.page.evaluate("selection.selection.ids"), ["1", "3"])
        self.assertEqual(self.page.locator(".x-shot-selection-box").count(), 0)
        self.page.evaluate("""() => { window.captureResult=(async () => {
          const initial=scrollY;
          chrome.tabs={query:async()=>[{id:1}],sendMessage:async()=>({ok:true}),
            captureVisibleTab:()=>new Promise(resolve=>{window.nextFrame=resolve;})};
          const job={tabId:1,windowId:1,controller:new AbortController(),step:f=>f(),
            page:async(type,fields)=>requireSuccess(await request(type,fields))};
          const prepared=await job.page('X_SHOT_PREPARE',{selection:selection.selection});
          const stitch=new XShotPngStitcher();
          stitch.begin(prepared.capture);
          await captureFrames(job,prepared.capture,(url,frame)=>stitch.addFrame(url,frame));
          const pixels=stitch.job.context;
          const rgb=(x,y)=>Array.from(pixels.getImageData(x,y,1,1).data).slice(0,3);
          const colors=[rgb(120,599),rgb(120,600),rgb(120,739),rgb(250,680)];
          const png=stitch.finish();
          await job.page('X_SHOT_RESTORE');
          return [prepared.hasVideo,png.width,png.height,colors,initial===scrollY];
        })().finally(()=>{window.finished=true;}); }""")
        while True:
            self.page.wait_for_function("window.finished || !!window.nextFrame", timeout=5000)
            if self.page.evaluate("Boolean(window.finished)"):
                break
            frame = "data:image/png;base64," + base64.b64encode(self.page.screenshot()).decode()
            self.page.evaluate("url => { nextFrame(url); window.nextFrame=null; }", frame)
        result = self.page.evaluate("captureResult")
        self.assertEqual(result, [False, 300, 740,
                         [[255, 0, 0], [0, 255, 0], [0, 255, 0], [255, 255, 255]], True])

    def test_empty_multiselect_and_cancel(self):
        self.page.add_style_tag(path=str(ROOT / "content.css"))
        self.script("content.js")
        self.page.evaluate("respond({type:'X_SHOT_ENTER'})")
        self.page.locator("#reply").click(modifiers=["Shift"])
        self.page.locator("#reply").click()
        self.page.keyboard.press("Enter")
        self.assertTrue(self.page.evaluate("document.documentElement.classList.contains('x-shot-selecting')"))
        self.page.keyboard.press("Escape")
        self.assertEqual(self.page.locator(".x-shot-selection-box, .x-shot-selecting").count(), 0)
        self.assertTrue(self.page.evaluate("window.selection === undefined"))

    def test_conversation_gallery_and_restore(self):
        self.page.add_style_tag(path=str(ROOT / "content.css"))
        self.page.evaluate("""() => {
          let scroller = document.createElement('div');
          scroller.id = 'carousel';
          scroller.style = 'width:100px;display:flex;overflow-x:auto';
          for(let i=0;i<3;i++){
            const a = document.createElement('a');
            a.style = 'min-width:100px'; a.href='/b/status/2/photo/'+(i+1);
            const img = document.createElement('img');
            img.src='data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+(30+i)+'" height="20"/>');
            a.append(img); scroller.append(a);
          }
          reply.append(scroller);
          scroller.scrollLeft=50;
        }""")
        self.select()
        result = self.page.evaluate("request('X_SHOT_PREPARE',{selection:selection.selection,stillOnly:true})")
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.page.locator(".x-shot-media-gallery img").count(), 3)
        self.page.evaluate("request('X_SHOT_SCROLL',{y:150})")
        self.page.keyboard.press("Escape")
        self.assertEqual(self.page.locator(".x-shot-media-gallery, .x-shot-capturing, .x-shot-target, .x-shot-original-media-hidden").count(), 0)
        self.assertEqual(self.page.evaluate("[scrollY,carousel.scrollLeft]"), [0, 50])
        self.assertFalse(self.page.evaluate("request('X_SHOT_SCROLL',{y:150})")["ok"])

    def test_image_timeout_and_dom_replacement(self):
        self.select()
        pending = []
        self.page.route("https://images.example/**", lambda route: pending.append(route))
        self.page.evaluate("""() => {
          const replacement = reply.cloneNode(true); reply.replaceWith(replacement);
          const img=document.createElement('img'); img.src='https://images.example/pending'; replacement.append(img);
        }""")
        result = self.page.evaluate("request('X_SHOT_PREPARE',{selection:selection.selection})")
        self.assertIn("未完整加载", result["error"])
        for route in pending:
            route.abort()
        self.page.evaluate("request('X_SHOT_RESTORE')")
        self.assertFalse(self.page.evaluate("document.documentElement.classList.contains('x-shot-capturing')"))

    def test_missing_ancestor_cannot_silently_shorten_conversation(self):
        self.select()
        self.page.locator("#parent").evaluate("(e) => e.remove()")
        result = self.page.evaluate("request('X_SHOT_PREPARE',{selection:selection.selection})")
        self.assertFalse(result["ok"])

    def test_layout_shift_and_worker_disconnect(self):
        self.select()
        self.assertTrue(self.page.evaluate("request('X_SHOT_PREPARE',{selection:selection.selection})")["ok"])
        position = self.page.evaluate("request('X_SHOT_SCROLL',{y:128})")
        self.page.locator("#reply").evaluate("(e) => e.style.height='400px'")
        self.assertFalse(self.page.evaluate("(position) => request('X_SHOT_VERIFY',{position})", position)["ok"])
        self.page.evaluate("complete(undefined)")
        self.page.wait_for_function("!document.documentElement.classList.contains('x-shot-capturing')")
        self.assertEqual(self.page.evaluate("scrollY"), 0)

    def test_fractional_png_pixel_rows(self):
        self.script("png-stitch.js")
        for scale in [1, 1.25, 1.5, 2]:
            with self.subTest(scale=scale):
                result = self.page.evaluate("""async scale => {
                  const stitch = new XShotPngStitcher(), width = 40, height = 80;
                  stitch.begin({top:0,left:0,width,height:120});
                  for(const scrollY of [0,40]){
                    const src = document.createElement('canvas'); src.width=width*scale; src.height=height*scale;
                    const ctx=src.getContext('2d');
                    for(let y=0;y<src.height;y++){
                      const row = y+scrollY*scale;
                      ctx.fillStyle='rgb('+row+','+(row%2 ? 255 : 0)+',0)';ctx.fillRect(0,y,src.width,1);
                    }
                    await stitch.addFrame(src.toDataURL(),{viewportWidth:width,viewportHeight:height,
                      scrollY,contentTop:scrollY ? 79.25 : 0,contentBottom:scrollY ? 120 : 79.25});
                  }
                  const {canvas,context}=stitch.job, bytes=context.getImageData(0,0,1,canvas.height).data;
                  const exact = [...bytes].every((v,i)=> i%4===0 ? v===i/4 : i%4!==1 || v===(Math.floor(i/4)%2 ? 255 : 0));
                  const result=stitch.finish();
                  return [exact,result.width,result.height,canvas.width];
                }""", scale)
                self.assertEqual(result, [True, 40*scale, 120*scale, 0])

    def test_media_restore(self):
        self.script("content.js")
        result = self.page.evaluate("""async () => {
          const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');
          const stream=canvas.captureStream(24), rec=new MediaRecorder(stream);
          const chunks=[];
          rec.ondataavailable=e=>chunks.push(e.data);
          const stopped=new Promise(r=>rec.onstop=r);
          rec.start(); for(let i=0;i<10;i++){ctx.fillRect(i,i,5,5); await new Promise(r=>setTimeout(r,50));}
          rec.stop(); await stopped; stream.getTracks().forEach(t=>t.stop());
          const v=document.createElement('video'); document.body.append(v); v.muted=true; v.volume=.35; v.loop=true;
          v.src=URL.createObjectURL(new Blob(chunks,{type:rec.mimeType}));
          await v.play(); await new Promise(r=>setTimeout(r,120));
          const snapshot=xShotPrepareVideo(v,false); v.loop=false; v.volume=1; v.muted=false; v.currentTime=0;
          xShotRestoreVideo(snapshot);
          const playing=!v.paused && v.loop && v.muted && v.volume===.35 && Math.abs(v.currentTime-snapshot.time)<.06;
          v.pause(); const paused=xShotPrepareVideo(v,true); xShotRestoreVideo(paused);
          v.remove(); xShotRestoreVideo(snapshot); URL.revokeObjectURL(v.src);
          return [playing,v.paused];
        }""")
        self.assertEqual(result, [True, True])

    def test_focused_png_clipboard(self):
        self.select()
        self.ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://x.com")
        result = self.page.evaluate("""async () => {
          const c=document.createElement('canvas'); c.width=13; c.height=7;
          const copied=await request('X_SHOT_COPY',{dataUrl:c.toDataURL()});
          if(!copied.ok) throw Error(copied.error);
          const [item]=await navigator.clipboard.read();
          const bitmap=await createImageBitmap(await item.getType('image/png'));
          return [bitmap.width,bitmap.height];
        }""")
        self.assertEqual(result, [13, 7])

    def test_real_mp4_audio_video(self):
        self.script("png-stitch.js")
        self.script("offscreen.js")
        output = self.page.evaluate("""async () => {
          const c=document.createElement('canvas'); c.width=320;c.height=240;
          const ctx=c.getContext('2d');
          function paint() {
            ctx.fillStyle='green';ctx.fillRect(0,0,320,240);
            ctx.fillStyle='#ff00ff';ctx.fillRect(8,8,24,24);
            ctx.fillStyle='#00ffff';ctx.fillRect(288,208,24,24);
          }
          paint(); const timer=setInterval(paint,40);
          const audio=new AudioContext(), dest=audio.createMediaStreamDestination(), osc=audio.createOscillator();
          osc.connect(dest);osc.start(); await audio.resume();
          const stream=new MediaStream([...c.captureStream(24).getTracks(),...dest.stream.getAudioTracks()]);
          Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>stream});
          const send=(type,fields={})=>handleMessage({type,jobId:'j',...fields});
          try {
            const capture={width:320,height:240,top:0,left:0};
            const rect={left:40,top:50,width:100,height:90};
            await send('X_SHOT_BEGIN',{capture});
            await send('X_SHOT_FRAME',{dataUrl:c.toDataURL(),frame:{scrollY:0,contentTop:0,contentBottom:240,viewportWidth:320,viewportHeight:240}});
            await send('X_SHOT_FINISH',{forVideo:true});
            await send('X_SHOT_RECORD_BEGIN',{capture,layout:{documentVideoRect:rect,preservePostLayout:true}});
            await send('X_SHOT_RECORD_CALIBRATE',{markers:{first:{x:20,y:20},second:{x:300,y:220}}});
            await send('X_SHOT_RECORD_START',{videoRect:rect});
            await new Promise(r=>setTimeout(r,1000));
            const result=await send('X_SHOT_RECORD_FINISH');
            if(stream.getTracks().some(t=>t.readyState!=='ended')) throw Error('live track after finish');
            return result.dataUrl;
          } finally { clearInterval(timer); dispose();osc.stop(); await audio.close(); }
        }""")
        data = base64.b64decode(output.split(",", 1)[1])
        self.assertIn(b"ftyp", data[:32])
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_packets", "-of", "json", "pipe:0"],
            input=data, capture_output=True, check=True)
        media = json.loads(probe.stdout)
        streams = media["streams"]
        packets = media["packets"]
        ends = [max(float(p["pts_time"]) for p in packets if p["codec_type"] == kind) for kind in ("audio", "video")]
        self.assertLess(abs(ends[0] - ends[1]), 0.25, ends)
        self.assertEqual({s["codec_type"] for s in streams}, {"audio", "video"})
        video = next(s for s in streams if s["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (160, 120))


if __name__ == "__main__":
    unittest.main(verbosity=2)
