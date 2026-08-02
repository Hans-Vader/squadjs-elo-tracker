import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// --- Config ---
// Inputs are positional (.jsonl files and/or directories); the output is an
// explicit --out= flag. Guessing the output from position silently overwrites
// an input file when more than two are given.
const args     = process.argv.slice(2);
const outArg   = args.find(a => a.startsWith('--out='));
const OUT_FILE = outArg ? outArg.slice('--out='.length) : 'merged-match-log.jsonl';
const inputs   = args.filter(a => a !== outArg);

if (!inputs.length) {
  console.error('Usage: node merge-match-logs.js <file.jsonl|dir> [...more] [--out=merged.jsonl]');
  process.exit(1);
}

// Expand directories to their .jsonl contents
const files = inputs.flatMap(p =>
  statSync(p).isDirectory()
    ? readdirSync(p).filter(f => f.endsWith('.jsonl')).sort().map(f => join(p, f))
    : [p]
);

if (files.includes(OUT_FILE)) {
  console.error(`Refusing to overwrite input file: ${OUT_FILE}`);
  process.exit(1);
}

// --- Parse ---
function parseJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch { console.warn(`Skipping malformed line ${i + 1} in ${path}`); return null; }
    })
    .filter(Boolean);
}

// --- Deduplicate by matchId, earlier file wins on conflict ---
let totalInput = 0;
const seen = new Map();

for (const file of files) {
  const entries = parseJsonl(file);
  totalInput += entries.length;
  for (const entry of entries) {
    if (!seen.has(entry.matchId)) seen.set(entry.matchId, entry);
  }
}

// --- Sort by endedAt ascending ---
const merged = [...seen.values()].sort((a, b) => a.endedAt - b.endedAt);

// --- Write ---
const output = merged.map(e => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(OUT_FILE, output, 'utf8');

console.log(`Merged ${files.length} files (${totalInput} total entries)`);
console.log(`Duplicates removed: ${totalInput - merged.length}`);
console.log(`Output: ${merged.length} records → ${OUT_FILE}`);
