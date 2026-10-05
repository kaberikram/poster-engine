/**
 * POSTER TYPE — width-driven line fitting.
 * ----------------------------------------------------------------------------
 * The look: every line of a phrase is set at whatever size makes it span the
 * measure exactly, so both edges stay flush. Short lines get huge type, long
 * lines get small type, and the block reads as one solid slab.
 *
 * The scaling itself is one division. The real problem is choosing WHERE to
 * break, because the break points decide the rhythm of sizes down the block —
 * and a naive greedy break produces one gigantic orphan ("I") sitting above a
 * cramped six-word line. So breaking is a DP that optimises for even sizes,
 * run over every plausible line count, picking the tallest type that still fits.
 *
 * No DOM dependencies beyond a 2D canvas for measurement. No Three, no engine.
 */

const REF = 256; // measure at a large size, then normalise — font metrics are
                 // effectively linear well above hinting territory.

/* ---------------------------------------------------------------------------
 * Measurement
 * ------------------------------------------------------------------------- */

/**
 * A cached text measurer normalised to "per unit of font-size".
 * Everything downstream works in these unit widths, so a line's font size is
 * simply `measure / unitWidth(text)`.
 */
export function createMeasurer(font) {
  const {
    family = 'Helvetica, Arial, sans-serif',
    weight = 700,
    style = 'normal',
    tracking = 0,        // em, matches CSS letter-spacing in em
  } = font || {};

  const cvs = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(8, 8)
    : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  const ctx = cvs.getContext('2d');

  const fontString = `${style} ${weight} ${REF}px ${family}`;
  const cache = new Map();

  function raw(text) {
    let m = cache.get(text);
    if (m) return m;

    ctx.font = fontString;
    // Canvas letterSpacing is a recent addition; fall back to manual tracking.
    const nativeTracking = 'letterSpacing' in ctx;
    if (nativeTracking) ctx.letterSpacing = `${tracking * REF}px`;

    const t = ctx.measureText(text);

    // Chrome appends tracking after the final glyph. Strip it so a tracked line
    // still sits flush against the right margin.
    let width = t.width;
    if (nativeTracking && tracking !== 0 && text.length > 0) width -= tracking * REF;
    if (!nativeTracking && tracking !== 0) width += tracking * REF * Math.max(0, text.length - 1);

    m = {
      // advance width, the thing that decides the fit
      w: width / REF,
      // tight ink bounds — what makes optical alignment possible
      ascent: (t.actualBoundingBoxAscent ?? REF * 0.72) / REF,
      descent: (t.actualBoundingBoxDescent ?? 0) / REF,
      // side bearings: how far the ink sits inside the advance box.
      // Round glyphs (O, C, S) overshoot; this is how we align on ink, not box.
      left: (t.actualBoundingBoxLeft ?? 0) / REF,
      right: (t.actualBoundingBoxRight ?? width) / REF,
      nativeTracking,
    };
    cache.set(text, m);
    return m;
  }

  return {
    font, fontString, tracking,
    /** Advance width of `text` per unit of font size. */
    width: (text) => raw(text).w,
    /** Full metrics per unit of font size. */
    metrics: raw,
    /** Ink height (ascent + descent) per unit of font size. */
    inkHeight: (text) => { const m = raw(text); return m.ascent + m.descent; },
    clear: () => cache.clear(),
  };
}

/* ---------------------------------------------------------------------------
 * Line breaking
 * ------------------------------------------------------------------------- */

/**
 * Words that should not be left alone on a line. Setting "I" or "a" at full
 * measure blows it up to four times the size of its neighbours and wrecks the
 * block — this is the single biggest visual difference between a considered
 * poster fit and a naive one.
 */
function orphanPenalty(words, i, j, measurer) {
  const n = j - i;
  if (n > 1) return 0;
  const w = words[i];
  // Penalty scales with how pathologically narrow the line is.
  const u = measurer.width(w);
  if (u < 0.35) return 8;       // "I", "1"
  if (u < 0.75) return 3;       // "A", "OF", "TO"
  if (w.length <= 2) return 1.5;
  return 0;
}

