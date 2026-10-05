/**
 * POSTER ENGINE — Three.js kinetic typography.
 * ----------------------------------------------------------------------------
 * Layers, bottom to top:
 *
 *   backdrop   full-screen video quad, cover-fitted, switched on onsets
 *   type       one textured plane per WORD, laid out by poster-type.js,
 *              rendered to its own RT so the composite can blend it
 *   fx         composite -> halftone -> lofi   (poster-fx.js)
 *
 * Three is passed in rather than imported, so the same file runs against a UMD
 * global and a modern ESM build without a second copy of the library.
 *
 * The scene works in PIXEL space (ortho camera 0..W, 0..H, y down) so layout
 * numbers from the fitter drop straight into transforms with no conversion.
 */

import { createMeasurer, fitPoster } from './poster-type.js';
import { CompositeShader, HalftoneShader, LofiShader, FXChain, FX_PRESETS } from './poster-fx.js';

/* ---------------------------------------------------------------------------
 * Easing
 * ------------------------------------------------------------------------- */

const ease = {
  // Fast out, settled — the shape that makes type feel *cut* rather than faded.
  outExpo: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  outQuint: t => 1 - Math.pow(1 - t, 5),
  inOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  // One controlled overshoot. Two looks like a bounce and cheapens it.
  outBack: (t, k = 1.9) => 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2),
};
const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

/* ---------------------------------------------------------------------------
 * Text rasterisation
 * ------------------------------------------------------------------------- */

/**
 * Draw one word to a tightly-cropped canvas.
 *
 * Cropping to the ink box rather than the em box matters here: at poster sizes
 * a single word can be 2000px wide, and the em box wastes ~30% of that on
 * empty ascender/descender space in every texture we upload.
 */
function rasterizeWord(word, size, font, measurer, pad = 6) {
  const m = measurer.metrics(word);
  const inkW = (m.left + m.right) * size;
  const inkH = (m.ascent + m.descent) * size;

  const w = Math.max(1, Math.ceil(inkW) + pad * 2);
  const h = Math.max(1, Math.ceil(inkH) + pad * 2);

  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');

  ctx.font = `${font.style || 'normal'} ${font.weight || 700} ${size}px ${font.family}`;
  if ('letterSpacing' in ctx && font.tracking) ctx.letterSpacing = `${font.tracking * size}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';           // white; the material tints it

  // ink left = originX - m.left, so originX = pad + m.left*size
  ctx.fillText(word, pad + m.left * size, pad + m.ascent * size);

  return { canvas: cvs, w, h, pad, inkW, inkH };
}

/* ---------------------------------------------------------------------------
 * Word material
 * ------------------------------------------------------------------------- */

/**
 * Words reveal by WIPE, not by fade.
 *
 * Fading opacity under a difference blend gives you `mix(bg, |bg-ink|, a)`,
 * which at half opacity is a muddy grey that belongs to neither. A wipe keeps
 * every visible pixel at full ink strength and moves a hard edge across the
 * glyph instead — which is also how type actually arrives on paper.
 */
const WordShader = {
  uniforms: {
    map:      { value: null },
    uColor:   { value: null },
    uOpacity: { value: 1 },
    uReveal:  { value: 1 },   // 0 hidden, 1 fully swept
    uSoft:    { value: 0.06 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D map;
    uniform vec3  uColor;
    uniform float uOpacity, uReveal, uSoft;
    void main() {
      float a = texture2D(map, vUv).a;
      // v = 0 is the canvas top (flipY is off), so sweep upward from v = 1
      float edge = smoothstep(1.0 - uReveal - uSoft, 1.0 - uReveal + uSoft, vUv.y);
      a *= edge * uOpacity;
      if (a < 0.002) discard;
      gl_FragColor = vec4(uColor * a, a);   // premultiplied, matching the composite
    }`,
};

/* ---------------------------------------------------------------------------
 * Backdrop
 * ------------------------------------------------------------------------- */

