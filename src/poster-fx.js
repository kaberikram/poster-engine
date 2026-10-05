/**
 * POSTER FX — the post chain.
 * ----------------------------------------------------------------------------
 * Three passes, all hand-rolled so this drops into any Three setup without
 * pulling in EffectComposer and its addon import graph.
 *
 * The two that matter:
 *
 *   COMPOSITE  puts the type over the video. The default blend is `difference`,
 *              not `normal` — which is why the type flips black-on-white and
 *              white-on-black by itself as the backdrop cuts. Beatsee gets that
 *              flip by accident, out of a threshold late in its chain; doing it
 *              in the blend means the type is *never* illegible, on any frame,
 *              with no per-video colour babysitting.
 *
 *   HALFTONE   a real rotated AM dot screen with area-proportional dots, locked
 *              to SCREEN space. Screen-locking is the whole game: grid the dots
 *              in UV space and they swim with every camera move and scale, which
 *              reads as a cheap filter. Locked, they read as print.
 *
 * All shaders are GLSL ES 1.0 / WebGL1-safe apart from fwidth, which comes from
 * the standard derivatives extension (core in WebGL2, near-universal in WebGL1).
 */

/* ---------------------------------------------------------------------------
 * Shared
 * ------------------------------------------------------------------------- */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMMON = /* glsl */`
// Rec.709 luma. Using the perceptual weights rather than a flat average keeps
// saturated reds from screening as if they were mid-greys.
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Cheap, stable, no texture fetch. Good enough for grain at 60fps.
float hash21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

vec2 rot(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c) * p;
}`;

/* ---------------------------------------------------------------------------
 * 1 — COMPOSITE : type over backdrop
 * ------------------------------------------------------------------------- */

