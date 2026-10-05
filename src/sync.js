/**
 * SYNC — lyrics in, timing out.
 * ----------------------------------------------------------------------------
 * Two independent halves:
 *
 *   parseLyrics()   LRC (plain and enhanced/word-level), a simple JSON shape,
 *                   and bare text with even spacing as a last resort.
 *
 *   analyseAudio()  offline spectral-flux onset detection plus a tempo estimate.
 *                   Beatsee cuts its backdrops on a fixed grid; cutting on real
 *                   detected onsets means the video lands on the actual hits of
 *                   whatever you loaded, including music that drifts or has no
 *                   steady tempo at all.
 */

/* ===========================================================================
 * LYRICS
 * ========================================================================= */

const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;

const toSeconds = (m, s, frac) => {
  const f = frac ? parseFloat('0.' + frac) : 0;
  return parseInt(m, 10) * 60 + parseInt(s, 10) + f;
};

/**
 * @param {string} src
 * @param {object} opts { duration, defaultHold }
 * @returns {Array<{start:number,end:number,text:string,words?:Array}>}
 */
export function parseLyrics(src, opts = {}) {
  const { duration = Infinity, defaultHold = 2.6 } = opts;
  const text = String(src || '').trim();
  if (!text) return [];

  // JSON passthrough
  if (text[0] === '[' || text[0] === '{') {
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : j.lines || j.phrases || [];
      if (arr.length && typeof arr[0] === 'object' && 'text' in arr[0]) {
        return normalise(arr.map(o => ({
          start: +(o.start ?? o.t ?? o.time ?? 0),
          end: o.end != null ? +o.end : null,
          text: String(o.text),
          words: o.words,
        })), duration, defaultHold);
      }
    } catch { /* not JSON, fall through to LRC */ }
  }

  const out = [];
  let sawTag = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\[(ar|ti|al|by|offset|length|re|ve):/i.test(line)) continue;

    TIME_TAG.lastIndex = 0;
    const stamps = [...line.matchAll(TIME_TAG)];
    if (!stamps.length) {
      if (!/^\[/.test(line)) out.push({ start: null, end: null, text: line });
      continue;
    }
    sawTag = true;

    const body = line.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length);

    // Enhanced LRC: per-word stamps inside the body.
    WORD_TAG.lastIndex = 0;
    const wordStamps = [...body.matchAll(WORD_TAG)];
    let words = null, plain = body;
    if (wordStamps.length) {
      words = [];
      let cursor = 0;
      const segments = [];
      for (const w of wordStamps) {
        if (w.index > cursor) segments.push({ t: null, s: body.slice(cursor, w.index) });
        segments.push({ t: toSeconds(w[1], w[2], w[3]), s: '' });
        cursor = w.index + w[0].length;
      }
      segments.push({ t: null, s: body.slice(cursor) });

      let pending = null;
      for (const seg of segments) {
        if (seg.t != null) { pending = seg.t; continue; }
        for (const tok of seg.s.split(/\s+/).filter(Boolean)) {
          words.push({ word: tok, start: pending ?? 0 });
          pending = null;
        }
      }
      plain = body.replace(WORD_TAG, ' ').replace(/\s+/g, ' ').trim();
    }

    for (const st of stamps) {
      out.push({
        start: toSeconds(st[1], st[2], st[3]),
        end: null,
        text: plain.trim(),
        words: words ? words.slice() : undefined,
      });
    }
  }

  const kept = out.filter(l => l.text);
  if (!kept.length) return [];

  // Untimed text: space it evenly across the track. Crude, but it gives you
  // something on screen to nudge rather than an empty editor.
  if (!sawTag) {
    const d = Number.isFinite(duration) ? duration : kept.length * defaultHold;
    const step = d / kept.length;
    kept.forEach((l, i) => { l.start = i * step; l.end = (i + 1) * step; });
    return kept;
  }

  return normalise(kept, duration, defaultHold);
}

function normalise(lines, duration, defaultHold) {
  const s = lines
    .filter(l => l.start != null && l.text)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < s.length; i++) {
    if (s[i].end == null) {
      const next = s[i + 1]?.start;
      s[i].end = next != null
        ? Math.min(next, s[i].start + defaultHold * 2.5)
        : Math.min(s[i].start + defaultHold, duration);
    }
    if (s[i].words?.length) {
      for (let w = 0; w < s[i].words.length; w++) {
        if (!s[i].words[w].start) {
          const span = s[i].end - s[i].start;
          s[i].words[w].start = s[i].start + span * (w / s[i].words.length);
        }
      }
    }
  }
  return s;
}

