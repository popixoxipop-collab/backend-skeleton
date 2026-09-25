#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runT07Corpus, validateT07CorpusManifest } from '../../scanners/language/ruby-php/corpus.mjs';

function usage() {
  process.stderr.write('usage: node test/language-ruby-php/corpus-runner.mjs [--manifest path] [--out path] [--id entry-id]\n');
  process.exit(2);
}

const args = process.argv.slice(2);
let manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
let outPath = null;
let onlyId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--manifest') { manifestPath = args[++i] ?? usage(); continue; }
  if (args[i] === '--out') { outPath = args[++i] ?? usage(); continue; }
  if (args[i] === '--id') { onlyId = args[++i] ?? usage(); continue; }
  usage();
}

const fullManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
validateT07CorpusManifest(fullManifest);
const manifest = onlyId
  ? { ...fullManifest, entries: fullManifest.entries.filter((entry) => entry.id === onlyId) }
  : fullManifest;

if (onlyId && manifest.entries.length !== 1) {
  throw new Error(`unknown corpus entry: ${onlyId}`);
}
// runT07Corpus's full-manifest cardinality check is intentional. A filtered execution gets a
// one-entry wrapper only after the checked manifest has been validated, then runs through the
// same scanner one entry at a time.
const report = onlyId
  ? runT07Corpus({ ...fullManifest, entries: fullManifest.entries }, { keepCheckouts: false })
  : runT07Corpus(fullManifest, { keepCheckouts: false });
const selected = onlyId
  ? { ...report, results: report.results.filter((entry) => entry.id === onlyId) }
  : report;
const text = JSON.stringify(selected, null, 2) + '\n';
if (outPath) fs.writeFileSync(outPath, text);
else process.stdout.write(text);
if (selected.results.some((entry) => entry.error)) process.exitCode = 1;
