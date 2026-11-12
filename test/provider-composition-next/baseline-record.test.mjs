import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as L from './baseline-record-lib.mjs';

// T14-01: verify the pinned baseline record and the RFC figures explicitly covered by this test. This is not an exhaustive proof of RFC prose or external producers; a missing pinned commit requires explicit unverified handling.
const ROOT = L.REPO_ROOT;
const KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
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
const shallowCopy = () => L.depthOneCase(L.tmpDir('t14-depth1-'));
const fixtureOf = (id) => record.fixtures.find((f) => f.id === id);
const expected = (id, pointer) => fixtureOf(id).expect.find(([p]) => p === pointer)[1];
const NEGATIVE = /^(rejected by design|observed defect|observed limit|BLOCKED by design): /;
const OBSERVED = /^(observed defect|observed limit|BLOCKED by design): /;
const OUTSIDE = [record.source_dir, record.test_dir];

test('the record is well formed and consistent with itself, and behavior-tested stays BLOCKED', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.equal(record.limits.find((l) => l.id === 'behavior-handoff-not-integrated')?.status, 'BLOCKED');
	const blocked = 'certification-behavior-all-eligible-still-blocked';
	assert.deepEqual(['/status', '/certifiedLevel', '/blockers/length', '/blockers/0/code'].map((p) => expected(blocked, p)), ['blocked', null, 1, 'behavior-handoff-not-integrated']);
});

test('the record is cross-checked without the modules: classes follow origins, observed limits are named, and the hashes and the plan combination are recomputed', async () => {
	const named = new Set(record.limits.flatMap((l) => l.fixtures ?? []));
	for (const f of record.fixtures) {
		assert.equal(NEGATIVE.test(f.origin), f.class === 'negative', `${f.id}: class ${f.class} does not follow the origin`);
		if (OBSERVED.test(f.origin)) assert.ok(named.has(f.id), `${f.id} is an observed limit or defect and no limit names it`);
	}
	const [value] = fixtureOf('evidence-t16-hash-of-known-value').call.args;
	assert.equal(expected('evidence-t16-hash-of-known-value', ''), L.sha256(L.jsonText(value)));
	assert.deepEqual(expected('plan-java-ready-with-emit-arguments-echo', '/combination'), expected('catalog-resolve-java-spring-jpa-uuid', ''));
	const [, binding] = fixtureOf('evidence-bound-accepted').call.args[0].$let.find(([name]) => name === 'text');
	const text = await L.evalValue(binding, L.fixtureContext(ROOT));
	const ref = expected('evidence-bound-accepted', '/accepted/artifactRef');
	assert.equal(ref.byte_sha256, crypto.createHash('sha256').update(text).digest('hex'));
	assert.equal(ref.size_bytes, Buffer.byteLength(text));
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, computed), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and the recorded searches (present and absent) give the same files', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	for (const { id, references: r } of record.limits.filter((l) => l.references)) assert.deepEqual(L.referencesAtCommit(ROOT, commit, r.pattern, OUTSIDE), r.paths, id);
	for (const { id, no_references: n } of record.limits.filter((l) => l.no_references)) {
		assert.deepEqual(L.referencesAtCommit(ROOT, commit, n.pattern, OUTSIDE), [], `${id}: the absence`);
		assert.deepEqual(L.referencesAtCommit(ROOT, commit, n.control.pattern, OUTSIDE), n.control.paths, `${id}: the control`);
	}
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t14-baseline-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.deepEqual(L.linkModules(ROOT, dir, record.files.map((f) => f.path)), record.environment.loaded_packages);
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, dir)), []);
});

