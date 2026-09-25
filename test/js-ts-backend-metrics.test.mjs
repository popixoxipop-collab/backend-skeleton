import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateJsTsBackend,
  probeJsTsBackendDeterminism,
} from '../scanners/language/js-ts/backend-metrics.mjs';
import { JS_TS_BACKEND_CONTRACT } from '../scanners/language/js-ts/backend-comparison.mjs';

function backend(id, analyze, syntaxValidated = false) {
  return { contract: JS_TS_BACKEND_CONTRACT, id, syntaxValidated, analyze };
}

const corpus = [
  {
    id: 'a',
    source: 'x',
    expected: {
      moduleEdges: [{ kind: 'import', specifier: 'x', typeOnly: false, bindings: [] }],
      diagnostics: [],
    },
  },
  {
    id: 'b',
    source: 'y',
    expected: {
      moduleEdges: [{ kind: 'import', specifier: 'y', typeOnly: false, bindings: [] }],
      diagnostics: ['missing'],
    },
  },
];

test('perfect backend scores precision/recall 1 without excluding diagnostics', () => {
  const b = backend('perfect', (source) => ({
    contract: 'facts',
    complete: true,
    syntaxValidated: false,
    moduleEdges: [{ kind: 'import', specifier: source, typeOnly: false, bindings: [] }],
    diagnostics: source === 'y' ? [{ code: 'missing' }] : [],
  }));
  const result = evaluateJsTsBackend(b, corpus);
  assert.equal(result.moduleEdges.precision, 1);
  assert.equal(result.moduleEdges.recall, 1);
  assert.equal(result.diagnostics.precision, 1);
  assert.equal(result.diagnostics.recall, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.incomplete, 0);
});

test('false positives and false negatives are counted rather than hidden', () => {
  const b = backend('wrong', () => ({
    contract: 'facts',
    complete: true,
    syntaxValidated: false,
    moduleEdges: [{ kind: 'import', specifier: 'z', typeOnly: false, bindings: [] }],
    diagnostics: [],
  }));
  const result = evaluateJsTsBackend(b, corpus);
  assert.deepEqual(
    [result.moduleEdges.tp, result.moduleEdges.fp, result.moduleEdges.fn],
    [0, 2, 2],
  );
  assert.equal(result.moduleEdges.precision, 0);
  assert.equal(result.moduleEdges.recall, 0);
  assert.equal(result.diagnostics.fn, 1);
});

test('zero-denominator metrics are null, never a synthetic 100 percent', () => {
  const b = backend('empty', () => ({
    contract: 'facts',
    complete: true,
    syntaxValidated: false,
    moduleEdges: [],
    diagnostics: [],
  }));
  const result = evaluateJsTsBackend(b, [{
    id: 'empty',
    source: '',
    expected: { moduleEdges: [], diagnostics: [] },
  }]);
  assert.equal(result.moduleEdges.precision, null);
  assert.equal(result.moduleEdges.recall, null);
  assert.equal(result.diagnostics.precision, null);
  assert.equal(result.diagnostics.recall, null);
});

test('incomplete results remain in the report and are not removed from edge denominators', () => {
  const b = backend('abstains', () => ({
    contract: 'facts',
    complete: false,
    syntaxValidated: false,
    moduleEdges: [],
    diagnostics: [{ code: 'budget' }],
  }));
  const result = evaluateJsTsBackend(b, [{
    id: 'must-find',
    source: 'x',
    expected: {
      moduleEdges: [{ kind: 'import', specifier: 'x', typeOnly: false, bindings: [] }],
      diagnostics: ['budget'],
    },
  }]);
  assert.equal(result.incomplete, 1);
  assert.equal(result.moduleEdges.fn, 1);
  assert.equal(result.moduleEdges.recall, 0);
  assert.equal(result.diagnostics.recall, 1);
});

test('backend errors are explicit and do not become passes or skipped cases', () => {
  const b = backend('throws', () => { throw new Error('parser failed'); });
  const result = evaluateJsTsBackend(b, [{
    id: 'error-case',
    source: '',
    expected: { moduleEdges: [], diagnostics: [] },
  }]);
  assert.equal(result.errors, 1);
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].errorMessage, /parser failed/);
});

test('binding differences count as semantic edge differences', () => {
  const b = backend('binding-mismatch', () => ({
    contract: 'facts',
    complete: true,
    syntaxValidated: false,
    moduleEdges: [{
      kind: 'import',
      specifier: 'pkg',
      typeOnly: false,
      bindings: [{ imported: 'A', local: 'B', bindingKind: 'named', typeOnly: false }],
    }],
    diagnostics: [],
  }));
  const result = evaluateJsTsBackend(b, [{
    id: 'bindings',
    source: '',
    expected: {
      moduleEdges: [{
        kind: 'import',
        specifier: 'pkg',
        typeOnly: false,
        bindings: [{ imported: 'A', local: 'A', bindingKind: 'named', typeOnly: false }],
      }],
      diagnostics: [],
    },
  }]);
  assert.deepEqual(
    [result.moduleEdges.tp, result.moduleEdges.fp, result.moduleEdges.fn],
    [0, 1, 1],
  );
});

test('duplicate corpus IDs and missing independent expected facts are rejected', () => {
  const b = backend('ok', () => ({
    contract: 'facts', complete: true, syntaxValidated: false, moduleEdges: [], diagnostics: [],
  }));
  assert.throws(() => evaluateJsTsBackend(b, [
    { id: 'x', source: '', expected: { moduleEdges: [] } },
    { id: 'x', source: '', expected: { moduleEdges: [] } },
  ]), /duplicate corpus id/);
  assert.throws(() => evaluateJsTsBackend(b, [
    { id: 'x', source: '' },
  ]), /expected\.moduleEdges/);
});

test('determinism probe detects byte-identical repeated outputs', () => {
  const b = backend('stable', () => ({
    contract: 'facts', complete: true, syntaxValidated: false, moduleEdges: [], diagnostics: [],
  }));
  const result = probeJsTsBackendDeterminism(b, { source: '' }, { repeats: 5 });
  assert.deepEqual(result, {
    backendId: 'stable',
    repeats: 5,
    byteIdentical: true,
    distinctOutputs: 1,
  });
});

test('determinism probe exposes changing output rather than averaging it away', () => {
  let n = 0;
  const b = backend('unstable', () => ({
    contract: 'facts',
    complete: true,
    syntaxValidated: false,
    moduleEdges: [],
    diagnostics: [{ code: String(++n) }],
  }));
  const result = probeJsTsBackendDeterminism(b, { source: '' }, { repeats: 3 });
  assert.equal(result.byteIdentical, false);
  assert.equal(result.distinctOutputs, 3);
});

test('determinism repeat count is bounded to meaningful integer values', () => {
  const b = backend('stable', () => ({
    contract: 'facts', complete: true, syntaxValidated: false, moduleEdges: [], diagnostics: [],
  }));
  assert.throws(() => probeJsTsBackendDeterminism(b, { source: '' }, { repeats: 1 }), />= 2/);
});
