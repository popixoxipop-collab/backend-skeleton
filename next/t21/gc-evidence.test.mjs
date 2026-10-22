import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { runBaselineScenarios } from './gc-baseline-probe.mjs';
import { SOURCE_COMMIT, SOURCE_TREE, SOURCE_PATHS, verifyGarbageEvidence } from './gc-evidence.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const record = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'record.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
function git(args) {
  return spawnSync('git', args, { cwd: ROOT, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
}
if (git(['cat-file', '-e', SOURCE_COMMIT + '^{commit}']).status !== 0) {
  const fetched = git(['fetch', '--no-tags', '--depth=1', 'https://github.com/popixoxipop-collab/backend-skeleton.git', SOURCE_COMMIT]);
  assert.equal(fetched.status, 0, fetched.stderr?.toString());
}
const tree = git(['rev-parse', SOURCE_COMMIT + '^{tree}']);
assert.equal(tree.status, 0); assert.equal(tree.stdout.toString().trim(), SOURCE_TREE);
const pinned = new Map(), current = new Map();
for (const name of SOURCE_PATHS) {
  const result = git(['cat-file', 'blob', SOURCE_COMMIT + ':' + name]);
  assert.equal(result.status, 0, result.stderr?.toString()); pinned.set(name, result.stdout);
  current.set(name, fs.readFileSync(path.join(ROOT, name)));
}
function raw(name) {
  const encoded = fs.readFileSync(path.join(EVIDENCE, name + '.stdout.gz.b64'), 'utf8');
  assert.ok(encoded.length < 128 * 1024);
  return gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 512 * 1024 });
}
const probeBytes = raw('probe'), testBytes = raw('tests'), replayed = runBaselineScenarios();
const inputs = { pinned, current, probeBytes, testBytes, replayed };
const verify = (r = record, values = inputs) => verifyGarbageEvidence(r, values);
const clone = () => structuredClone(record);
const sha = b => createHash('sha256').update(b).digest('hex');

test('exact Git source, documentation and original baseline match the recorded run; current replay agrees', () => {
  assert.deepEqual(verify(), []);
});
test('wrong source commit and tree are rejected independently of self-consistent file hashes', () => {
  for (const key of ['source_commit', 'source_tree']) {
    const r = clone(); r[key] = '0'.repeat(40); assert.ok(verify(r).includes('record identity or authority mismatch'));
  }
});
test('removed or duplicate source records cannot shrink the verification boundary', () => {
  for (const mutate of [r => r.source_files.pop(), r => r.source_files.push(r.source_files[0])]) {
    const r = clone(); mutate(r); assert.ok(verify(r).includes('source inventory mismatch'));
  }
});
test('document and implementation edits fail, rather than being excluded as own files', () => {
  for (const name of ['next/t21/GC_BASELINE_SUPPLEMENT.md', 'next/t21/gc-plan.mjs', 'next/t21/gc-plan.test.mjs']) {
    const changed = new Map(current); changed.set(name, Buffer.concat([changed.get(name), Buffer.from('\nchanged\n')]));
    assert.ok(verify(record, { ...inputs, current: changed }).includes('source inventory mismatch'));
  }
});
test('rehashing forged source inventory still disagrees with independently read Git blobs', () => {
  const r = clone(), changed = new Map(current), item = r.source_files[0], bytes = Buffer.from('forged');
  item.size = bytes.length; item.sha256 = sha(bytes);
  item.git_blob_sha1 = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  changed.set(item.path, bytes); assert.ok(verify(r, { ...inputs, current: changed }).includes('source inventory mismatch'));
});
test('corrupted transcripts or invented command success are rejected', () => {
  const r = clone(); r.commands[1].exit_code = 2;
  assert.ok(verify(r).includes('command or transcript mismatch'));
  assert.ok(verify(record, { ...inputs, testBytes: Buffer.from('PASS') }).includes('command or transcript mismatch'));
});
test('rehashing a false complete result cannot replace the actual reproduced counterexample', () => {
  const result = JSON.parse(probeBytes), r = clone();
  result.cases.find(x => x.id === 'oversized-first-smaller-later').observed.status = 'complete';
  const changed = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  r.commands[0].stdout_sha256 = sha(changed);
  assert.ok(verify(r, { ...inputs, probeBytes: changed }).includes('scenario replay mismatch'));
});
test('evidence cannot grant deletion or release authority', () => {
  for (const key of ['deletion_performed', 'release_authorized']) {
    const r = clone(); r[key] = true; assert.ok(verify(r).includes('record identity or authority mismatch'));
  }
});


for (const [label, mutate] of [
  ['limitations text', r => { r.limits = Array(5).fill('All platforms are certified and no limitation remains.'); }],
  ['non-text limitations', r => { r.limits = Array(5).fill(null); }],
  ['observation timestamp', r => { r.observed_at = '2020-01-01T00:00:00Z'; }],
  ['Node version', r => { r.environment.node_version = 'v0.0.0'; }],
  ['platform', r => { r.environment.platform = 'win32'; }],
  ['self-consistent executable substitution', r => {
    r.environment.node_executable = '/fixture/not-the-observed-node';
    for (const command of r.commands) command.argv[0] = r.environment.node_executable;
  }],
  ['invented certification metadata', r => { r.certification = { independently_attested: true }; }],
]) {
  test(`fixed measurement metadata cannot change: ${label}`, () => {
    const r = clone(); mutate(r);
    assert.ok(verify(r).includes('fixed measurement record identity mismatch'));
  });
}
