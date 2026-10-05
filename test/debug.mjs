import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = process.cwd();
const MIME={'.html':'text/html','.js':'text/javascript'};
const server=http.createServer((req,res)=>{const p=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
 if(!fs.existsSync(p)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});
 fs.createReadStream(p).pipe(res);});
await new Promise(r=>server.listen(8421,r));
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1400,height:900}});
page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('http://localhost:8421/index.html',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__poster,null,{timeout:30000});
await page.waitForTimeout(800);

const d = await page.evaluate(() => {
  const { engine } = window.__poster;
  engine.update(0.9, 0.4, 0.2);

  // 1. what does the browser actually report for bounding box left?
  const c = document.createElement('canvas').getContext('2d');
  c.font = '900 256px Helvetica, Arial, sans-serif';
  const m = c.measureText('HOLD');
  const rawMetrics = {
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    asc: m.actualBoundingBoxAscent,
    desc: m.actualBoundingBoxDescent,
  };

  // 2. engine's view
  const mm = engine.measurer.metrics('HOLD');

  // 3. mesh state
  const meshes = engine.words.map(w => ({
    word: w.mesh.material.map.image.width + 'x' + w.mesh.material.map.image.height,
    pos: [Math.round(w.mesh.position.x), Math.round(w.mesh.position.y)],
    scale: [Math.round(w.mesh.scale.x), Math.round(w.mesh.scale.y)],
    opacity: +w.mat.opacity.toFixed(3),
    visible: w.mesh.visible,
  }));

  // 4. is anything actually drawn into the word canvases?
  const first = engine.words[0]?.mesh.material.map.image;
  let inkPixels = 0;
  if (first) {
    const cc = first.getContext('2d');
    const dd = cc.getImageData(0, 0, first.width, first.height).data;
    for (let i = 3; i < dd.length; i += 4) if (dd[i] > 8) inkPixels++;
  }

  // 5. read back the type render target
  const r = engine.renderer, THREE_RT = engine.typeRT;
  const buf = new Uint8Array(4 * 64 * 64);
  r.readRenderTargetPixels(THREE_RT, 400, 900, 64, 64, buf);
  let rtNonZero = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) rtNonZero++;

  return { rawMetrics, engineMetrics: mm, meshes, inkPixels,
           canvasSize: first ? [first.width, first.height] : null,
           rtAlphaPixels: rtNonZero,
           camera: { l: engine.typeCamera.left, r: engine.typeCamera.right,
                     t: engine.typeCamera.top, b: engine.typeCamera.bottom } };
});
console.log(JSON.stringify(d, null, 1));
await browser.close(); server.close();