/**
 * Optimal partition of `words` into exactly `lines` runs, minimising the
 * spread of resulting font sizes.
 *
 * Sizes are compared in log space so the cost is scale-invariant: a line twice
 * as big as its neighbour costs the same whether the pair is 40px/80px or
 * 400px/800px. Without that, the optimiser quietly prefers small type.
 */
function partition(words, lines, measurer, opts) {
  const n = words.length;
  if (lines > n) return null;
  if (lines === 1) return [[0, n]];

  // logSize[i][j] for the run words[i..j)  (size ∝ 1 / unitWidth)
  const logSize = [];
  const pen = [];
  for (let i = 0; i < n; i++) {
    logSize[i] = [];
    pen[i] = [];
    for (let j = i + 1; j <= n; j++) {
      const u = measurer.width(words.slice(i, j).join(' '));
      logSize[i][j] = -Math.log(Math.max(u, 1e-6));
      pen[i][j] = orphanPenalty(words, i, j, measurer);
    }
  }

  // Two-pass: the mean log size isn't known until the partition is chosen, so
  // minimise pairwise squared difference between consecutive lines instead —
  // it has the same minimum for even blocks and is separable for DP.
  //   cost = Σ_k (logSize_k - logSize_{k-1})² + Σ_k penalty_k
  const INF = Infinity;
  // dp[k][i] = best cost using k lines to cover words[0..i), with last line
  // starting at `start`. We need the previous line's size, so carry it.
  // State: (k, i, prevStart) is O(n³k); n is a phrase's word count (<20), fine.
  const dp = new Map();
  const back = new Map();
  const key = (k, i, p) => `${k}|${i}|${p}`;

  function solve(k, i, prevStart) {
    if (k === 0) return i === n ? 0 : INF;
    const K = key(k, i, prevStart);
    if (dp.has(K)) return dp.get(K);

    let best = INF, bestJ = -1;
    const maxTake = n - i - (k - 1); // leave at least one word per remaining line
    for (let take = 1; take <= maxTake; take++) {
      const j = i + take;
      let c = pen[i][j];
      if (prevStart >= 0) {
        const d = logSize[i][j] - logSize[prevStart][i];
        c += d * d * (opts.evenness ?? 1);
      }
      const rest = solve(k - 1, j, i);
      if (rest === INF) continue;
      const total = c + rest;
      if (total < best) { best = total; bestJ = j; }
    }
    dp.set(K, best);
    back.set(K, bestJ);
    return best;
  }

  const cost = solve(lines, 0, -1);
  if (cost === INF) return null;

  const runs = [];
  let i = 0, prev = -1;
  for (let k = lines; k > 0; k--) {
    const j = back.get(key(k, i, prev));
    runs.push([i, j]);
    prev = i;
    i = j;
  }
  return runs;
}

/* ---------------------------------------------------------------------------
 * The fit
 * ------------------------------------------------------------------------- */

/**
 * Lay a phrase out as a poster block.
 *
 * @param {string}   text      the phrase
 * @param {object}   measurer  from createMeasurer()
 * @param {object}   box       { width, height } of the available frame, px
 * @param {object}   opts
 *   @param {number} opts.fill        0..1 — fraction of `box.width` the measure
 *                                    occupies. Beatsee calls this SIZE (0.90).
 *   @param {number} opts.leading     multiplier on ink height. 1.0 = lines touch.
 *   @param {number} opts.maxLines
 *   @param {number} opts.maxSizeRatio  reject blocks where the biggest line is
 *                                      more than this times the smallest.
 *   @param {boolean} opts.opticalEdges align on ink rather than advance box.
 *
 * @returns {{ lines, blockWidth, blockHeight, measure, scale }}
 */
