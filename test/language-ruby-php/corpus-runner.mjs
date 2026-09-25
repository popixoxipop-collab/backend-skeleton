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
if (onlyId && !fullManifest.entries.some((entry) => entry.id === onlyId)) {
  throw new Error(`unknown corpus entry: ${onlyId}`);
}
const selected = runT07Corpus(fullManifest, {
  keepCheckouts: false,
  ids: onlyId ? [onlyId] : null,
});
const text = JSON.stringify(selected, null, 2) + '\n';
if (outPath) fs.writeFileSync(outPath, text);
else process.stdout.write(text);
if (selected.results.some((entry) => entry.error)) process.exitCode = 1;