export const CompositeShader = {
  name: 'composite',
  uniforms: {
    tBackdrop: { value: null },
    tType:     { value: null },   // rgb = type colour, a = coverage
    uBlend:    { value: 1 },      // 0 normal · 1 difference · 2 exclusion
                                  // 3 multiply · 4 screen · 5 knockout
    uOpacity:  { value: 1 },
    uBackdropTint: { value: [0, 0, 0] },
    uBackdropMix:  { value: 0 },  // pull the video toward the tint
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tBackdrop, tType;
    uniform int   uBlend;
    uniform float uOpacity, uBackdropMix;
    uniform vec3  uBackdropTint;
    ${COMMON}

    void main() {
      vec3 bg = texture2D(tBackdrop, vUv).rgb;
      bg = mix(bg, uBackdropTint, uBackdropMix);

      vec4 tp = texture2D(tType, vUv);
      float a = tp.a * uOpacity;
      vec3  t  = tp.a > 0.0001 ? tp.rgb / tp.a : tp.rgb;   // un-premultiply

      vec3 blended;
      if      (uBlend == 1) blended = abs(bg - t);                    // difference
      else if (uBlend == 2) blended = bg + t - 2.0 * bg * t;          // exclusion
      else if (uBlend == 3) blended = bg * t;                          // multiply
      else if (uBlend == 4) blended = 1.0 - (1.0 - bg) * (1.0 - t);    // screen
      else if (uBlend == 5) blended = vec3(1.0) - bg;                  // knockout/invert
      else                  blended = t;                               // normal

      gl_FragColor = vec4(mix(bg, blended, a), 1.0);
    }`,
};

/* ---------------------------------------------------------------------------
 * 2 — HALFTONE : rotated AM dot screen
 * ------------------------------------------------------------------------- */

export const HalftoneShader = {
  name: 'halftone',
  uniforms: {
    tDiffuse:   { value: null },
    uResolution:{ value: [1080, 1920] },
    uCell:      { value: 8.0 },    // dot pitch in device px
    uAngle:     { value: 0.7854 }, // 45deg, the classic single-screen angle
    uAmount:    { value: 1.0 },    // dry/wet
    uContrast:  { value: 1.0 },    // pushes coverage toward the extremes
    uSharpness: { value: 1.0 },    // 0 soft blobs, 1 crisp print
    uMode:      { value: 0 },      // 0 mono · 1 duotone · 2 CMYK
    uInk:       { value: [0, 0, 0] },
    uPaper:     { value: [1, 1, 1] },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uCell, uAngle, uAmount, uContrast, uSharpness;
    uniform int   uMode;
    uniform vec3  uInk, uPaper;
    ${COMMON}

    // Coverage -> dot. Ink area on paper is proportional to the value, and a
    // disc's area goes as r^2, so the radius is the SQRT of coverage. Skipping
    // that (radius = coverage, the common shortcut) makes midtones read far too
    // light and is the main reason most halftone filters look wrong.
    float screenDot(vec2 frag, float cover, float angle, float cell) {
      vec2 p = rot(frag, angle) / cell;
      vec2 c = fract(p) - 0.5;
      float d = length(c);
      float r = sqrt(clamp(cover, 0.0, 1.0)) * 0.5 * 1.4142;
      // fwidth gives us one screen-pixel of feather regardless of cell size, so
      // the dots stay antialiased at any pitch and never shimmer.
      float aa = max(fwidth(d), 0.0005) * mix(2.5, 0.75, uSharpness);
      return smoothstep(r + aa, r - aa, d);
    }

    void main() {
      vec3 src = texture2D(tDiffuse, vUv).rgb;

      // Screen space, not UV space. This is what keeps the grid pinned to the
      // frame while the type moves underneath it.
      vec2 frag = vUv * uResolution;

      vec3 outc;

      if (uMode == 2) {
        // Four-screen process colour at the traditional angles. Costs three
        // extra dot evaluations and looks enormously more like real print.
        vec3 cmy = 1.0 - src;
        float k = min(min(cmy.r, cmy.g), cmy.b);
        cmy = (cmy - k) / max(1.0 - k, 1e-4);

        float dc = screenDot(frag, cmy.r, radians(15.0), uCell);
        float dm = screenDot(frag, cmy.g, radians(75.0), uCell);
        float dy = screenDot(frag, cmy.b, radians(0.0),  uCell);
        float dk = screenDot(frag, k,     radians(45.0), uCell);

        vec3 ink = vec3(1.0);
        ink *= mix(vec3(1.0), vec3(0.0, 1.0, 1.0), dc);
        ink *= mix(vec3(1.0), vec3(1.0, 0.0, 1.0), dm);
        ink *= mix(vec3(1.0), vec3(1.0, 1.0, 0.0), dy);
        ink *= mix(vec3(1.0), vec3(0.0),           dk);
        outc = ink;
      } else {
        float v = luma(src);
        // Contrast about mid-grey, applied to COVERAGE rather than to the image,
        // so the dots gain weight without the source clipping first.
        float cover = clamp((1.0 - v - 0.5) * uContrast + 0.5, 0.0, 1.0);
        float d = screenDot(frag, cover, uAngle, uCell);
        outc = (uMode == 1) ? mix(uPaper, uInk, d) : mix(vec3(1.0), vec3(0.0), d);
      }

      gl_FragColor = vec4(mix(src, outc, uAmount), 1.0);
    }`,
};

/* ---------------------------------------------------------------------------
 * 3 — LOFI : grain, chroma, vignette, tone
 * ------------------------------------------------------------------------- */

export const LofiShader = {
  name: 'lofi',
  uniforms: {
    tDiffuse:    { value: null },
    uResolution: { value: [1080, 1920] },
    uTime:       { value: 0 },
    uGrain:      { value: 0.10 },
    uChroma:     { value: 0.0015 }, // base RGB split, fraction of frame width
    uEnergy:     { value: 0 },      // 0..1 from the audio — drives the split
    uVignette:   { value: 0.35 },
    uScanline:   { value: 0.0 },
    uLift:       { value: 0.02 },   // crush the blacks up, VHS-style
    uGamma:      { value: 1.0 },
    uSaturation: { value: 1.0 },
    uJitter:     { value: 0.0 },    // horizontal tear, beat-triggered
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime, uGrain, uChroma, uEnergy, uVignette,
                  uScanline, uLift, uGamma, uSaturation, uJitter;
    ${COMMON}

    void main() {
      vec2 uv = vUv;

      // Horizontal tear: a few displaced bands, seeded per-band so they hold
      // still for a frame instead of boiling.
      if (uJitter > 0.0001) {
        float band = floor(uv.y * 24.0);
        float n = hash21(vec2(band, floor(uTime * 24.0)));
        if (n > 1.0 - uJitter) uv.x += (hash21(vec2(band, 7.0)) - 0.5) * 0.06 * uJitter;
      }

      // Chroma split scaled from frame centre, so the edges smear and the
      // middle stays readable — lenses do this, a flat offset does not.
      vec2 dir = uv - 0.5;
      float amt = uChroma * (1.0 + uEnergy * 3.0);
      vec3 c;
      c.r = texture2D(tDiffuse, uv + dir * amt).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - dir * amt).b;

      // Tone: lift, gamma, saturation.
      c = mix(vec3(uLift), vec3(1.0), c);
      c = pow(max(c, 0.0), vec3(uGamma));
      c = mix(vec3(luma(c)), c, uSaturation);

      // Grain weighted by luminance. Real film grain lives in the midtones and
      // all but disappears in the blacks; uniform noise over the whole frame is
      // the tell-tale sign of a digital overlay.
      float l = luma(c);
      float weight = 4.0 * l * (1.0 - l);          // peaks at mid-grey
      float g = hash21(uv * uResolution + fract(uTime) * 1371.0) - 0.5;
      c += g * uGrain * mix(0.25, 1.0, weight);

      if (uScanline > 0.0001) {
        float s = sin(uv.y * uResolution.y * 1.5708);
        c *= 1.0 - uScanline * 0.5 * (0.5 + 0.5 * s);
      }

      // Vignette in aspect-corrected space so it stays circular on 9:16.
      vec2 v = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0) * 2.0;
      c *= 1.0 - uVignette * smoothstep(0.5, 1.6, length(v));

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/* ---------------------------------------------------------------------------
 * A minimal ping-pong chain
 * ------------------------------------------------------------------------- */

/**
 * Runs an ordered list of full-screen passes between two render targets.
 * Deliberately tiny: no EffectComposer, no addon imports, works the same with
 * a UMD `THREE` global and a modern ESM build.
 */
export class FXChain {
  /** @param {*} THREE the three namespace @param {*} renderer @param {number} w @param {number} h */
  constructor(THREE, renderer, w, h) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.size = [w, h];

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.passes = [];
  }

  /** @param {object} shaderDef one of the exported shader defs */
  add(shaderDef, overrides = {}) {
    const THREE = this.THREE;
    const uniforms = THREE.UniformsUtils.clone(shaderDef.uniforms);
    // clone() shares plain arrays by reference; two chains would stomp each
    // other's uResolution without this.
    for (const u of Object.values(uniforms)) {
      if (Array.isArray(u.value)) u.value = u.value.slice();
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (uniforms[k]) uniforms[k].value = Array.isArray(v) ? v.slice() : v;
    }
    const pass = {
      name: shaderDef.name,
      enabled: true,
      uniforms,
      material: new THREE.ShaderMaterial({
        uniforms,
        vertexShader: shaderDef.vertexShader,
        fragmentShader: shaderDef.fragmentShader,
        depthTest: false,
        depthWrite: false,
        extensions: { derivatives: true },
      }),
    };
    this.passes.push(pass);
    return pass;
  }

  get(name) { return this.passes.find(p => p.name === name); }

  setSize(w, h) {
    this.size = [w, h];
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    for (const p of this.passes) {
      if (p.uniforms.uResolution) p.uniforms.uResolution.value = [w, h];
    }
  }

  /**
   * @param {THREE.Texture} input  starting texture (usually a composited RT)
   * @param {THREE.WebGLRenderTarget|null} output  null renders to the canvas
   */
  render(input, output = null) {
    const active = this.passes.filter(p => p.enabled);
    if (!active.length) return input;

    let read = input, write = this.rtA, other = this.rtB;

    active.forEach((pass, i) => {
      const last = i === active.length - 1;
      if (pass.uniforms.tDiffuse) pass.uniforms.tDiffuse.value = read;
      this.quad.material = pass.material;
      const target = last ? output : write;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
      if (!last) { read = write.texture; const t = write; write = other; other = t; }
    });

    this.renderer.setRenderTarget(null);
    return output ? output.texture : null;
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.quad.geometry.dispose();
    for (const p of this.passes) p.material.dispose();
  }
}

/** Curated starting points. `beatsee` reproduces the reference; the rest are ours. */
export const FX_PRESETS = {
  beatsee:   { halftone: { uCell: 7,  uAmount: 0.85, uContrast: 1.15, uMode: 0, uSharpness: 0.9 },
               lofi:     { uGrain: 0.10, uChroma: 0.0012, uVignette: 0.30, uLift: 0.02 } },
  newsprint: { halftone: { uCell: 11, uAmount: 1.0,  uContrast: 1.45, uMode: 1, uSharpness: 1.0,
                           uInk: [0.08, 0.07, 0.09], uPaper: [0.96, 0.94, 0.88] },
               lofi:     { uGrain: 0.06, uChroma: 0.0, uVignette: 0.22, uLift: 0.04, uSaturation: 0.9 } },
  process:   { halftone: { uCell: 9,  uAmount: 1.0,  uContrast: 1.2,  uMode: 2, uSharpness: 1.0 },
               lofi:     { uGrain: 0.05, uChroma: 0.002, uVignette: 0.25, uSaturation: 1.15 } },
  clean:     { halftone: { uAmount: 0.0 },
               lofi:     { uGrain: 0.02, uChroma: 0.0006, uVignette: 0.18 } },
  wrecked:   { halftone: { uCell: 5,  uAmount: 1.0,  uContrast: 1.8,  uMode: 0, uSharpness: 0.4 },
               lofi:     { uGrain: 0.22, uChroma: 0.004, uVignette: 0.45, uScanline: 0.35,
                           uLift: 0.06, uSaturation: 0.75 } },
};
