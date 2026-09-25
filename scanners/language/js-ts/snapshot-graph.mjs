// T04: immutable in-memory JS/TS project snapshot analysis.
//
// Callers supply repository-relative source snapshots. This module never discovers files, imports
// target modules, evaluates tsconfig, or touches the filesystem. It gives higher layers one stable
// deterministic graph boundary they can later feed from their own approved file-index layer.

import path from 'node:path';
import { analyzeJsTsSource } from './source-facts.mjs';
import { resolveJsTsModuleEdges } from './module-resolver.mjs';

// Provisional T04-internal shape. T01 owns any future stable cross-tool contract.\nexport const JS_TS_SNAPSHOT_CONTRACT = 'bskel.internal.js-ts-snapshot/0';

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('entry.path must be a non-empty repository-relative path without NUL bytes');
  const slashed = value.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) throw new TypeError('entry.path must be repository-relative');
  const normalized = path.posix.normalize(slashed).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new TypeError('entry.path escapes the repository root');
  if (normalized === '.' || normalized.length === 0) throw new TypeError('entry.path must identify a file path');
  return normalized;
}

function inferLanguage(filePath) {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (['.ts', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  return null;
}

function validateLimits({ maxFiles, maxTotalBytes }) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new TypeError('maxFiles must be a positive safe integer');
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) throw new TypeError('maxTotalBytes must be a positive safe integer');
}

export function analyzeJsTsSnapshot(entries, {
  maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFileBytes,
  maxFileTokens,
  extensions,
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  validateLimits({ maxFiles, maxTotalBytes });

  if (entries.length > maxFiles) {
    return {
      contract: JS_TS_SNAPSHOT_CONTRACT,
      complete: false,
      allResolved: false,
      syntaxValidated: false,
      files: [],
      moduleGraph: [],
      diagnostics: [{ level: 'info', code: 'file-limit', message: `snapshot has ${entries.length} files; limit is ${maxFiles}; no partial graph emitted` }],
    };
  }

  const normalized = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new TypeError('each entry must be an object');
    if (typeof entry.source !== 'string') throw new TypeError('entry.source must be a string');
    const filePath = canonicalPath(entry.path);
    if (seen.has(filePath)) throw new TypeError(`duplicate snapshot path after normalization: ${filePath}`);
    seen.add(filePath);

    const language = entry.language ?? inferLanguage(filePath);
    if (!language) {
      return {
        contract: JS_TS_SNAPSHOT_CONTRACT,
        complete: false,
        allResolved: false,
        syntaxValidated: false,
        files: [],
        moduleGraph: [],
        diagnostics: [{ level: 'info', code: 'unsupported-extension', message: `${filePath}: language must be explicit for this extension` }],
      };
    }
    const bytes = Buffer.byteLength(entry.source, 'utf8');
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      return {
        contract: JS_TS_SNAPSHOT_CONTRACT,
        complete: false,
        allResolved: false,
        syntaxValidated: false,
        files: [],
        moduleGraph: [],
        diagnostics: [{ level: 'info', code: 'snapshot-too-large', message: `snapshot exceeds ${maxTotalBytes} bytes; no partial graph emitted` }],
      };
    }
    normalized.push({ path: filePath, source: entry.source, language, bytes });
  }

  normalized.sort((a, b) => compareText(a.path, b.path));
  const knownFiles = normalized.map((entry) => entry.path);
  const analyzedFiles = [];
  const graph = [];
  const diagnostics = [];

  for (const entry of normalized) {
    const analyzerOptions = { filePath: entry.path, language: entry.language };
    if (maxFileBytes !== undefined) analyzerOptions.maxBytes = maxFileBytes;
    if (maxFileTokens !== undefined) analyzerOptions.maxTokens = maxFileTokens;
    const facts = analyzeJsTsSource(entry.source, analyzerOptions);

    if (!facts.complete) {
      diagnostics.push(...facts.diagnostics.map((d) => ({ ...d, filePath: entry.path })));
      return {
        contract: JS_TS_SNAPSHOT_CONTRACT,
        complete: false,
        allResolved: false,
        syntaxValidated: false,
        files: [],
        moduleGraph: [],
        diagnostics,
      };
    }

    const resolved = resolveJsTsModuleEdges(facts, { knownFiles, ...(extensions === undefined ? {} : { extensions }) });
    analyzedFiles.push({
      path: entry.path,
      language: entry.language,
      bytes: entry.bytes,
      sourceFacts: facts,
    });
    for (const resolution of resolved.resolutions) {
      graph.push({
        from: entry.path,
        edgeKind: resolution.edgeKind,
        typeOnly: resolution.typeOnly,
        sourceBasis: resolution.sourceBasis,
        specifier: resolution.specifier,
        status: resolution.status,
        ...(resolution.target ? { target: resolution.target } : {}),
        candidates: resolution.candidates,
        ...(resolution.reason ? { reason: resolution.reason } : {}),
        source: resolution.source,
      });
    }
    diagnostics.push(...resolved.diagnostics.map((d) => ({ ...d, filePath: entry.path })));
  }

  graph.sort((a, b) =>
    compareText(a.from, b.from)
    || a.source.byteStart - b.source.byteStart
    || compareText(a.edgeKind, b.edgeKind)
    || compareText(a.specifier, b.specifier)
  );
  diagnostics.sort((a, b) =>
    compareText(a.filePath ?? '', b.filePath ?? '')
    || (a.source?.byteStart ?? a.start ?? -1) - (b.source?.byteStart ?? b.start ?? -1)
    || compareText(a.code, b.code)
  );

  return {
    contract: JS_TS_SNAPSHOT_CONTRACT,
    complete: true,
    allResolved: graph.every((edge) => edge.status === 'resolved'),
    syntaxValidated: analyzedFiles.length > 0 && analyzedFiles.every((file) => file.sourceFacts.syntaxValidated === true),
    totalBytes,
    files: analyzedFiles,
    moduleGraph: graph,
    diagnostics,
  };
}
