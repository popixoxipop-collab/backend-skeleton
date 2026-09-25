// T04 shadow bridge from an existing first-party adapter read-set into the provisional JS/TS graph.
//
// This does not replace adapter.scan() and does not alter adapter output. It exists so T04 can
// compare the new language-analysis boundary against already-shipped adapter behavior before any
// migration. The adapter itself must be trusted first-party code; this module is not a plugin loader.

import fs from 'node:fs';
import path from 'node:path';
import { analyzeJsTsSnapshot } from './snapshot-graph.mjs';

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function canonicalRelative(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('adapter read-set path must be a non-empty string');
  if (path.isAbsolute(value)) throw new TypeError(`adapter read-set path must be relative: ${value}`);
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new TypeError(`adapter read-set path escapes repository root: ${value}`);
  }
  return normalized;
}

function languageSourcePath(relativePath) {
  return JS_TS_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export function analyzeAdapterJsTsShadow(adapter, repoRoot, {
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  snapshotOptions = {},
} = {}) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('adapter must be an object');
  if (typeof adapter.id !== 'string' || adapter.id.length === 0) throw new TypeError('adapter.id must be non-empty');
  if (typeof adapter.detect !== 'function') throw new TypeError('adapter.detect must be a function');
  if (typeof adapter.listReadSet !== 'function') throw new TypeError('adapter.listReadSet must be a function');
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot must be a non-empty path');
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new TypeError('maxReadBytes must be a positive safe integer');
  if (!snapshotOptions || typeof snapshotOptions !== 'object' || Array.isArray(snapshotOptions)) throw new TypeError('snapshotOptions must be an object');

  const realRoot = fs.realpathSync(repoRoot);
  const detection = adapter.detect(realRoot);
  if (!detection) {
    return {
      adapterId: adapter.id,
      detected: false,
      readSet: [],
      skippedReadSet: [],
      snapshot: null,
    };
  }

  const rawReadSet = adapter.listReadSet(realRoot);
  if (!Array.isArray(rawReadSet)) throw new TypeError(`${adapter.id}.listReadSet() must return an array`);

  const normalized = rawReadSet.map(canonicalRelative);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${adapter.id}.listReadSet() returned duplicate paths after normalization`);
  }
  normalized.sort(compareText);

  const sourcePaths = normalized.filter(languageSourcePath);
  const skippedReadSet = normalized.filter((p) => !languageSourcePath(p));
  const entries = [];
  let totalReadBytes = 0;

  for (const relativePath of sourcePaths) {
    const joined = path.resolve(realRoot, relativePath);
    if (!isWithin(realRoot, joined)) throw new TypeError(`read-set path escapes repository root: ${relativePath}`);

    const realFile = fs.realpathSync(joined);
    if (!isWithin(realRoot, realFile)) {
      throw new TypeError(`read-set symlink escapes repository root: ${relativePath}`);
    }
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) throw new TypeError(`read-set entry is not a regular file: ${relativePath}`);
    totalReadBytes += stat.size;
    if (totalReadBytes > maxReadBytes) {
      return {
        adapterId: adapter.id,
        detected: true,
        readSet: normalized.map((p) => p.split(path.sep).join('/')),
        skippedReadSet: skippedReadSet.map((p) => p.split(path.sep).join('/')),
        snapshot: {
          complete: false,
          allResolved: false,
          syntaxValidated: false,
          files: [],
          moduleGraph: [],
          diagnostics: [{
            level: 'info',
            code: 'shadow-read-limit',
            message: `adapter read-set exceeds ${maxReadBytes} bytes; no partial shadow graph emitted`,
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
    adapterId: adapter.id,
    detected: true,
    readSet: normalized.map((p) => p.split(path.sep).join('/')),
    skippedReadSet: skippedReadSet.map((p) => p.split(path.sep).join('/')),
    snapshot: analyzeJsTsSnapshot(entries, snapshotOptions),
  };
}
