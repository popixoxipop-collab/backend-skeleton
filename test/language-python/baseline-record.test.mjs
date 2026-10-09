import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as L from './baseline-record-lib.mjs';

// T06-01. Every value in scanners/language/python/BASELINE.json is recomputed here from the checkout, the pinned commit and fresh runs; a well-formed value is never evidence.
// The pinned commit is fetched when missing; an unavailable commit or a missing Python runtime FAILS (only BASELINE_ALLOW_UNVERIFIED=1 skips them, visibly). BASELINE_CORPUS_FETCH=1 (network) also re-fetches the corpus commits and re-runs the runner.
const ROOT = L.REPO_ROOT;
const record = L.readRecord();
const commit = record.base_commit;
const tree = L.classifyLive(record);
const verdict = L.commitVerdict(ROOT, commit);
const runtime = L.runtimeVerdict(await L.pythonRuntime());
const paths = (...roles) => record.files.filter((f) => roles.includes(f.role)).map((f) => f.path);
const env = (value) => ({ BASELINE_ALLOW_UNVERIFIED: value });
const damage = (e, key) => ({ ...e, [key]: key === 'bytes' ? e.bytes + 1 : L.flip(e[key]) });
const tampered = (mutate) => { const r = structuredClone(record); mutate(r); return r; };
const mentions = (list, text) => assert.ok(list.some((p) => p.includes(text)), `no problem mentions "${text}": ${list.join(' | ')}`);
const shallowCopy = () => L.depthOneCase(L.tmpDir('python-depth1-'));
const unchanged = record.fixtures.map((f) => ({ id: f.id, deterministic: true, output_sha256: f.output_sha256, observed: f.expect.map(([, value]) => value) }));

test('the record is well formed and consistent with itself, and its limits keep their status', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual(L.replayProblems(record, unchanged), []);
	assert.ok(record.fixtures.some((f) => f.class === 'normal') && record.fixtures.some((f) => f.class === 'negative'));
	assert.deepEqual(['reserved-holdouts-not-run', 'model-facts-gaps', 'dynamic-values-stay-unknown'].map((id) => record.limits.find((l) => l.id === id)?.status), ['BLOCKED', 'UNSUPPORTED', 'UNKNOWN']);
	for (const id of record.limits.flatMap((l) => l.fixtures ?? [])) assert.equal(record.fixtures.find((f) => f.id === id).class, 'negative', id);
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', async (t) => {
	if (!L.requireFresh(t, tree) || !L.need(t, runtime)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, ROOT)), []);
});

test('commit: the base commit holds exactly the recorded tree and files and is an ancestor of HEAD (shallow: deepened first)', (t) => {
	if (!L.need(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	if (L.need(t, L.ancestryVerdict(ROOT, commit))) assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts and every fixture reproduce at the base commit', async (t) => {
	if (!L.need(t, verdict) || !L.need(t, runtime)) return;
	const dir = L.extractTree(ROOT, commit, L.tmpDir('python-baseline-'));
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, dir)), []);
});

test('corpus: with BASELINE_CORPUS_FETCH=1 the pinned commits are fetched and the runner reproduces the recorded run', (t) => {
	if (process.env.BASELINE_CORPUS_FETCH !== '1') return t.skip('BASELINE_CORPUS_FETCH is not 1: the pinned corpus commits were NOT fetched and the corpus runner was NOT re-run');
	if (!L.need(t, verdict) || !L.need(t, runtime)) return;
	const dir = L.extractTree(ROOT, commit, L.tmpDir('python-corpus-base-'));
	const run = L.replayCorpus(record, dir);
	assert.deepEqual([run.exit_code, run.stdout_sha256, run.stderr], ['exit_code', 'stdout_sha256', 'stderr'].map((k) => record.real_corpus[k]));
});

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit fixtures, expect, class, corpus, status)', () => {
	const [a, b] = ['fastapi-shadow-add-api-route-is-silently-dropped', 'fastapi-shadow-api-route-decorator-is-silently-dropped'].map((id) => record.fixtures.findIndex((f) => f.id === id));
	assert.equal(record.fixtures[a].output_sha256, record.fixtures[b].output_sha256);
	const limit = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[limit].statement += ' (edited)'; },
		(r) => { r.limits[limit].fixtures.pop(); },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = 'normal'; },
		(r) => { r.real_corpus.interpreters_compared.pop(); },
		(r) => { r.artifact_digest.note = 'edited'; },
		...record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }))
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id or PR number is reported', () => {
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	mentions(L.replayProblems(hash, unchanged), `${first.id}: output sha256`);
	mentions(L.verifyRecord(hash), 'artifact_digest');
	mentions(L.replayProblems(tampered((r) => { r.fixtures[0].expect[0][1] = 'tampered'; }), unchanged), `${first.id}: ${first.expect[0][0]}`);
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'test').test_count += 1; })), 'sum of per-file test_count');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].exit_code = '0'; })), 'exit_code must be an integer');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].result.fail = 1; })), 'contradicts failing tests');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].status = 'SUPPORTED'; })), 'status SUPPORTED');
	mentions(L.verifyRecord(tampered((r) => { r.base_commit = r.base_commit.slice(1); })), 'base_commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ' see PR 12'; })), 'not by PR or issue number');
});

