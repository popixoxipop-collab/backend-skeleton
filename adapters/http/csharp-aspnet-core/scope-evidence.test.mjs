import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT, SOURCE_FILES, UPSTREAM, SCOPE, digests, problems, replay,
} from './scope-evidence.mjs';

const readReceipt = () => JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
const copy = (value) => structuredClone(value);

test('receipt is source-bound and replays a real 14/14 zero-skip run', () => {
  const receipt = readReceipt();
  assert.deepEqual(problems(receipt), []);
  assert.deepEqual(receipt.observed, replay());
  assert.deepEqual(receipt.observed.counts, { tests: 14, pass: 14, fail: 0, skipped: 0, cancelled: 0, todo: 0 });
});

test('source mutation and missing pins are rejected', () => {
  const receipt = readReceipt();
  const actual = digests();
  actual[SOURCE_FILES[0]] = '0'.repeat(64);
  assert.ok(problems(receipt, actual, false).some((item) => item.startsWith('source digest drift')));
  const missing = copy(receipt);
  delete missing.sources[SOURCE_FILES[1]];
  assert.deepEqual(problems(missing, digests(), false), ['invalid source map']);
});

test('matching caller-supplied digest cannot forge the source commit Git blob', () => {
  const receipt = readReceipt();
  const forged = copy(receipt);
  const relative = 'adapters/http/csharp-aspnet-core/TARGET_SCOPE.md';
  forged.sources[relative] = 'a'.repeat(64);
  const fakeActual = digests();
  fakeActual[relative] = forged.sources[relative];
  assert.ok(problems(forged, fakeActual, true).some((item) => item === 'original Git blob differs ' + relative));
});

test('BLOCKED_INFRA, exact upstream, oracle scope, and authority cannot drift', () => {
  const receipt = readReceipt();
  assert.deepEqual(receipt.upstream, UPSTREAM);
  assert.deepEqual(receipt.scope, SCOPE);
  const upstream = copy(receipt);
  upstream.upstream.comparison = 'PASS';
  assert.ok(problems(upstream, digests(), false).includes('upstream identity or comparison drift'));
  const runtime = copy(receipt);
  runtime.scope.dotnet_executed = true;
  runtime.assertions.runtime_certified = true;
  const failures = problems(runtime, digests(), false);
  assert.ok(failures.includes('oracle/runtime scope drift'));
  assert.ok(failures.includes('false authority'));
});

test('fabricated totals or replay commands fail evidence validation', () => {
  const receipt = readReceipt();
  const totals = copy(receipt);
  totals.observed.counts.pass = 15;
  assert.ok(problems(totals, digests(), false).includes('replay mismatch'));
  const command = copy(receipt);
  command.observed.command = ['node', '--test', 'fabricated.test.mjs'];
  assert.ok(problems(command, digests(), false).includes('replay mismatch'));
});

test('closure pins baseline, nested runner, ownership inputs, and transitive ASP.NET code', () => {
  for (const relative of [
    'next/t00/baseline.lock.json',
    'scripts/run-next-nested-tests.mjs',
    'next/t00/ownership-map.json',
    'next/t00/fixtures/ownership-rules.json',
    'next/t00/fixtures/plan-write-scopes.json',
    'adapters/http-wave-a/aspnet-core.mjs',
    'adapters/http-wave-a/_shared.mjs',
    'scanners/language/native-server/csharp.mjs',
    'scanners/language/native-server/shared.mjs',
  ]) {
    assert.ok(SOURCE_FILES.includes(relative), relative + ' must be hash-pinned');
  }
});
