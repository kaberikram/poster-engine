/**
 * Verifies the onset detector against a synthetic click track of known tempo.
 * No Web Audio in node, so we hand analyseAudio() a minimal AudioBuffer stub —
 * it only ever calls numberOfChannels / length / sampleRate / getChannelData.
 */
import { analyseAudio, beatGrid } from '../src/sync.js';

const SR = 44100, BPM = 120, DUR = 8;
const period = 60 / BPM;                    // 0.5s
const n = SR * DUR;
const data = new Float32Array(n);

// Click = short noise burst with a fast exponential decay, plus a quiet
// sine bed so the detector has to work against a real noise floor.
for (let i = 0; i < n; i++) data[i] = Math.sin(2 * Math.PI * 110 * i / SR) * 0.05;
const expected = [];
for (let t = 0.25; t < DUR; t += period) {
  expected.push(t);
  const start = Math.floor(t * SR);
  for (let k = 0; k < SR * 0.05 && start + k < n; k++) {
    data[start + k] += (Math.random() * 2 - 1) * Math.exp(-k / (SR * 0.006));
  }
}

const buffer = {
  sampleRate: SR, length: n, numberOfChannels: 1,
  getChannelData: () => data,
};

const t0 = Date.now();
const { onsets, bpm } = analyseAudio(buffer);
const ms = Date.now() - t0;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`);
  if (!cond) fails++;
};

console.log(`\nanalysed ${DUR}s in ${ms}ms — ${onsets.length} onsets, tempo ${bpm} bpm\n`);
console.log('  detected:', onsets.map(t => t.toFixed(3)).join(' '));
console.log('  expected:', expected.map(t => t.toFixed(3)).join(' '), '\n');

check('found every click', onsets.length >= expected.length,
  `${onsets.length} vs ${expected.length}`);

// Frame timestamps are centred on the FFT window, keeping the systematic
// window-start error below one hop (~11.6ms).
const matched = expected.filter(e => onsets.some(o => Math.abs(o - e) < 0.012));
check('all clicks matched within one hop', matched.length === expected.length,
  `${matched.length}/${expected.length}`);

check('tempo within 3 bpm', Math.abs(bpm - BPM) <= 3, `got ${bpm}`);
check('runs faster than realtime', ms < DUR * 1000, `${ms}ms for ${DUR}s of audio`);
check('beatGrid divides correctly', beatGrid(120, 2).length === 4);

console.log(`\n${fails ? fails + ' FAILURES' : 'ALL PASS'}\n`);
process.exit(fails ? 1 : 0);
