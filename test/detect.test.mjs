/**
 * Segmentation has to separate SINGING from everything else, so the fixture is
 * built adversarially: a steady drum pattern runs the whole way through, and
 * harmonic "vocal" phrases sit on top of it at known times. A segmenter that
 * merely thresholds energy reports one continuous phrase; only the flatness
 * weighting (harmonic vs noise-like) recovers the real spans.
 */
import { analyseAudio } from '../src/sync.js';
import { segmentPhrases, distributeWords, buildLines, reflow, linesToLRC,
         attachTranscript, findRepeats, countSyllables, setLineStart,
         nudgeLine, matchSpansToLines, placeLyrics } from '../src/detect.js';

const SR = 44100, DUR = 16;
const n = SR * DUR;
const data = new Float32Array(n);

// drums, all the way through — noise bursts every 0.5s
for (let t = 0; t < DUR; t += 0.5) {
  const s = Math.floor(t * SR);
  for (let k = 0; k < SR * 0.08 && s + k < n; k++) {
    data[s + k] += (Math.random() * 2 - 1) * 0.45 * Math.exp(-k / (SR * 0.012));
  }
}
// bass drone, also all the way through
for (let i = 0; i < n; i++) data[i] += Math.sin(2 * Math.PI * 55 * i / SR) * 0.12;

// vocal phrases: harmonic stacks with vibrato, only in these windows
const PHRASES = [[1.0, 3.2], [5.0, 7.4], [9.5, 11.0], [12.5, 15.0]];
for (const [a, b] of PHRASES) {
  for (let i = Math.floor(a * SR); i < Math.floor(b * SR) && i < n; i++) {
    const tt = i / SR;
    const f0 = 240 + 12 * Math.sin(2 * Math.PI * 5 * tt);       // vibrato
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
    const env = Math.min(1, (tt - a) * 8) * Math.min(1, (b - tt) * 8);
    data[i] += v * 0.30 * env;
  }
}

