/**
 * APP — the harness around the engine.
 * Wiring and UI only; everything interesting lives in the modules it imports.
 */
import { PosterEngine, DEFAULTS } from './poster-engine.js';
import { FX_PRESETS } from './poster-fx.js';
import { parseLyrics, analyseAudio, beatGrid, createEnergyTap } from './sync.js';
import { segmentPhrases, buildLines, reflow, linesToLRC, placeLyrics,
         transcribe, attachTranscript, findRepeats, setLineStart, nudgeLine } from './detect.js';
import { defaultBackdrops, createBackdrop, BACKDROP_KINDS } from './backdrops.js';

// Mixed on purpose: the first two lines carry word-level <mm:ss.xx> stamps so
// the per-word emphasis has something to key off, the rest are phrase-timed.
export const DEFAULT_LRC = `[00:00.30]<00:00.30>I <00:00.62>just <00:01.05>wanna <00:01.55>hold <00:02.05>you
[00:02.60]<00:02.60>Never <00:03.10>let <00:03.45>you <00:03.80>go
[00:04.90]Say it like you mean it
[00:07.20]Say it slow
[00:09.50]Everything I never said out loud`;

const FONTS = [
  ['Inter', '"Inter", Helvetica, Arial, sans-serif'],
  ['Archivo', '"Archivo", Helvetica, Arial, sans-serif'],
  ['Poppins', '"Poppins", Helvetica, Arial, sans-serif'],
  ['Anton', '"Anton", Impact, sans-serif'],
  ['Space Grotesk', '"Space Grotesk", Helvetica, sans-serif'],
  ['Helvetica', 'Helvetica, Arial, sans-serif'],
  ['Georgia', 'Georgia, "Times New Roman", serif'],
];

