import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  T22_DISTRIBUTION_RECEIPT,
  canonicalJson,
  receiptBytes,
  sha256Bytes,
  verifyDistributionArtifacts as verifyDistributionArtifactsRaw,
} from '../scripts/t22-distribution-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = '1'.repeat(40);
const TREE = '2'.repeat(40);
function verifyDistributionArtifacts(directory, options = {}) {
  return verifyDistributionArtifactsRaw(directory, { expectedHead: HEAD, expectedTree: TREE, ...options });
}


function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t22-receipt-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'durable');
  const scratch = path.join(parent, 'scratch');
  fs.mkdirSync(directory);
  fs.mkdirSync(scratch);
  const tarball = Buffer.from('exact packed artifact');
  const transcript = Buffer.from('TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  fs.writeFileSync(path.join(directory, 'candidate.tgz'), tarball);
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  fs.writeFileSync(path.join(directory, 'test.stderr'), '');
  const members = [{ path: 'sdk/next/index.mjs', size_bytes: 123, mode: 420 }];
  const receipt = {
    schema: T22_DISTRIBUTION_RECEIPT,
    status: 'pass',
    generated_at: '2026-10-19T00:00:00.000Z',
    source: {
      head: HEAD, tree: TREE, expected_head: HEAD, dirty: false,
      relevant_files: [{ path: 'package-lock.json', size_bytes: 1, sha256: 'a'.repeat(64) }],
    },
    package: {
      tarball_file: 'candidate.tgz', tarball_sha256: sha256Bytes(tarball),
      tarball_size_bytes: tarball.byteLength, member_count: members.length,
      member_inventory_sha256: sha256Bytes(Buffer.from(canonicalJson(members))), members,
    },
    test: {
      command: [process.execPath, '--test', '--test-reporter=tap',
        'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs'],
      signal: null, exit_code: 0, counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
      transcript_file: 'test.tap', transcript_sha256: sha256Bytes(transcript),
      stderr_file: 'test.stderr', stderr_sha256: sha256Bytes(Buffer.from('')),
      tarball_sha256: sha256Bytes(tarball),
    },
    cache: {
      mode: 'network-disabled-prewarmed-npm-cache', lockfile_sha256: 'a'.repeat(64),
      empty_cache_probe_expected: 'nonzero-exit', empty_cache_probe_exit_code: 1,
    },
    failures: [],
  };
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
  return { directory, scratch, receipt };
}

test('T22R01 detached receipt verifies and survives deletion of unrelated scratch', (t) => {
  const { directory, scratch } = fixture(t);
  fs.rmSync(scratch, { recursive: true, force: true });
  const verified = verifyDistributionArtifacts(directory, { expectedHead: HEAD });
  assert.deepEqual(verified.problems, []);
  assert.match(verified.receiptSha256, /^[0-9a-f]{64}$/);
});

test('T22R02 expected source HEAD mismatch fails closed', (t) => {
  const { directory } = fixture(t);
  const verified = verifyDistributionArtifacts(directory, { expectedHead: 'f'.repeat(40) });
  assert.match(verified.problems.join('\n'), /source HEAD mismatch/);
});

test('T22R03 preserved tarball mutation and external digest mismatch fail closed', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'candidate.tgz'), 'mutated');
  const verified = verifyDistributionArtifacts(directory, {
    expectedHead: HEAD, expectedTarballSha256: receipt.package.tarball_sha256,
  });
  assert.match(verified.problems.join('\n'), /tarball SHA-256 does not match receipt/);
  assert.match(verifyDistributionArtifacts(directory, {
    expectedHead: HEAD, expectedTarballSha256: '0'.repeat(64),
  }).problems.join('\n'), /tarball SHA-256 mismatch/);
});

test('T22R04 changed receipt bytes invalidate the detached SHA-256', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'receipt.json'), ' ');
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'),
    /detached receipt SHA-256 does not match/);
});

test('T22R05 offline mode is explicitly warm-cache and empty-cache-negative', (t) => {
  const { directory } = fixture(t);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
  receipt.cache.mode = 'hermetic-single-tarball';
  receipt.cache.empty_cache_probe_exit_code = 0;
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /pre-warmed offline precondition/);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /empty-cache offline negative/);
});

test('T22R06 package script and regular CI preserve the durable report', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:t22-distribution'], 'node scripts/t22-distribution-report.mjs');
  const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['nested-next'].steps;
  const report = steps.find((step) => step.name === 'T22 durable distribution report');
  assert.match(report?.run ?? '', /npm run test:t22-distribution/);
  assert.match(report?.run ?? '', /git rev-parse HEAD/);
  const upload = steps.find((step) => step.name === 'Upload T22 durable distribution report');
  assert.equal(upload?.uses, 'actions/upload-artifact@v4');
  assert.equal(upload?.if, 'always()');
  assert.equal(upload?.with?.['if-no-files-found'], 'error');
});

// An empty or contradictory test receipt must not count as product evidence.
function rewriteFixtureReceipt(directory, receipt) {
  const bytes = receiptBytes(receipt);
  fs.writeFileSync(path.join(directory, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(directory, 'receipt.sha256'), `${sha256Bytes(bytes)}\n`);
}
function replaceTap(directory, receipt, counts) {
  const transcript = Buffer.from(`TAP version 13\n1..${counts.tests}\n` +
    Object.entries(counts).map(([key, value]) => `# ${key} ${value}\n`).join(''));
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  receipt.test.transcript_sha256 = sha256Bytes(transcript);
}

test('T22R07 zero executed tests cannot produce an accepted passing receipt', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /executed passing test/);
});

test('T22R08 an all-skipped suite cannot count as product acceptance', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /executed passing test/);
});

