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
  verifyDistributionArtifacts,
} from '../scripts/t22-distribution-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = '1'.repeat(40);
const TREE = '2'.repeat(40);

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
      exit_code: 0, counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
      transcript_file: 'test.tap', transcript_sha256: sha256Bytes(transcript),
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
  const { directory } = fixture(t);
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
