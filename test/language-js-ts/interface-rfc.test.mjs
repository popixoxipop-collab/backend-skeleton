import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJsTsSource } from '../../scanners/language/js-ts/source-facts.mjs';
import { resolveJsTsModuleEdges } from '../../scanners/language/js-ts/module-resolver.mjs';
import { analyzeJsTsSnapshot } from '../../scanners/language/js-ts/snapshot-graph.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DIR = path.join(ROOT, 'scanners', 'language', 'js-ts');
const vocab = JSON.parse(fs.readFileSync(path.join(HERE, 'interface-rfc.vocabulary.json'), 'utf8'));
const rfc = fs.readFileSync(path.join(DIR, 'INTERFACE_RFC.md'), 'utf8');
const readSource = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const grab = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))].sort();
const sortKeys = (_key, value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value);
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value, sortKeys)).digest('hex');
const quoted = (name) => rfc.includes('`' + name + '`');
const FIXTURE = [
  { path: 'src/app.ts', source: [
    "import { a } from './a';", "import type { T } from './types';", "import lib from 'left-pad';",
    "export * from './amb';", "const c = require('./c.cjs');", "const lazy = import('./lazy');",
    "import './missing';", "import '/abs/mod';", "import './x?raw';", "import '../../outside';",
    'const dyn = import(name);', 'require(name);',
  ].join('\n') },
  { path: 'src/a.ts', source: 'export const a = 1;\n' },
  { path: 'src/types.ts', source: 'export type T = 1;\n' },
  ...['src/amb.ts', 'src/amb.js', 'src/c.cjs', 'src/lazy.ts'].map((file) => ({ path: file, source: '' })),
];

// Vocabulary as the T04 source spells it; `read` is injectable so a drift check can feed it a doctored file.
function fromSource(read) {
  const [facts, resolver, snapshot, backend] = ['source-facts', 'module-resolver', 'snapshot-graph', 'backend-comparison']
    .map((name) => read(`${name}.mjs`));
  const statuses = grab(resolver, /status: '([a-z]+)'/g);
  return {
    binding_kinds: grab(facts, /bindingKind: '([a-z-]+)'/g),
    comparison_differences: grab(backend, /differences[^\n]*?'([A-Za-z-]+)'/g),
    edge_kinds: grab(facts, /kind: '([a-z-]+)', specifier/g),
    lexical_diagnostics: grab(facts, /diag\('([a-z-]+)'/g),
    resolver_diagnostics: ['source-facts-incomplete', ...statuses.filter((s) => s !== 'resolved').map((s) => `module-${s}`)].sort(),
    resolver_reasons: grab(resolver, /reason: '([a-z-]+)'/g),
    resolver_statuses: statuses,
    snapshot_diagnostics: grab(snapshot, /code: '([a-z-]+)'/g),
  };
}

test('exports and contract strings in the vocabulary are the ones the modules expose, and the RFC names them', async () => {
  for (const [file, names] of Object.entries(vocab.modules)) {
    const mod = await import(path.join(DIR, file));
    assert.deepEqual(Object.keys(mod).sort(), names, file);
    for (const name of names) assert.ok(quoted(name), `${name} is not named in the RFC`);
    for (const name of names.filter((n) => n in vocab.contracts)) assert.equal(mod[name], vocab.contracts[name]);
  }
  for (const value of Object.values(vocab.contracts)) assert.ok(quoted(value), value);
});

test('every kind, status, reason and unknown/partial code in the source is recorded and named in the RFC', () => {
  assert.deepEqual(fromSource(readSource), vocab.vocabulary);
  for (const [group, words] of Object.entries(vocab.vocabulary)) {
    for (const word of words) assert.ok(quoted(word), `${group}: ${word} is not named in the RFC`);
  }
});

test('normal fixture: all six resolution statuses occur, nothing claims validated syntax, output hash is pinned', () => {
  const result = analyzeJsTsSnapshot(FIXTURE);
  assert.deepEqual([...new Set(result.moduleGraph.map((edge) => edge.status))].sort(), vocab.vocabulary.resolver_statuses);
  const app = result.files.find((file) => file.path === 'src/app.ts');
  assert.deepEqual(app.sourceFacts.diagnostics.map((d) => d.code), ['dynamic-import-nonliteral', 'require-nonliteral']);
  assert.deepEqual([result.complete, result.allResolved, result.syntaxValidated], [true, false, false]);
  assert.ok(result.moduleGraph.every((edge) => edge.sourceBasis === 'lexical-literal'));
  assert.equal(sha256(result), vocab.fixture.output_sha256);
});

test('negative fixture: each hard stop reports complete=false, no partial facts and its recorded code', () => {
  const tooLarge = analyzeJsTsSource("import './a';", { maxBytes: 4 });
  const stops = {
    'input-too-large': [tooLarge, 'moduleEdges'],
    'token-limit': [analyzeJsTsSource("import './a';", { maxTokens: 2 }), 'moduleEdges'],
    'source-facts-incomplete': [resolveJsTsModuleEdges(tooLarge, { knownFiles: [] }), 'resolutions'],
    'file-limit': [analyzeJsTsSnapshot(FIXTURE, { maxFiles: 1 }), 'moduleGraph'],
    'snapshot-too-large': [analyzeJsTsSnapshot(FIXTURE, { maxTotalBytes: 8 }), 'moduleGraph'],
    'unsupported-extension': [analyzeJsTsSnapshot([{ path: 'notes.txt', source: '' }]), 'moduleGraph'],
  };
  assert.deepEqual(Object.keys(stops).sort(), vocab.hard_stop_codes);
  for (const [code, [result, list]] of Object.entries(stops)) {
    assert.equal(result.complete, false, code);
    assert.deepEqual(result[list], [], code);
    assert.ok(result.diagnostics.some((d) => d.code === code), code);
  }
});

test('negative fixture: unproven constructs stay diagnostics, and an empty graph is vacuously allResolved', () => {
  const facts = analyzeJsTsSource("import x from './\\u0061';\nrequire(name);\nimport(name);\n/* open", { language: 'typescript' });
  assert.deepEqual([facts.complete, facts.syntaxValidated, facts.moduleEdges], [true, false, []]);
  assert.deepEqual(facts.diagnostics.map((d) => d.code).sort(),
    ['dynamic-import-nonliteral', 'escaped-module-literal', 'import-unresolved', 'require-nonliteral', 'unterminated-block-comment']);
  assert.equal(analyzeJsTsSnapshot([{ path: 'a.js', source: '' }]).allResolved, true);
});

test('the drift check can fail: an invented diagnostic code in the source is reported', () => {
  const doctored = (name) => readSource(name) + (name === 'source-facts.mjs' ? "\ndiag('invented-code', 'x');\n" : '');
  assert.deepEqual(fromSource(doctored).lexical_diagnostics.filter((c) => !vocab.vocabulary.lexical_diagnostics.includes(c)), ['invented-code']);
});

test('ownership and commands: owned files sit in the two T04 directories, other tracks are named, commands are recorded', () => {
  for (const rel of vocab.owned_files) {
    assert.match(rel, /^(scanners\/language\/js-ts|test\/language-js-ts)\//);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
  for (const track of vocab.not_owned) assert.match(rfc, new RegExp(`\\b${track}\\b`));
  for (const { cmd, exit } of vocab.commands) {
    assert.equal(exit, 0);
    assert.ok(quoted(cmd), `${cmd} is not recorded in the RFC`);
  }
  assert.ok(rfc.includes(vocab.fixture.output_sha256), 'fixture hash is not recorded in the RFC');
});
