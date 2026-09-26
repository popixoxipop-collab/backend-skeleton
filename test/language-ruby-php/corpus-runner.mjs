#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runT07Corpus, validateT07CorpusManifest } from '../../scanners/language/ruby-php/corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function usage() {
  process.stderr.write('usage: node test/language-ruby-php/corpus-runner.mjs [--manifest path] [--out path] [--id entry-id]\n');
  process.exit(2);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

function buildAnalysisBinding(manifestBytes) {
  const analyzerCommit = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(analyzerCommit)) throw new Error('analyzer HEAD is not an exact git commit');

  const sourcePaths = git(['ls-files', 'scanners/language/ruby-php/*.mjs'])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (!sourcePaths.length) throw new Error('no tracked T07 analyzer source files');

  const analyzerSources = sourcePaths.map((relativePath) => {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const bytes = fs.readFileSync(absolutePath);
    const expectedBlob = git(['rev-parse', `HEAD:${relativePath}`]);
    const actualBlob = git(['hash-object', relativePath]);
    if (actualBlob !== expectedBlob) {
      throw new Error(`analyzer source differs from HEAD: ${relativePath}`);
    }
    return {
      path: relativePath,
      git_blob_sha: expectedBlob,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    };
  });
  const framed = analyzerSources
    .map((entry) => `${entry.path}\0${entry.sha256}\0${entry.size_bytes}\n`)
    .join('');

  return {
    analyzer_commit: analyzerCommit,
    analyzer_source_digest_sha256: sha256(Buffer.from(framed, 'utf8')),
    manifest_sha256: sha256(manifestBytes),
    analyzer_sources: analyzerSources.map(({ git_blob_sha: _gitBlobSha, ...entry }) => entry),
    analyzer_source_git_blobs: Object.fromEntries(
      analyzerSources.map((entry) => [entry.path, entry.git_blob_sha]),
    ),
  };
}

const args = process.argv.slice(2);
let manifestPath = path.join(HERE, 'corpus-manifest.json');
let outPath = null;
let onlyId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--manifest') { manifestPath = args[++i] ?? usage(); continue; }
  if (args[i] === '--out') { outPath = args[++i] ?? usage(); continue; }
  if (args[i] === '--id') { onlyId = args[++i] ?? usage(); continue; }
  usage();
}

const manifestBytes = fs.readFileSync(manifestPath);
const fullManifest = JSON.parse(manifestBytes.toString('utf8'));
validateT07CorpusManifest(fullManifest);
if (onlyId && !fullManifest.entries.some((entry) => entry.id === onlyId)) {
  throw new Error(`unknown corpus entry: ${onlyId}`);
}
const analysisBinding = buildAnalysisBinding(manifestBytes);
const selected = runT07Corpus(fullManifest, {
  keepCheckouts: false,
  ids: onlyId ? [onlyId] : null,
  analysisBinding,
});
selected.analysis_binding.analyzer_source_git_blobs = analysisBinding.analyzer_source_git_blobs;
const text = JSON.stringify(selected, null, 2) + '\n';
if (outPath) fs.writeFileSync(outPath, text);
else process.stdout.write(text);
if (selected.results.some((entry) => entry.error)) process.exitCode = 1;