export async function boot(THREE, root) {
  const $ = (s, r = root) => r.querySelector(s);

  /* ---- fonts must be resident before we measure anything ---------------- */
  const status = $('#status');
  status.textContent = 'loading fonts';
  try {
    await document.fonts.ready;
    await Promise.all(FONTS.flatMap(([, stack]) =>
      [400, 700, 900].map(w => document.fonts.load(`${w} 120px ${stack.split(',')[0]}`))));
  } catch { /* system fonts are fine */ }

  /* ---- engine ----------------------------------------------------------- */
  const canvas = $('#stage');
  const engine = new PosterEngine(THREE, canvas, {
    width: 1080, height: 1920,
    font: { family: FONTS[0][1], weight: 900, tracking: -0.015 },
  });

  const backdrops = defaultBackdrops();
  engine.setBackdrops(backdrops.map(b => b.canvas));

  const state = {
    lrc: DEFAULT_LRC,
    duration: 12,
    playing: true,
    t: 0,
    audio: null, audioEl: null, tap: null,
    buffer: null, analysis: null, lines: [],
    onsets: beatGrid(120, 12, 0.3, 1),
    wordOnsets: beatGrid(120, 12, 0.3, 1),
    bpm: 120,
    backdropKinds: backdrops.map(b => b.kind),
  };

  function reloadLyrics() {
    const phrases = parseLyrics(state.lrc, { duration: state.duration });
    engine.setLyrics(phrases);
    const last = phrases[phrases.length - 1];
    if (!state.audioEl && last) state.duration = Math.max(6, last.end + 0.8);
    return phrases;
  }
  reloadLyrics();
  engine.setOnsets(state.onsets);

  /* ---- controls --------------------------------------------------------- */
  const panel = $('#controls');

  const control = (spec) => {
    const row = document.createElement('label');
    row.className = 'row' + (spec.wide ? ' wide' : '');
    const name = document.createElement('span');
    name.className = 'k';
    name.textContent = spec.label;
    row.appendChild(name);

    let input, readout;
    if (spec.type === 'range') {
      input = document.createElement('input');
      Object.assign(input, { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: spec.value });
      readout = document.createElement('output');
      readout.textContent = (+spec.value).toFixed(spec.dp ?? 2);
    } else if (spec.type === 'select') {
      input = document.createElement('select');
      for (const o of spec.options) {
        const opt = document.createElement('option');
        const [v, t] = Array.isArray(o) ? o : [o, o];
        opt.value = v; opt.textContent = t;
        input.appendChild(opt);
      }
      input.value = spec.value;
    } else if (spec.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox'; input.checked = spec.value;
    } else if (spec.type === 'color') {
      input = document.createElement('input');
      input.type = 'color'; input.value = spec.value;
    }
    input.className = 'c';
    row.appendChild(input);
    if (readout) row.appendChild(readout);

    const fire = () => {
      const v = spec.type === 'toggle' ? input.checked
              : spec.type === 'range' ? +input.value
              : input.value;
      if (readout) readout.textContent = (+v).toFixed(spec.dp ?? 2);
      spec.on(v);
    };
    input.addEventListener('input', fire);
    return { row, input, fire };
  };

  const group = (title, specs) => {
    const sec = document.createElement('section');
    sec.className = 'group';
    const h = document.createElement('h3'); h.textContent = title;
    sec.appendChild(h);
    for (const s of specs) sec.appendChild(control(s).row);
    panel.appendChild(sec);
    return sec;
  };

  const set = (k) => (v) => engine.set({ [k]: v });
  const setFont = (k) => (v) => engine.set({ font: { ...engine.opt.font, [k]: v } });

  group('Type', [
    { label: 'Face', type: 'select', options: FONTS.map(([n, s]) => [s, n]), value: FONTS[0][1], on: setFont('family') },
    { label: 'Weight', type: 'range', min: 300, max: 900, step: 100, value: 900, dp: 0, on: setFont('weight') },
    { label: 'Tracking', type: 'range', min: -0.06, max: 0.15, step: 0.005, value: -0.015, dp: 3, on: setFont('tracking') },
    { label: 'Caps', type: 'toggle', value: true, on: set('uppercase') },
    { label: 'Fill', type: 'range', min: 0.5, max: 1, step: 0.01, value: 0.9, on: set('fill') },
    { label: 'Leading', type: 'range', min: 0.85, max: 1.6, step: 0.01, value: 1.03, on: set('leading') },
    { label: 'Max lines', type: 'range', min: 1, max: 8, step: 1, value: 6, dp: 0, on: set('maxLines') },
    { label: 'Align', type: 'select', options: ['top', 'center', 'bottom'], value: 'center', on: set('align') },
  ]);

  group('Colour', [
    { label: 'Ink', type: 'color', value: '#ffffff', on: set('color') },
    { label: 'Blend', type: 'select',
      options: ['difference', 'normal', 'exclusion', 'multiply', 'screen', 'knockout'],
      value: 'difference', on: set('blend') },
  ]);

  group('Motion', [
    { label: 'Reveal', type: 'select', options: ['wipe', 'fade', 'cut'], value: 'wipe', on: set('reveal') },
    { label: 'Enter', type: 'range', min: 0.05, max: 0.8, step: 0.01, value: 0.24, on: set('enter') },
    { label: 'Stagger', type: 'range', min: 0, max: 0.2, step: 0.005, value: 0.035, dp: 3, on: set('lineStagger') },
    { label: 'Emphasis', type: 'select', options: ['contrast', 'scale', 'none'], value: 'contrast', on: set('emphasis') },
    { label: 'Amount', type: 'range', min: 0, max: 1, step: 0.05, value: 1, on: set('emphasisAmount') },
    { label: 'Breathe', type: 'range', min: 0, max: 0.05, step: 0.002, value: 0.006, dp: 3, on: set('breathe') },
  ]);

  group('Backdrop', [
    { label: 'Cut on', type: 'select', options: [['onset', 'onsets'], ['off', 'hold']], value: 'onset', on: set('backdropSwitch') },
    { label: 'Crossfade', type: 'range', min: 0.001, max: 0.6, step: 0.005, value: 0.06, dp: 3, on: set('backdropCross') },
    { label: 'Clip A', type: 'select', options: BACKDROP_KINDS, value: 'flash', on: v => swapBackdrop(0, v) },
    { label: 'Clip B', type: 'select', options: BACKDROP_KINDS, value: 'bars', on: v => swapBackdrop(1, v) },
    { label: 'Clip C', type: 'select', options: BACKDROP_KINDS, value: 'rings', on: v => swapBackdrop(2, v) },
    { label: 'Clip D', type: 'select', options: BACKDROP_KINDS, value: 'noise', on: v => swapBackdrop(3, v) },
  ]);

  const fxu = (pass, name) => (v) => { engine[pass].uniforms[name].value = v; };
  const fxGroup = group('Finish', [
    { label: 'Preset', type: 'select', options: Object.keys(FX_PRESETS), value: 'beatsee',
      on: v => { engine.applyFXPreset(v); syncFX(); } },
    { label: 'Screen', type: 'select', options: [[0, 'mono'], [1, 'duotone'], [2, 'CMYK']], value: 0,
      on: v => fxu('halftone', 'uMode')(+v) },
    { label: 'Dot pitch', type: 'range', min: 2, max: 24, step: 0.5, value: 7, dp: 1, on: fxu('halftone', 'uCell') },
    { label: 'Screen mix', type: 'range', min: 0, max: 1, step: 0.02, value: 0.85, on: fxu('halftone', 'uAmount') },
    { label: 'Ink weight', type: 'range', min: 0.4, max: 2.5, step: 0.05, value: 1.15, on: fxu('halftone', 'uContrast') },
    { label: 'Grain', type: 'range', min: 0, max: 0.4, step: 0.01, value: 0.10, on: fxu('lofi', 'uGrain') },
    { label: 'Chroma', type: 'range', min: 0, max: 0.008, step: 0.0002, value: 0.0012, dp: 4, on: fxu('lofi', 'uChroma') },
    { label: 'Vignette', type: 'range', min: 0, max: 0.8, step: 0.02, value: 0.30, on: fxu('lofi', 'uVignette') },
    { label: 'Scanline', type: 'range', min: 0, max: 0.8, step: 0.02, value: 0, on: fxu('lofi', 'uScanline') },
  ]);

  // Reflect preset changes back into the sliders.
  function syncFX() {
    const rows = [...fxGroup.querySelectorAll('.row')];
    const map = [
      null, ['halftone', 'uMode'], ['halftone', 'uCell'], ['halftone', 'uAmount'],
      ['halftone', 'uContrast'], ['lofi', 'uGrain'], ['lofi', 'uChroma'],
      ['lofi', 'uVignette'], ['lofi', 'uScanline'],
    ];
    rows.forEach((row, i) => {
      const m = map[i]; if (!m) return;
      const input = row.querySelector('.c');
      const out = row.querySelector('output');
      const v = engine[m[0]].uniforms[m[1]].value;
      input.value = v;
      if (out) out.textContent = (+v).toFixed(+input.step < 0.001 ? 4 : +input.step < 0.01 ? 3 : 2);
    });
  }

  function swapBackdrop(i, kind) {
    backdrops[i] = createBackdrop(kind, { seed: i * 37 });
    state.backdropKinds[i] = kind;
    engine.setBackdrops(backdrops.map(b => b.canvas));
  }

  /* ---- lyrics + audio --------------------------------------------------- */
  const lrcBox = $('#lrc');
  lrcBox.value = DEFAULT_LRC;
  lrcBox.addEventListener('input', () => { state.lrc = lrcBox.value; reloadLyrics(); });

  /* ---- detection -------------------------------------------------------- */
  const detectBtn = $('#detect');
  const detectStatus = $('#detectStatus');
  const prog = $('#prog'), progBar = prog.querySelector('i');
  const pasteBox = $('#pasteLyrics');
  const wordSource = $('#wordSource');
  const snaps = () => state.wordOnsets.length ? state.wordOnsets : state.onsets;
  const linesGroup = $('#linesGroup');
  const lineList = $('#lineList');

  const say = (msg, warn = false) => {
    detectStatus.textContent = msg;
    detectStatus.classList.toggle('warn', warn);
  };
  const setProgress = (p) => {
    prog.hidden = p == null;
    if (p != null) progBar.style.width = `${Math.round(p * 100)}%`;
  };

  wordSource.addEventListener('change', () => {
    pasteBox.hidden = wordSource.value !== 'paste';
  });

  $('#audio').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    say('decoding…');
    detectBtn.disabled = true;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      state.buffer = buf;
      state.duration = buf.duration;

      const el = new Audio(URL.createObjectURL(file));
      el.loop = true;
      const src = ctx.createMediaElementSource(el);
      src.connect(ctx.destination);
      state.tap = createEnergyTap(ctx, src);
      state.audioEl = el; state.audio = ctx;
      await ctx.resume();
      // Autoplay may be refused until the user interacts; reflect what actually
      // happened rather than leaving the transport lying about its state.
      await el.play().catch(() => {});
      state.playing = !el.paused;
      play.textContent = state.playing ? '❚❚' : '▶';

      say('analysing…');
      await new Promise(r => setTimeout(r, 0));
      state.analysis = analyseAudio(buf);
      state.onsets = state.analysis.onsets;
      state.wordOnsets = state.analysis.vocalOnsets?.length
        ? state.analysis.vocalOnsets : state.analysis.onsets;
      state.bpm = state.analysis.bpm;
      engine.setOnsets(state.onsets);

      detectBtn.disabled = false;
      say(`${buf.duration.toFixed(0)}s · ${state.bpm} bpm · ${state.onsets.length} onsets. Ready to detect.`);
      status.textContent = `${state.bpm} bpm · ${state.onsets.length} onsets`;
    } catch (err) {
      say(`could not read that file — ${err.message}`, true);
    }
  });

  detectBtn.addEventListener('click', async () => {
    if (!state.analysis) return;
    detectBtn.disabled = true;

    const mode = wordSource.value;
    const spans = segmentPhrases(state.analysis, { enter: +$('#sens').value,
                                                   exit: +$('#sens').value * 0.62 });
    if (!spans.length) {
      say('no sung phrases found — try lowering sensitivity', true);
      detectBtn.disabled = false;
      return;
    }
    let flagged = new Set();

    try {
      if (mode === 'paste') {
        const r = placeLyrics(spans, pasteBox.value, snaps());
        state.lines = r.lines;
        say(`${r.lines.length} lyric lines placed on the vocal`);
      } else if (mode === 'none') {
        state.lines = buildLines(spans, snaps(), []);
        say(`${spans.length} phrases timed — type the words in`);
      } else {
        setProgress(0);
        const { words } = await transcribe(state.buffer, {
          model: mode,
          onProgress: ({ stage, progress, detail }) => {
            say(stage === 'loading' ? `downloading ${detail || 'model'}…`
              : stage === 'resampling' ? 'resampling…'
              : detail || 'transcribing…');
            setProgress(progress ?? 0);
          },
        });
        setProgress(null);
        const texts = attachTranscript(spans, words);
        flagged = findRepeats(texts);
        state.lines = buildLines(spans, snaps(), texts);
        say(flagged.size
          ? `${spans.length} phrases · ${flagged.size} look looped (highlighted) — retype those`
          : `${spans.length} phrases transcribed — check the words`, flagged.size > 0);
      }
    } catch (err) {
      setProgress(null);
      if (spans.length) state.lines = buildLines(spans, snaps(), []);
      say(`${err.message.slice(0, 80)}${spans.length ? ' — timing still detected, type the words in' : ''}`, true);
    }

    renderLines(flagged);
    applyLines();
    detectBtn.disabled = false;
  });

  function renderLines(flagged = new Set()) {
    linesGroup.hidden = false;
    lineList.innerHTML = '';
    state.lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'lyr' + (flagged.has(i) ? ' flag' : '');
      row.dataset.i = String(i);

      const t = document.createElement('button');
      t.className = 't';
      t.type = 'button';
      const m = Math.floor(line.start / 60), sec = line.start % 60;
      t.textContent = `${m}:${sec.toFixed(2).padStart(5, '0')}`;
      t.title = 'Jump here';
      t.addEventListener('click', () => {
        state.t = line.start;
        if (state.audioEl) state.audioEl.currentTime = line.start;
      });

      const sync = document.createElement('button');
      sync.className = 'sync';
      sync.type = 'button';
      sync.textContent = 'set';
      sync.title = 'Set this line start to the current playhead';
      sync.addEventListener('click', () => {
        const playhead = state.audioEl?.currentTime ?? state.t;
        rewriteLine(i, setLineStart(state.lines[i], playhead, snaps()), t);
      });

      const earlier = document.createElement('button');
      earlier.className = 'nudge';
      earlier.type = 'button';
      earlier.textContent = '−';
      earlier.title = 'Nudge 80ms earlier';
      earlier.addEventListener('click', () => {
        rewriteLine(i, nudgeLine(state.lines[i], -0.08, snaps()), t);
      });

      const later = document.createElement('button');
      later.className = 'nudge';
      later.type = 'button';
      later.textContent = '+';
      later.title = 'Nudge 80ms later';
      later.addEventListener('click', () => {
        rewriteLine(i, nudgeLine(state.lines[i], 0.08, snaps()), t);
      });

      const drop = document.createElement('button');
      drop.className = 'drop';
      drop.type = 'button';
      drop.textContent = '×';
      drop.title = 'Delete this line';
      drop.addEventListener('click', () => {
        state.lines.splice(i, 1);
        renderLines();
        applyLines();
      });

      const input = document.createElement('input');
      input.value = line.text;
      input.placeholder = 'type this line…';
      input.addEventListener('input', () => {
        state.lines[i].text = input.value;
        state.lines[i] = reflow(state.lines[i], snaps());
        row.classList.remove('flag');
        clearTimeout(applyLines._t);
        applyLines._t = setTimeout(applyLines, 220);
      });

      row.append(t, input, earlier, later, sync, drop);
      lineList.appendChild(row);
    });
    $('#tally').textContent =
      `${state.lines.length} phrases · ${state.lines.filter(l => l.text).length} with words`;
    $('#tallyWarn').textContent = flagged.size ? `${flagged.size} looped` : '';
  }

  function stamp(el, start) {
    const m = Math.floor(start / 60), sec = start % 60;
    el.textContent = `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  }

  function rewriteLine(i, next, stampEl) {
    state.lines[i] = next;
    stamp(stampEl, next.start);
    applyLines();
  }

  function applyLines() {
    const lrc = linesToLRC(state.lines);
    state.lrc = lrc;
    lrcBox.value = lrc;
    engine.setLyrics(parseLyrics(lrc, { duration: state.duration }));
  }

  $('#applyLines').addEventListener('click', applyLines);
  $('#showRaw').addEventListener('click', () => {
    const g = $('#rawGroup');
    g.hidden = !g.hidden;
    $('#showRaw').textContent = g.hidden ? 'Show raw LRC' : 'Hide raw LRC';
  });

  $('#videos').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])].slice(0, 4);
    if (!files.length) return;
    const els = files.map(f => {
      const v = document.createElement('video');
      v.src = URL.createObjectURL(f);
      v.muted = true; v.loop = true; v.playsInline = true;
      v.play().catch(() => {});
      return v;
    });
    engine.setBackdrops(els);
    status.textContent = `${els.length} clip${els.length > 1 ? 's' : ''}`;
  });

  /* ---- transport -------------------------------------------------------- */
  const scrub = $('#scrub');
  const clock = $('#clock');
  const play = $('#play');
  play.addEventListener('click', () => {
    state.playing = !state.playing;
    play.textContent = state.playing ? '❚❚' : '▶';
    if (state.audioEl) state.playing ? state.audioEl.play() : state.audioEl.pause();
  });
  scrub.addEventListener('input', () => {
    const t = Math.max(0, Math.min(state.duration, (+scrub.value / 1000) * state.duration));
    state.t = t;
    onsetCursor = 0;                       // let the onset spike re-arm
    if (state.audioEl) state.audioEl.currentTime = t;
  });

  /* ---- loop ------------------------------------------------------------- */
  const fitBox = $('#fit');
  let lastFit = null;
  let lastActiveLine = -1;
  let lastFrame = null;          // set on the first frame, not at boot
  let onsetHit = 0, onsetCursor = 0;

  // JS `%` keeps the sign of the dividend, so a clock that ever goes negative
  // stays negative and no phrase is ever active again.
  const wrap = (t, d) => ((t % d) + d) % d;

  function frame(now) {
    // rAF timestamps and performance.now() do not always share an origin, so
    // seeding lastFrame at boot can hand the first frame a NEGATIVE dt. Clamp
    // both ends: no going backwards, and no giant jump after a background tab.
    if (lastFrame === null) lastFrame = now;
    const dt = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000));
    lastFrame = now;

    if (state.audioEl) {
      state.t = state.audioEl.currentTime;
    } else if (state.playing) {
      state.t = wrap(state.t + dt, state.duration);
    }

    // decaying spike on the most recent onset, for the chroma response
    onsetHit = Math.max(0, onsetHit - dt * 6);
    while (onsetCursor < state.onsets.length && state.onsets[onsetCursor] <= state.t) {
      onsetHit = 1; onsetCursor++;
    }
    if (onsetCursor && state.onsets[onsetCursor - 1] > state.t) onsetCursor = 0; // looped

    const e = state.tap ? state.tap.read() : { level: 0.35 + 0.25 * Math.sin(state.t * 3), bass: 0 };
    const energy = Math.max(0, Math.min(1, e.level));

    for (const b of backdrops) b.draw(state.t, energy);
    engine.update(state.t, energy, onsetHit);

    // mark the line currently on screen, so the editor tracks playback
    if (state.lines.length) {
      const active = state.lines.findIndex(l => state.t >= l.start && state.t < l.end);
      if (active !== lastActiveLine) {
        lastActiveLine = active;
        for (const row of lineList.children) {
          row.classList.toggle('now', +row.dataset.i === active);
        }
      }
    }

    scrub.value = String((state.t / state.duration) * 1000);
    const m = Math.floor(state.t / 60), s = state.t % 60;
    clock.textContent = `${m}:${s.toFixed(1).padStart(4, '0')} / ${state.duration.toFixed(1)}s`;

    // Live readout of the fitter. The per-line sizes are the whole point of the
    // style, and watching them recompute as you drag Fill or swap the face is
    // the fastest way to understand what the layout is doing.
    const sig = engine.current?.phrase.text ?? '';
    if (sig !== lastFit) {
      lastFit = sig;
      const f = engine.current?.fit;
      fitBox.innerHTML = f
        ? f.lines.map(l =>
            `<div class="ln"><b>${l.text.replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')}</b>` +
            `<span>${Math.round(l.size)}px</span></div>`).join('') +
          `<div class="meta"><span>${f.lines.length} line${f.lines.length > 1 ? 's' : ''}` +
          ` · measure ${Math.round(f.measure)}px</span>` +
          `<span>${engine.words.length} words</span></div>`
        : '<div class="meta"><span>instrumental</span><span>—</span></div>';
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  status.textContent = `${state.bpm} bpm · synthetic grid`;

  // expose for the headless render check
  window.__poster = { engine, state, reloadLyrics, backdrops };
  return engine;
}
