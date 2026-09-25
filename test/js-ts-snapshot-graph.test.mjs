import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJsTsSnapshot, JS_TS_SNAPSHOT_CONTRACT } from '../scanners/language/js-ts/snapshot-graph.mjs';

test('snapshot graph resolves relative ESM edges across multiple TypeScript files', () => {
  const result = analyzeJsTsSnapshot([
    { path: 'src/app.ts', source: "import { router } from './router';\n" },
    { path: 'src/router.ts', source: "export const router = 1;\n" },
  ]);
  assert.equal(result.contract, JS_TS_SNAPSHOT_CONTRACT);
  assert.equal(result.complete, true);
  assert.deepEqual(result.files.map((f) => f.path), ['src/app.ts', 'src/router.ts']);
  assert.equal(result.moduleGraph.length, 1);
  assert.deepEqual(
    [result.moduleGraph[0].from, result.moduleGraph[0].specifier, result.moduleGraph[0].status, result.moduleGraph[0].target],
    ['src/app.ts', './router', 'resolved', 'src/router.ts'],
  );
});

test('CommonJS edges participate in the same graph without executing target code', () => {
  globalThis.__BSKEL_T04_SNAPSHOT_SENTINEL__ = 0;
  const result = analyzeJsTsSnapshot([
    { path: 'lib/a.cjs', source: "globalThis.__BSKEL_T04_SNAPSHOT_SENTINEL__ = 99;\nconst b = require('./b.cjs');\n" },
    { path: 'lib/b.cjs', source: 'module.exports = 1;\n' },
  ]);
  assert.equal(globalThis.__BSKEL_T04_SNAPSHOT_SENTINEL__, 0);
  assert.equal(result.moduleGraph[0].status, 'resolved');
  assert.equal(result.moduleGraph[0].target, 'lib/b.cjs');
  delete globalThis.__BSKEL_T04_SNAPSHOT_SENTINEL__;
});

test('input order does not affect byte-identical JSON output', () => {
  const a = { path: 'src/a.ts', source: "import './b';\n" };
  const b = { path: 'src/b.ts', source: 'export const b = 1;\n' };
  const one = analyzeJsTsSnapshot([a, b]);
  const two = analyzeJsTsSnapshot([b, a]);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});

test('ambiguous extensionless edges remain explicit and never pick an extension priority', () => {
  const result = analyzeJsTsSnapshot([
    { path: 'src/app.ts', source: "import './router';\n" },
    { path: 'src/router.ts', source: '' },
    { path: 'src/router.js', source: '' },
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.moduleGraph[0].status, 'ambiguous');
  assert.deepEqual(result.moduleGraph[0].candidates, ['src/router.js', 'src/router.ts']);
  assert.ok(result.diagnostics.some((d) => d.code === 'module-ambiguous'));
});

test('bare package-or-alias specifiers remain visible but unresolved', () => {
  const result = analyzeJsTsSnapshot([
    { path: 'src/app.ts', source: "import express from 'express';\nimport user from '@/user';\n" },
    { path: 'src/user.ts', source: '' },
  ]);
  assert.deepEqual(result.moduleGraph.map((e) => e.status), ['bare', 'bare']);
  assert.ok(result.diagnostics.every((d) => d.code === 'module-bare'));
});

test('duplicate paths after separator normalization are rejected', () => {
  assert.throws(() => analyzeJsTsSnapshot([
    { path: 'src/app.ts', source: '' },
    { path: 'src\\app.ts', source: '' },
  ]), /duplicate snapshot path/);
});

test('unsupported extensions fail closed unless language is explicit', () => {
  const blocked = analyzeJsTsSnapshot([{ path: 'src/template.vue', source: "import x from './x';" }]);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.diagnostics[0].code, 'unsupported-extension');

  const explicit = analyzeJsTsSnapshot([
    { path: 'src/embedded.custom', language: 'javascript', source: "import './x.js';" },
    { path: 'src/x.js', source: '' },
  ]);
  assert.equal(explicit.complete, true);
  assert.equal(explicit.moduleGraph[0].status, 'resolved');
});

test('file-count and total-byte limits return no partial graph', () => {
  const tooMany = analyzeJsTsSnapshot([
    { path: 'a.js', source: '' },
    { path: 'b.js', source: '' },
  ], { maxFiles: 1 });
  assert.equal(tooMany.complete, false);
  assert.deepEqual(tooMany.files, []);
  assert.deepEqual(tooMany.moduleGraph, []);
  assert.equal(tooMany.diagnostics[0].code, 'file-limit');

  const tooLarge = analyzeJsTsSnapshot([
    { path: 'a.js', source: '1234' },
    { path: 'b.js', source: '5678' },
  ], { maxTotalBytes: 6 });
  assert.equal(tooLarge.complete, false);
  assert.deepEqual(tooLarge.moduleGraph, []);
  assert.equal(tooLarge.diagnostics[0].code, 'snapshot-too-large');
});

test('per-file lexical limits fail the whole graph closed instead of mixing partial facts', () => {
  const result = analyzeJsTsSnapshot([
    { path: 'a.js', source: "import './b.js';" },
    { path: 'b.js', source: '' },
  ], { maxFileBytes: 1 });
  assert.equal(result.complete, false);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.moduleGraph, []);
  assert.equal(result.diagnostics[0].code, 'input-too-large');
});

test('source byte spans remain tied to the originating file edge', () => {
  const result = analyzeJsTsSnapshot([
    { path: 'src/app.ts', source: "const title = '한글';\nimport './router.ts';\n" },
    { path: 'src/router.ts', source: '' },
  ]);
  const edge = result.moduleGraph[0];
  assert.equal(edge.from, 'src/app.ts');
  assert.equal(edge.source.line, 2);
  assert.ok(edge.source.byteStart > "const title = '한글';\n".length);
});

test('invalid path and invalid explicit language fail instead of being guessed', () => {
  assert.throws(() => analyzeJsTsSnapshot([{ path: '../escape.js', source: '' }]), /escapes/);
  assert.throws(() => analyzeJsTsSnapshot([{ path: 'src/app.ts', language: 'java', source: '' }]), /unsupported language mode/);
});