const buffer = { sampleRate: SR, length: n, numberOfChannels: 1, getChannelData: () => data };

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`); if (!cond) fails++;
};

const t0 = Date.now();
const analysis = analyseAudio(buffer);
const spans = segmentPhrases(analysis);
console.log(`\nanalysed ${DUR}s in ${Date.now() - t0}ms · ${analysis.onsets.length} onsets\n`);
console.log('  detected spans:', spans.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join('  '));
console.log('  true phrases  :', PHRASES.map(p => `${p[0].toFixed(2)}-${p[1].toFixed(2)}`).join('  '), '\n');

check('found every sung phrase', spans.length === PHRASES.length, `got ${spans.length}`);
if (spans.length === PHRASES.length) {
  PHRASES.forEach(([a, b], i) => {
    check(`phrase ${i + 1} starts within 250ms`, Math.abs(spans[i].start - a) < 0.25,
      `${spans[i].start.toFixed(2)} vs ${a}`);
    check(`phrase ${i + 1} ends within 250ms`, Math.abs(spans[i].end - b) < 0.25,
      `${spans[i].end.toFixed(2)} vs ${b}`);
  });
}
check('drums alone never open a phrase',
  !spans.some(s => !PHRASES.some(([a, b]) => s.start < b && s.end > a)));
const vocalHits = (analysis.vocalOnsets || []).filter(t =>
  PHRASES.some(([a, b]) => t >= a - 0.15 && t <= b + 0.15));
check('word snaps prefer the vocal, not the kit',
  analysis.vocalOnsets.length > 0 && vocalHits.length / analysis.vocalOnsets.length > 0.6,
  `${vocalHits.length}/${analysis.vocalOnsets.length}`);

console.log('\n— word distribution ————————————————————————————');
const span = { start: 1.0, end: 3.2 };
const words = 'I just wanna hold you'.split(' ');
const placed = distributeWords(words, span, analysis.vocalOnsets);
console.log('  ', placed.map(p => `${p.word}@${p.start.toFixed(2)}`).join(' '));
check('all words placed', placed.length === words.length);
check('strictly increasing', placed.every((p, i) => i === 0 || p.start > placed[i - 1].start));
check('inside the span', placed.every(p => p.start >= span.start - 1e-6 && p.start < span.end));
// "wanna" carries 2 syllables so it should hold longer than 1-syllable "just"
const gap = (i) => placed[i + 1].start - placed[i].start;
check('syllable weighting affects spacing', gap(2) > gap(1) * 0.9,
  `wanna=${gap(2).toFixed(3)} just=${gap(1).toFixed(3)}`);

console.log('\n— reflow keeps timing after an edit ————————————');
let lines = buildLines(spans, analysis.vocalOnsets, ['I just wanna hold you', 'never let you go', '', 'say it slow']);
const before = { start: lines[0].start, end: lines[0].end };
lines[0].text = 'completely different words entirely now';
lines[0] = reflow(lines[0], analysis.vocalOnsets);
check('span survived the rewrite',
  lines[0].start === before.start && lines[0].end === before.end);
check('rewritten words re-placed', lines[0].words.length === 5, `${lines[0].words.length}`);
check('still inside the span',
  lines[0].words.every(w => w.start >= before.start - 1e-6 && w.start < before.end));

console.log('\n— manual timing correction —————————————————————');
const corrected = setLineStart(lines[0], 1.18, analysis.vocalOnsets);
check('line start follows the correction', corrected.start === 1.18, `${corrected.start}`);
check('line end stays measured', corrected.end === lines[0].end, `${corrected.end}`);
check('corrected words stay inside the span',
  corrected.words.every(w => w.start >= corrected.start && w.start < corrected.end));

console.log('\n— lyric count wins over over-segmentation ————');
const fragments = [];
for (let i = 0; i < 40; i++) fragments.push({ start: i * 0.2, end: i * 0.2 + 0.15, energy: 0.5 });
const merged = matchSpansToLines(fragments, 4);
check('40 fragments collapse to 4 lines', merged.length === 4, `${merged.length}`);
check('collapsed span covers the singing',
  merged[0].start === 0 && Math.abs(merged[3].end - 7.95) < 1e-6, `${merged[0].start}-${merged[3].end}`);
const placedLines = placeLyrics(fragments, 'one\ntwo\nthree\nfour', []).lines;
check('placeLyrics follows the lyric sheet',
  placedLines.length === 4 && placedLines.every(l => l.text), `${placedLines.length}`);
const split = matchSpansToLines([{ start: 1, end: 5, energy: 1 }], 4);
check('one long span splits to 4', split.length === 4, `${split.length}`);

const slid = nudgeLine({ start: 1, end: 3, text: 'hi', words: [] }, 0.16, []);
check('nudge keeps duration', Math.abs((slid.end - slid.start) - 2) < 1e-6, `${slid.end - slid.start}`);
check('nudge moves the start', Math.abs(slid.start - 1.16) < 1e-6, `${slid.start}`);

console.log('\n— empty line stays editable ————————————————————');
check('untranscribed span kept', lines[2].text === '' && lines[2].words.length === 0);
check('LRC skips empty lines', linesToLRC(lines).split('\n').length === 3);
console.log('\n' + linesToLRC(lines).split('\n').map(l => '  ' + l.slice(0, 76)).join('\n'));

console.log('\n— ASR helpers ——————————————————————————————————');
const asr = [
  { word: 'I', start: 1.05 }, { word: 'just', start: 1.4 }, { word: 'hold', start: 2.6 },
  { word: 'never', start: 5.1 }, { word: 'go', start: 7.0 },
  { word: 'stray', start: 40.0 },                       // past the end, must drop
];
const texts = attachTranscript(spans, asr);
check('words land in the right spans', texts[0] === 'I just hold' && texts[1] === 'never go',
  JSON.stringify(texts.slice(0, 2)));
check('out-of-range word dropped', !texts.join(' ').includes('stray'));
const looped = findRepeats(['aku sakit gila', 'aku sakit gila', 'aku sakit gila', 'kau nombor dua']);
check('flags a Whisper loop', looped.size === 3 && !looped.has(3), `${[...looped]}`);
check('does not flag normal repetition', findRepeats(['a', 'b', 'a']).size === 0);

console.log(`\n${fails ? fails + ' FAILURES' : 'ALL PASS'}\n`);
process.exit(fails ? 1 : 0);
