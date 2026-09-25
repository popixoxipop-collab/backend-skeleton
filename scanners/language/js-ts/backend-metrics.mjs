// T04 backend metrics over an externally supplied, independently reviewed corpus.
//
// This module does not create goldens. It only scores a backend against caller-supplied expected
// module edges/diagnostics and exposes determinism. T19/independent QA owns corpus truth.

import { analyzeWithJsTsBackend, validateJsTsBackend } from './backend-comparison.mjs';

export const JS_TS_BACKEND_METRICS_CONTRACT = 'bskel.internal.js-ts-backend-metrics/0';

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function stableBindings(bindings) {
  return Array.isArray(bindings)
    ? bindings.map((b) => ({
        imported: b.imported,
        local: b.local,
        bindingKind: b.bindingKind,
        typeOnly: Boolean(b.typeOnly),
      }))
    : [];
}

function edgeShape(edge) {
  return {
    kind: edge.kind,
    specifier: edge.specifier,
    typeOnly: Boolean(edge.typeOnly),
    bindings: stableBindings(edge.bindings),
  };
}

function key(value) { return JSON.stringify(value); }
function ratio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }

function tally(expected, actual) {
  const exp = new Map();
  const got = new Map();
  for (const item of expected) exp.set(key(item), (exp.get(key(item)) ?? 0) + 1);
  for (const item of actual) got.set(key(item), (got.get(key(item)) ?? 0) + 1);

  let tp = 0, fp = 0, fn = 0;
  for (const [k, count] of exp) {
    const actualCount = got.get(k) ?? 0;
    tp += Math.min(count, actualCount);
    if (count > actualCount) fn += count - actualCount;
  }
  for (const [k, count] of got) {
    const expectedCount = exp.get(k) ?? 0;
    if (count > expectedCount) fp += count - expectedCount;
  }
  return {
    tp, fp, fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
}

function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length === 0) throw new TypeError('corpus must be a non-empty array');
  const ids = new Set();
  return corpus.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
      throw new TypeError('corpus entry.id is required');
    }
    if (ids.has(entry.id)) throw new TypeError(`duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.source !== 'string') throw new TypeError(`${entry.id}: source is required`);
    if (!entry.expected || !Array.isArray(entry.expected.moduleEdges)) {
      throw new TypeError(`${entry.id}: expected.moduleEdges is required`);
    }
    return {
      id: entry.id,
      source: entry.source,
      options: entry.options ?? {},
      expected: {
        moduleEdges: entry.expected.moduleEdges.map(edgeShape),
        diagnostics: [...(entry.expected.diagnostics ?? [])].sort(compareText),
      },
    };
  }).sort((a, b) => compareText(a.id, b.id));
}

export function evaluateJsTsBackend(backend, corpus) {
  validateJsTsBackend(backend);
  const cases = validateCorpus(corpus);
  const edgeTotals = { tp: 0, fp: 0, fn: 0 };
  const diagnosticTotals = { tp: 0, fp: 0, fn: 0 };
  let errors = 0;
  let incomplete = 0;
  let syntaxValidatedCases = 0;
  const results = [];

  for (const entry of cases) {
    try {
      const result = analyzeWithJsTsBackend(backend, entry.source, entry.options);
      if (!result.complete) incomplete++;
      if (result.syntaxValidated) syntaxValidatedCases++;

      const edgeMetrics = tally(entry.expected.moduleEdges, result.moduleEdges.map(edgeShape));
      const diagnosticMetrics = tally(
        entry.expected.diagnostics,
        result.diagnostics.map((d) => d.code ?? '<uncoded>').sort(compareText),
      );
      edgeTotals.tp += edgeMetrics.tp;
      edgeTotals.fp += edgeMetrics.fp;
      edgeTotals.fn += edgeMetrics.fn;
      diagnosticTotals.tp += diagnosticMetrics.tp;
      diagnosticTotals.fp += diagnosticMetrics.fp;
      diagnosticTotals.fn += diagnosticMetrics.fn;

      results.push({
        id: entry.id,
        status: 'ok',
        complete: result.complete,
        syntaxValidated: result.syntaxValidated,
        moduleEdges: edgeMetrics,
        diagnostics: diagnosticMetrics,
      });
    } catch (error) {
      errors++;
      results.push({
        id: entry.id,
        status: 'error',
        errorName: error?.name ?? 'Error',
        errorMessage: String(error?.message ?? error),
      });
    }
  }

  return {
    contract: JS_TS_BACKEND_METRICS_CONTRACT,
    backendId: backend.id,
    cases: cases.length,
    errors,
    incomplete,
    syntaxValidatedCases,
    moduleEdges: {
      ...edgeTotals,
      precision: ratio(edgeTotals.tp, edgeTotals.tp + edgeTotals.fp),
      recall: ratio(edgeTotals.tp, edgeTotals.tp + edgeTotals.fn),
    },
    diagnostics: {
      ...diagnosticTotals,
      precision: ratio(diagnosticTotals.tp, diagnosticTotals.tp + diagnosticTotals.fp),
      recall: ratio(diagnosticTotals.tp, diagnosticTotals.tp + diagnosticTotals.fn),
    },
    results,
  };
}

export function probeJsTsBackendDeterminism(backend, entry, { repeats = 10 } = {}) {
  validateJsTsBackend(backend);
  if (!Number.isSafeInteger(repeats) || repeats < 2) throw new TypeError('repeats must be an integer >= 2');
  if (!entry || typeof entry.source !== 'string') throw new TypeError('entry.source is required');

  const outputs = [];
  for (let i = 0; i < repeats; i++) {
    outputs.push(JSON.stringify(analyzeWithJsTsBackend(backend, entry.source, entry.options ?? {})));
  }
  const first = outputs[0];
  return {
    backendId: backend.id,
    repeats,
    byteIdentical: outputs.every((value) => value === first),
    distinctOutputs: new Set(outputs).size,
  };
}
