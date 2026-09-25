#!/usr/bin/env node
// T04 candidate smoke: install two exact TypeScript versions into a disposable directory and
// execute the injected Compiler API backend. No TypeScript dependency is added to backend-skeleton.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { lexicalJsTsBackend, compareJsTsBackends } from '../scanners/language/js-ts/backend-comparison.mjs';
import { createTypeScriptCompilerBackend } from '../scanners/language/js-ts/typescript-compiler-backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t04-ts-compiler-'));

function fail(message) {
  console.error(`t04-typescript-compiler-smoke: FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

async function loadCompiler(packageName) {
  const requireFromScratch = createRequire(path.join(scratch, 'package.json'));
  let entry;
  try {
    entry = requireFromScratch.resolve(packageName);
  } catch (error) {
    fail(`cannot resolve installed compiler package "${packageName}": ${error.message}`);
  }
  const imported = await import(pathToFileURL(entry).href);
  return imported.default ?? imported;
}

try {
  fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
      typescript: '5.9.3',
      typescript7: 'npm:typescript@7.0.2',
    },
  }, null, 2));

  console.log('t04-typescript-compiler-smoke: installing exact compiler candidates 5.9.3 and 7.0.2 in scratch...');
  sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], scratch);

  const ts59 = await loadCompiler('typescript');
  const ts70 = await loadCompiler('typescript7');
  assert.equal(ts59.version, '5.9.3');
  assert.equal(ts70.version, '7.0.2');

  const backend59 = createTypeScriptCompilerBackend(ts59, { id: 'typescript-compiler-5.9.3' });
  const backend70 = createTypeScriptCompilerBackend(ts70, { id: 'typescript-compiler-7.0.2' });

  const parityCorpus = [{
    id: 'module-edges',
    source: `
import express, { Router as R, type Request } from 'express';
import * as pathNs from 'node:path';
import type { User } from './types';
export { thing } from './thing';
const router = require('./router');
const { json: expressJson } = require('express');
const lazy = import('./lazy');
`,
    options: { filePath: 'src/app.ts', language: 'typescript' },
  }];

  const crossVersion = compareJsTsBackends([backend59, backend70], parityCorpus, {
    referenceBackendId: backend59.id,
  });
  const v7Comparison = crossVersion.cases[0].comparisons.find((x) => x.backendId === backend70.id);
  assert.deepEqual(v7Comparison, {
    backendId: backend70.id,
    comparable: true,
    agrees: true,
    differences: [],
  });

  const lexicalParity = compareJsTsBackends([lexicalJsTsBackend(), backend59], [{
    id: 'simple-lexical-parity',
    source: "import x from './x.js';\n",
    options: { filePath: 'src/app.js', language: 'javascript' },
  }]);
  const compilerComparison = lexicalParity.cases[0].comparisons.find((x) => x.backendId === backend59.id);
  assert.deepEqual(compilerComparison.differences, ['syntaxValidated']);

  for (const backend of [backend59, backend70]) {
    const valid = backend.analyze(`
import type { User } from './types';
import { Router as R } from 'express';
const { json: expressJson } = require('express');
const lazy = import('./lazy');
export { thing } from './thing';
`, { filePath: 'src/app.ts', language: 'typescript' });
    assert.equal(valid.complete, true);
    assert.equal(valid.syntaxValidated, true);
    assert.deepEqual(valid.moduleEdges.map((e) => [e.kind, e.specifier]), [
      ['import', './types'],
      ['import', 'express'],
      ['require', 'express'],
      ['dynamic-import', './lazy'],
      ['export-from', './thing'],
    ]);
    assert.equal(valid.moduleEdges[0].typeOnly, true);
    assert.equal(valid.moduleEdges[0].bindings[0].typeOnly, true);
    assert.deepEqual(valid.moduleEdges[2].bindings, [{
      imported: 'json',
      local: 'expressJson',
      bindingKind: 'commonjs-named',
      typeOnly: false,
    }]);

    const invalid = backend.analyze("import { value from './broken';\n", {
      filePath: 'src/broken.ts',
      language: 'typescript',
    });
    assert.equal(invalid.complete, true);
    assert.equal(invalid.syntaxValidated, false);
    assert.ok(invalid.diagnostics.some((d) => d.code === 'typescript-parse-diagnostic'));

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

    const importEquals = backend.analyze("import router = require('./router');\n", {
      filePath: 'src/legacy.ts',
      language: 'typescript',
    });
    assert.equal(importEquals.syntaxValidated, true);
    assert.deepEqual(importEquals.moduleEdges.map((e) => [e.kind, e.specifier, e.bindings[0]?.local]), [
      ['require', './router', 'router'],
    ]);

    const utf8Source = "const title = '한글😀';\nimport value from './value.js';\n";
    const utf8 = backend.analyze(utf8Source, { filePath: 'src/utf8.ts', language: 'typescript' });
    const edge = utf8.moduleEdges[0];
    assert.equal(Buffer.from(utf8Source).subarray(edge.source.byteStart, edge.source.byteEnd).toString('utf8'), "import value from './value.js'");
    assert.equal(edge.source.line, 2);

    const tooBig = backend.analyze("import x from 'x';", { maxBytes: 1 });
    assert.equal(tooBig.complete, false);
    assert.deepEqual(tooBig.moduleEdges, []);
    assert.equal(tooBig.diagnostics[0].code, 'input-too-large');

    const tooManyTokens = backend.analyze("import x from 'x'; import y from 'y';", { maxTokens: 2 });
    assert.equal(tooManyTokens.complete, false);
    assert.deepEqual(tooManyTokens.moduleEdges, []);
    assert.equal(tooManyTokens.diagnostics[0].code, 'token-limit');
  }

  console.log('t04-typescript-compiler-smoke: PASS');
  console.log(`t04-typescript-compiler-smoke: versions ${ts59.version} and ${ts70.version} produced identical normalized module facts on the comparison corpus`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