/** Serialise back to enhanced LRC, for round-tripping an edit. */
export function toLRC(phrases) {
  const fmt = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  return phrases.map(p => {
    if (p.words?.length) {
      return `[${fmt(p.start)}]` + p.words.map(w => `<${fmt(w.start)}>${w.word}`).join(' ');
    }
    return `[${fmt(p.start)}]${p.text}`;
  }).join('\n');
}

/* ===========================================================================
 * AUDIO
 * ========================================================================= */

/** In-place iterative radix-2 FFT. Small, dependency-free, fast enough offline. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],           ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;            im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;  im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;         cr = nr;
      }
    }
  }
}

/**
 * Offline onset detection.
 *
 * Spectral flux — the sum of positive frame-to-frame change across the
 * magnitude spectrum — then an adaptive median threshold and peak picking with
 * a minimum gap. Median rather than mean for the threshold because a single
 * loud transient skews a mean enough to swallow the onsets right after it.
 *
 * @param {AudioBuffer} buffer
 * @param {object} opts
 * @returns {{onsets:number[], bpm:number, envelope:Float32Array, hopSeconds:number}}
 */
export function analyseAudio(buffer, opts = {}) {
  const {
    fftSize = 1024,
    hop = 512,
    minGap = 0.12,       // seconds between accepted onsets
    sensitivity = 1.5,   // multiplier over the local median
  } = opts;

  const sr = buffer.sampleRate;
  const n = buffer.length;

  // mono mix
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }

  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)); // Hann
  }

  const frames = Math.max(0, Math.floor((n - fftSize) / hop) + 1);
  const bins = fftSize / 2;
  const flux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const vocalness = new Float32Array(frames);
  let prev = new Float32Array(bins);
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);

  // Vocal band, roughly 200Hz-4kHz: fundamentals through the presence range
  // where sung consonants and formants live.
  const loBin = Math.max(1, Math.floor(200 * fftSize / sr));
  const hiBin = Math.min(bins - 1, Math.ceil(4000 * fftSize / sr));

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let sum = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = mono[off + i];
      re[i] = s * win[i];
      im[i] = 0;
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / fftSize);
    fft(re, im);

    let d = 0;
    const cur = new Float32Array(bins);
    let bandSum = 0, bandLogSum = 0, bandN = 0;
    for (let k = 0; k < bins; k++) {
      const lin = Math.hypot(re[k], im[k]);
      // log magnitude: matches loudness perception, and keeps a quiet hi-hat
      // from being buried by a bass note ten times its linear amplitude
      const mag = Math.log1p(lin);
      cur[k] = mag;
      const diff = mag - prev[k];
      if (diff > 0) d += diff;      // half-wave rectify: onsets, not offsets

      if (k >= loBin && k <= hiBin) {
        bandSum += lin;
        bandLogSum += Math.log(lin + 1e-10);
        bandN++;
      }
    }
    flux[f] = d;

    // Spectral flatness of the vocal band: the ratio of geometric to arithmetic
    // mean. Noise-like content (drums, cymbals, distortion) is flat; a sung
    // note is peaky because it is harmonic. Weighting band energy by (1 -
    // flatness) is a cheap way to keep a snare from reading as a lyric.
    const arith = bandSum / Math.max(1, bandN);
    const geo = Math.exp(bandLogSum / Math.max(1, bandN));
    const flatness = arith > 1e-9 ? Math.min(1, geo / arith) : 1;
    vocalness[f] = arith * (1 - flatness);

    prev = cur;
  }

  // Normalise to 0..1 against a high percentile — using the max would let one
  // clipped frame flatten the whole envelope.
  {
    const sorted = Array.from(vocalness).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    for (let f = 0; f < frames; f++) vocalness[f] = Math.min(1, vocalness[f] / p95);
  }

  // Normalise the flux to unit mean so the thresholds below are absolute
  // numbers rather than something you re-tune per track.
  let fluxMean = 0;
  for (const v of flux) fluxMean += v;
  fluxMean = fluxMean / Math.max(1, frames) || 1;
  const fn = new Float32Array(frames);
  for (let f = 0; f < frames; f++) fn[f] = flux[f] / fluxMean;

  // Adaptive threshold: delta + lambda * localMedian.
  //
  // The additive delta is what makes this work. A purely multiplicative
  // threshold (v > median * k) collapses in quiet passages, where the median
  // approaches zero and every speck of numerical noise clears the bar — which
  // is exactly how a detector ends up reporting an onset every other frame.
  const W = Math.max(3, Math.round(0.4 * sr / hop));
  const NEIGHBOURHOOD = 2;
  const delta = 0.6;
  const lambda = sensitivity;

  const onsets = [];
  const hopSeconds = hop / sr;
  // Spectral flux belongs to the centre of the FFT window, not its first
  // sample. Stamping the frame start makes every detected attack early by
  // half a window (11.6ms with the defaults).
  const frameCentreSeconds = fftSize / (2 * sr);
  let lastT = -Infinity;
  const scratch = [];

  for (let f = NEIGHBOURHOOD; f < frames - NEIGHBOURHOOD; f++) {
    const v = fn[f];
    if (v < delta) continue;                      // cheap reject first

    // strict local maximum over a small neighbourhood, not just its two
    // immediate neighbours — stops a broad transient reporting three times
    let isPeak = true;
    for (let k = -NEIGHBOURHOOD; k <= NEIGHBOURHOOD; k++) {
      if (k !== 0 && fn[f + k] > v) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    const a = Math.max(0, f - W), b = Math.min(frames, f + W);
    scratch.length = 0;
    for (let i = a; i < b; i++) scratch.push(fn[i]);
    scratch.sort((x, y) => x - y);
    const median = scratch[scratch.length >> 1];

    if (v > delta + lambda * median) {
      const t = f * hopSeconds + frameCentreSeconds;
      if (t - lastT >= minGap) { onsets.push(t); lastT = t; }
    }
  }

  // Word placement must snap to sung attacks, not kicks. Spectral flux hears
  // the drum kit; vocalness already threw those away.
  const vocalOnsets = [];
  let lastVocal = -Infinity;
  for (let f = 2; f < frames - 2; f++) {
    const v = vocalness[f];
    if (v < 0.18) continue;
    if (vocalness[f - 1] >= v || vocalness[f + 1] > v) continue;
    if (v - Math.min(vocalness[f - 2], vocalness[f - 1]) < 0.035) continue;
    const t = f * hopSeconds + frameCentreSeconds;
    if (t - lastVocal >= 0.09) { vocalOnsets.push(t); lastVocal = t; }
  }

  return { onsets, vocalOnsets, bpm: estimateTempo(fn, hopSeconds), envelope: rms,
           vocalness, hopSeconds, frameCentreSeconds, duration: buffer.duration };
}