test('negative: an installed version that differs from the pinned package-lock.json, a missing package and an import the lock lacks fail, and the copy is then not linked', () => {
	const dir = L.tmpDir('t14-lock-');
	const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^2.0.0' } }, 'node_modules/beta': { version: '2.1.0' }, 'node_modules/@scope/gamma': { version: '3.0.0' }, 'node_modules/unused': { version: '9.9.9' } } };
	const source = "import alpha from 'alpha/lib/x.js';\nimport fs from 'node:fs';\nimport './local.mjs';\nconst lazy = () => import('@scope/gamma');\n// values come from 'not-an-import'\n";
	const installed = { alpha: '1.0.0', beta: '2.1.0', '@scope/gamma': '3.0.0' };
	const checkout = (name, versions) => { for (const [pkg, version] of Object.entries(versions)) write(`${name}/node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version })); return path.join(dir, name); };
	const copy = (name, text = source) => { write(`${name}/main.mjs`, text); write(`${name}/package-lock.json`, JSON.stringify(lock)); return path.join(dir, name); };
	const link = (root, dest) => L.linkModules(root, dest, ['main.mjs', 'package-lock.json']);
	const aligned = copy('copy-aligned');
	assert.deepEqual(link(checkout('aligned', installed), aligned), { '@scope/gamma': '3.0.0', alpha: '1.0.0', beta: '2.1.0' });
	assert.ok(fs.lstatSync(path.join(aligned, 'node_modules')).isSymbolicLink());
	const refused = (name, root, pattern, text) => {
		const dest = copy(name, text);
		assert.throws(() => link(root, dest), pattern);
		assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, `${name} must not be linked`);
	};
	refused('copy-newer', checkout('newer', { ...installed, beta: '2.1.1' }), /beta: installed 2\.1\.1, the pinned package-lock\.json states 2\.1\.0/);
	refused('copy-missing', checkout('missing', { alpha: '1.0.0', '@scope/gamma': '3.0.0' }), /beta: node_modules\/beta\/package\.json cannot be read/);
	refused('copy-extra', checkout('extra', installed), /delta \(required by main\.mjs\) has no node_modules\/delta entry/, `${source}import 'delta';\n`);
});

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit fixtures, search patterns and paths, expect, class, status)', () => {
	const [a, b] = ['safety-python-fails-closed', 'safety-typescript-matches-python'].map((id) => record.fixtures.findIndex((f) => f.id === id));
	assert.equal(record.fixtures[a].output_sha256, record.fixtures[b].output_sha256);
	assert.notDeepEqual(record.fixtures[a].call, record.fixtures[b].call);
	const limit = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const absent = record.limits.findIndex((l) => l.no_references);
	const present = record.limits.findIndex((l) => l.references);
	const statuses = record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }));
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[limit].statement += ' (edited)'; },
		(r) => { r.limits[limit].fixtures.pop(); },
		(r) => { r.limits[absent].no_references.pattern += '|extra'; },
		(r) => { r.limits[absent].no_references.control.paths.pop(); },
		(r) => { r.limits[present].references.paths.pop(); },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = r.fixtures[a].class === 'normal' ? 'negative' : 'normal'; },
		(r) => { r.artifact_digest.note = 'edited'; }, (r) => { r.title += ' (edited)'; }, (r) => { r.verification.levels[0] += ' (edited)'; },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
});

test('documents: the table, every test count, the NESTED_SUITE line and the base commit in INTERFACE_RFC.md equal the record', () => {
	const docs = L.readDocs();
	assert.deepEqual(L.docProblems(record, docs), []);
	const edit = (name, from, to) => L.docProblems(record, { ...docs, [name]: docs[name].replaceAll(from, to) });
	mentions(edit('rfc', /(\.test\.mjs` \| )\d+/g, (_, head) => `${head}999`), 'RFC table');
	mentions(edit('rfc', commit, 'f'.repeat(40)), 'does not name the base commit');
	mentions(edit('rfc', /RUN \d+ files/g, 'RUN 99 files'), 'NESTED_SUITE T14 RUN 99 files');
	mentions(L.docProblems(record, { ...docs, rfc: `${docs.rfc}\n999 tests` }), 'recorded total');
	mentions(L.docProblems(record, { ...docs, rfc: `${docs.rfc}\n| \`ghost.test.mjs\` | 3 |\n` }), 'ghost.test.mjs is not a recorded test file');
	mentions(L.docProblems(record, { ...docs, rfc: docs.rfc.replace(/NESTED_SUITE T14 RUN \d+ files/g, 'the nested runner') }), 'does not state the NESTED_SUITE line');
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id, PR number, search or fixture module is reported', () => {
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
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.no_references).no_references.control.paths = []; })), 'no_references needs');
	mentions(L.verifyRecord(tampered((r) => { delete r.limits.find((l) => l.no_references).no_references.control; })), 'no_references needs');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.no_references).no_references.pattern = ''; })), 'no_references needs');
	mentions(L.verifyRecord(tampered((r) => { delete r.limits.find((l) => l.id === 'safety-profile-gaps').fixtures; })), 'a UNSUPPORTED limit needs fixtures, references or no_references');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].fixtures.push('no-such-fixture'); })), 'unknown fixture no-such-fixture');
	const unpinned = `${record.source_dir}/not-pinned.mjs`;
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].call.args = [{ $export: { module: unpinned, name: 'x' } }]; })), `module ${unpinned} is not a pinned file`);
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].call.args = [{ $call: { module: unpinned, fn: 'f', args: [] } }]; })), `module ${unpinned} is not a pinned file`);
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].call.args = [{ $file: unpinned }]; })), `$file ${unpinned} is not a pinned file`);
});

