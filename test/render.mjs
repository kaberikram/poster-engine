/**
 * Headless render check. Boots the real page in Chromium with software GL,
 * drives the engine to fixed times, and writes PNGs of the canvas so the
 * output can be compared against the captured reference frames.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(8420, r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const errors = [];
// This container has no egress, so Google Fonts and favicon fetches fail.
// Those are environmental, not defects in the page.
const ENV_NOISE = /ERR_TUNNEL|ERR_FAILED|fonts\.googleapis|favicon|404/;
page.on('console', m => {
  if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
});
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8420/index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__poster, null, { timeout: 30000 });
await page.waitForTimeout(1500);   // let fonts settle and a few frames run

const info = await page.evaluate(() => {
  const { engine, state } = window.__poster;
  const gl = engine.renderer.getContext();
  return {
    renderer: gl.getParameter(gl.VERSION),
    phrases: engine.phrases.length,
    words: engine.words.length,
    fit: engine.current ? engine.current.fit.lines.map(l => ({
      text: l.text, size: +l.size.toFixed(1), advance: +l.advance.toFixed(1),
    })) : null,
    status: document.getElementById('status').textContent,
    duration: state.duration,
  };
});
console.log('\nGL      :', info.renderer);
console.log('status  :', info.status);
console.log('phrases :', info.phrases, ' words on screen:', info.words);
console.log('fit     :', JSON.stringify(info.fit, null, 1));

// Freeze the clock and step to chosen moments so shots are reproducible.
const marks = [
  { t: 0.9,  name: '01-phrase-one' },
  { t: 3.2,  name: '02-phrase-two' },
  { t: 5.6,  name: '03-phrase-three' },
  { t: 10.2, name: '04-long-phrase' },
  { t: 1.30, name: '09-mid-word-emphasis' },   // 'wanna' just landed, 'you' has not
  { t: 0.38, name: '10-mid-enter' },           // block still staggering in
];

for (const m of marks) {
  await page.evaluate((t) => {
    const { engine, state, backdrops } = window.__poster;
    state.playing = false;
    state.t = t;
    for (const b of backdrops) b.draw(t, 0.4);
    engine.update(t, 0.4, 0.2);
  }, m.t);
  await page.waitForTimeout(120);
  const el = await page.$('#stage');
  await el.screenshot({ path: path.join(OUT, m.name + '.png') });
  console.log('shot    :', m.name);
}

// Full UI shot
await page.screenshot({ path: path.join(OUT, '00-ui.png') });

// Variant sweep: prove the controls actually reach the shaders.
const variants = [
  { name: '05-cmyk',      apply: () => { window.__poster.engine.halftone.uniforms.uMode.value = 2;
                                          window.__poster.engine.halftone.uniforms.uCell.value = 10; } },
  { name: '06-newsprint', apply: () => { window.__poster.engine.applyFXPreset('newsprint'); } },
  { name: '07-clean-normal', apply: () => { const e = window.__poster.engine;
                                          e.applyFXPreset('clean'); e.set({ blend: 'normal' }); } },
  { name: '08-wrecked',   apply: () => { const e = window.__poster.engine;
                                          e.applyFXPreset('wrecked'); e.set({ blend: 'difference' }); } },
];
for (const v of variants) {
  await page.evaluate(v.apply);
  await page.evaluate(() => {
    const { engine, state, backdrops } = window.__poster;
    // The rAF loop is still running and re-renders from state.t, so setting
    // state.t is what actually pins the frame — calling update() alone gets
    // overwritten before the screenshot lands.
    state.t = 0.9;
    for (const b of backdrops) b.draw(0.9, 0.4);
    engine.update(0.9, 0.4, 0.2);
  });
  await page.waitForTimeout(120);
  const el = await page.$('#stage');
  await el.screenshot({ path: path.join(OUT, v.name + '.png') });
  console.log('shot    :', v.name);
}

console.log('\nconsole errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
