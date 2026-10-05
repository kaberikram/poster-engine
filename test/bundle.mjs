/**
 * Verifies the bundled single-file artifact actually boots. The container has
 * no route to jsdelivr, so we intercept that one request and serve the vendored
 * three — everything else runs exactly as the published page will.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// The test itself aborts the Google Fonts request (no egress here), so the
// resulting load failure is expected, not a defect in the bundle.
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (/ERR_FAILED|fonts\.googleapis/.test(m.text())) return;
  errors.push(m.text());
});

await page.route('**/three@0.160.1/build/three.module.js', route =>
  route.fulfill({ contentType: 'text/javascript',
                  body: fs.readFileSync('vendor/three.module.js', 'utf8') }));
// fonts.googleapis is unreachable here; let it fail like any offline viewer would
await page.route('**/fonts.googleapis.com/**', r => r.abort());

// The Artifact host wraps the fragment in a document; do the same.
await page.setContent(
  '<!doctype html><meta charset="utf-8"><body style="margin:0">' +
  fs.readFileSync('dist/poster-engine.html', 'utf8'),
  { waitUntil: 'domcontentloaded' });

await page.waitForFunction(() => window.__poster, null, { timeout: 30000 });
await page.waitForTimeout(2200);

const r = await page.evaluate(() => {
  const { engine } = window.__poster;
  return {
    status: document.getElementById('status').textContent,
    fitRows: document.querySelectorAll('#fit .ln').length,
    controlRows: document.querySelectorAll('.row').length,
    words: engine.words.length,
    gl: engine.renderer.getContext().getParameter(0x1F02),
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: 'shots/11-bundle.png' });

let fail = 0;
const check = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) fail++; };
check('booted (status left "booting")', r.status !== 'booting');
check('fit readout populated', r.fitRows > 0);
check('controls generated', r.controlRows > 20);
check('words on stage', r.words > 0);
check('no console errors', errors.length === 0);
if (errors.length) console.log('  ' + errors.join('\n  '));

await browser.close();
process.exit(fail ? 1 : 0);
