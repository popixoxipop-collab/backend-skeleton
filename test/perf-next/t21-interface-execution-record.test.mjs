import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECORD_PATH = 'next/t21/evidence/T21_02_INTERFACE_RUN.json';
const ARCHIVE_PATH = 'next/t21/evidence/T21_02_INTERFACE_STDOUT.gz.b64';
const PINNED_RECORD_SHA256 = '493f9ceaf43ec97b6be424ece194a4ec12535784c661f143b6a8a8ddbe117cd6';
const PINNED_ARCHIVE_TEXT_SHA256 = '6d1fa36f9f6e7d3309b3e44edec6e265bd2425235405c901c01e3dd7e08ed3f2';
const PINNED_SOURCE_COMMIT = '5ddd35e59fafe55bf972a6801739c675b685e776';
const PINNED_SOURCE_TREE = '598d35d2f3229402350fd491a036e1917be65e0b';
const SOURCE_PATHS = [
  'lib/scan-scheduler-next/INTERFACE_RFC.md',
  'test/perf-next/t21-interface-rfc.test.mjs',
  'test/perf-next/t21-interface-rfc.vocabulary.json',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const git = (args) => {
  const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: null, timeout: 10000 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
};
const asText = (bytes) => bytes.toString('utf8').trim();
const expectedCounts = { tests: 46, pass: 46, fail: 0, skipped: 0, cancelled: 0, todo: 0 };

function verifyRecord(record, archivedStdout) {
  assert.equal(record.schema, 't21.rfc-exact-execution/1');
  assert.equal(record.task, 'T21-02');
  assert.equal(record.source_commit, PINNED_SOURCE_COMMIT);
  assert.equal(record.source_tree, PINNED_SOURCE_TREE);
  assert.deepEqual(record.command, ['node', '--test', '--test-reporter=tap', 'test/perf-next/t21-interface-rfc.test.mjs']);
  assert.equal(record.observed_node_version, 'v24.19.0');
  assert.equal(record.observed_platform, 'darwin');
  assert.equal(record.exit_code, 0);
  assert.deepEqual(record.counts, expectedCounts);
  assert.equal(record.stdout_archive_path, ARCHIVE_PATH);
  assert.equal(record.stdout_sha256, sha(archivedStdout));
  assert.equal(record.stderr_sha256, sha(Buffer.alloc(0)));
  assert.deepEqual(Object.keys(record.source_files).sort(), [...SOURCE_PATHS].sort());
  for (const [key, expected] of Object.entries(expectedCounts)) {
    const m = new RegExp('^# ' + key + ' (\\d+)$', 'gm').exec(archivedStdout.toString('utf8'));
    assert.ok(m, 'missing TAP summary for ' + key);
    assert.equal(Number(m[1]), expected, key);
  }
  assert.equal(archivedStdout.toString('utf8').includes('\nnot ok '), false);
  assert.equal(archivedStdout.toString('utf8').startsWith('TAP version 13\n'), true);
}

test('T21-02 recorded RFC command and full TAP are fixed-byte, revision-bound evidence', () => {
  const recordBytes = read(RECORD_PATH);
  const encoded = read(ARCHIVE_PATH);
  assert.equal(sha(recordBytes), PINNED_RECORD_SHA256);
  assert.equal(sha(encoded), PINNED_ARCHIVE_TEXT_SHA256);
  const compact = encoded.toString('utf8').trim();
  assert.match(compact, /^[A-Za-z0-9+/]+=*$/);
  const compressed = Buffer.from(compact, 'base64');
  assert.equal(compressed.toString('base64'), compact);
  const record = JSON.parse(recordBytes.toString('utf8'));
  assert.equal(sha(compressed), record.stdout_archive_sha256);
  verifyRecord(record, gunzipSync(compressed));

  assert.equal(asText(git(['cat-file', '-t', PINNED_SOURCE_COMMIT])), 'commit');
  assert.equal(asText(git(['rev-parse', PINNED_SOURCE_COMMIT + '^{tree}'])), PINNED_SOURCE_TREE);
  for (const rel of SOURCE_PATHS) {
    const bytes = git(['show', PINNED_SOURCE_COMMIT + ':' + rel]);
    const expected = record.source_files[rel];
    assert.equal(bytes.length, expected.bytes, rel);
    assert.equal(sha(bytes), expected.sha256, rel);
    assert.equal(asText(git(['rev-parse', PINNED_SOURCE_COMMIT + ':' + rel])), expected.git_blob_sha1, rel);
    // The archived source revision stays immutable; later owned inventory updates are tested by the live suite.
  }
});

test('T21-02 changed output, exit or source claims are refused', () => {
  const record = JSON.parse(read(RECORD_PATH));
  const compressed = Buffer.from(read(ARCHIVE_PATH).toString('utf8').trim(), 'base64');
  const output = gunzipSync(compressed);
  const bad = structuredClone(record);
  bad.exit_code = 1;
  assert.throws(() => verifyRecord(bad, output), /1 !== 0/);
  const badRevision = structuredClone(record);
  badRevision.source_commit = '0'.repeat(40);
  assert.throws(() => verifyRecord(badRevision, output));
  const editedOutput = Buffer.from(output);
  editedOutput[editedOutput.length - 2] ^= 1;
  assert.throws(() => verifyRecord(record, editedOutput));
  const badMetadata = structuredClone(record);
  badMetadata.observed_platform = 'linux';
  assert.throws(() => verifyRecord(badMetadata, output));
});
