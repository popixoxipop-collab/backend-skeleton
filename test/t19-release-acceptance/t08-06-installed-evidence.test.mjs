import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isAbsolute, join } from 'node:path';

const packet = new URL('../../next/t19/t08-06-review/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, packet));
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const hex = /^[a-f0-9]{64}$/;
const source = {
  source_commit: 'c45eb5aefd6ca3dc787389db337f016177a03757',
  source_tree: 'bd187ad9a6cb7d93f367d59ee5ee1495e6547184',
  source_lock_sha256: 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0'
};
const files = ['pack', 'archive', 'installed'];
const fixtures = ['go-gin.go', 'csharp-aspnet.cs', 'rust-axum.rs', 'rust-actix.rs'];

function verify(receipt, goldenBytes, members) {
  assert.equal(receipt.schema, 't19.t08-installed-review-candidate/1');
  assert.equal(receipt.status, 'CANDIDATE_OBSERVATION_NOT_APPROVAL');
  assert.equal(receipt.independent_t19_attestation, false);
  assert.equal(receipt.release_approved, false);
  for (const [key, value] of Object.entries(source)) assert.equal(receipt[key], value, key);
  assert.match(receipt.archive_sha256, hex);
  assert.equal(sha(goldenBytes), receipt.golden_sha256, 'golden bytes do not match receipt');
  const golden = parse(goldenBytes);
  assert.equal(golden.status, 'UNAPPROVED_PROPOSAL');
  assert.equal(golden.source_commit, source.source_commit);
  assert.equal(golden.source_tree, source.source_tree);

  for (const name of files)
    assert.equal(sha(members[name]), receipt[`${name}_members_sha256`], `${name} bytes do not match receipt`);
  const [pack, archive, installed] = files.map(name => parse(members[name]));
  assert.equal(pack.length, receipt.pack_member_count);
  assert.equal(pack.length, 424);
  assert.equal(new Set(pack.map(row => row.path)).size, pack.length);
  assert.deepEqual(archive, pack.map(({ git_mode, ...row }) => ({ ...row, mode: git_mode })));
  assert.deepEqual(installed, pack.map(({ git_mode, ...row }) => row));
  assert.ok(installed.some(row => row.path === 'scanners/language/native-server/worker.mjs'));
  assert.equal(receipt.worker_inside_installed_package, true);

  assert.deepEqual(Object.keys(golden.fixtures).sort(), [...fixtures].sort());
  assert.deepEqual(receipt.observations.map(row => row.filename).sort(), [...fixtures].sort());
  for (const row of receipt.observations) {
    const want = golden.fixtures[row.filename];
    assert.equal(sha(read(`fixtures/${row.filename}`)), row.source_sha256);
    assert.deepEqual([...row.routes].sort(), [...want.route_pairs].sort());
    assert.ok(want.required_unknown_codes.every(item => row.unknown_codes.includes(item)));
    assert.equal(row.deterministic, true);
  }
}

const recorded = parse(read('evidence-installed/receipt.json'));
const golden = read('golden-candidate.json');
const members = Object.fromEntries(files.map(name => [name, read(`evidence-installed/${name}-members.json`)]));

test('T08-06 recorded install packet binds source, fixtures and every inventory (not a fresh replay)', () => {
  verify(recorded, golden, members);
});

test('T08-06 changed inventory bytes or claimed source tree cannot validate', () => {
  assert.throws(() => verify(recorded, golden, {
    ...members, installed: Buffer.concat([members.installed, Buffer.from('\n')])
  }), /installed bytes do not match receipt/);
  assert.throws(() => verify({ ...recorded, source_tree: '0'.repeat(40) }, golden, members), /source_tree/);
});

// The caller supplies a fresh replay directory explicitly. Ordinary CI still
// validates the archived packet only and never implies a live replay ran.
const replayDir = process.env.T19_T08_FRESH_REPLAY_DIR;
if (replayDir !== undefined) {
  test('T08-06 supplied replay matches the pinned packet and records successful pack/install', () => {
    assert.ok(isAbsolute(replayDir), 'fresh replay directory must be absolute');
    const load = name => readFileSync(join(replayDir, name));
    const fresh = parse(load('receipt.json'));
    const freshMembers = Object.fromEntries(files.map(name => [name, load(`${name}-members.json`)]));
    verify(fresh, golden, freshMembers);
    for (const name of files)
      assert.deepEqual(freshMembers[name], members[name], name + ' inventory differs from pinned packet');
    assert.deepEqual(fresh.observations, recorded.observations);
    assert.equal(fresh.byte_mode_tamper_detected, true);
    assert.match(fresh.consumer_lock_sha256, hex);
    assert.equal(fresh.pinned_dependency_count, 21);
    for (const [key, command] of [['npm_pack', 'pack'], ['npm_install', 'ci']]) {
      const r = fresh.commands?.[key];
      assert.deepEqual(r?.argv.slice(0, 2), ['npm', command]);
      assert.ok(r.argv.includes('--ignore-scripts'));
      assert.equal(r.exit_code, 0);
      assert.equal(r.signal, null);
      assert.match(r.stdout_sha256, hex);
      assert.match(r.stderr_sha256, hex);
    }
  });
}
