import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as L from './baseline-record-lib.mjs';

// T05-01. Every value in scanners/language/jvm/BASELINE.json is recomputed here from the checkout, the pinned commit and
// fresh runs; a well-formed value is never evidence. The pinned commit is fetched when missing and an unavailable commit
// FAILS. BASELINE_ALLOW_UNVERIFIED=1 is the only way to skip those checks, and it skips them visibly.
const ROOT = L.REPO_ROOT;
const record = L.readRecord();
const commit = record.base_commit;
const tree = L.classifyLive(record);
const verdict = L.commitVerdict(ROOT, commit);
const computed = await L.replay(record, ROOT);
const paths = (...roles) => record.files.filter((f) => roles.includes(f.role)).map((f) => f.path);
const env = (value) => ({ BASELINE_ALLOW_UNVERIFIED: value });
const damage = (e, key) => ({ ...e, [key]: key === 'bytes' ? e.bytes + 1 : L.flip(e[key]) });
const tampered = (mutate) => { const r = structuredClone(record); mutate(r); return r; };
const mentions = (list, text) => assert.ok(list.some((p) => p.includes(text)), `no problem mentions "${text}": ${list.join(' | ')}`);
const shallowCopy = () => L.depthOneCase(L.tmpDir('jvm-depth1-'));

test('the record is well formed and consistent with itself, and Kotlin/Ktor and the real JVM run stay BLOCKED', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.ok(record.fixtures.some((f) => f.class === 'normal') && record.fixtures.some((f) => f.class === 'negative'));
	const status = (id) => record.limits.find((l) => l.id === id)?.status;
	assert.deepEqual(['kotlin-ktor-blocked', 'real-javaparser-jdk-run-blocked'].map(status), ['BLOCKED', 'BLOCKED']);
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, computed), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('jvm-baseline-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, dir)), []);
});

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit fixtures, expect, class, status)', () => {
	const [a, b] = ['neg-unterminated-string-no-diagnostic', 'neg-unterminated-body-no-diagnostic'].map((id) => record.fixtures.findIndex((f) => f.id === id));
	assert.equal(record.fixtures[a].output_sha256, record.fixtures[b].output_sha256);
	assert.notDeepEqual(record.fixtures[a].call, record.fixtures[b].call);
	const limit = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const statuses = record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }));
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[limit].statement += ' (edited)'; },
		(r) => { r.limits[limit].fixtures.pop(); },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = 'normal'; },
		(r) => { r.artifact_digest.note = 'edited'; },
		(r) => { r.title += ' (edited)'; },
		(r) => { r.verification.levels[0] += ' (edited)'; },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
});

test('limits: the layer is mentioned outside its directories only by the recorded files (git grep at the base commit)', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const { references } = record.limits.find((l) => l.id === 'not-integrated-draft-layer');
	assert.deepEqual(L.referencesAtCommit(ROOT, commit, references.pattern, [record.source_dir, record.test_dir]), references.paths);
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id or PR number is reported', () => {
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	mentions(L.replayProblems(hash, computed), `${first.id}: output sha256`);
	mentions(L.verifyRecord(hash), 'artifact_digest');
	mentions(L.replayProblems(tampered((r) => { r.fixtures[0].expect[0][1] = 'tampered'; }), computed), `${first.id}: ${first.expect[0][0]}`);
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'test').test_count += 1; })), 'sum of per-file test_count');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].exit_code = '0'; })), 'exit_code must be an integer');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].result.fail = 1; })), 'contradicts failing tests');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].status = 'SUPPORTED'; })), 'status SUPPORTED');
	mentions(L.verifyRecord(tampered((r) => { r.base_commit = r.base_commit.slice(1); })), 'base_commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ' see PR 12'; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.references).references.paths = []; })), 'references needs');
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh', () => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: 'scanners/language/jvm/x.mjs', ...L.digestsOf(buf) };
	assert.equal(L.classifyEntry(entry, buf).state, 'fresh');
	for (const key of ['bytes', 'git_blob_sha1', 'sha256']) {
		assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
		mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	}
	assert.equal(L.classifyEntry(entry, Buffer.from('export const pinned = 2;\n')).state, 'drift');
	assert.equal(L.classifyEntry(entry, null).state, 'missing');
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('jvm-moved-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.equal(L.classifyLive(record, dir).fresh, true);
	fs.writeFileSync(path.join(dir, record.source_dir, 'extra.mjs'), 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`]);
	fs.appendFileSync(path.join(dir, paths('source')[0]), '\n');
	assert.ok(L.classifyLive(record, dir).moved.includes(paths('source')[0]));
});

test('depth-1 clone: the pinned commit is fetched, its blobs are recomputed, ancestry is deepened', () => {
	const { checkout, record: rec } = shallowCopy();
	assert.deepEqual([L.isShallow(checkout), L.commitVerdict(checkout, rec.base_commit).verdict], [true, 'ok']);
	const read = L.commitReader(checkout, rec.base_commit);
	assert.deepEqual(L.recomputeProblems(rec.files, read, 'depth-1'), []);
	for (const key of ['bytes', 'git_blob_sha1', 'sha256']) mentions(L.recomputeProblems([damage(rec.files[0], key), ...rec.files.slice(1)], read, 'depth-1'), `${key} `);
	assert.equal(L.ancestryVerdict(checkout, rec.base_commit).verdict, 'ok');
	assert.equal(L.isShallow(checkout), false);
});

test('negative: an unavailable commit, a non-ancestor and a failed deepening fail unless the opt-out is exactly 1', () => {
	const { checkout, sideCommit } = shallowCopy();
	const verdicts = (call) => ['', 'true', '1'].map((v) => call(env(v)).verdict);
	assert.deepEqual(verdicts((e) => L.commitVerdict(checkout, 'f'.repeat(40), e)), ['fail', 'fail', 'unverified']);
	assert.equal(L.commitVerdict(checkout, sideCommit).verdict, 'ok');
	assert.equal(L.ancestryVerdict(checkout, sideCommit, env('')).verdict, 'fail');
	const broken = shallowCopy();
	spawnSync('git', ['remote', 'set-url', 'origin', 'file:///nonexistent'], { cwd: broken.checkout });
	assert.equal(L.commitVerdict(broken.checkout, broken.record.base_commit, env('')).verdict, 'fail');
	assert.deepEqual(verdicts((e) => L.ancestryVerdict(broken.checkout, broken.record.base_commit, e)), ['fail', 'fail', 'unverified']);
});
