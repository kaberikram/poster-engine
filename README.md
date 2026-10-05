# Poster Engine

A width-fitted kinetic typography renderer — the "Poster" lyric-video style,
rebuilt in Three.js.

Every line is set at whatever size makes it span the measure exactly, so both
edges stay flush and short lines get huge type. Beat-reactive backdrops, a real
rotated halftone screen, and onset detection off the audio file itself.

```
npx serve .        # or: python3 -m http.server
open http://localhost:3000
```

No build step. `vendor/three.module.js` is included, so it runs offline.

---

## How the style works

The scaling is one division. The interesting problem is **where to break**,
because the break points decide the rhythm of sizes down the block.

For `I just wanna hold you`, a greedy fit gives you `I` alone on a line at four
times its neighbours' size. The fitter runs a DP over every plausible line
count, minimising the spread of resulting sizes in log space, penalising narrow
orphans, and picking the *most* lines that still fit — more lines means shorter
runs means bigger type, which is the whole point.

It lands on the same partition the reference does:

```
I JUST    328px          ← 6 chars, one of them narrow
WANNA     263px          ← 5 wide caps, so the smallest size
HOLD      362px
YOU       471px          ← 3 chars, so the biggest
                           every line spans 972px exactly
```

Lines are fitted on **ink width**, not advance width. The advance box includes
side bearings, so a line starting with `O` reads as inset even when the box is
flush. Fitting the ink puts the actual letterform edges on the margin.

---

## What's different from the app this came from

| | Reference | Here |
|---|---|---|
| Type over video | Normal blend; legibility depends on the clip | **Difference blend** — the flip is automatic and the type is never lost on any frame |
| Line breaking | Naive | DP over line counts, orphan-penalised |
| Edge alignment | Advance box | Optical, on the ink |
| Reveal | Whole block at once | Wipe at full ink strength, line-staggered, with per-word emphasis |
| Backdrop cuts | Fixed grid | Spectral-flux onsets detected from your file |
| Halftone | UV-space dots that swim | Screen-locked, area-proportional (`r = √coverage`), 4-screen CMYK option |
| Grain | Uniform | Luminance-weighted, like film |

The word emphasis is the one worth seeing: with word-level `<mm:ss.xx>` tags,
words that haven't been sung yet sit back while sung words come forward —
karaoke logic inside a poster block.

---

## Lyric detection

The premise is inverted from how these tools are usually built:

> **Timing is the product. Words are a draft.**

Transcribing sung vocals is unreliable — speech models hallucinate and loop on
music. The app this came from demonstrates it: on a 2:51 track it looped one
phrase five times and gave up 15 seconds in, and it meters that at one free use
because it costs them a server.

But you don't need to know *what* is being sung to know *when*. So the skeleton
— where phrases start and stop, where each word lands — comes from the signal,
with **no model and no network**:

1. Vocal-band energy (200Hz–4kHz) weighted by `1 - spectral flatness`. Harmonic
   content scores high, noise-like content low, so a snare doesn't read as a
   lyric.
2. Hysteresis thresholding into phrase spans — a single threshold chatters
   through every held note.
3. Merge breaths, drop fragments, split anything too long to be a lyric line.

Verified against a fixture where drums run *louder than the vocals* for the
whole track: all four phrases recovered within 50ms, no false phrases.

Then words go onto that skeleton three ways:

| mode | needs | good for |
|---|---|---|
| **my lyrics** | nothing | your own songs — you already know the words |
| **signal only** | nothing | type the words in against detected timing |
| **whisper tiny/base/small** | 40–250MB model, WebGPU | a rough draft you'll correct |

Words are spread across a phrase by syllable weight, then **snapped to detected
onsets** within ±130ms — proportional spacing alone reads as metronomic; landing
on real attacks is what makes it feel synced.

Whisper runs locally via transformers.js and is entirely optional. Where model
weights can't be fetched (strict CSP, offline), detection falls back to the
model-free skeleton and says so — placement never depends on ASR succeeding.
Obvious ASR loops get flagged in the editor so you know which lines to retype.

**Timing survives editing.** Timings live on the measured span, not on the
words. Retype a line completely, add words, delete words — it still lands where
the singing is:

```
before  [00:01.04] I just wanna hold you            span 1.04 → 3.17
after   [00:01.04] totally different words go here  span 1.04 → 3.17
```

---

## Modules

| file | what it is | deps |
|---|---|---|
| `src/poster-type.js` | the fitter — measurement, DP line breaking, optical edges | none |
| `src/poster-fx.js` | composite / halftone / lofi shaders + a tiny ping-pong chain | three (injected) |
| `src/poster-engine.js` | scene, per-word meshes, animation, backdrop switching | three (injected) |
| `src/sync.js` | LRC parsing, FFT, onset detection, tempo, vocal envelope | none |
| `src/detect.js` | phrase segmentation, word placement, reflow, optional Whisper | none* |
| `src/backdrops.js` | procedural stand-ins for video clips | none |
| `src/app.js` | the harness UI | — |

`poster-type.js`, `sync.js` and `detect.js` are pure and have no Three
dependency — lift any of them on its own. *`detect.js` dynamically imports
transformers.js only if you ask for a Whisper mode.

Three is **passed in**, never imported:

```js
import * as THREE from 'three';
import { PosterEngine } from './src/poster-engine.js';

const engine = new PosterEngine(THREE, canvas, {
  width: 1080, height: 1920,
  font: { family: 'Circular, Helvetica', weight: 900, tracking: -0.015 },
  blend: 'difference',
  fill: 0.90,        // measure as a fraction of frame width
  leading: 1.03,     // 1.0 = ink boxes touch
  reveal: 'wipe',
});

engine.setLyrics(parseLyrics(lrcText));
engine.setOnsets(analyseAudio(audioBuffer).onsets);
engine.setBackdrops([video1, video2, video3]);

// in your loop
engine.update(currentTime, energy, onsetSpike);
```

---

## Tests

```
node test/fit.test.mjs      # layout solver, against real Helvetica metrics
node test/audio.test.mjs    # onset detection against a synthetic click track
node test/detect.test.mjs   # phrase segmentation vs. drums-louder-than-vocals
node test/render.mjs        # headless WebGL render → shots/
node test/e2e-detect.mjs    # full UI: WAV in, detect, edit, timing holds
node test/bundle.mjs        # verifies the single-file build boots
```

`test/render.mjs` and `test/bundle.mjs` need `npm i playwright`.

---

## Where to take it next

**Export.** The engine renders to a fixed-size canvas at a time you pass in, so
it's already frame-accurate — drive `update(frameIndex / fps)` and pipe the
canvas through `VideoEncoder` (WebCodecs) plus `mp4-muxer`. No engine changes.

**Vocal isolation.** The one real upgrade to ASR quality: separate the vocal
stem before transcribing. A browser-side separation model is heavy (300MB+), so
this is the point where a small backend starts to earn its place — but note the
skeleton doesn't need it, only the word guesses do.

**Outline emphasis.** Unsung words currently dim. Stroking them instead would
read better on paper-like backdrops — rasterise a second stroked texture in
`rasterizeWord` and cross-fade in the word shader.

**MSDF text.** Canvas textures are re-rasterised per phrase, which is fine at
these sizes and supports any font the browser has. If you want per-glyph 3D
transforms, swap in an MSDF atlas — the fitter's output already gives you
per-word boxes and per-line sizes to place them with.

**Variable fonts.** The fitter is width-driven, so a variable width axis is a
natural fit: solve for the `wdth` value that hits the measure instead of scaling
the size, and every line can share one optical size.
