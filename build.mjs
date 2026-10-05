/**
 * Bundles the ES modules into one inline <script type="module"> and emits the
 * artifact page (no doctype/html/head/body — the Artifact host supplies those).
 * three comes from jsdelivr, which the artifact CSP admits.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = ['poster-type', 'poster-fx', 'backdrops', 'sync', 'detect', 'poster-engine', 'app'];
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';

const strip = (code) => code
  // relative imports and re-exports vanish; everything shares one scope now
  .replace(/^import\s+[\s\S]*?from\s+['"]\.\/[^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\}\s*from\s+['"]\.\/[^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s+(const|let|function|class|async\s+function)\b/gm, '$1');

const bundle = SRC.map(n => {
  const code = strip(fs.readFileSync(path.join('src', `${n}.js`), 'utf8'));
  return `/* ===== src/${n}.js ${'='.repeat(Math.max(0, 60 - n.length))} */\n${code.trim()}\n`;
}).join('\n');

const html = fs.readFileSync('index.html', 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body  = html.match(/<div class="app"[\s\S]*?<\/div>\s*(?=<script)/)[0];
const fonts = html.match(/<link href="https:\/\/fonts\.googleapis[^>]*>/)[0];

const out = `<title>Poster Engine</title>
${fonts}
<style>${style}</style>
${body}
<script type="module">
import * as THREE from '${THREE_URL}';
${bundle}
boot(THREE, document.getElementById('root')).catch(e => {
  const s = document.getElementById('status');
  if (s) s.textContent = 'error: ' + e.message;
  console.error(e);
});
<\/script>
<script>
// If the module never runs (blocked import, no WebGL), say so rather than
// leaving an empty bench.
setTimeout(() => {
  const s = document.getElementById('status');
  if (s && s.textContent === 'booting') {
    s.textContent = 'renderer unavailable — needs WebGL';
  }
}, 6000);
<\/script>
`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/poster-engine.html', out);
console.log('dist/poster-engine.html', (out.length / 1024).toFixed(1) + 'KB');

// sanity: nothing relative survived, nothing lost
for (const bad of [/from\s+['"]\.\//, /^export\s/m]) {
  if (bad.test(bundle)) { console.error('LEFTOVER:', bad); process.exit(1); }
}
for (const need of ['class PosterEngine', 'function fitPoster', 'function analyseAudio',
                    'function boot', 'HalftoneShader', 'defaultBackdrops',
                    'function segmentPhrases', 'function placeLyrics', 'function reflow']) {
  if (!out.includes(need)) { console.error('MISSING:', need); process.exit(1); }
}
console.log('bundle checks passed');
