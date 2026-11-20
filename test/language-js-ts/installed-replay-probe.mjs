// Runs only against a disposable npm-installed package, never the source checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, slot] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(slot));
const modulePath = path.join(root, 'scanners/language/js-ts/source-facts.mjs');

if (slot === 'previous') {
  assert.equal(fs.existsSync(modulePath), false);
  console.log(JSON.stringify({ expected: slot, vectors: 1, release_authorized: false }));
} else {
  assert.equal(fs.existsSync(modulePath), true);
  const { analyzeJsTsSource, JS_TS_FACTS_CONTRACT } = await import(pathToFileURL(modulePath).href);
  const literal = analyzeJsTsSource("import x from './x.js'; // require('inert')", { filePath: 'src/a.ts', language: 'typescript' });
  assert.equal(literal.contract, JS_TS_FACTS_CONTRACT);
  assert.equal(literal.syntaxValidated, false);
  assert.deepEqual(literal.moduleEdges.map(edge => edge.specifier), ['./x.js']);
  const dynamic = analyzeJsTsSource('import(name);', { filePath: 'src/b.js' });
  assert.equal(dynamic.moduleEdges.length, 0);
  assert.ok(dynamic.diagnostics.some(item => item.code === 'dynamic-import-nonliteral'));
  const limited = analyzeJsTsSource("import x from './x.js'", { maxBytes: 4 });
  assert.equal(limited.complete, false);
  assert.equal(limited.moduleEdges.length, 0);
  assert.ok(limited.diagnostics.some(item => item.code === 'input-too-large'));
  const inert = analyzeJsTsSource("/* import x from 'false' */\nconst s = \"require('false')\";", { filePath: 'src/c.js' });
  assert.equal(inert.moduleEdges.length, 0);
  if (process.env.T04_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
  console.log(JSON.stringify({ expected: slot, vectors: 4, release_authorized: false }));
}
