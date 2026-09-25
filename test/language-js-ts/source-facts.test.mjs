import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJsTsSource, JS_TS_FACTS_CONTRACT } from '../../scanners/language/js-ts/source-facts.mjs';

function edges(source, options = {}) {
  return analyzeJsTsSource(source, options).moduleEdges;
}

test('ESM imports: default, namespace, named aliases, type-only and side effects', () => {
  const result = analyzeJsTsSource(`
import express, { Router as ExpressRouter, type Request } from 'express'
import * as pathNs from "node:path";
import type { User } from './types';
import './bootstrap';
export { createApp } from './app';
`, { filePath: 'src/index.ts', language: 'typescript' });
  assert.equal(result.contract, JS_TS_FACTS_CONTRACT);
  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.equal(result.moduleEdges[0].basis, 'lexical-literal');
  assert.equal(result.moduleEdges[0].resolution, 'unresolved');
  assert.deepEqual(result.moduleEdges.map((e) => [e.kind, e.specifier]), [
    ['import', 'express'], ['import', 'node:path'], ['import', './types'], ['import', './bootstrap'], ['export-from', './app'],
  ]);
  assert.deepEqual(result.moduleEdges[0].bindings, [
    { imported: 'default', local: 'express', bindingKind: 'default', typeOnly: false },
    { imported: 'Router', local: 'ExpressRouter', bindingKind: 'named', typeOnly: false },
    { imported: 'Request', local: 'Request', bindingKind: 'named', typeOnly: true },
  ]);
  assert.equal(result.moduleEdges[2].typeOnly, true);
  assert.equal(result.moduleEdges[2].bindings[0].typeOnly, true);
  assert.deepEqual(result.moduleEdges[3].bindings, []);
});

test('CommonJS require records simple default/destructured bindings and ignores member calls', () => {
  const out = edges(`
const express = require('express');
const { Router: R, json } = require("express");
require('./side-effect');
obj.require('not-a-module-edge');
`);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].bindings, [{ imported: 'module.exports', local: 'express', bindingKind: 'commonjs-default', typeOnly: false }]);
  assert.deepEqual(out[1].bindings, [
    { imported: 'Router', local: 'R', bindingKind: 'commonjs-named', typeOnly: false },
    { imported: 'json', local: 'json', bindingKind: 'commonjs-named', typeOnly: false },
  ]);
  assert.equal(out[2].specifier, './side-effect');
});

test('comments, strings, regexes and member methods cannot manufacture import facts', () => {
  const result = analyzeJsTsSource(String.raw`
// import nope from 'comment-a'
/* const x = require('comment-b') */
const prose = "import fake from 'string-a'";
const re = /require\\('regex-a'\\)/g;
obj.import('member-a');
obj.require('member-b');
import real from 'real-module';
`);
  assert.deepEqual(result.moduleEdges.map((e) => e.specifier), ['real-module']);
});

test('literal dynamic import is explicit; non-literal import is an unknown diagnostic', () => {
  const result = analyzeJsTsSource(`
const a = import('./literal.js');
const b = import('./' + name + '.js');
const c = require(pkgName);
`);
  assert.deepEqual(result.moduleEdges.map((e) => [e.kind, e.specifier]), [['dynamic-import', './literal.js']]);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['dynamic-import-nonliteral', 'require-nonliteral']);
});

test('UTF-8 byte spans remain exact when non-ASCII text precedes an import', () => {
  const source = `const title = '한글🙂';\nimport value from './value.js';\n`;
  const [edge] = edges(source);
  const bytes = Buffer.from(source, 'utf8');
  assert.equal(bytes.subarray(edge.source.byteStart, edge.source.byteEnd).toString('utf8'), `import value from './value.js'`);
  assert.equal(edge.source.line, 2);
});

test('escaped module string is deliberately unresolved instead of decoded by the lexer', () => {
  const result = analyzeJsTsSource(String.raw`import x from './fo\\u006f.js';`);
  assert.equal(result.moduleEdges.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'escaped-module-literal'));
  assert.ok(result.diagnostics.every((d) => d.source === undefined || Number.isSafeInteger(d.source.byteStart)));
  assert.ok(result.diagnostics.some((d) => d.code === 'import-unresolved'));
});

test('template interpolation is bounded and does not leak fake imports from template text', () => {
  const result = analyzeJsTsSource('const x = `text ${"import fake from \\\'inside\\\'"}`;\nimport ok from "outside";');
  assert.deepEqual(result.moduleEdges.map((e) => e.specifier), ['outside']);
  assert.ok(result.diagnostics.some((d) => d.code === 'template-expression-unparsed'));
});

test('input and token limits fail closed without partial facts', () => {
  const tooBig = analyzeJsTsSource(`import x from 'x';`, { maxBytes: 5 });
  assert.equal(tooBig.complete, false);
  assert.deepEqual(tooBig.moduleEdges, []);
  assert.equal(tooBig.diagnostics[0].code, 'input-too-large');

  const tokenLimited = analyzeJsTsSource(`import x from 'x'; import y from 'y';`, { maxTokens: 3 });
  assert.equal(tokenLimited.complete, false);
  assert.deepEqual(tokenLimited.moduleEdges, []);
  assert.equal(tokenLimited.diagnostics[0].code, 'token-limit');
});

test('same bytes and options produce byte-identical JSON', () => {
  const src = `import { Router } from 'express';\nconst r = require('./router');\n`;
  const one = analyzeJsTsSource(src, { filePath: 'src/router.ts', language: 'typescript' });
  const two = analyzeJsTsSource(src, { filePath: 'src/router.ts', language: 'typescript' });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});

test('analyzer receives source bytes only and never executes target code', () => {
  globalThis.__BSKEL_T04_SENTINEL__ = 0;
  const src = `globalThis.__BSKEL_T04_SENTINEL__ = 99;\nimport x from 'x';`;
  const result = analyzeJsTsSource(src);
  assert.equal(globalThis.__BSKEL_T04_SENTINEL__, 0);
  assert.equal(result.moduleEdges[0].specifier, 'x');
  delete globalThis.__BSKEL_T04_SENTINEL__;
});

test('unsupported language modes are rejected rather than guessed', () => {
  assert.throws(() => analyzeJsTsSource('', { language: 'java' }), /unsupported language mode/);
});
