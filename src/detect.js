/**
 * DETECT — lyric placement.
 * ----------------------------------------------------------------------------
 * The premise, which is the opposite of how most tools build this:
 *
 *   TIMING is the product. WORDS are a draft.
 *
 * Transcribing sung vocals is unreliable — models trained on speech hallucinate
 * and loop on music, and the tool this was modelled on demonstrates it, looping
 * one phrase five times and giving up 15 seconds into a three-minute track.
 * But you do not need to know WHAT is being sung to know WHEN it is being sung,
 * and "when" is the part that is tedious to fix by hand.
 *
 * So the skeleton — where phrases start and stop, where each word lands — is
 * derived from the signal, with no model and no network. ASR only fills in
 * guesses at the words, and every one of them is editable. Rewrite a line
 * completely and the timing still holds, because the timing was never stored
 * on the words in the first place: reflow() redistributes whatever text you
 * give it across the same measured span.
 */

/* ---------------------------------------------------------------------------
 * Phrase segmentation
 * ------------------------------------------------------------------------- */

const smooth = (src, radius) => {
  const out = new Float32Array(src.length);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i > 2 * radius) sum -= src[i - 2 * radius - 1];
    out[Math.max(0, i - radius)] = sum / Math.min(i + 1, 2 * radius + 1);
  }
  return out;
};

/**
 * Sung spans, from the vocalness envelope produced by analyseAudio().
 *
 * @param {object} analysis  { vocalness, hopSeconds, duration }
 * @param {object} opts
 * @returns {Array<{start:number,end:number,energy:number}>}
 */