test('T22R09 passing metadata cannot contradict the retained TAP summary', (t) => {
  const { directory, receipt } = fixture(t);
  replaceTap(directory, receipt, { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary.*(pass|fail)/);
});

test('T22R10 a transcript without a complete TAP summary fails closed', (t) => {
  const { directory, receipt } = fixture(t);
  const transcript = Buffer.from('TAP version 13\n1..1\n# pass 1\n');
  fs.writeFileSync(path.join(directory, 'test.tap'), transcript);
  receipt.test.transcript_sha256 = sha256Bytes(transcript);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary/);
});

test('T22R11 duplicate TAP count lines cannot be accepted as one run', (t) => {
  const { directory, receipt } = fixture(t);
  fs.appendFileSync(path.join(directory, 'test.tap'), '# pass 1\n');
  receipt.test.transcript_sha256 = sha256Bytes(fs.readFileSync(path.join(directory, 'test.tap')));
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /TAP summary/);
});


for (const [label, counts] of [
  ['pass exceeds tests', { tests: 1, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
  ['outcomes undercount tests', { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
  ['overlapping pass and skipped', { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 }],
  ['unsafe summed outcome count', { tests: Number.MAX_SAFE_INTEGER, pass: Number.MAX_SAFE_INTEGER,
    fail: 0, cancelled: 0, skipped: 1, todo: 0 }],
]) {
  test(`T22R12 inconsistent totals fail closed: ${label}`, (t) => {
    const { directory, receipt } = fixture(t);
    receipt.test.counts = counts;
    replaceTap(directory, receipt, counts);
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /outcome counts.*total/);
  });
}

test('T22R13 valid passing tests with an explicit skip retain consistent totals', (t) => {
  const { directory, receipt } = fixture(t);
  receipt.test.counts = { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
  replaceTap(directory, receipt, receipt.test.counts);
  rewriteFixtureReceipt(directory, receipt);
  assert.deepEqual(verifyDistributionArtifacts(directory).problems, []);
});


for (const failures of [['HARNESS_ERROR retained failure'], null, 'not-an-array']) {
  test(`T22R14 contradictory or malformed failure inventory is rejected: ${JSON.stringify(failures)}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.failures = failures;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /failures/);
  });
}

for (const mode of ['missing', 'modified', 'symlink']) {
  test(`T22R15 retained stderr must remain exact and regular: ${mode}`, (t) => {
    const { directory } = fixture(t); const p = path.join(directory, 'test.stderr');
    if (mode === 'missing') fs.unlinkSync(p);
    if (mode === 'modified') fs.writeFileSync(p, 'changed diagnostics');
    if (mode === 'symlink') { fs.renameSync(p, path.join(directory, 'outside.stderr'));
      fs.symlinkSync('outside.stderr', p); }
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /stderr|regular/);
  });
}

for (const mode of ['mismatch', 'duplicate', 'invalid-digest']) {
  test(`T22R16 source and cache bind one exact lockfile: ${mode}`, (t) => {
    const { directory, receipt } = fixture(t);
    if (mode === 'mismatch') receipt.cache.lockfile_sha256 = 'b'.repeat(64);
    if (mode === 'duplicate') receipt.source.relevant_files.push({ ...receipt.source.relevant_files[0] });
    if (mode === 'invalid-digest') receipt.source.relevant_files[0].sha256 = 'invalid';
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /lockfile/);
  });
}

test('T22R17 source expected_head cannot contradict a passing source head', (t) => {
  const { directory, receipt } = fixture(t); receipt.source.expected_head = 'f'.repeat(40);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /expected_head/);
});

test('T22R18 JSON null is a malformed receipt, not empty successful verification', (t) => {
  const { directory } = fixture(t); rewriteFixtureReceipt(directory, null);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /receipt.*object/);
});


test('T22R19 externally bound HEAD also requires its exact trusted Git tree', (t) => {
  const { directory, receipt } = fixture(t); receipt.source.tree = 'f'.repeat(40);
  rewriteFixtureReceipt(directory, receipt);
  assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /source tree mismatch/);
});

for (const options of [{}, { expectedHead: HEAD }, { expectedHead: HEAD, expectedTree: 'invalid' }, { expectedTree: TREE }]) {
  test(`T22R20 pass acceptance requires externally supplied commit and tree: ${JSON.stringify(options)}`, (t) => {
    const { directory } = fixture(t);
    assert.match(verifyDistributionArtifactsRaw(directory, options).problems.join('\n'), /expectedHead|expectedTree/);
  });
}


for (const [label, command] of [
  ['missing', undefined], ['unrelated program', ['true']],
  ['unrelated absolute program', ['/bin/true', '--test', '--test-reporter=tap',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['missing required suite', [process.execPath, '--test', '--test-reporter=tap', 'test/t22-packed-consumer.test.mjs']],
  ['different test', [process.execPath, '--test', '--test-reporter=tap', 'test/unrelated.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['injected node flag', [process.execPath, '--require', 'inject.mjs', '--test', '--test-reporter=tap',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
  ['wrong reporter', [process.execPath, '--test', '--test-reporter=spec',
    'test/t22-packed-consumer.test.mjs', 'test/t22-sdk-util-hardening-integration.test.mjs']],
]) {
  test(`T22R21 required distribution command is bound: ${label}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.test.command = command;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /required distribution test command/);
  });
}


for (const signal of ['SIGKILL', 'SIGTERM', undefined, '', false, 0]) {
  test(`T22R22 passing execution requires an explicit null signal: ${String(signal)}`, (t) => {
    const { directory, receipt } = fixture(t); receipt.test.signal = signal;
    rewriteFixtureReceipt(directory, receipt);
    assert.match(verifyDistributionArtifacts(directory).problems.join('\n'), /signal|failing test outcome/);
  });
}
