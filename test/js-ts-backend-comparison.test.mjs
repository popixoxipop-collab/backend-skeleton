import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JS_TS_BACKEND_CONTRACT,
  analyzeWithJsTsBackend,
  compareJsTsBackends,
  lexicalJsTsBackend,
  validateJsTsBackend,
} from '../scanners/language/js-ts/backend-comparison.mjs';

function fakeBackend(id, analyze, syntaxValidated = false) {
  return { contract: JS_TS_BACKEND_CONTRACT, id, syntaxValidated, analyze };
}

test('bounded lexical backend satisfies the provisional backend boundary', () => {
  const backend = validateJsTsBackend(lexicalJsTsBackend());
  const result = analyzeWithJsTsBackend(backend, "import x from './x.js';", {
    filePath: 'src/app.js',
    language: 'javascript',
  });
  assert.equal(backend.id, 'bounded-lexical');
  assert.equal(backend.syntaxValidated, false);
  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.equal(result.moduleEdges[0].specifier, './x.js');
});

test('comparison reports exact agreement for a second backend that returns the same facts', () => {
  const lexical = lexicalJsTsBackend();
  const mirror = fakeBackend('mirror', (source, options) => lexical.analyze(source, options));
  const report = compareJsTsBackends([mirror, lexical], [{
    id: 'simple-import',
    source: "import { x } from './x.js';",
    options: { filePath: 'src/app.js', language: 'javascript' },
  }]);
  assert.deepEqual(report.backendIds, ['bounded-lexical', 'mirror']);
  assert.equal(report.cases[0].comparisons[0].comparable, true);
  assert.equal(report.cases[0].comparisons[0].agrees, true);
  assert.deepEqual(report.cases[0].comparisons[0].differences, []);
});

test('comparison identifies edge differences without declaring either parser correct', () => {
  const lexical = lexicalJsTsBackend();
  const extra = fakeBackend('candidate', (source, options) => {
    const out = lexical.analyze(source, options);
    return {
      ...out,
      moduleEdges: [...out.moduleEdges, {
        kind: 'import',
        specifier: './candidate-only.js',
        bindings: [],
        typeOnly: false,
        basis: 'candidate-test',
        resolution: 'unresolved',
        source: { byteStart: 0, byteEnd: 0, line: 1 },
      }],
    };
  });
  const report = compareJsTsBackends([lexical, extra], [{
    id: 'difference',
    source: "import './base.js';",
    options: { filePath: 'src/app.js' },
  }]);
  const comparison = report.cases[0].comparisons[0];
  assert.equal(comparison.agrees, false);
  assert.deepEqual(comparison.differences, ['moduleEdges']);
});

test('syntax validation is a capability fact and cannot be elevated by a backend that declared false', () => {
  const lexical = lexicalJsTsBackend();
  const invalid = fakeBackend('liar', (source, options) => ({
    ...lexical.analyze(source, options),
    syntaxValidated: true,
  }), false);
  assert.throws(
    () => analyzeWithJsTsBackend(invalid, '', { filePath: 'src/app.js' }),
    /declared syntaxValidated=false/,
  );
});

test('backend errors are recorded as incomparable rather than crashing the whole corpus', () => {
  const boom = fakeBackend('boom', () => { throw new Error('candidate parser failed'); });
  const report = compareJsTsBackends([lexicalJsTsBackend(), boom], [{
    id: 'case-a',
    source: "import './a.js';",
    options: { filePath: 'src/a.js' },
  }]);
  const outcome = report.cases[0].outcomes.find((o) => o.backendId === 'boom');
  assert.equal(outcome.status, 'error');
  const comparison = report.cases[0].comparisons.find((o) => o.backendId === 'boom');
  assert.deepEqual(comparison, {
    backendId: 'boom',
    comparable: false,
    agrees: false,
    differences: ['backend-error'],
  });
});

