// T04: deterministic repository-relative resolution for literal JS/TS module edges.
//
// This module deliberately does not emulate Node, TypeScript, bundlers, package exports, tsconfig
// path aliases, or filesystem symlinks. It consumes an explicit in-memory file inventory and
// resolves only relative literal specifiers that are unambiguous under the supplied inventory.

import path from 'node:path';
import { JS_TS_FACTS_CONTRACT } from './source-facts.mjs';

// Provisional T04-internal shape. T01 owns any future stable cross-tool contract.
export const JS_TS_RESOLUTION_CONTRACT = 'bskel.internal.js-ts-resolution/0';

export const DEFAULT_JS_TS_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
]);

function canonicalRepoPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty repository-relative path without NUL bytes`);
  }
  const slashed = value.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
    throw new TypeError(`${label} must be repository-relative`);
  }
  const normalized = path.posix.normalize(slashed);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError(`${label} escapes the repository root`);
  }
  const repoPath = normalized.replace(/^\.\//, '');
  if (repoPath === '.' || repoPath.length === 0) throw new TypeError(`${label} must identify a file path`);
  return repoPath;
}

function normalizeExtensions(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new TypeError('extensions must be a non-empty array');
  }
  const out = [];
  for (const ext of extensions) {
    if (typeof ext !== 'string' || !/^\.[A-Za-z0-9]+$/.test(ext)) {
      throw new TypeError(`invalid extension: ${String(ext)}`);
    }
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

function classifySpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier.length === 0) return 'invalid';
  if (specifier.includes('?') || specifier.includes('#')) return 'qualified';
  if (specifier.startsWith('/')) return 'absolute';
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') return 'relative';
  return 'bare';
}

function candidatePaths(base, specifier, extensions) {
  const out = [];
  const ext = path.posix.extname(base);
  const endsWithSlash = specifier.endsWith('/');

  if (!endsWithSlash) {
    out.push(base);
    if (!ext) for (const suffix of extensions) out.push(base + suffix);
  }
  for (const suffix of extensions) out.push(path.posix.join(base, 'index' + suffix));
  return [...new Set(out)];
}

function relativeBase(filePath, specifier) {
  const parent = path.posix.dirname(filePath);
  const base = path.posix.normalize(path.posix.join(parent, specifier));
  if (base === '..' || base.startsWith('../')) return null;
  return base.replace(/^\.\//, '');
}

export function resolveJsTsModuleEdge(edge, {
  filePath,
  knownFiles,
  extensions = DEFAULT_JS_TS_EXTENSIONS,
} = {}) {
  if (!edge || typeof edge !== 'object') throw new TypeError('edge must be an object');
  if (typeof edge.specifier !== 'string') throw new TypeError('edge.specifier must be a string');
  const from = canonicalRepoPath(filePath, 'filePath');
  const extList = normalizeExtensions(extensions);
  if (!knownFiles || typeof knownFiles === 'string' || typeof knownFiles[Symbol.iterator] !== 'function') {
    throw new TypeError('knownFiles must be a non-string iterable of repository-relative file paths');
  }

  const inventory = new Set();
  for (const file of knownFiles) inventory.add(canonicalRepoPath(file, 'knownFiles entry'));

  const classification = classifySpecifier(edge.specifier);
  const common = {
    specifier: edge.specifier,
    from,
  };

  if (classification === 'bare') {
    return { ...common, status: 'bare', reason: 'package-or-alias-resolution-not-in-lexical-layer', candidates: [] };
  }
  if (classification === 'absolute') {
    return { ...common, status: 'unsupported', reason: 'absolute-specifier', candidates: [] };
  }
  if (classification === 'qualified') {
    return { ...common, status: 'unsupported', reason: 'query-or-fragment-specifier', candidates: [] };
  }
  if (classification !== 'relative') {
    return { ...common, status: 'unsupported', reason: 'invalid-specifier', candidates: [] };
  }

  const base = relativeBase(from, edge.specifier);
  if (base === null) {
    return { ...common, status: 'blocked', reason: 'repository-root-escape', candidates: [] };
  }

  const matches = candidatePaths(base, edge.specifier, extList)
    .filter((candidate) => inventory.has(candidate))
    .sort();

  if (matches.length === 0) {
    return { ...common, status: 'missing', reason: 'no-inventory-match', candidates: [] };
  }
  if (matches.length > 1) {
    return { ...common, status: 'ambiguous', reason: 'multiple-inventory-matches', candidates: matches };
  }
  return { ...common, status: 'resolved', target: matches[0], candidates: matches };
}

export function resolveJsTsModuleEdges(sourceFacts, {
  knownFiles,
  extensions = DEFAULT_JS_TS_EXTENSIONS,
} = {}) {
  if (!sourceFacts || sourceFacts.contract !== JS_TS_FACTS_CONTRACT) {
    throw new TypeError(`sourceFacts.contract must be ${JS_TS_FACTS_CONTRACT}`);
  }
  if (!sourceFacts.complete) {
    return {
      contract: JS_TS_RESOLUTION_CONTRACT,
      sourceFactsContract: sourceFacts.contract,
      filePath: sourceFacts.filePath,
      complete: false,
      allResolved: false,
      sourceSyntaxValidated: Boolean(sourceFacts.syntaxValidated),
      resolutions: [],
      diagnostics: [{ level: 'info', code: 'source-facts-incomplete', message: 'resolution skipped because lexical source facts are incomplete' }],
    };
  }

  const filePath = canonicalRepoPath(sourceFacts.filePath, 'sourceFacts.filePath');
  const resolutions = sourceFacts.moduleEdges.map((edge) => ({
    edgeKind: edge.kind,
    typeOnly: Boolean(edge.typeOnly),
    sourceBasis: edge.basis ?? 'unknown',
    source: edge.source,
    ...resolveJsTsModuleEdge(edge, { filePath, knownFiles, extensions }),
  }));

  const diagnostics = [];
  for (const resolution of resolutions) {
    if (resolution.status === 'resolved') continue;
    diagnostics.push({
      level: 'info',
      code: `module-${resolution.status}`,
      message: `${resolution.specifier}: ${resolution.reason}`,
      source: resolution.source,
    });
  }

  return {
    contract: JS_TS_RESOLUTION_CONTRACT,
    sourceFactsContract: sourceFacts.contract,
    filePath,
    complete: true,
    allResolved: resolutions.every((resolution) => resolution.status === 'resolved'),
    sourceSyntaxValidated: Boolean(sourceFacts.syntaxValidated),
    resolutions,
    diagnostics,
  };
}