export function segmentPhrases(analysis, opts = {}) {
  const {
    enter = 0.26,      // hysteresis: rise above this to open a phrase
    exit = 0.16,       // fall below this to close it
    mergeGap = 0.70,   // breaths and held notes are not new lines
    minLength = 0.45,
    maxLength = 7.0,   // longer than this is not a lyric line
    smoothMs = 140,
  } = opts;

  const { vocalness: v, hopSeconds: hop, frameCentreSeconds = 0 } = analysis;
  if (!v || !v.length) return [];

  const env = smooth(v, Math.max(1, Math.round((smoothMs / 1000) / hop / 2)));

  // Hysteresis rather than a single threshold: one threshold chatters on and
  // off through every held note, producing dozens of 60ms fragments.
  const spans = [];
  let open = null;
  for (let f = 0; f < env.length; f++) {
    if (!open && env[f] > enter) {
      // Hysteresis confirms a phrase at the high threshold, but the audible
      // attack began on the preceding rise. Walk back to the low threshold so
      // the timestamp marks the start of singing rather than confirmation.
      let start = f;
      while (start > 0 && env[start - 1] > exit) start--;
      open = { start, peak: env[f] };
    }
    else if (open) {
      open.peak = Math.max(open.peak, env[f]);
      if (env[f] < exit) { spans.push({ ...open, end: f }); open = null; }
    }
  }
  if (open) spans.push({ ...open, end: env.length - 1 });

  // merge, drop, split — in that order
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && (s.start - last.end) * hop < mergeGap) {
      last.end = s.end;
      last.peak = Math.max(last.peak, s.peak);
    } else merged.push({ ...s });
  }

  const out = [];
  for (const s of merged) {
    if ((s.end - s.start) * hop < minLength) continue;
    let cursor = s.start;
    while ((s.end - cursor) * hop > maxLength) {
      // split at the quietest interior frame in the back half of the window,
      // so the break lands in a gap rather than mid-word
      const from = cursor + Math.round((maxLength * 0.6) / hop);
      const to = Math.min(s.end, cursor + Math.round(maxLength / hop));
      let best = from, bestV = Infinity;
      for (let f = from; f < to; f++) if (env[f] < bestV) { bestV = env[f]; best = f; }
      out.push({
        start: cursor * hop + frameCentreSeconds,
        end: best * hop + frameCentreSeconds,
        energy: s.peak,
      });
      cursor = best;
    }
    out.push({
      start: cursor * hop + frameCentreSeconds,
      end: s.end * hop + frameCentreSeconds,
      energy: s.peak,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Word distribution
 * ------------------------------------------------------------------------- */

/**
 * Syllable estimate by vowel groups.
 *
 * Deliberately language-loose: it counts vowel clusters and trims a silent
 * terminal 'e'. That is a decent approximation for English and a good one for
 * the vowel-regular languages (Malay, Indonesian, Italian, Japanese romaji),
 * which matters when the track being captioned is not in English.
 */
export function countSyllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (n > 1 && /[^aeiou]e$/.test(w)) n--;      // silent terminal e
  return Math.max(1, n);
}

/**
 * Lay words across a span, then pull each onto a real onset if one is close.
 *
 * Proportional-by-syllable alone gives metronomic spacing that reads as fake.
 * Snapping to detected onsets puts the words on the actual attacks, which is
 * what makes the result feel synced rather than merely sequenced. The snap is
 * bounded and order-preserving so a dense onset cluster can't reorder a line.
 *
 * @param {string[]} words
 * @param {{start:number,end:number}} span
 * @param {number[]} onsets   sorted
 * @param {object} opts
 */
export function distributeWords(words, span, onsets = [], opts = {}) {
  const { snapWindow = 0.13, minGap = 0.055, holdLast = 0.18 } = opts;
  if (!words.length) return [];

  const weights = words.map(countSyllables);
  const total = weights.reduce((a, b) => a + b, 0);
  const usable = Math.max(0.1, (span.end - span.start) - holdLast);

  // proportional pass
  let t = span.start;
  const placed = words.map((word, i) => {
    const start = t;
    t += (weights[i] / total) * usable;
    return { word, start };
  });

  // snap pass — nearest onset inside the window, monotonic
  let floor = span.start - 0.001;
  for (let i = 0; i < placed.length; i++) {
    const target = placed[i].start;
    let best = target, bestD = snapWindow;
    // onsets are sorted; a linear scan is fine at lyric densities
    for (const o of onsets) {
      if (o < target - snapWindow) continue;
      if (o > target + snapWindow) break;
      const d = Math.abs(o - target);
      if (d < bestD && o > floor) { bestD = d; best = o; }
    }
    placed[i].start = Math.max(best, floor + minGap * (i > 0 ? 1 : 0));
    floor = placed[i].start;
  }

  // never let a snap push a word past the end of its own phrase
  const cap = span.end - minGap;
  for (let i = placed.length - 1; i >= 0; i--) {
    if (placed[i].start > cap - (placed.length - 1 - i) * minGap) {
      placed[i].start = cap - (placed.length - 1 - i) * minGap;
    }
  }
  return placed;
}

/* ---------------------------------------------------------------------------
 * Assembling and re-flowing lines
 * ------------------------------------------------------------------------- */

/**
 * Build editable lines from a skeleton plus (optionally) transcribed text.
 *
 * @param {Array} spans    from segmentPhrases()
 * @param {number[]} onsets
 * @param {string[]} texts one draft line per span; missing entries become
 *                         placeholders you can type over
 */
export function buildLines(spans, onsets, texts = []) {
  return spans.map((span, i) => {
    const text = (texts[i] || '').trim();
    const words = text ? text.split(/\s+/) : [];
    return {
      start: span.start,
      end: span.end,
      text,
      confidence: span.energy ?? 0,
      words: words.length ? distributeWords(words, span, onsets) : [],
    };
  });
}

/**
 * Re-derive word timings after the text of a line changed.
 *
 * This is the point of separating timing from words: you can retype a line
 * entirely, add words, delete words, and the line still lands where the singing
 * actually is, because the span was measured from the audio and never moved.
 */
export function reflow(line, onsets, opts) {
  const words = (line.text || '').trim().split(/\s+/).filter(Boolean);
  return {
    ...line,
    words: words.length
      ? distributeWords(words, { start: line.start, end: line.end }, onsets, opts)
      : [],
  };
}

/** Move a line boundary and re-place its words inside the corrected span. */
export function setLineStart(line, start, onsets, opts) {
  const nextStart = Math.max(0, Math.min(Number(start), line.end - 0.1));
  if (!Number.isFinite(nextStart)) return line;
  return reflow({ ...line, start: nextStart }, onsets, opts);
}

/** Slide a whole line earlier or later without changing its length. */
export function nudgeLine(line, dt, onsets, opts) {
  if (!Number.isFinite(dt) || !dt) return line;
  const len = Math.max(0.1, line.end - line.start);
  const start = Math.max(0, line.start + dt);
  return reflow({ ...line, start, end: start + len }, onsets, opts);
}

/**
 * Force a set of detected spans down (or up) to exactly `n` lines.
 *
 * This is the fix for "40 phrases, 12 lyric lines": the waveform over-segments
 * breaths and held notes. The lyric sheet is the authority on how many lines
 * exist; adjacent fragments get merged (shortest gap / tiniest span first) or
 * the longest span is split until the counts match.
 */
export function matchSpansToLines(spans, n) {
  if (!spans.length || n <= 0) return [];
  const out = spans.map(s => ({ ...s }));
  while (out.length > n) {
    let best = 0, bestCost = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const gap = Math.max(0, out[i + 1].start - out[i].end);
      const short = Math.min(out[i].end - out[i].start, out[i + 1].end - out[i + 1].start);
      const cost = gap + short * 0.15;
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    const a = out[best], b = out[best + 1];
    out.splice(best, 2, {
      start: a.start,
      end: b.end,
      energy: Math.max(a.energy ?? 0, b.energy ?? 0),
    });
  }
  while (out.length < n) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < out.length; i++) {
      const len = out[i].end - out[i].start;
      if (len > bestLen) { bestLen = len; best = i; }
    }
    const s = out[best];
    const mid = (s.start + s.end) / 2;
    out.splice(best, 1,
      { start: s.start, end: mid, energy: s.energy },
      { start: mid, end: s.end, energy: s.energy });
  }
  return out;
}

