/**
 * Headless verification of the layout solver.
 *
 * Canvas isn't available in node, so we substitute a measurer built from real
 * Helvetica Bold advance widths. That's enough to check the two things that
 * actually matter: that every line lands flush on the measure, and that the
 * break chooser produces the same partition Beatsee produced for the reference
 * phrase ("I just wanna hold you" -> I JUST / WANNA / HOLD / YOU).
 */
import { fitPoster, describeFit } from '../src/poster-type.js';

// Helvetica Bold advance widths, units per 1000 em.
const ADV = {
  ' ': 278, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778,
  R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "'": 238, ',': 278, '.': 278, '!': 333, '?': 611, '-': 333,
};
const CAP = 0.717;      // cap height, em
const SIDE = 0.045;     // typical side bearing on a heavy grotesque, em

function fakeMeasurer() {
  const w = (t) => [...t.toUpperCase()].reduce((s, c) => s + (ADV[c] ?? 600) / 1000, 0);
  const metrics = (t) => {
    const adv = w(t);
    return {
      w: adv,
      ascent: CAP, descent: 0,
      left: -SIDE, right: adv - SIDE,   // spec sign: negative when ink is inset
    };
  };
  return { width: w, metrics, inkHeight: (t) => CAP, clear() {} };
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};
const approx = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

const M = fakeMeasurer();
const BOX = { width: 1080, height: 1920 };

console.log('\n— reference phrase ————————————————————————————');
const fit = fitPoster('I just wanna hold you', M, BOX, { fill: 0.90, leading: 1.03 });
console.log(describeFit(fit));

check('breaks into 4 lines', fit.lines.length === 4, `got ${fit.lines.length}`);
check('partition matches reference',
  fit.lines.map(l => l.text).join('/') === 'I just/wanna/hold/you',
  fit.lines.map(l => l.text).join('/'));

console.log('\n— flush edges —————————————————————————————————');
const measure = BOX.width * 0.90;
for (const l of fit.lines) {
  // ink width must equal the measure, that is the entire premise of the style
  const inkW = (M.metrics(l.text).left + M.metrics(l.text).right) * l.size;
  check(`"${l.text}" spans the measure`, approx(inkW, measure * fit.scale, 1),
    `${inkW.toFixed(2)} vs ${(measure * fit.scale).toFixed(2)}`);
}

console.log('\n— size ordering ———————————————————————————————');
// Fewer/narrower glyphs must yield bigger type. YOU > HOLD > I JUST > WANNA.
const size = (t) => fit.lines.find(l => l.text === t).size;
check('you  > hold',   size('you')  > size('hold'));
check('hold > I just', size('hold') > size('I just'));
check('I just > wanna', size('I just') > size('wanna'));

console.log('\n— orphan avoidance ————————————————————————————');
// "I" alone would be ~4x its neighbours; the penalty must prevent it.
const solo = fitPoster('I am here now', M, BOX, { fill: 0.9 });
console.log(describeFit(solo));
check('never orphans a single narrow word',
  !solo.lines.some(l => l.text === 'I'),
  solo.lines.map(l => l.text).join('/'));

console.log('\n— overflow handling ———————————————————————————');
const long = fitPoster(
  'And I would walk five hundred miles just to fall down at your door',
  M, BOX, { fill: 0.9, maxLines: 6 });
console.log(describeFit(long));
check('block fits the frame', long.blockHeight <= BOX.height * 0.94 + 1,
  `${long.blockHeight.toFixed(1)} > ${(BOX.height * 0.94).toFixed(1)}`);
check('respects maxLines', long.lines.length <= 6, `${long.lines.length}`);

console.log('\n— single word —————————————————————————————————');
const one = fitPoster('forever', M, BOX, { fill: 0.9 });
check('one word, one line', one.lines.length === 1);
check('single line still flush',
  approx((M.metrics('forever').left + M.metrics('forever').right) * one.lines[0].size,
         measure * one.scale, 1));

console.log('\n— word boxes ——————————————————————————————————');
const wb = fit.lines[0].wordBoxes;
check('word boxes cover the line', wb.length === 2, `${wb.length}`);
const first = wb[0], last = wb[wb.length - 1];
check('first word starts on the left margin', approx(first.inkX, 0, 1.5),
  `${first.inkX.toFixed(2)}`);
check('last word ends on the right margin',
  approx(last.inkX + last.inkW, measure * fit.scale, 1.5),
  `${(last.inkX + last.inkW).toFixed(2)} vs ${(measure * fit.scale).toFixed(2)}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}\n`);
process.exit(failures ? 1 : 0);
