// T04 shadow bridge from the existing webgame scanner's own evidence file set into the
// provisional JS/TS snapshot graph. This does not alter sbf.webgame-scan/1 output.

import fs from 'node:fs';
import path from 'node:path';
import { scanWebgame } from '../../webgame.mjs';
import { analyzeJsTsSnapshot } from './snapshot-graph.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('webgame files_read entry must be a non-empty string');
  if (path.isAbsolute(value)) throw new TypeError(`webgame files_read entry must be relative: ${value}`);
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new TypeError(`webgame files_read entry escapes repository root: ${value}`);
  }
  return normalized;
}

export function analyzeWebgameJsTsShadow(repoRoot, {
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  snapshotOptions = {},
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty path');
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new TypeError('maxReadBytes must be a positive safe integer');
  if (!snapshotOptions || typeof snapshotOptions !== 'object' || Array.isArray(snapshotOptions)) {
    throw new TypeError('snapshotOptions must be an object');
  }

  const realRoot = fs.realpathSync(repoRoot);
  const webgameScan = scanWebgame(realRoot);
  const rawFiles = Array.isArray(webgameScan.files_read) ? webgameScan.files_read : [];
  const normalized = rawFiles.map(normalizeRelative).sort(compareText);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('webgame files_read contains duplicate paths after normalization');
  }

  const sourceFiles = normalized.filter((relativePath) => SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()));
  const skippedFiles = normalized.filter((relativePath) => !SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()));

  if (sourceFiles.length === 0) {
    return {
      webgameAdapter: webgameScan.adapter,
      detected: webgameScan.completeness?.status !== 'blocked',
      webgameSourceHash: webgameScan.source_hash ?? null,
      filesRead: normalized.map((p) => p.split(path.sep).join('/')),
      skippedFiles: skippedFiles.map((p) => p.split(path.sep).join('/')),
      snapshot: null,
    };
  }

  const entries = [];
  let totalReadBytes = 0;
  for (const relativePath of sourceFiles) {
    const joined = path.resolve(realRoot, relativePath);
    if (!isWithin(realRoot, joined)) throw new TypeError(`webgame read path escapes repository root: ${relativePath}`);

    const realFile = fs.realpathSync(joined);
    if (!isWithin(realRoot, realFile)) throw new TypeError(`webgame read symlink escapes repository root: ${relativePath}`);

    const stat = fs.statSync(realFile);
    if (!stat.isFile()) throw new TypeError(`webgame read entry is not a regular file: ${relativePath}`);
    totalReadBytes += stat.size;
    if (totalReadBytes > maxReadBytes) {
      return {
        webgameAdapter: webgameScan.adapter,
        detected: true,
        webgameSourceHash: webgameScan.source_hash ?? null,
        filesRead: normalized.map((p) => p.split(path.sep).join('/')),
        skippedFiles: skippedFiles.map((p) => p.split(path.sep).join('/')),
        snapshot: {
          complete: false,
          allResolved: false,
          syntaxValidated: false,
          files: [],
          moduleGraph: [],
          diagnostics: [{
            level: 'info',
            code: 'webgame-shadow-read-limit',
            message: `webgame source read-set exceeds ${maxReadBytes} bytes; no partial shadow graph emitted`,
          }],
        },
      };
    }

    entries.push({
      path: relativePath.split(path.sep).join('/'),
      source: fs.readFileSync(realFile, 'utf8'),
    });
  }

  return {
    webgameAdapter: webgameScan.adapter,
    detected: true,
    webgameSourceHash: webgameScan.source_hash ?? null,
    filesRead: normalized.map((p) => p.split(path.sep).join('/')),
    skippedFiles: skippedFiles.map((p) => p.split(path.sep).join('/')),
    snapshot: analyzeJsTsSnapshot(entries, snapshotOptions),
  };
}
