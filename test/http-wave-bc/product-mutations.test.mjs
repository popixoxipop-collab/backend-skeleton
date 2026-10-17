// T13-04: three product-source mutants run only in disposable copies.
// No promotion or T13-02 receipt-verification claims follow from this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const OUT = 'test/http-wave-bc';
const MUTANTS = [
  {
    id: 'Hono: unknown basePath must withhold routes',
    file: 'adapters/http-wave-bc/node-hono/route-graph.mjs',
    sha: '604e6ad4d0fe7f2d95ddd77487c1d5cd8f04d9932ab5d6e6c935ceac839ea488',
    test: OUT + '/node-hono.test.mjs',
    testSha: 'bd4808742799c32ff61ceb8e60093ca908f753d1844d8f45b41aceb96251d52b',
    find: "if (node.basePathUnknown) {\n          notes.push('Hono basePath()",
    replace: "if (false) {\n          notes.push('Hono basePath()",
    expectedFailure: 'dynamic basePath and interpolated template routes are refused instead of mis-normalized'
  },
  {
    id: 'Koa: an unmounted router must not emit live routes',
    file: 'adapters/http-wave-bc/node-koa/adapter.mjs',
    sha: 'd546ae51e5fbb5893fbf90c901c6a68445ac4dbb299c03c3c507645d1f142129',
    test: OUT + '/node-koa.test.mjs',
    testSha: '273713c0f8bd5d9b00e6bd6d05b9758b6ed18e3c39acffccc5ad6fcb93b9cbea',
    find: 'if (!appUsesRouter(masked, apps.keys(), router.name)) {',
    replace: 'if (false) {',
    expectedFailure: 'unmounted router routes are withheld instead of treated as live application routes'
  },
  {
    id: 'Next.js: catch-all must keep its withheld reason',
    file: 'adapters/http-wave-bc/typescript-nextjs/adapter.mjs',
    sha: '8df6384432f9fa0936a533a1607c8db81a0289e2b3a2b0080189fc20a3e5bffc',
    test: OUT + '/typescript-nextjs.test.mjs',
    testSha: '3fb3bf7af91c1b5e9044cc233460b87d2991aa097742824c405c1f338fa2c82a',
    find: "if (segment.includes('[...') || segment.includes('[[...')) return { path: null, unknown: true, reason: 'catch-all-segment', params };",
    replace: "if (false) return { path: null, unknown: true, reason: 'catch-all-segment', params };",
    expectedFailure: 'catch-all and optional catch-all Route Handlers are not flattened into fake single params'
  }
];

const READONLY_DEPENDENCIES = [
  'scanners/adapters/_express-shared.mjs',
  'scanners/text-util.mjs',
  'schemas/adapter.schema.json'
];
function copyFile(root, destination, relativePath) {
  const out = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(root, relativePath), out);
}
function assertPinned(root, row) {
  for (const [relativePath, digest] of [[row.file, row.sha], [row.test, row.testSha]]) {
    const actual = sha256(fs.readFileSync(path.join(root, relativePath)));
    assert.equal(actual, digest, 'unpinned input ' + relativePath);
  }
  const code = fs.readFileSync(path.join(root, row.file), 'utf8');
  assert.equal(code.split(row.find).length - 1, 1, 'nonunique mutation anchor ' + row.id);
  assert.notEqual(row.find, row.replace);
}
function isolatedCopy() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-mutation-'));
  for (const subdir of ['adapters/http-wave-bc', 'test/http-wave-bc']) {
    fs.mkdirSync(path.dirname(path.join(temp, subdir)), { recursive: true });
    fs.cpSync(path.join(ROOT, subdir), path.join(temp, subdir), { recursive: true, dereference: false });
  }
  for (const file of READONLY_DEPENDENCIES) copyFile(ROOT, temp, file);
  const dependencyDir = path.join(ROOT, 'node_modules');
  assert.ok(fs.statSync(dependencyDir).isDirectory(), 'test dependencies are not installed');
  fs.symlinkSync(dependencyDir, path.join(temp, 'node_modules'), 'dir');
  return temp;
}
function cleanChildEnv() {
  const env = { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '1', CI: '1' };
  // node:test sets NODE_TEST_CONTEXT=child-v8. Inheriting it into a nested
  // "node --test" silently skips the child suite and exits 0 with a warning.
  // Fail closed on any unexecuted child; remove only this runner-control flag.
  delete env.NODE_TEST_CONTEXT;
  return env;
}
function targetedRun(root, testFile) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    env: cleanChildEnv()
  });
}
function assertGoodRun(run, id) {
  assert.ifError(run.error);
  assert.equal(run.status, 0, id + ': unmodified input suite failed: ' + String(run.stdout).slice(-1600) + ' ' + String(run.stderr).slice(-500));
  assert.equal(run.signal, null, id + ': terminated by signal');
  assert.match(run.stdout ?? '', /^# fail 0\s*$/m);
  assert.match(run.stdout ?? '', /^# skipped 0\s*$/m);
}
test('T13-04 nested Node test environment excludes inherited NODE_TEST_CONTEXT', () => {
  assert.ok(!Object.hasOwn(cleanChildEnv(), 'NODE_TEST_CONTEXT'));
});

for (const row of MUTANTS) {
  test('T13-04 product mutation rejected: ' + row.id, (t) => {
    assertPinned(ROOT, row);
    let temp;
    try {
      temp = isolatedCopy();
      const original = targetedRun(temp, row.test);
      assertGoodRun(original, row.id);
      const file = path.join(temp, row.file);
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(source.split(row.find).length - 1, 1, 'anchor altered in isolated copy');
      fs.writeFileSync(file, source.replace(row.find, row.replace));
      assert.notEqual(sha256(fs.readFileSync(file)), row.sha, 'product source mutation did not change bytes');
      const mutant = targetedRun(temp, row.test);
      assert.ifError(mutant.error);
      assert.notEqual(mutant.status, 0, row.id + ': mutant survived all asserted checks');
      assert.equal(mutant.signal, null, row.id + ': mutation stopped by signal rather than test assertion');
      assert.match(mutant.stdout ?? '', /^# fail [1-9]\d*\s*$/m, row.id + ': no asserted test failure recorded');
      const marker = /^not ok \d+ - (.+)$/gm;
      const failedNames = [...(mutant.stdout ?? '').matchAll(marker)].map((m) => m[1].trim());
      assert.ok(failedNames.includes(row.expectedFailure),
        row.id + ': mutant died for unexpected reason: ' + failedNames.join('; ') + '; stdout tail ' + String(mutant.stdout).slice(-1800));
      const cleanTests = /^# tests (\d+)\s*$/m.exec(original.stdout ?? '');
      const mutantTests = /^# tests (\d+)\s*$/m.exec(mutant.stdout ?? '');
      assert.ok(cleanTests && mutantTests, row.id + ': missing measured TAP test counts');
      assert.equal(mutantTests[1], cleanTests[1], row.id + ': mutated suite ran fewer tests');
      t.diagnostic('MUTANT_RESULT ' + JSON.stringify({
        id: row.id, node: process.version, source_sha256: row.sha, test_sha256: row.testSha,
        mutant_sha256: sha256(fs.readFileSync(file)), clean_exit: original.status,
        mutant_exit: mutant.status, tests: Number(cleanTests[1]), expected_failure: row.expectedFailure,
        observed_failures: failedNames
      }));
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
