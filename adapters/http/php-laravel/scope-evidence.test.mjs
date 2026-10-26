import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  COMMAND, RECEIPT, SOURCE_FILES, UPSTREAM, SCOPE, digests, problems, replay,
} from './scope-evidence.mjs';

test('Laravel scope receipt replays a real zero-skip 16-case Node run', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.ok(SOURCE_FILES.length >= 100);
  assert.deepEqual(replay().counts, {
    tests: 16, pass: 16, fail: 0, skipped: 0, cancelled: 0, todo: 0,
  });
  assert.deepEqual(problems(receipt), []);
});

test('source SHA mutations and absent pin sets invalidate the receipt', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const relative = 'scanners/language/ruby-php/dsl-facts.mjs';
  assert.ok(problems(receipt, { ...digests(), [relative]: 'f'.repeat(64) }, false)
    .some((value) => value.includes('source digest drift')));
  assert.ok(problems({ ...receipt, sources: {} }, digests(), false)
    .some((value) => value.includes('invalid source map')));
});

test('matching fake caller digests cannot forge immutable upstream Git-source bytes', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const relative = 'adapters/http/php-laravel/fixtures/upstream/laravel/routes/web.php';
  const forged = { ...receipt, sources: { ...receipt.sources, [relative]: '0'.repeat(64) } };
  assert.deepEqual(problems(forged, { ...digests(), [relative]: '0'.repeat(64) }, false), []);
  assert.ok(problems(forged, { ...digests(), [relative]: '0'.repeat(64) }, true)
    .some((value) => value.includes('original Git blob differs')));
});

test('source revision, upstream identity, runtime scope, and fake authority are rejected', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.ok(problems({ ...receipt, source_commit: '0'.repeat(40) }).length);
  assert.ok(problems({ ...receipt, upstream: { ...UPSTREAM, framework_tag: 'v13.18.0' } }, undefined, false)
    .some((value) => value.includes('upstream identity drift')));
  assert.ok(problems({ ...receipt, scope: { ...SCOPE, artisan_executed: true } }, undefined, false)
    .some((value) => value.includes('oracle/runtime scope drift')));
  for (const [name, value] of [
    ['MET', 1], ['release', true], ['runtime_certified', true],
    ['external_runtime_equal', true], ['signed_attestation', true],
  ]) {
    assert.ok(problems({ ...receipt, assertions: { ...receipt.assertions, [name]: value } }, undefined, false)
      .some((entry) => entry.includes('false authority')));
  }
});

test('fabricated PASS, skip, or replay command cannot substitute for the real run', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const skipped = {
    ...receipt,
    observed: { ...receipt.observed, counts: { ...receipt.observed.counts, pass: 15, skipped: 1 } },
  };
  assert.ok(problems(skipped, undefined, false).some((value) => value.includes('replay mismatch')));
  assert.equal(Object.isFrozen(COMMAND), true);
  assert.throws(() => COMMAND.splice(1), TypeError);
  const forged = { ...receipt, observed: { ...receipt.observed, command: ['node', '-e', 'print fake TAP totals'] } };
  assert.ok(problems(forged, undefined, false).some((value) => value.includes('replay mismatch')));
});

test('Laravel analyzers, Wave A leaf, baseline lock, nested runner, and ownership truth stay pinned', () => {
  const dependencies = [
    'scanners/language/ruby-php/dsl-facts.mjs',
    'scanners/language/ruby-php/dsl-expand.mjs',
    'scanners/language/ruby-php/expand-laravel.mjs',
    'scanners/language/ruby-php/runtime-route-snapshot.mjs',
    'adapters/http-wave-a/laravel.mjs',
    'adapters/http-wave-a/_shared.mjs',
    'adapters/http-wave-a/BASELINE.json',
    'test/http-wave-a/route-unknown-preservation.test.mjs',
    'test/language-ruby-php/dsl-expand.test.mjs',
    'next/t00/baseline.lock.json',
    'next/t00/ownership-map.json',
    'scripts/run-next-nested-tests.mjs',
  ];
  for (const relative of dependencies) assert.ok(SOURCE_FILES.includes(relative), 'missing dependency pin ' + relative);
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const relative = 'adapters/http-wave-a/laravel.mjs';
  const tampered = { ...digests(), [relative]: '0'.repeat(64) };
  assert.ok(problems(receipt, tampered, false).some((value) => value.includes('source digest drift ' + relative)));
  const forged = { ...receipt, sources: { ...receipt.sources, [relative]: '0'.repeat(64) } };
  assert.ok(problems(forged, tampered, true).some((value) => value.includes('original Git blob differs ' + relative)));
});

test('receipt field sets reject injected authority and removed evidence keys', () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.deepEqual(problems({ ...receipt, approval: 'forged' }, undefined, false), ['invalid receipt field set']);
  const { limits, ...missing } = receipt;
  assert.deepEqual(problems(missing, undefined, false), ['invalid receipt field set']);
});
