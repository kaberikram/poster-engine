/**
 * BACKDROPS — procedurally drawn stand-ins for video clips.
 *
 * The engine takes canvases as happily as it takes <video>, so these behave
 * exactly like real footage: they get cover-fitted, crossfaded and cut on
 * onsets through the same path. Useful as a default so the thing runs with
 * nothing uploaded, and useful on their own — `flash` is what produces the
 * hard black/white flip the reference style is built on.
 */

const W = 540, H = 960;   // half res is plenty; it's behind a halftone screen

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
}

export const BACKDROP_KINDS = ['flash', 'bars', 'noise', 'rings', 'sweep'];

/**
 * @param {string} kind
 * @param {object} opts { seed }
 * @returns {{canvas: HTMLCanvasElement, draw(t:number, energy:number):void}}
 */
export function createBackdrop(kind, opts = {}) {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  const seed = opts.seed ?? Math.random() * 1000;

  const draw = {
    // Solid inversion. Against a difference blend this is the entire reference
    // look: the type reads black on white, then white on black, on the cut.
    flash(t) {
      ctx.fillStyle = (Math.floor(t * 2 + seed) % 2) ? '#000' : '#fff';
      ctx.fillRect(0, 0, W, H);
    },

    bars(t) {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(-0.4);
      ctx.fillStyle = '#f2f2f2';
      const pitch = 120, off = (t * 90 + seed) % pitch;
      for (let x = -H; x < H * 1.5; x += pitch) {
        ctx.fillRect(x + off, -H, pitch * 0.45, H * 2.4);
      }
      ctx.restore();
    },

    noise(t, e) {
      const cell = 6;
      const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const g = 0.35 + e * 0.4;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const n = Math.sin((x * 12.9898 + y * 78.233 + Math.floor(t * 12) * 3.1) * 43758.5453);
          const v = (n - Math.floor(n));
          if (v > 1 - g) {
            ctx.fillStyle = `rgb(${(v * 255) | 0},${(v * 255) | 0},${(v * 255) | 0})`;
            ctx.fillRect(x * cell, y * cell, cell, cell);
          }
        }
      }
    },

    rings(t, e) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#fff';
      const n = 14, phase = (t * 0.35 + seed) % 1;
      for (let i = 0; i < n; i++) {
        const k = (i / n + phase) % 1;
        ctx.lineWidth = 2 + k * 26 * (1 + e);
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, k * H * 0.85, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    sweep(t) {
      const g = ctx.createLinearGradient(0, 0, W, H);
      const p = (t * 0.25 + seed) % 1;
      g.addColorStop(Math.max(0, p - 0.35), '#000');
      g.addColorStop(p, '#ffffff');
      g.addColorStop(Math.min(1, p + 0.35), '#000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    },
  }[kind] || (() => { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); });

  return { canvas, kind, draw: (t, e = 0) => draw(t, e) };
}

/** A default set that reads well against the difference blend. */
export function defaultBackdrops() {
  return ['flash', 'bars', 'rings', 'noise'].map((k, i) => createBackdrop(k, { seed: i * 37 }));
}
