import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJsTsSource } from '../scanners/language/js-ts/source-facts.mjs';
import {
  DEFAULT_JS_TS_EXTENSIONS,
  JS_TS_RESOLUTION_CONTRACT,
  resolveJsTsModuleEdge,
  resolveJsTsModuleEdges,
} from '../scanners/language/js-ts/module-resolver.mjs';

function edge(specifier) {
  return { kind: 'import', specifier };
}

test('explicit relative module resolves against the supplied repository inventory only', () => {
  const result = resolveJsTsModuleEdge(edge('./router.ts'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/app.ts', 'src/router.ts'],
  });
  assert.deepEqual(result, {
    specifier: './router.ts',
    from: 'src/app.ts',
    status: 'resolved',
    target: 'src/router.ts',
    candidates: ['src/router.ts'],
  });
});

test('extensionless relative module resolves when exactly one inventory candidate exists', () => {
  const result = resolveJsTsModuleEdge(edge('./router'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/router.ts'],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.target, 'src/router.ts');
});

test('extensionless relative module is ambiguous instead of applying an implicit priority', () => {
  const result = resolveJsTsModuleEdge(edge('./router'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/router.ts', 'src/router.js'],
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates, ['src/router.js', 'src/router.ts']);
  assert.equal('target' in result, false);
});

test('directory import resolves an index file only when unambiguous', () => {
  const result = resolveJsTsModuleEdge(edge('./routes'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/routes/index.ts'],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.target, 'src/routes/index.ts');
});

test('bare specifiers remain unresolved because package and tsconfig alias resolution are separate layers', () => {
  const result = resolveJsTsModuleEdge(edge('@/users'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/users.ts'],
  });
  assert.equal(result.status, 'bare');
  assert.equal(result.reason, 'package-or-alias-resolution-not-in-lexical-layer');
});

test('relative paths that escape the repository root are blocked', () => {
  const result = resolveJsTsModuleEdge(edge('../../secrets'), {
    filePath: 'src/app.ts',
    knownFiles: ['secrets.ts'],
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'repository-root-escape');
});

test('query and fragment suffixes are unsupported rather than stripped optimistically', () => {
  const query = resolveJsTsModuleEdge(edge('./shader.glsl?raw'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/shader.glsl'],
  });
  const fragment = resolveJsTsModuleEdge(edge('./router#x'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/router.ts'],
  });
  assert.equal(query.status, 'unsupported');
  assert.equal(fragment.status, 'unsupported');
});

test('an explicit .js import is not silently redirected to a .ts file', () => {
  const result = resolveJsTsModuleEdge(edge('./router.js'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/router.ts'],
  });
  assert.equal(result.status, 'missing');
});

test('Windows separators in inventory/filePath are normalized, but resolution output stays repository-posix', () => {
  const result = resolveJsTsModuleEdge(edge('./router'), {
    filePath: 'src\\app.ts',
    knownFiles: ['src\\router.ts'],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.target, 'src/router.ts');
  assert.equal(result.from, 'src/app.ts');
});

test('source-facts integration preserves edge kind/type-only/source provenance', () => {
  const facts = analyzeJsTsSource("import type { User } from './types';\nconst route = import('./route.js');\n", {
    filePath: 'src/app.ts',
    language: 'typescript',
  });
  const result = resolveJsTsModuleEdges(facts, {
    knownFiles: ['src/app.ts', 'src/types.ts', 'src/route.js'],
  });
  assert.equal(result.contract, JS_TS_RESOLUTION_CONTRACT);
  assert.match(result.contract, /^bskel\.internal\./);
  assert.equal(result.complete, true);
  assert.equal(result.allResolved, true);
  assert.equal(result.sourceSyntaxValidated, false);
  assert.deepEqual(result.resolutions.map((r) => [r.edgeKind, r.typeOnly, r.target]), [
    ['import', true, 'src/types.ts'],
    ['dynamic-import', false, 'src/route.js'],
  ]);
  assert.ok(result.resolutions.every((r) => Number.isInteger(r.source.byteStart)));
  assert.ok(result.resolutions.every((r) => r.sourceBasis === 'lexical-literal'));
});

test('incomplete lexical facts fail closed and do not attempt resolution', () => {
  const facts = analyzeJsTsSource("import x from 'x'", { maxBytes: 1, filePath: 'src/app.ts' });
  const result = resolveJsTsModuleEdges(facts, { knownFiles: ['src/app.ts'] });
  assert.equal(result.complete, false);
  assert.equal(result.allResolved, false);
  assert.equal(result.sourceSyntaxValidated, false);
  assert.deepEqual(result.resolutions, []);
  assert.equal(result.diagnostics[0].code, 'source-facts-incomplete');
});

test('invalid inventories, absolute paths and malformed extension policies are rejected or refused explicitly', () => {
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: '/src/app.ts', knownFiles: [] }), /repository-relative/);
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: 'src/app.ts', knownFiles: null }), /knownFiles/);
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: 'src/app.ts', knownFiles: 'src/x.ts' }), /non-string iterable/);
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: '.', knownFiles: [] }), /file path/);
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: 'src/evil\0.ts', knownFiles: [] }), /NUL/);
  assert.throws(() => resolveJsTsModuleEdge(edge('./x'), { filePath: 'src/app.ts', knownFiles: [], extensions: ['ts'] }), /invalid extension/);
  const abs = resolveJsTsModuleEdge(edge('/etc/passwd'), { filePath: 'src/app.ts', knownFiles: [] });
  assert.equal(abs.status, 'unsupported');
  assert.deepEqual(DEFAULT_JS_TS_EXTENSIONS, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
});


test('complete resolution analysis is distinct from every module edge resolving', () => {
  const facts = analyzeJsTsSource("import x from 'package-x';\nimport y from './missing';\n", {
    filePath: 'src/app.ts',
    language: 'typescript',
  });
  const result = resolveJsTsModuleEdges(facts, { knownFiles: ['src/app.ts'] });
  assert.equal(result.complete, true);
  assert.equal(result.allResolved, false);
  assert.deepEqual(result.resolutions.map((r) => r.status), ['bare', 'missing']);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['module-bare', 'module-missing']);
});


test('explicit extension specifiers never fall through to directory index candidates', () => {
  const result = resolveJsTsModuleEdge(edge('./router.js'), {
    filePath: 'src/app.ts',
    knownFiles: ['src/router.js/index.ts'],
  });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.candidates, []);
});