export function fitPoster(text, measurer, box, opts = {}) {
  const {
    fill = 0.90,
    leading = 1.03,
    maxLines = 6,
    maxSizeRatio = 2.6,
    evenness = 1,
    opticalEdges = true,
    verticalFill = 0.94,   // block may occupy this much of the frame height
  } = opts;

  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return { lines: [], blockWidth: 0, blockHeight: 0, measure: 0, scale: 1 };
  }

  const measure = box.width * fill;
  const availH = box.height * verticalFill;

  const build = (runs) => {
    const lines = runs.map(([i, j]) => {
      const str = words.slice(i, j).join(' ');
      const m = measurer.metrics(str);

      // Optical fit: the advance box includes side bearings, so a line starting
      // with "O" and ending in "C" reads as inset even when the box is flush.
      // Fitting the INK width instead puts the actual edges of the letterforms
      // on the margin, which is what makes a poster look properly justified.
      const inkW = opticalEdges ? (m.left + m.right) : m.w;
      const fitW = Math.max(inkW, 1e-6);
      const size = measure / fitW;

      return {
        text: str,
        words: words.slice(i, j),
        wordRange: [i, j],
        size,
        // ink box in px at this size
        ascent: m.ascent * size,
        descent: m.descent * size,
        height: (m.ascent + m.descent) * size,
        advance: m.w * size,
        // Draw origin that puts the ink's LEFT EDGE on the margin.
        // actualBoundingBoxLeft is negative for a normal side bearing
        // (ink sits right of the alignment point), so this shifts left.
        inkShift: opticalEdges ? m.left * size : 0,
      };
    });

    let blockHeight = 0;
    for (let k = 0; k < lines.length; k++) {
      blockHeight += lines[k].height * (k === 0 ? 1 : leading);
    }
    const sizes = lines.map(l => l.size);
    const ratio = Math.max(...sizes) / Math.min(...sizes);
    return { lines, blockHeight, ratio };
  };

  // Prefer the most lines that still fit — more lines means shorter runs, which
  // means bigger type, which is the whole point of the style.
  let chosen = null;
  const upper = Math.min(maxLines, words.length);
  for (let L = upper; L >= 1; L--) {
    const runs = partition(words, L, measurer, { evenness });
    if (!runs) continue;
    const b = build(runs);
    if (b.ratio > maxSizeRatio && L > 1) continue;
    if (b.blockHeight <= availH) { chosen = b; break; }
    chosen = chosen || b; // remember the tightest option as a fallback
  }
  if (!chosen) chosen = build(partition(words, 1, measurer, { evenness }));

  // If even the tightest block overflows, scale the whole thing down uniformly.
  // Scaling the block rather than re-fitting keeps the edges flush.
  const scale = Math.min(1, availH / chosen.blockHeight);

  // Stack: y is the top of each line's ink box, block origin at 0.
  let y = 0;
  const out = chosen.lines.map((l, k) => {
    if (k > 0) y += l.height * scale * leading - l.height * scale;
    const line = {
      ...l,
      size: l.size * scale,
      ascent: l.ascent * scale,
      descent: l.descent * scale,
      height: l.height * scale,
      advance: l.advance * scale,
      inkShift: l.inkShift * scale,
      y,                          // ink top
      baseline: y + l.ascent * scale,
    };
    y += line.height;
    return line;
  });

  // Per-word positions inside each line, taken from prefix advances of the
  // full run rather than from each word measured alone — that way the spacing
  // matches a single continuous line exactly, tracking and all.
  const spaceW = measurer.width(' ');
  for (const line of out) {
    let x = line.inkShift;
    line.wordBoxes = line.words.map((w) => {
      const wm = measurer.metrics(w);
      const box = {
        word: w,
        x,                                  // left of the advance box
        width: wm.w * line.size,            // advance width
        inkX: x - wm.left * line.size,      // left of the actual ink
        inkW: (wm.left + wm.right) * line.size,
        ascent: wm.ascent * line.size,
        descent: wm.descent * line.size,
      };
      x += box.width + spaceW * line.size;
      return box;
    });
  }

  return {
    lines: out,
    blockWidth: measure,
    blockHeight: y,
    measure,
    scale,
  };
}

/** Convenience: total sizes for debugging / tests. */
export function describeFit(fit) {
  return fit.lines
    .map(l => `${l.text.padEnd(18)} size=${l.size.toFixed(1).padStart(7)}  adv=${l.advance.toFixed(1)}`)
    .join('\n');
}