/** Lines -> the enhanced-LRC the engine already parses. */
export function linesToLRC(lines) {
  const fmt = (t) => {
    const m = Math.floor(t / 60), s = Math.max(0, t - m * 60);
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  return lines
    .filter(l => l.text && l.text.trim())
    .map(l => l.words?.length
      ? `[${fmt(l.start)}]` + l.words.map(w => `<${fmt(w.start)}>${w.word}`).join(' ')
      : `[${fmt(l.start)}]${l.text}`)
    .join('\n');
}

/**
 * Place lyrics you already have onto the measured phrases.
 *
 * For anyone captioning their OWN music this beats transcription outright:
 * you already know the words, and the only hard part — when each one lands —
 * is exactly what the skeleton measured. No model, no download, no guessing at
 * a mumbled line.
 *
 * When the counts disagree, spans are merged or split until they match the
 * lyric sheet. Forty detected fragments and twelve typed lines become twelve
 * phrases; the sheet is the authority on how many lines exist.
 *
 * @param {Array} spans
 * @param {string} lyricText  plain text, one line per lyric line
 * @param {number[]} onsets
 */
export function placeLyrics(spans, lyricText, onsets = []) {
  const texts = String(lyricText || '')
    .split(/\r?\n/).map(t => t.trim()).filter(Boolean);
  if (!spans.length) return { lines: [], unplaced: texts.length, spare: 0 };
  if (!texts.length) return { lines: buildLines(spans, onsets, []), unplaced: 0, spare: spans.length };

  const fitted = matchSpansToLines(spans, texts.length);
  return { lines: buildLines(fitted, onsets, texts), unplaced: 0, spare: 0 };
}

/* ---------------------------------------------------------------------------
 * Optional ASR
 * ------------------------------------------------------------------------- */

export const ASR_MODELS = {
  tiny:  { id: 'onnx-community/whisper-tiny_timestamped',  mb: 40  },
  base:  { id: 'onnx-community/whisper-base_timestamped',  mb: 78  },
  small: { id: 'onnx-community/whisper-small_timestamped', mb: 250 },
};

let _pipe = null, _pipeKey = null;

const yieldUI = () => new Promise(r => setTimeout(r, 0));

function withTimeout(promise, ms, message) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

async function pickDevice() {
  if (navigator.gpu?.requestAdapter) {
    try {
      if (await navigator.gpu.requestAdapter()) return 'webgpu';
    } catch { /* fall through */ }
  }
  return 'wasm';
}

/** Downmix + resample to the 16kHz mono Float32 that Whisper expects. */
async function toWhisperInput(buffer) {
  const target = 16000;
  if (buffer.sampleRate === target && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Off(1, Math.ceil(buffer.duration * target), target);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

function wordsFromOutput(out, offset = 0) {
  const words = [];
  for (const c of out.chunks || []) {
    const stamp = Array.isArray(c.timestamp) ? c.timestamp : [c.timestamp, c.timestamp];
    const t0 = stamp[0], t1 = stamp[1] ?? t0;
    const toks = String(c.text || '').trim().split(/\s+/).filter(Boolean);
    if (!toks.length || !Number.isFinite(t0)) continue;
    const span = Math.max(0.08, (Number.isFinite(t1) ? t1 : t0) - t0);
    toks.forEach((word, i) => {
      words.push({ word, start: offset + t0 + span * (i / toks.length) });
    });
  }
  return words;
}

/**
 * Transcribe with Whisper running locally in the browser.
 *
 * Entirely optional. The model weights are fetched from the Hugging Face CDN,
 * so this is the one part of the pipeline that needs network — and it is the
 * part that fails first behind a restrictive CSP or an offline machine. Every
 * caller must handle rejection and fall back to the model-free skeleton, which
 * is why placement never depends on this succeeding.
 *
 * @returns {Promise<{lines:string[], words:Array<{word:string,start:number}>}>}
 */
export async function transcribe(buffer, opts = {}) {
  const {
    model = 'base',
    language = null,           // null = auto-detect
    onProgress = () => {},
    cdn = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
  } = opts;

  const spec = ASR_MODELS[model] || ASR_MODELS.base;
  onProgress({ stage: 'loading', detail: `${spec.mb}MB model`, progress: 0 });
  await yieldUI();

  const { pipeline } = await import(/* @vite-ignore */ `${cdn}/+esm`);

  let device = await pickDevice();
  // Full fp32 small on WebGPU compiles for minutes or never comes back.
  const dtype = device === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q8' }
    : 'q8';
  const key = `${spec.id}:${device}:${typeof dtype === 'string' ? dtype : 'hybrid'}`;
  if (_pipeKey !== key) {
    const load = (dev, dt) => pipeline('automatic-speech-recognition', spec.id, {
      device: dev,
      dtype: dt,
      progress_callback: (p) => {
        if (p.status !== 'progress') return;
        const frac = p.total ? p.loaded / p.total
          : (p.progress > 1 ? p.progress / 100 : p.progress || 0);
        const file = String(p.file || '').split('/').pop();
        onProgress({ stage: 'loading', detail: file || `${spec.mb}MB`, progress: frac });
      },
    });
    try {
      _pipe = await withTimeout(load(device, dtype), 180000,
        `downloading ${spec.id.split('/').pop()} timed out`);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      device = 'wasm';
      _pipe = await withTimeout(load('wasm', 'q8'), 180000,
        `downloading ${spec.id.split('/').pop()} timed out`);
    }
    _pipeKey = `${spec.id}:${device}:${device === 'webgpu' ? 'hybrid' : 'q8'}`;
  }

  onProgress({ stage: 'resampling', detail: 'resampling', progress: 0 });
  await yieldUI();
  const audio = await toWhisperInput(buffer);
  const sr = 16000;
  const duration = audio.length / sr;

  const decode = { ...(language ? { language, task: 'transcribe' } : {}) };
  const runChunk = async (samples) => {
    try {
      return await _pipe(samples, { ...decode, return_timestamps: 'word' });
    } catch {
      return await _pipe(samples, { ...decode, return_timestamps: true });
    }
  };

  // One shot over the whole file is what looked "stuck": no ticks, main thread
  // blocked, small+attentions on a 3 minute mix. 30s slices keep the bar moving.
  const size = 30, overlap = 2;
  const windows = [];
  if (duration <= size) windows.push({ start: 0, end: duration });
  else {
    for (let t = 0; t < duration; t += size - overlap) {
      const end = Math.min(duration, t + size);
      windows.push({ start: t, end });
      if (end >= duration) break;
    }
  }

  const words = [];
  const texts = [];
  for (let i = 0; i < windows.length; i++) {
    const { start, end } = windows[i];
    onProgress({
      stage: 'transcribing',
      detail: `transcribing ${start.toFixed(0)}–${end.toFixed(0)}s of ${duration.toFixed(0)}s`,
      progress: i / windows.length,
    });
    await yieldUI();
    const view = audio.subarray(Math.floor(start * sr), Math.max(1, Math.ceil(end * sr)));
    // onnxruntime rejects a subarray view (non-zero byteOffset) as the input.
    const piece = new Float32Array(view);
    const out = await withTimeout(runChunk(piece), 180000,
      'whisper froze on this slice — try base, or paste the lyrics');
    texts.push(out.text || '');
    const cut = i === 0 ? -1 : start + overlap / 2;
    for (const w of wordsFromOutput(out, start)) {
      if (w.start >= cut) words.push(w);
    }
  }
  onProgress({ stage: 'transcribing', detail: 'transcribing', progress: 1 });

  return { text: texts.join(' ').trim(), words };
}

/**
 * Fit transcribed words onto the measured spans.
 *
 * Whisper's own segment boundaries drift and sometimes run past the end of the
 * track; the spans do not, because they came from the waveform. So words are
 * assigned to whichever span they fall inside (or nearest, within a tolerance)
 * and the span keeps authority over the timing.
 */
export function attachTranscript(spans, asrWords, tolerance = 0.6) {
  const texts = spans.map(() => []);
  for (const w of asrWords) {
    let idx = -1, bestD = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (w.start >= s.start - tolerance && w.start <= s.end + tolerance) {
        const d = w.start < s.start ? s.start - w.start
                : w.start > s.end   ? w.start - s.end : 0;
        if (d < bestD) { bestD = d; idx = i; }
        if (d === 0) break;
      }
    }
    if (idx >= 0) texts[idx].push(w.word);
  }
  return texts.map(t => t.join(' ').replace(/\s+([,.!?])/g, '$1').trim());
}

/** Did ASR clearly loop? Whisper does this on music and it should be flagged. */
export function findRepeats(texts, run = 3) {
  const flags = new Set();
  for (let i = 0; i + run <= texts.length; i++) {
    const a = texts[i].toLowerCase().trim();
    if (!a) continue;
    let n = 1;
    while (i + n < texts.length && texts[i + n].toLowerCase().trim() === a) n++;
    if (n >= run) for (let k = i; k < i + n; k++) flags.add(k);
  }
  return flags;
}
