import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeJsTsSource } from '../../scanners/language/js-ts/source-facts.mjs';

test('Legacy A: comments, strings and regex text stay inert for module-edge discovery', () => {
  const source = String.raw`
    // import fake from 'comment-only';
    /* const hidden = require('comment-require'); */
    const docs = "import fake from 'string-only'";
    const re = /require\('regex-only'\)|import fake from 'regex-import'/g;
    import real from './real.js';
  `;
  const result = analyzeJsTsSource(source, {
    filePath: 'src/legacy-a.ts',
    language: 'typescript',
  });

  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.deepEqual(result.moduleEdges.map((edge) => edge.specifier), ['./real.js']);
  assert.ok(result.moduleEdges.every((edge) => edge.basis === 'lexical-literal'));
});

test('Legacy A: delimiter damage is not silently promoted to syntax-valid analysis', () => {
  const source = `
    import real from './real.js';
    function broken() {
      return 1;
  `;
  const result = analyzeJsTsSource(source, {
    filePath: 'src/broken.ts',
    language: 'typescript',
  });

  // The bounded lexer can still finish tokenization and preserve a literal import. It does NOT
  // validate delimiter balance or TypeScript syntax. A parser backend is required for that claim.
  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.equal(result.moduleEdges[0]?.specifier, './real.js');
  assert.equal(result.moduleEdges[0]?.basis, 'lexical-literal');
});

test('Legacy A: lexical coordinates are exact for the provided source string, not a Svelte host container', () => {
  const svelte = `<h1>demo</h1>
<script lang="ts">
  import { Scene } from 'three';
  const scene = new Scene();
</script>`;
  const open = svelte.indexOf('>\n', svelte.indexOf('<script')) + 2;
  const close = svelte.indexOf('</script>', open);
  const script = svelte.slice(open, close);

  const result = analyzeJsTsSource(script, {
    filePath: 'src/Scene.svelte',
    language: 'typescript',
  });
  const edge = result.moduleEdges.find((item) => item.specifier === 'three');

  assert.ok(edge);
  assert.equal(edge.source.line, 1);
  assert.equal(result.syntaxValidated, false);

  // Legacy A's Svelte parser reports original-container coordinates (line 3). This T04 API is
  // intentionally source-string relative; host-container offset/provenance is not claimed here.
  assert.equal(svelte.slice(0, open).split('\n').length, 3);
});

test('Issue #119 handoff: default plus named Express import bindings are preserved as source facts', () => {
  const source = `
    import express, { Router } from 'express';
    const userRouter: Router = express.Router();
    userRouter.get('/:id', authentication, getUserById);
  `;
  const result = analyzeJsTsSource(source, {
    filePath: 'src/routes/user.ts',
    language: 'typescript',
  });
  const expressEdge = result.moduleEdges.find((edge) => edge.specifier === 'express');

  assert.ok(expressEdge);
  assert.deepEqual(expressEdge.bindings, [
    { imported: 'default', local: 'express', bindingKind: 'default', typeOnly: false },
    { imported: 'Router', local: 'Router', bindingKind: 'named', typeOnly: false },
  ]);
  assert.equal(expressEdge.basis, 'lexical-literal');
  assert.equal(result.syntaxValidated, false);

  // T04 does not claim framework call semantics here. T11 owns deciding that express.Router()
  // should satisfy the TypeScript Express detector's router-construction signal.
});

test('Legacy A: unterminated block comments stay inert and are surfaced as lexical uncertainty', () => {
  const source = "import real from './real.js';\n/* import fake from 'comment-leak.js';";
  const result = analyzeJsTsSource(source, {
    filePath: 'src/unclosed-comment.ts',
    language: 'typescript',
  });

  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.deepEqual(result.moduleEdges.map((edge) => edge.specifier), ['./real.js']);
  assert.ok(result.diagnostics.some((item) => item.code === 'unterminated-block-comment'));
});

test('Legacy A: unterminated regex bodies cannot manufacture import facts', () => {
  const source = "const docs = /import fake from 'regex-leak.js';\nimport real from './real.js';";
  const result = analyzeJsTsSource(source, {
    filePath: 'src/unclosed-regex.ts',
    language: 'typescript',
  });

  assert.equal(result.complete, true);
  assert.equal(result.syntaxValidated, false);
  assert.deepEqual(result.moduleEdges.map((edge) => edge.specifier), ['./real.js']);
  assert.ok(result.diagnostics.some((item) => item.code === 'unterminated-regex'));
});

test('Legacy A: UTF-8 byte coordinates remain exact for the supplied source string', () => {
  const source = "const label = '한글😀';\nimport real from './real.js';\n";
  const result = analyzeJsTsSource(source, {
    filePath: 'src/coords.ts',
    language: 'typescript',
  });
  const edge = result.moduleEdges[0];
  const bytes = Buffer.from(source, 'utf8');

  assert.ok(edge);
  assert.equal(edge.source.line, 2);
  assert.equal(
    bytes.subarray(edge.source.byteStart, edge.source.byteEnd).toString('utf8'),
    "import real from './real.js'",
  );
  assert.equal(result.syntaxValidated, false);
});

