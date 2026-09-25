// T04 parser-backend comparison boundary.
//
// This is deliberately T04-internal and provisional. T01 owns any cross-tool stable contract.
// Backends registered here are trusted first-party analysis implementations; this module is NOT a
// plugin loader and does not make arbitrary third-party parser code safe to execute in-process.

import { analyzeJsTsSource } from './source-facts.mjs';

export const JS_TS_BACKEND_CONTRACT = 'bskel.internal.js-ts-backend/0';

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertUnique(items, label, keyFn) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) throw new TypeError(`duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

export function lexicalJsTsBackend() {
  return Object.freeze({
    contract: JS_TS_BACKEND_CONTRACT,
    id: 'bounded-lexical',
    syntaxValidated: false,
    analyze(source, options) {
      return analyzeJsTsSource(source, options);
    },
  });
}

export function validateJsTsBackend(backend) {
  if (!backend || typeof backend !== 'object') throw new TypeError('backend must be an object');
  if (backend.contract !== JS_TS_BACKEND_CONTRACT) {
    throw new TypeError(`backend.contract must be ${JS_TS_BACKEND_CONTRACT}`);
  }
  if (typeof backend.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(backend.id)) {
    throw new TypeError('backend.id must be a stable lowercase identifier');
  }
  if (typeof backend.syntaxValidated !== 'boolean') {
    throw new TypeError('backend.syntaxValidated must be boolean');
  }
  if (typeof backend.analyze !== 'function') throw new TypeError('backend.analyze must be a function');
  return backend;
}

function validateBackendResult(backend, result, options) {
  if (!result || typeof result !== 'object') throw new TypeError(`${backend.id}: analyze() must return an object`);
  if (typeof result.contract !== 'string' || result.contract.length === 0) throw new TypeError(`${backend.id}: result.contract must be non-empty`);
  if (typeof result.complete !== 'boolean') throw new TypeError(`${backend.id}: result.complete must be boolean`);
  if (typeof result.syntaxValidated !== 'boolean') throw new TypeError(`${backend.id}: result.syntaxValidated must be boolean`);
  if (!Array.isArray(result.moduleEdges)) throw new TypeError(`${backend.id}: result.moduleEdges must be an array`);
  if (!Array.isArray(result.diagnostics)) throw new TypeError(`${backend.id}: result.diagnostics must be an array`);
  if (options?.filePath !== undefined && result.filePath !== options.filePath) {
    throw new TypeError(`${backend.id}: result.filePath does not match requested filePath`);
  }
  if (result.syntaxValidated && !backend.syntaxValidated) {
    throw new TypeError(`${backend.id}: backend declared syntaxValidated=false but result elevated it to true`);
  }
  return result;
}

export function analyzeWithJsTsBackend(backend, source, options = {}) {
  validateJsTsBackend(backend);
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  return validateBackendResult(backend, backend.analyze(source, options), options);
}

function normalizedEdges(result) {
  return result.moduleEdges.map((edge) => ({
    kind: edge.kind,
    specifier: edge.specifier,
    typeOnly: Boolean(edge.typeOnly),
    bindings: Array.isArray(edge.bindings) ? edge.bindings : [],
    source: edge.source ?? null,
  }));
}

function normalizedOutcome(result) {
  return {
    complete: result.complete,
    syntaxValidated: result.syntaxValidated,
    edges: normalizedEdges(result),
    diagnostics: result.diagnostics.map((d) => d.code ?? '<uncoded>'),
  };
}

function diffAgainst(reference, candidate) {
  const a = JSON.stringify(reference);
  const b = JSON.stringify(candidate);
  if (a === b) return [];
  const differences = [];
  if (reference.complete !== candidate.complete) differences.push('complete');
  if (reference.syntaxValidated !== candidate.syntaxValidated) differences.push('syntaxValidated');
  if (JSON.stringify(reference.edges) !== JSON.stringify(candidate.edges)) differences.push('moduleEdges');
  if (JSON.stringify(reference.diagnostics) !== JSON.stringify(candidate.diagnostics)) differences.push('diagnostics');
  return differences.length ? differences : ['normalized-output'];
}

export function compareJsTsBackends(backends, corpus, {
  referenceBackendId = 'bounded-lexical',
} = {}) {
  if (!Array.isArray(backends) || backends.length === 0) throw new TypeError('backends must be a non-empty array');
  if (!Array.isArray(corpus) || corpus.length === 0) throw new TypeError('corpus must be a non-empty array');

  const checkedBackends = backends.map(validateJsTsBackend);
  assertUnique(checkedBackends, 'backend id', (b) => b.id);
  if (!checkedBackends.some((b) => b.id === referenceBackendId)) {
    throw new TypeError(`reference backend not found: ${referenceBackendId}`);
  }

  const checkedCorpus = corpus.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('corpus entry must be an object');
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw new TypeError('corpus entry.id must be non-empty');
    if (typeof entry.source !== 'string') throw new TypeError(`${entry.id}: corpus source must be a string`);
    if (entry.options !== undefined && (!entry.options || typeof entry.options !== 'object' || Array.isArray(entry.options))) {
      throw new TypeError(`${entry.id}: corpus options must be an object`);
    }
    return { id: entry.id, source: entry.source, options: entry.options ?? {} };
  });
  assertUnique(checkedCorpus, 'corpus id', (c) => c.id);
  checkedCorpus.sort((a, b) => compareText(a.id, b.id));

  const cases = [];
  for (const entry of checkedCorpus) {
    const outcomes = [];
    for (const backend of [...checkedBackends].sort((a, b) => compareText(a.id, b.id))) {
      try {
        const result = analyzeWithJsTsBackend(backend, entry.source, entry.options);
        outcomes.push({
          backendId: backend.id,
          status: 'ok',
          outputContract: result.contract,
          normalized: normalizedOutcome(result),
        });
      } catch (error) {
        outcomes.push({
          backendId: backend.id,
          status: 'error',
          errorName: error?.name ?? 'Error',
          errorMessage: String(error?.message ?? error),
        });
      }
    }

    const reference = outcomes.find((o) => o.backendId === referenceBackendId);
    const comparisons = outcomes
      .filter((o) => o.backendId !== referenceBackendId)
      .map((candidate) => {
        if (reference.status !== 'ok' || candidate.status !== 'ok') {
          return {
            backendId: candidate.backendId,
            comparable: false,
            agrees: false,
            differences: ['backend-error'],
          };
        }
        const differences = diffAgainst(reference.normalized, candidate.normalized);
        return {
          backendId: candidate.backendId,
          comparable: true,
          agrees: differences.length === 0,
          differences,
        };
      });

    cases.push({ id: entry.id, outcomes, comparisons });
  }

  return {
    contract: JS_TS_BACKEND_CONTRACT,
    referenceBackendId,
    backendIds: checkedBackends.map((b) => b.id).sort(compareText),
    cases,
  };
}