/**
 * Autocorrelation of the flux over a musical tempo range.
 *
 * Weighted by a log-normal prior centred on 120bpm. Raw autocorrelation cannot
 * tell 120 from 60 — every beat also lands on every other beat, so both lags
 * peak — and picking the bare maximum reports the half-tempo about as often as
 * the right one. The prior breaks the tie the way a listener would.
 */
function estimateTempo(flux, hopSeconds, { centre = 120, spread = 0.9 } = {}) {
  const minBpm = 60, maxBpm = 190;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / hopSeconds));
  const maxLag = Math.ceil(60 / minBpm / hopSeconds);
  if (maxLag >= flux.length) return 0;

  let mean = 0;
  for (const v of flux) mean += v;
  mean /= flux.length;

  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < flux.length; i++) s += (flux[i] - mean) * (flux[i + lag] - mean);
    s /= (flux.length - lag);

    const bpm = 60 / (lag * hopSeconds);
    const oct = Math.log2(bpm / centre) / spread;
    const weighted = s * Math.exp(-0.5 * oct * oct);

    if (weighted > best) { best = weighted; bestLag = lag; }
  }
  return bestLag ? Math.round(60 / (bestLag * hopSeconds)) : 0;
}

/** A steady grid, for when you want the cuts metronomic instead of reactive. */
export function beatGrid(bpm, duration, offset = 0, division = 1) {
  if (!bpm) return [];
  const step = (60 / bpm) * division;
  const out = [];
  for (let t = offset; t < duration; t += step) out.push(t);
  return out;
}

/**
 * Live energy from a playing element. Drives the breathe/chroma response.
 * Returns a getter rather than a stream so the render loop stays in control.
 */
export function createEnergyTap(audioCtx, sourceNode, { smoothing = 0.75 } = {}) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = smoothing;
  sourceNode.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);

  return {
    analyser,
    /** @returns {{level:number, bass:number}} both 0..1 */
    read() {
      analyser.getByteFrequencyData(bins);
      let all = 0, low = 0;
      const lowN = Math.max(1, Math.floor(bins.length * 0.12));
      for (let i = 0; i < bins.length; i++) {
        all += bins[i];
        if (i < lowN) low += bins[i];
      }
      return {
        level: all / bins.length / 255,
        bass: low / lowN / 255,
      };
    },
  };
}