const BackdropShader = {
  uniforms: {
    tA: { value: null }, tB: { value: null },
    uScaleA: { value: [1, 1] }, uScaleB: { value: [1, 1] },
    uMix: { value: 0 }, uZoom: { value: 1 }, uBrightness: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tA, tB;
    uniform vec2 uScaleA, uScaleB;
    uniform float uMix, uZoom, uBrightness;

    vec3 sampleCover(sampler2D t, vec2 s) {
      vec2 uv = (vUv - 0.5) / (s * uZoom) + 0.5;
      // Clamp rather than wrap so a mis-sized video letterboxes its edge pixel
      // instead of tiling, which is far less noticeable on a cut.
      return texture2D(t, clamp(uv, 0.001, 0.999)).rgb;
    }
    void main() {
      vec3 a = sampleCover(tA, uScaleA);
      vec3 b = sampleCover(tB, uScaleB);
      gl_FragColor = vec4(mix(a, b, uMix) * uBrightness, 1.0);
    }`,
};

/* ---------------------------------------------------------------------------
 * Engine
 * ------------------------------------------------------------------------- */

export const DEFAULTS = {
  width: 1080,
  height: 1920,
  font: { family: 'Helvetica Neue, Helvetica, Arial, sans-serif', weight: 800, tracking: 0 },
  uppercase: true,
  color: '#ffffff',
  blend: 'difference',            // the flip that keeps type legible on any frame
  fill: 0.90,                     // Beatsee's SIZE
  leading: 1.03,
  maxLines: 6,
  align: 'center',                // top | center | bottom
  // motion
  enter: 0.24, exit: 0.14, lineStagger: 0.035,
  reveal: 'wipe',                 // wipe | fade | cut
  emphasis: 'contrast',           // none | contrast | scale | weight
  emphasisAmount: 1,
  breathe: 0.006,                 // scale response to audio energy
  // backdrop
  backdropSwitch: 'onset',        // onset | bar | off
  backdropCross: 0.06,            // crossfade seconds; 0 = hard cut
  backdropZoomDrift: 0.02,
  fx: 'beatsee',
};

const BLEND_ID = { normal: 0, difference: 1, exclusion: 2, multiply: 3, screen: 4, knockout: 5 };

export class PosterEngine {
  /**
   * @param {*} THREE            the three namespace
   * @param {HTMLCanvasElement} canvas
   * @param {object} options     see DEFAULTS
   */
  constructor(THREE, canvas, options = {}) {
    this.THREE = THREE;
    this.opt = { ...DEFAULTS, ...options, font: { ...DEFAULTS.font, ...(options.font || {}) } };
    const { width: W, height: H } = this.opt;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setPixelRatio(1);          // we render at explicit output size
    this.renderer.setSize(W, H, false);
    this.renderer.autoClear = false;

    this.measurer = createMeasurer(this.opt.font);

    /* ---- type layer ------------------------------------------------------ */
    this.typeScene = new THREE.Scene();
    // ortho in pixel space, y down, so fitter coords are transform coords
    this.typeCamera = new THREE.OrthographicCamera(0, W, 0, H, -100, 100);
    this.typeRT = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    });
    this.unitQuad = new THREE.PlaneGeometry(1, 1);
    this.words = [];               // live word records
    this.pool = [];                // retired meshes awaiting disposal

    /* ---- backdrop -------------------------------------------------------- */
    this.bdScene = new THREE.Scene();
    this.bdCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bdUniforms = THREE.UniformsUtils.clone(BackdropShader.uniforms);
    for (const u of Object.values(this.bdUniforms)) {
      if (Array.isArray(u.value)) u.value = u.value.slice();
    }
    this.bdMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.bdUniforms,
      vertexShader: BackdropShader.vertexShader,
      fragmentShader: BackdropShader.fragmentShader,
      depthTest: false, depthWrite: false,
    }));
    this.bdMesh.frustumCulled = false;
    this.bdScene.add(this.bdMesh);
    this.bdRT = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    });
    this.clips = [];
    this.clipIndex = 0; this.prevClipIndex = 0; this.clipMix = 1; this.lastSwitch = -1e9;

    /* ---- fx -------------------------------------------------------------- */
    this.fx = new FXChain(THREE, this.renderer, W, H);
    this.composite = this.fx.add(CompositeShader);
    this.halftone = this.fx.add(HalftoneShader);
    this.lofi = this.fx.add(LofiShader);
    this.composite.uniforms.uBlend.value = BLEND_ID[this.opt.blend] ?? 1;
    this.applyFXPreset(this.opt.fx);
    for (const p of [this.halftone, this.lofi]) p.uniforms.uResolution.value = [W, H];

    /* ---- state ----------------------------------------------------------- */
    this.phrases = [];
    this.onsets = [];
    this.current = null;
    this.time = 0;
    this.energy = 0;
    this._fitCache = new Map();
  }

  /* -------------------------------------------------------------------------
   * Configuration
   * ---------------------------------------------------------------------- */

  applyFXPreset(name) {
    const p = FX_PRESETS[name];
    if (!p) return;
    for (const [k, v] of Object.entries(p.halftone || {})) {
      if (this.halftone.uniforms[k]) {
        this.halftone.uniforms[k].value = Array.isArray(v) ? v.slice() : v;
      }
    }
    for (const [k, v] of Object.entries(p.lofi || {})) {
      if (this.lofi.uniforms[k]) {
        this.lofi.uniforms[k].value = Array.isArray(v) ? v.slice() : v;
      }
    }
    this.opt.fx = name;
  }

  set(options = {}) {
    const relayout = ['font', 'uppercase', 'fill', 'leading', 'maxLines', 'align']
      .some(k => k in options);
    Object.assign(this.opt, options);
    if (options.font) {
      this.opt.font = { ...this.opt.font, ...options.font };
      this.measurer = createMeasurer(this.opt.font);
    }
    if (options.blend) this.composite.uniforms.uBlend.value = BLEND_ID[options.blend] ?? 1;
    if (options.color) {
      for (const w of this.words) w.mat.uniforms.uColor.value.set(options.color);
    }
    if (options.fx) this.applyFXPreset(options.fx);
    if (relayout) { this._fitCache.clear(); this._rebuild(true); }
  }

  /** @param {Array<{start:number,end:number,text:string,words?:Array}>} phrases */
  setLyrics(phrases) {
    this.phrases = (phrases || []).slice().sort((a, b) => a.start - b.start);
    this._fitCache.clear();
    this.current = null;
    this._clearWords();
  }

  /** @param {number[]} times seconds — from the onset detector or a fixed grid */
  setOnsets(times) { this.onsets = (times || []).slice().sort((a, b) => a - b); }

  /**
   * @param {Array<HTMLVideoElement|HTMLCanvasElement>} sources
   * Videos get a VideoTexture (self-updating); canvases get a CanvasTexture
   * that we flag dirty each frame, so procedurally drawn backdrops work the
   * same way clips do.
   */
  setBackdrops(sources) {
    const THREE = this.THREE;
    for (const c of this.clips) c.texture.dispose();
    this.clips = (sources || []).map(src => {
      const isVideo = typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement;
      const texture = isVideo ? new THREE.VideoTexture(src) : new THREE.CanvasTexture(src);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
      return { video: src, texture, isVideo };
    });
    this.clipIndex = 0; this.prevClipIndex = 0; this.clipMix = 1;
  }

  /* -------------------------------------------------------------------------
   * Layout
   * ---------------------------------------------------------------------- */

  _fit(text) {
    const key = text;
    let f = this._fitCache.get(key);
    if (f) return f;
    const t = this.opt.uppercase ? text.toUpperCase() : text;
    f = fitPoster(t, this.measurer, { width: this.opt.width, height: this.opt.height }, {
      fill: this.opt.fill,
      leading: this.opt.leading,
      maxLines: this.opt.maxLines,
    });
    this._fitCache.set(key, f);
    return f;
  }

  _clearWords() {
    for (const w of this.words) {
      this.typeScene.remove(w.mesh);
      w.mesh.material.uniforms?.map?.value?.dispose();
      w.mesh.material.dispose();
    }
    this.words = [];
  }

  _buildPhrase(phrase) {
    const THREE = this.THREE;
    this._clearWords();

    const fit = this._fit(phrase.text);
    const { width: W, height: H } = this.opt;

    // Vertical placement of the block.
    const align = this.opt.align;
    const originY = align === 'top' ? H * 0.06
                  : align === 'bottom' ? H * 0.94 - fit.blockHeight
                  : (H - fit.blockHeight) / 2;
    const marginX = (W - fit.measure) / 2;

    // Word-level timings, if the lyric supplies them.
    const wordTimes = phrase.words && phrase.words.length === fit.lines
      .reduce((n, l) => n + l.words.length, 0) ? phrase.words : null;

    let wi = 0;
    fit.lines.forEach((line, li) => {
      for (const box of line.wordBoxes) {
        const raster = rasterizeWord(box.word, line.size, this.opt.font, this.measurer);
        const tex = new THREE.CanvasTexture(raster.canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        // Textures default to flipY for a y-up camera. Ours is y-down, so the
        // default puts the canvas's top row at the bottom of the quad and every
        // glyph comes out mirrored.
        tex.flipY = false;
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;

        const uniforms = THREE.UniformsUtils.clone(WordShader.uniforms);
        uniforms.map.value = tex;
        uniforms.uColor.value = new THREE.Color(this.opt.color);
        const mat = new THREE.ShaderMaterial({
          uniforms,
          vertexShader: WordShader.vertexShader,
          fragmentShader: WordShader.fragmentShader,
          transparent: true, depthTest: false, depthWrite: false,
          // Output is premultiplied (see the shader), so the RT accumulates the
          // same way the composite pass expects to read it back.
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          // The y-down ortho camera (top=0, bottom=H) is a mirror transform:
          // its projection has a negative determinant, which reverses triangle
          // winding, so every quad would otherwise be backface-culled.
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(this.unitQuad, mat);
        mesh.frustumCulled = false;

        // Plane covers the padded canvas; centre it on the word's ink box.
        const cx = marginX + box.inkX + box.inkW / 2;
        const cy = originY + line.y + line.height / 2;

        mesh.scale.set(raster.w, raster.h, 1);
        mesh.position.set(cx, cy, 0);

        const rec = {
          mesh, mat, line: li, index: wi,
          home: { x: cx, y: cy },
          size: { w: raster.w, h: raster.h },
          t: 0, hit: 0,
          hitAt: wordTimes ? wordTimes[wi].start : phrase.start,
        };
        this.words.push(rec);
        this.typeScene.add(mesh);
        wi++;
      }
    });

    this.current = { phrase, fit, builtAt: this.time };
  }

  _rebuild(force) {
    if (this.current && force) {
      const p = this.current.phrase;
      this.current = null;
      this._buildPhrase(p);
    }
  }

  /* -------------------------------------------------------------------------
   * Frame
   * ---------------------------------------------------------------------- */

  /**
   * @param {number} time     playback position, seconds
   * @param {number} energy   0..1 audio energy for micro-motion
   * @param {number} onsetHit 0..1 decaying spike on the most recent onset
   */
  update(time, energy = 0, onsetHit = 0) {
    this.time = time;
    this.energy += (energy - this.energy) * 0.25;   // smooth, avoids strobing

    /* -- phrase selection ------------------------------------------------- */
    const active = this.phrases.find(p => time >= p.start - this.opt.enter && time < p.end);
    if (active !== this.current?.phrase) {
      if (active) this._buildPhrase(active);
      else { this._clearWords(); this.current = null; }
    }

    /* -- word animation --------------------------------------------------- */
    const { enter, exit, lineStagger, emphasis, emphasisAmount } = this.opt;
    if (this.current) {
      const p = this.current.phrase;
      for (const w of this.words) {
        // Lead the entrance into the detected vocal attack. Starting the wipe
        // at p.start made the typography feel late even when detection was
        // correct, because the timestamp marked the first invisible frame.
        const t0 = p.start - enter + w.line * lineStagger;
        w.t = clamp01((time - t0) / enter);
        // exit: whole block leaves together, faster than it arrived
        const out = clamp01((time - (p.end - exit)) / exit);

        const e = ease.outExpo(w.t) * (1 - ease.inOutQuart(out));
        w.hit = clamp01((time - w.hitAt) / 0.09);

        const pop = w.t < 1 ? ease.outBack(w.t, 1.2) : 1;
        const breathe = 1 + this.energy * this.opt.breathe;
        let s = (0.965 + 0.035 * pop) * breathe;
        let alpha = e;

        if (emphasis === 'contrast') {
          // unsung words sit back, sung words come forward — karaoke logic
          // inside a poster block, which Beatsee's Poster reveal does not do
          alpha *= (0.55 + 0.45 * ease.outQuint(w.hit)) * emphasisAmount
                 + (1 - emphasisAmount) * 1;
        } else if (emphasis === 'scale') {
          s *= 1 + 0.045 * emphasisAmount * (1 - ease.outQuint(w.hit));
        }

        w.mesh.scale.set(w.size.w * s, w.size.h * s, 1);
        w.mesh.position.y = w.home.y + (1 - ease.outQuint(w.t)) * w.size.h * 0.12;

        const u = w.mat.uniforms;
        if (this.opt.reveal === 'wipe') {
          // motion carries the entrance; ink stays at full strength throughout
          u.uReveal.value = ease.outExpo(w.t) * (out < 1 ? 1 : 0);
          u.uOpacity.value = alpha > 0 ? alpha / Math.max(e, 1e-6) : 0;
        } else if (this.opt.reveal === 'cut') {
          u.uReveal.value = w.t > 0 ? 1 : 0;
          u.uOpacity.value = w.t > 0 && out < 1 ? (alpha / Math.max(e, 1e-6)) : 0;
        } else {
          u.uReveal.value = 1;
          u.uOpacity.value = alpha;
        }
        w.mesh.visible = u.uOpacity.value > 0.002 && u.uReveal.value > 0.002;
      }
    }

    /* -- backdrop switching ----------------------------------------------- */
    if (this.clips.length) {
      if (this.opt.backdropSwitch === 'onset' && this.onsets.length) {
        // most recent onset at or before `time`
        let last = -1e9;
        for (let i = this.onsets.length - 1; i >= 0; i--) {
          if (this.onsets[i] <= time) { last = this.onsets[i]; break; }
        }
        if (last > this.lastSwitch + 1e-4) {
          this.lastSwitch = last;
          this.prevClipIndex = this.clipIndex;
          this.clipIndex = (this.clipIndex + 1) % this.clips.length;
          this.clipMix = 0;
        }
      }
      const cross = Math.max(this.opt.backdropCross, 1e-4);
      this.clipMix = clamp01(this.clipMix + (1 / 60) / cross);

      const a = this.clips[this.prevClipIndex] || this.clips[0];
      const b = this.clips[this.clipIndex] || this.clips[0];
      if (!a.isVideo) a.texture.needsUpdate = true;
      if (!b.isVideo) b.texture.needsUpdate = true;
      this.bdUniforms.tA.value = a.texture;
      this.bdUniforms.tB.value = b.texture;
      this.bdUniforms.uScaleA.value = this._coverScale(a.video);
      this.bdUniforms.uScaleB.value = this._coverScale(b.video);
      this.bdUniforms.uMix.value = ease.outQuint(this.clipMix);
      this.bdUniforms.uZoom.value = 1 + this.opt.backdropZoomDrift * this.energy;
    }

    /* -- fx uniforms ------------------------------------------------------- */
    this.lofi.uniforms.uTime.value = time;
    this.lofi.uniforms.uEnergy.value = onsetHit;

    this.render();
  }

  _coverScale(video) {
    const vw = video.videoWidth || video.width || 16;
    const vh = video.videoHeight || video.height || 9;
    const va = vw / vh, fa = this.opt.width / this.opt.height;
    // scale the sampled region so the short side fills — i.e. object-fit: cover
    return va > fa ? [fa / va, 1] : [1, va / fa];
  }

  render() {
    const r = this.renderer;

    // backdrop
    r.setRenderTarget(this.bdRT);
    r.setClearColor(0x000000, 1); r.clear(true, false, false);
    if (this.clips.length) r.render(this.bdScene, this.bdCamera);

    // type, on transparent
    r.setRenderTarget(this.typeRT);
    r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.render(this.typeScene, this.typeCamera);

    // composite + post
    this.composite.uniforms.tBackdrop.value = this.bdRT.texture;
    this.composite.uniforms.tType.value = this.typeRT.texture;
    this.fx.render(this.bdRT.texture, null);

    r.setRenderTarget(null);
  }

  setSize(w, h) {
    this.opt.width = w; this.opt.height = h;
    this.renderer.setSize(w, h, false);
    this.typeCamera.right = w; this.typeCamera.bottom = h;
    this.typeCamera.updateProjectionMatrix();
    this.typeRT.setSize(w, h);
    this.bdRT.setSize(w, h);
    this.fx.setSize(w, h);
    this._fitCache.clear();
    this._rebuild(true);
  }

  dispose() {
    this._clearWords();
    for (const c of this.clips) c.texture.dispose();
    this.typeRT.dispose(); this.bdRT.dispose();
    this.unitQuad.dispose();
    this.bdMesh.geometry.dispose(); this.bdMesh.material.dispose();
    this.fx.dispose();
    this.renderer.dispose();
  }
}

export { fitPoster, createMeasurer } from './poster-type.js';
export { FX_PRESETS } from './poster-fx.js';
