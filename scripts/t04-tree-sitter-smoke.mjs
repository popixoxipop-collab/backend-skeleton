#!/usr/bin/env node
// T04 Tree-sitter candidate smoke.
//
// Exact native/parser packages are installed only inside a disposable scratch directory on the
// GitHub-hosted CI runner. This is an evaluation profile, not a backend-skeleton runtime dependency.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { lexicalJsTsBackend, compareJsTsBackends } from '../scanners/language/js-ts/backend-comparison.mjs';
import { createTreeSitterJsTsBackend } from '../scanners/language/js-ts/tree-sitter-backend.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t04-tree-sitter-'));

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function loadPackage(name) {
  const requireFromScratch = createRequire(path.join(scratch, 'package.json'));
  return requireFromScratch(name);
}

try {
  fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
      'tree-sitter': '0.21.1',
      'tree-sitter-javascript': '0.23.1',
      'tree-sitter-typescript': '0.23.2',
    },
  }, null, 2));

  console.log('t04-tree-sitter-smoke: installing exact candidate packages in scratch...');
  // Do NOT use --ignore-scripts: tree-sitter uses a native addon and its normal package install
  // lifecycle is part of this exact-version CI candidate profile. The scratch has no secrets and
  // runs on GitHub-hosted pull-request infrastructure.
  sh('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], scratch);

  const ParserModule = loadPackage('tree-sitter');
  const Parser = ParserModule.default ?? ParserModule;
  const JavaScriptModule = loadPackage('tree-sitter-javascript');
  const JavaScript = JavaScriptModule.default ?? JavaScriptModule;
  const TypeScriptGrammars = loadPackage('tree-sitter-typescript');

  assert.ok(TypeScriptGrammars.typescript, 'tree-sitter-typescript must expose .typescript');
  assert.ok(TypeScriptGrammars.tsx, 'tree-sitter-typescript must expose .tsx');

  const backend = createTreeSitterJsTsBackend(Parser, {
    javascript: JavaScript,
    typescript: TypeScriptGrammars.typescript,
    tsx: TypeScriptGrammars.tsx,
  }, { id: 'tree-sitter-0.21.1-ts-0.23.2' });

  const simple = compareJsTsBackends([lexicalJsTsBackend(), backend], [{
    id: 'simple-js-import',
    source: "import value from './value.js';\n",
    options: { filePath: 'src/app.js', language: 'javascript' },
  }]);
  const simpleDiff = simple.cases[0].comparisons.find((x) => x.backendId === backend.id);
  assert.deepEqual(simpleDiff.differences, ['syntaxValidated']);

  const ts = backend.analyze(`
import express, { Router as R, type Request } from 'express';
import type { User } from './types';
export { thing } from './thing';
const router = require('./router');
const { json: expressJson } = require('express');
const lazy = import('./lazy');
`, { filePath: 'src/app.ts', language: 'typescript' });
  assert.equal(ts.complete, true);
  assert.equal(ts.syntaxValidated, true);
  assert.deepEqual(ts.moduleEdges.map((e) => [e.kind, e.specifier]), [
    ['import', 'express'],
    ['import', './types'],
    ['export-from', './thing'],
    ['require', './router'],
    ['require', 'express'],
    ['dynamic-import', './lazy'],
  ]);
  assert.equal(ts.moduleEdges[1].typeOnly, true);
  assert.equal(ts.moduleEdges[1].bindings[0].typeOnly, true);
  assert.deepEqual(ts.moduleEdges[4].bindings, [{
    imported: 'json',
    local: 'expressJson',
    bindingKind: 'commonjs-named',
    typeOnly: false,
  }]);

  const tsx = backend.analyze(`
import { Canvas } from '@react-three/fiber';
import Player from './Player';
export const App = () => <Canvas><Player /></Canvas>;
`, { filePath: 'src/App.tsx', language: 'tsx' });
  assert.equal(tsx.syntaxValidated, true);
  assert.deepEqual(tsx.moduleEdges.map((e) => [e.kind, e.specifier]), [
    ['import', '@react-three/fiber'],
    ['import', './Player'],
  ]);

  const invalid = backend.analyze("import { value from './broken';\n", {
    filePath: 'src/broken.ts',
    language: 'typescript',
  });
  assert.equal(invalid.complete, true);
  assert.equal(invalid.syntaxValidated, false);
  assert.ok(invalid.diagnostics.some((d) => d.code === 'tree-sitter-parse-error'));

  const comments = backend.analyze(`
// import fake from 'comment';
const prose = "require('string-fake')";
const real = require('./real');
`, { filePath: 'src/comments.js', language: 'javascript' });
  assert.deepEqual(comments.moduleEdges.map((e) => [e.kind, e.specifier]), [
    ['require', './real'],
  ]);

  const dynamic = backend.analyze(`
const a = import('./' + name);
const b = require(packageName);
obj.require('not-a-module-edge');
`, { filePath: 'src/dynamic.js', language: 'javascript' });
  assert.deepEqual(dynamic.moduleEdges, []);
  assert.deepEqual(dynamic.diagnostics.map((d) => d.code), [
    'dynamic-import-nonliteral',
    'require-nonliteral',
  ]);

  const utf8Source = "const title = '한글😀';\nimport value from './value.js';\n";
  const utf8 = backend.analyze(utf8Source, { filePath: 'src/utf8.ts', language: 'typescript' });
  const edge = utf8.moduleEdges[0];
  assert.equal(
    Buffer.from(utf8Source).subarray(edge.source.byteStart, edge.source.byteEnd).toString('utf8'),
    "import value from './value.js'",
  );
  assert.equal(edge.source.line, 2);

  const tooBig = backend.analyze("import x from 'x';", { maxBytes: 1 });
  assert.equal(tooBig.complete, false);
  assert.equal(tooBig.syntaxValidated, false);
  assert.deepEqual(tooBig.moduleEdges, []);
  assert.equal(tooBig.diagnostics[0].code, 'input-too-large');

  const tooManyTokens = backend.analyze("import x from 'x'; import y from 'y';", { maxTokens: 2 });
  assert.equal(tooManyTokens.complete, false);
  assert.equal(tooManyTokens.syntaxValidated, false);
  assert.deepEqual(tooManyTokens.moduleEdges, []);
  assert.equal(tooManyTokens.diagnostics[0].code, 'token-limit');

  console.log('t04-tree-sitter-smoke: PASS');
  console.log('t04-tree-sitter-smoke: candidate versions tree-sitter=0.21.1 javascript=0.23.1 typescript=0.23.2');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