test('the fixture language is data: every form is evaluated depth first, an unbound name throws, and a recorded call that throws is recorded as threw', async () => {
	const ctx = L.fixtureContext(ROOT);
	const ev = (value) => L.evalValue(value, ctx);
	assert.equal(await ev({ $sha256: 'abc' }), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	assert.equal(await ev({ $size: `a${String.fromCodePoint(0xe9)}` }), 3);
	assert.deepEqual(await ev({ $let: [['a', 1], ['b', [{ $var: 'a' }, 2]]], $in: { both: { $var: 'b' }, first: { $var: 'a' } } }), { both: [1, 2], first: 1 });
	await assert.rejects(ev({ $var: 'nobody' }), /unbound \$var nobody/);
	await assert.rejects(ev({ $let: [['early', { $var: 'late' }], ['late', 1]], $in: null }), /unbound \$var late/);
	assert.equal(await ev({ $json: { b: [1, { d: 2, c: 3 }], a: null } }), '{\n  "a": null,\n  "b": [\n    1,\n    {\n      "c": 3,\n      "d": 2\n    }\n  ]\n}\n');
	const echo = await ev({ $function: { returns: { seen: ['x'] }, appendArgumentJsonTo: 'seen' } });
	assert.deepEqual([echo({ k: 1 }), echo({ k: 2 })], [{ seen: ['x', '{"k":1}'] }, { seen: ['x', '{"k":2}'] }]);
	assert.equal((await ev({ $function: {} }))(1), undefined);
	assert.throws(await ev({ $function: { throws: 'boom' } }), /boom/);
	const hashModule = `${record.source_dir}/evidence-boundary.mjs`;
	const t16HashJson = await ev({ $export: { module: hashModule, name: 't16HashJson' } });
	assert.equal(t16HashJson({ b: 1, a: 2 }), crypto.createHash('sha256').update(L.jsonText({ a: 2, b: 1 })).digest('hex'));
	assert.deepEqual(await ev({ $call: { module: hashModule, fn: 't16HashJson', args: [{ a: 1 }] }, $get: 'length' }), 64);
	assert.deepEqual(await ev({ $map: [['k', { $var: 'k' }]] }).catch((error) => error.message), 'unbound $var k');
	assert.deepEqual(L.normalize(new Map([[1, new Set([undefined])]])), { $map: [[1, { $set: [{ $undefined: true }] }]] });
	assert.deepEqual(await L.runFixture({ call: { module: hashModule, fn: 'not_exported', args: [] } }, ctx), { threw: { name: 'TypeError', message: 'mod[spec.fn] is not a function' } });
	assert.deepEqual(['/a/0', '/a/length', '/a/5', '/b~1c', ''].map((p) => L.pointerGet({ a: [7], 'b/c': 8 }, p)), [7, 1, { $missing: '/a/5' }, 8, { a: [7], 'b/c': 8 }]);
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh', () => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: `${record.source_dir}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t14-moved-');
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
	for (const key of KEYS) mentions(L.recomputeProblems([damage(rec.files[0], key), ...rec.files.slice(1)], read, 'depth-1'), `${key} `);
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
