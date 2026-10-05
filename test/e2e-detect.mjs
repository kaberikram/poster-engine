/**
 * End-to-end through the real UI: build a WAV whose sung phrases are at known
 * times, hand it to the file input, run detection in "my lyrics" mode, then
 * edit a line and confirm the timing survives the edit.
 */
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

/* ---- fixture: drums throughout, harmonic phrases on top ---------------- */
const SR = 22050, DUR = 16;
const PHRASES = [[1.0, 3.2], [5.0, 7.4], [9.5, 11.0], [12.5, 15.0]];
const n = SR * DUR;
const f = new Float32Array(n);
for (let t = 0; t < DUR; t += 0.5) {
  const s0 = Math.floor(t * SR);
  for (let k = 0; k < SR * 0.08 && s0 + k < n; k++)
    f[s0 + k] += (Math.random() * 2 - 1) * 0.45 * Math.exp(-k / (SR * 0.012));
}
for (let i = 0; i < n; i++) f[i] += Math.sin(2 * Math.PI * 55 * i / SR) * 0.12;
for (const [a, b] of PHRASES) {
  for (let i = Math.floor(a * SR); i < Math.floor(b * SR) && i < n; i++) {
    const tt = i / SR, f0 = 240 + 12 * Math.sin(2 * Math.PI * 5 * tt);
    let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
    f[i] += v * 0.30 * Math.min(1, (tt - a) * 8) * Math.min(1, (b - tt) * 8);
  }
}
// 16-bit PCM WAV
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, f[i] * 20000)), i * 2);
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28);
hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('/tmp/fixture.wav', Buffer.concat([hdr, pcm]));

/* ---- serve + drive ------------------------------------------------------ */
const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(8422, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// This container has no egress, so Google Fonts and favicon fetches fail.
// Those are environmental, not defects in the page.
const ENV_NOISE = /ERR_TUNNEL|ERR_FAILED|fonts\.googleapis|favicon|404/;
page.on('console', m => {
  if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
});

await page.goto('http://localhost:8422/index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__poster, null, { timeout: 30000 });

await page.fill('#pasteLyrics',
  'I just wanna hold you\nnever let you go\nsay it slow\neverything I never said out loud');
await page.setInputFiles('#audio', '/tmp/fixture.wav');
await page.waitForFunction(() => !document.getElementById('detect').disabled, null, { timeout: 30000 });
console.log('\ndecode+analyse :', await page.textContent('#detectStatus'));

await page.click('#detect');
await page.waitForSelector('#lineList .lyr', { timeout: 20000 });
await page.waitForTimeout(400);

const got = await page.evaluate(() => ({
  status: document.getElementById('detectStatus').textContent,
  tally: document.getElementById('tally').textContent,
  rows: [...document.querySelectorAll('#lineList .lyr')].map(r => ({
    t: r.querySelector('.t').textContent,
    text: r.querySelector('input').value,
  })),
  lines: window.__poster.state.lines.map(l => ({
    start: +l.start.toFixed(2), end: +l.end.toFixed(2), words: l.words.length })),
  enginePhrases: window.__poster.engine.phrases.length,
  lrc: document.getElementById('lrc').value.split('\n')[0],
}));
console.log('detect         :', got.status);
console.log('tally          :', got.tally);
console.log('rows           :', got.rows.map(r => `${r.t} ${r.text}`).join('\n                 '));
console.log('engine phrases :', got.enginePhrases);
console.log('first LRC line :', got.lrc.slice(0, 90));

/* ---- the claim under test: retype a line, timing must not move --------- */
const before = got.lines[0];
await page.fill('#lineList .lyr:first-child input', 'totally different words go here now');
await page.waitForTimeout(500);
const after = await page.evaluate(() => {
  const l = window.__poster.state.lines[0];
  return { start: +l.start.toFixed(2), end: +l.end.toFixed(2), words: l.words.length,
           first: +l.words[0].start.toFixed(2), last: +l.words[l.words.length-1].start.toFixed(2) };
});
console.log('after rewrite  :', JSON.stringify(after));

await page.screenshot({ path: 'shots/12-detect-ui.png' });

let fails = 0;
const check = (nme, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${nme} ${d}`); if (!c) fails++; };
console.log('');
check('found 4 phrases', got.lines.length === 4, `got ${got.lines.length}`);
got.lines.forEach((l, i) => check(`phrase ${i+1} start within 250ms`,
  Math.abs(l.start - PHRASES[i][0]) < 0.25, `${l.start} vs ${PHRASES[i][0]}`));
check('all lines got words', got.rows.every(r => r.text.length > 0));
check('engine received the lyrics', got.enginePhrases === 4, `${got.enginePhrases}`);
check('word-level LRC emitted', /<\d\d:\d\d\.\d\d>/.test(got.lrc));
check('span unchanged after rewrite',
  after.start === before.start && after.end === before.end,
  `${after.start}-${after.end} vs ${before.start}-${before.end}`);
check('new words re-placed', after.words === 6, `${after.words}`);
check('rewritten words stay inside the span',
  after.first >= before.start - 0.01 && after.last < before.end);
check('no console errors', errors.length === 0, errors.join(' | '));

console.log(`\n${fails ? fails + ' FAILURES' : 'ALL PASS'}\n`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