test('duplicate backend ids and duplicate corpus ids are rejected', () => {
  const lexical = lexicalJsTsBackend();
  assert.throws(
    () => compareJsTsBackends([lexical, lexical], [{ id: 'x', source: '' }]),
    /duplicate backend id/,
  );
  assert.throws(
    () => compareJsTsBackends([lexical], [{ id: 'x', source: '' }, { id: 'x', source: '' }]),
    /duplicate corpus id/,
  );
});

test('reference backend must be present explicitly', () => {
  const other = fakeBackend('other', (source, options) => lexicalJsTsBackend().analyze(source, options));
  assert.throws(
    () => compareJsTsBackends([other], [{ id: 'x', source: '' }]),
    /reference backend not found/,
  );
});

test('malformed backend results are rejected before comparison', () => {
  const malformed = fakeBackend('malformed', () => ({ complete: true }));
  assert.throws(
    () => analyzeWithJsTsBackend(malformed, '', { filePath: 'src/app.js' }),
    /result.contract/,
  );
});

test('corpus order and backend order do not affect byte-identical comparison output', () => {
  const lexical = lexicalJsTsBackend();
  const mirror = fakeBackend('mirror', (source, options) => lexical.analyze(source, options));
  const a = { id: 'a', source: "import './a.js';", options: { filePath: 'src/a.js' } };
  const b = { id: 'b', source: "import './b.js';", options: { filePath: 'src/b.js' } };
  const one = compareJsTsBackends([lexical, mirror], [a, b]);
  const two = compareJsTsBackends([mirror, lexical], [b, a]);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});


test('comparison isolates and freezes common options per backend', () => {
  const mutator = fakeBackend('a-mutator', (source, options) => {
    options.language = 'javascript';
    return lexicalJsTsBackend().analyze(source, options);
  });
  const report = compareJsTsBackends([mutator, lexicalJsTsBackend()], [{
    id: 'typed',
    source: "import type { X } from './x.js';",
    options: { filePath: 'src/app.ts', language: 'typescript' },
  }]);
  const outcomes = Object.fromEntries(report.cases[0].outcomes.map((o) => [o.backendId, o]));
  assert.equal(outcomes['a-mutator'].status, 'error');
  assert.equal(outcomes['bounded-lexical'].status, 'ok');
  assert.equal(outcomes['bounded-lexical'].normalized.edges[0].typeOnly, true);
});

test('corpus limits fail before any backend executes', () => {
  let calls = 0;
  const counted = fakeBackend('counted', (source, options) => {
    calls++;
    return lexicalJsTsBackend().analyze(source, options);
  });
  assert.throws(
    () => compareJsTsBackends([counted], [
      { id: 'a', source: 'a' },
      { id: 'b', source: 'b' },
    ], { referenceBackendId: 'counted', maxCases: 1 }),
    /no backend was executed/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => compareJsTsBackends([counted], [
      { id: 'a', source: '12345' },
    ], { referenceBackendId: 'counted', maxCorpusBytes: 4 }),
    /no backend was executed/,
  );
  assert.equal(calls, 0);
});

test('comparison rejects backend-specific executable-shaped options at the common boundary', () => {
  assert.throws(
    () => compareJsTsBackends([lexicalJsTsBackend()], [{
      id: 'bad-options',
      source: '',
      options: { transformer: () => {} },
    }]),
    /unsupported common analysis option/,
  );
});

test('a legitimately syntax-validating backend stays comparable but reports the capability difference', () => {
  const parser = fakeBackend('parser', (source, options) => ({
    ...lexicalJsTsBackend().analyze(source, options),
    syntaxValidated: true,
  }), true);
  const report = compareJsTsBackends([lexicalJsTsBackend(), parser], [{
    id: 'syntax',
    source: "import './x.js';",
    options: { filePath: 'src/app.ts', language: 'typescript' },
  }]);
  assert.equal(report.corpusCases, 1);
  assert.ok(report.corpusBytes > 0);
  assert.deepEqual(report.cases[0].comparisons[0].differences, ['syntaxValidated']);
});