test('negative: a tampered corpus report, hash, byte count, exit code, revision or checkout is reported', (t) => {
	if (!L.need(t, verdict)) return;
	const read = L.commitReader(ROOT, commit);
	const corpus = (mutate) => L.corpusProblems(tampered(mutate), read);
	assert.deepEqual(L.corpusProblems(record, read), []);
	mentions(corpus((r) => { r.real_corpus.report.cases[0].selectedFiles[0].sizeBytes += 1; }), 'stdout_sha256');
	mentions(corpus((r) => { r.real_corpus.report.cases[0].commit = L.flip(r.real_corpus.report.cases[0].commit); }), 'differs from what the manifest');
	mentions(corpus((r) => { r.real_corpus.stdout_sha256 = L.flip(r.real_corpus.stdout_sha256); }), 'stdout_sha256');
	mentions(corpus((r) => { r.real_corpus.stdout_bytes += 1; }), 'stdout_bytes');
	mentions(corpus((r) => { r.real_corpus.exit_code = 1; }), 'exit_code 0');
	mentions(corpus((r) => { r.real_corpus.revision = r.base_commit.slice(1); }), 'revision');
	mentions(corpus((r) => { r.real_corpus.checkouts[0].head = L.flip(r.real_corpus.checkouts[0].head); }), 'checkouts differ');
	mentions(corpus((r) => { r.real_corpus = { status: 'BLOCKED' }; }), 'needs a reason');
});

test('negative: damage in one hash or in the size alone is corrupt; a changed, missing or unrecorded file moves the tree', (t) => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: 'scanners/language/python/x.mjs', ...L.digestsOf(buf) };
	assert.deepEqual([buf, Buffer.from('export const pinned = 2;\n'), null].map((b) => L.classifyEntry(entry, b).state), ['fresh', 'drift', 'missing']);
	for (const key of ['bytes', 'git_blob_sha1', 'sha256']) {
		assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
		mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	}
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
	if (!L.need(t, verdict)) return;
	const dir = L.extractTree(ROOT, commit, L.tmpDir('python-moved-'));
	assert.equal(L.classifyLive(record, dir).fresh, true);
	fs.writeFileSync(`${dir}/${record.source_dir}/extra.mjs`, 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`]);
	fs.appendFileSync(`${dir}/${paths('source')[0]}`, '\n');
	assert.ok(L.classifyLive(record, dir).moved.includes(paths('source')[0]));
});

test('depth-1 clone: the pinned commit is fetched, its blobs are recomputed, ancestry is deepened', () => {
	const { checkout, record: rec } = shallowCopy();
	assert.deepEqual([L.isShallow(checkout), L.commitVerdict(checkout, rec.base_commit).verdict], [true, 'ok']);
	const read = L.commitReader(checkout, rec.base_commit);
	assert.deepEqual(L.recomputeProblems(rec.files, read, 'depth-1'), []);
	for (const key of ['bytes', 'git_blob_sha1', 'sha256']) mentions(L.recomputeProblems([damage(rec.files[0], key), ...rec.files.slice(1)], read, 'depth-1'), `${key} `);
	assert.deepEqual([L.ancestryVerdict(checkout, rec.base_commit).verdict, L.isShallow(checkout)], ['ok', false]);
});

test('negative: an unavailable commit, a non-ancestor, a failed deepening or no Python fail unless the opt-out is exactly 1', () => {
	const { checkout, sideCommit } = shallowCopy();
	const verdicts = (call) => ['', 'true', '1'].map((v) => call(env(v)).verdict);
	assert.deepEqual(verdicts((e) => L.commitVerdict(checkout, 'f'.repeat(40), e)), ['fail', 'fail', 'unverified']);
	assert.deepEqual(verdicts((e) => L.runtimeVerdict(null, e)), ['fail', 'fail', 'unverified']);
	assert.deepEqual([L.commitVerdict(checkout, sideCommit).verdict, L.ancestryVerdict(checkout, sideCommit, env('')).verdict], ['ok', 'fail']);
	const broken = shallowCopy();
	spawnSync('git', ['remote', 'set-url', 'origin', 'file:///nonexistent'], { cwd: broken.checkout });
	assert.equal(L.commitVerdict(broken.checkout, broken.record.base_commit, env('')).verdict, 'fail');
	assert.deepEqual(verdicts((e) => L.ancestryVerdict(broken.checkout, broken.record.base_commit, e)), ['fail', 'fail', 'unverified']);
});
