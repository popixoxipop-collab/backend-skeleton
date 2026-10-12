import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as L from './baseline-record-lib.mjs';

// T22-01: every value in sdk/next/BASELINE.json and every number sdk/next/README.md states about it is recomputed here; an unavailable pinned commit FAILS unless BASELINE_ALLOW_UNVERIFIED=1.
const ROOT = L.REPO_ROOT;
const KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const record = L.readRecord();
const commit = record.base_commit;
const tree = L.classifyLive(record);
const verdict = L.commitVerdict(ROOT, commit);
// Nothing below replays a fixture against the live tree when the file loads: a checkout without a pinned module or export would throw here
// before any test is registered. The live replay runs inside the `live:` test, after requireFresh has decided.
const paths =(...roles) => record.files.filter((f) => roles.includes(f.role)).map((f) => f.path);
const env = (value) => ({ BASELINE_ALLOW_UNVERIFIED: value });
const damage = (e, key) => ({ ...e, [key]: key === 'bytes' ? e.bytes + 1 : L.flip(e[key]) });
const tampered = (mutate) => { const r = structuredClone(record); mutate(r); return r; };
// An edit that is sealed again: only the rule under test, not artifact_digest, can report it.
const resealed = (mutate) => { const r = tampered(mutate); r.artifact_digest.value = L.artifactDigest(r); return r; };
const mentions = (list, text) => assert.ok(list.some((p) => p.includes(text)), `no problem mentions "${text}": ${list.join(' | ')}`);
const reportedAlone = (mutate, text) => {
	const problems = L.verifyRecord(resealed(mutate));
	mentions(problems, text);
	assert.ok(!problems.some((p) => p.includes('artifact_digest')), `a re-sealed edit must not trip the digest: ${problems.join(' | ')}`);
};
const shallowCopy = () => L.depthOneCase(L.tmpDir('t22-depth1-'));

test('the record is well formed and consistent with itself, and the adapter execution stays BLOCKED', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.equal(record.limits.find((l) => l.id === 'real-adapter-execution-is-not-observed')?.status, 'BLOCKED');
	assert.ok(record.fixtures.some((f) => f.id.startsWith(L.GAP_PREFIX)), 'the observed gaps are part of the baseline');
	assert.ok(record.limits.every((l) => L.LIMIT_STATUSES.includes(l.status)), 'no limit is marked as supported');
	for (const own of L.TRACK.ownFiles) {
		assert.ok(fs.existsSync(path.join(ROOT, own)), `${own} is listed in TRACK.ownFiles and must exist`);
		assert.ok(!record.files.some((f) => f.path === own), `${own} cannot be both pinned and an own file`);
		assert.ok(own.startsWith(`${record.test_dir}/`), `${own} lives in the test directory`);
	}
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', async (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, ROOT)), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and the SDK is referenced from outside only as recorded', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	for (const { id, references: r } of record.limits.filter((l) => l.references)) assert.deepEqual(L.referencesAtCommit(ROOT, commit, r.pattern, [record.source_dir, record.test_dir]), r.paths, id);
	for (const limit of record.limits.filter((l) => l.absent)) assert.deepEqual(L.absentProblems(ROOT, commit, limit), [], limit.id);
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t22-baseline-');
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
	const dir = L.tmpDir('t22-lock-');
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

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit fixtures, expect, class, status)', () => {
	const [a, b] = ['task-packet-rejects-short-base-sha', 'task-packet-rejects-uppercase-base-sha'].map((id) => record.fixtures.findIndex((f) => f.id === id));
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
		(r) => { r.artifact_digest.note = 'edited'; }, (r) => { r.title += ' (edited)'; }, (r) => { r.verification.levels[0] += ' (edited)'; },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
});

test('documents: the table, every test count, the NESTED_SUITE line and the base commit in README.md equal the record', () => {
	const docs = L.readDocs();
	assert.deepEqual(L.docProblems(record, docs), []);
	const total = record.commands.find((c) => c.id === 'direct-tap').result.tests;
	const edit = (from, to) => L.docProblems(record, { ...docs, readme: docs.readme.replaceAll(from, to) });
	mentions(edit(/(\.test\.mjs` \| )\d+/g, (_, head) => `${head}999`), 'README table');
	mentions(edit(commit, 'f'.repeat(40)), 'does not name the base commit');
	mentions(edit(/RUN \d+ files/g, 'RUN 99 files'), 'NESTED_SUITE T22 RUN 99 files');
	mentions(edit(`${total} tests`, `${total - 1} tests`), 'recorded total');
	mentions(L.docProblems(record, { ...docs, readme: `${docs.readme}\n999 tests` }), 'recorded total');
	mentions(L.docProblems(record, { ...docs, readme: `${docs.readme}\n| \`ghost.test.mjs\` | 1 |` }), 'ghost.test.mjs is not a recorded test file');
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id or PR number is reported', async () => {
	// The replayed values come from a synthetic module (dslDir and identity are defined below with the fixture-language tests), so the
	// first two checks need neither the live tree nor git.
	const steady = { id: 'steady', call: identity([1]), expect: [['/0', 1]] };
	const replayed = await L.replay({ fixtures: [steady] }, dslDir());
	steady.output_sha256 = replayed[0].output_sha256;
	const against = (mutate) => { const f = structuredClone(steady); mutate(f); return L.replayProblems({ fixtures: [f] }, replayed); };
	assert.deepEqual(against(() => {}), []);
	mentions(against((f) => { f.output_sha256 = L.flip(f.output_sha256); }), 'steady: output sha256');
	mentions(against((f) => { f.expect[0][1] = 'tampered'; }), 'steady: /0 is 1, recorded "tampered"');
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	mentions(L.verifyRecord(hash), 'artifact_digest');
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
	const entry = { role: 'source', path: `${record.source_dir}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline, and the record, markdown and the own files do not', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t22-moved-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	assert.equal(L.classifyLive(record, dir).fresh, true);
	for (const rel of [L.TRACK.recordFile, `${record.source_dir}/NOTES.md`, ...L.TRACK.ownFiles]) put(rel, 'not pinned, and not a reason to skip\n');
	assert.equal(L.classifyLive(record, dir).fresh, true, 'the record, a markdown file and the own files keep the live checks running');
	put(`${record.source_dir}/extra.mjs`, 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`]);
	put(`${record.test_dir}/extra.test.mjs`, 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`, `${record.test_dir}/extra.test.mjs`]);
	fs.appendFileSync(path.join(dir, paths('source')[0]), '\n');
	assert.ok(L.classifyLive(record, dir).moved.includes(paths('source')[0]));
	// A removed module that a fixture imports is moved too, but replaying on it throws: that is why the live replay waits for requireFresh.
	const imported = record.fixtures[0].call.module;
	fs.rmSync(path.join(dir, imported));
	assert.ok(L.classifyLive(record, dir).moved.includes(imported));
	await assert.rejects(L.replay(record, dir), dsl(/cannot load/));
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

test('negative: an absence is reported when the searched text is found, when its anchor no longer finds the recorded files, or when its scope cannot be read', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const [listed, derived] = ['package-manifest-does-not-name-the-sdk', 'nothing-that-ships-mentions-the-sdk-directory'].map((id) => record.limits.find((l) => l.id === id));
	assert.deepEqual([L.absentProblems(ROOT, commit, listed), L.absentProblems(ROOT, commit, derived)], [[], []]);
	const shown = spawnSync('git', ['show', `${commit}:package.json`], { cwd: ROOT, encoding: 'utf8' });
	assert.deepEqual(L.absentScope(ROOT, commit, derived.absent), JSON.parse(shown.stdout).files);
	assert.deepEqual(L.absentScope(ROOT, commit, listed.absent), listed.absent.scope);
	const changed = (limit, change) => ({ ...limit, absent: { ...limit.absent, ...change } });
	mentions(L.absentProblems(ROOT, commit, changed(listed, { pattern: listed.absent.anchor.pattern })), 'so the recorded absence does not hold');
	mentions(L.absentProblems(ROOT, commit, changed(listed, { anchor: { ...listed.absent.anchor, paths: ['README.md'] } })), 'an absence is only evidence when the same search finds its anchor');
	mentions(L.absentProblems(ROOT, commit, changed(derived, { anchor: { pattern: 'no-such-text-anywhere', paths: derived.absent.anchor.paths } })), 'finds nothing in the scope');
	assert.throws(() => L.absentProblems(ROOT, commit, changed(derived, { scope_from: 'package.json#no_such_key' })), /is not a non-empty list of paths/);
	assert.throws(() => L.absentProblems(ROOT, commit, changed(derived, { scope_from: 'no-such-file.json#files' })), /failed/);
});

test('negative: a re-sealed record is still rejected for a call outside the pins, an unknown builtin, a misplaced or undisclosed gap, an unbound limit, a malformed absence, a missing ajv and a number-based reference', () => {
	const index = (pick) => record.fixtures.findIndex(pick);
	const normal = index((f) => f.class === 'normal' && f.call.module !== L.BUILTIN);
	const gap = index((f) => f.id.startsWith(L.GAP_PREFIX));
	const parity = index((f) => f.call.module === L.BUILTIN && f.call.fn === 'schemaParity');
	const limitAt = (pick) => record.limits.findIndex(pick);
	const listed = limitAt((l) => l.absent?.scope);
	const derived = limitAt((l) => l.absent?.scope_from);
	const unsupported = limitAt((l) => l.status === 'UNSUPPORTED' && l.fixtures?.length > 0);
	const notRecorded = limitAt((l) => l.status === 'NOT_RECORDED' && !(l.fixtures?.length > 0) && l.references === undefined && l.absent === undefined);
	const unpinned = 'docs/scale-sdk/README.md';
	const fileOf = () => /"\$file":"([^"]+)"/.exec(JSON.stringify(record.fixtures[parity].call))[1];
	const swap = (r, from, to) => { r.fixtures[parity].call = JSON.parse(JSON.stringify(r.fixtures[parity].call).replaceAll(`"${from}"`, `"${to}"`)); };
	const edits = [
		[(r) => { r.fixtures[normal].call.module = 'sdk/next/not-pinned.mjs'; }, 'call module "sdk/next/not-pinned.mjs" is not a pinned file'],
		[(r) => { swap(r, fileOf(), unpinned); }, `$file "${unpinned}" is not a pinned file`],
		[(r) => { r.fixtures[parity].call.fn = 'noSuchBuiltin'; }, 'names the unknown builtin noSuchBuiltin'],
		[(r) => { r.fixtures[gap].class = 'normal'; }, 'an observed gap is a negative fixture'],
		[(r) => { for (const l of r.limits) if (l.fixtures) l.fixtures = l.fixtures.filter((id) => id !== r.fixtures[gap].id); }, 'an observed gap that no limit cites is not disclosed'],
		[(r) => { r.limits[0].fixtures.push('no-such-fixture'); }, 'unknown fixture no-such-fixture'],
		[(r) => { delete r.limits[listed].absent; }, 'is bound to no fixture, reference list or absence check'],
		[(r) => { r.limits[notRecorded].status = 'UNSUPPORTED'; }, 'is bound to no fixture, reference list or absence check'],
		[(r) => { delete r.limits[listed].absent.anchor; }, 'absent needs an anchor'],
		[(r) => { r.limits[listed].absent.pattern = ''; }, 'absent needs a pattern'],
		[(r) => { r.limits[listed].absent.scope_from = 'package.json#files'; }, 'exactly one of scope'],
		[(r) => { delete r.limits[listed].absent.scope; }, 'exactly one of scope'],
		[(r) => { r.limits[derived].absent.scope_from = 'package.json'; }, 'exactly one of scope'],
		[(r) => { r.limits[listed].absent.exclude = 'sdk/next'; }, 'absent.exclude is a list of directories'],
		[(r) => { delete r.environment.loaded_packages.ajv; }, 'must name ajv'],
		[(r) => { r.fixtures[normal].origin += ' see PR 12'; }, 'not by PR or issue number'],
		[(r) => { r.limits[unsupported].statement += ` see ${'#'}12`; }, 'not by PR or issue number'],
		[(r) => { r.limits[unsupported].statement += ` ${'/pull/'}12`; }, 'not by PR or issue number'],
		[(r) => { r.ci_observations[0].head_sha = 'f'.repeat(40); }, 'head_sha is not the base commit'],
		[(r) => { r.schema_status = 'final'; }, 'schema_status must be provisional'],
		[(r) => { r.commands.find((c) => c.id === 'nested-runner').runner_files += 1; }, 'runner_files does not match'],
		[(r) => { r.fixtures[1].id = r.fixtures[0].id; }, 'missing or duplicated'],
		[(r) => { r.fixtures.forEach((f) => { f.class = 'negative'; }); }, 'needs at least one normal fixture'],
		[(r) => { r.fixtures[0].expect = [['no-slash', 1]]; }, 'expect needs [json-pointer, value] pairs'],
		[(r) => { r.files[0].path = '/etc/hosts'; }, 'path must be repo-relative']
	];
	assert.deepEqual(L.verifyRecord(resealed(() => {})), [], 'sealing alone changes nothing');
	for (const [mutate, text] of edits) reportedAlone(mutate, text);
});

// The fixture language runs on a synthetic module, so that its documented behaviour is shown apart from the SDK.
const dslDir = () => {
	const dir = L.tmpDir('t22-dsl-');
	const put = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
	put('mod.mjs', [
		'export const answer = 42;',
		'export const identity = (...args) => args;',
		"export const boom = () => { throw new RangeError('boom'); };",
		"export const later = async () => ({ y: new Map([['k', new Set([1, undefined])]]), f() {} });",
		'let n = 0;',
		'export const counter = () => ({ n: (n += 1) });',
		''
	].join('\n'));
	put('data.json', '{"a":[1,2,{"b":"c"}],"s":"text"}');
	put('text.txt', 'hello\n');
	put('broken.json', '{not json');
	put('bad.mjs', 'export const x = ;\n');
	return dir;
};
const identity = (args, extra = {}) => ({ module: 'mod.mjs', fn: 'identity', args, ...extra });
const dsl = (pattern) => (error) => error instanceof L.DslError && pattern.test(error.message);

test('fixture language: file, hash, repeat, edit, export, map and nested-call nodes, chains, thrown errors and normalised values behave as documented', async () => {
	const ctx = L.fixtureContext(dslDir());
	const run = (call) => L.runFixture({ call }, ctx);
	assert.deepEqual(await run(identity([{ $file: 'text.txt' }, { $json: 'data.json' }, { $fileBytes: 'text.txt' }, { $fileSha256: 'text.txt' }])), ['hello\n', { a: [1, 2, { b: 'c' }], s: 'text' }, 6, L.sha256('hello\n')]);
	assert.deepEqual(await run(identity([{ $repeat: { text: 'ab', times: 3 } }])), ['ababab']);
	const edit = (spec) => run(identity([{ $edit: { base: { $json: 'data.json' }, ...spec } }]));
	assert.deepEqual(await edit({ set: [['/a/1', 'two'], ['/a/-', { $repeat: { text: 'z', times: 2 } }], ['/s', 'new']], remove: ['/a/0'] }), [{ a: ['two', { b: 'c' }, 'zz'], s: 'new' }]);
	for (const [spec, pattern] of [
		[{ set: [['/a/9', 1]] }, /not a position of the array/],
		[{ remove: ['/a/9'] }, /not a position of the array/],
		[{ remove: ['/zzz'] }, /there is no such key/],
		[{ set: [['/nope/deeper', 1]] }, /there is no value at nope/],
		[{ set: [['/__proto__', 1]] }, /__proto__ cannot be edited/],
		[{ set: [['', 1]] }, /needs a pointer below the root/],
		[{ set: [['a', 1]] }, /not a json pointer/]
	]) await assert.rejects(edit(spec), dsl(pattern));
	const [namespace] = await run(identity([{ $export: { module: 'mod.mjs' } }]));
	assert.deepEqual([namespace.answer, namespace.identity], [42, { $function: 'identity' }]);
	assert.deepEqual(await run(identity([{ $export: { module: 'mod.mjs', name: 'answer' } }, { $map: [['k', 1]] }])), [42, { $map: [['k', 1]] }]);
	await assert.rejects(run(identity([{ $export: { module: 'mod.mjs', name: 'nothing' } }])), dsl(/has no export nothing/));
	assert.deepEqual(await run(identity([{ $call: identity([7, 8]), $get: 1 }, { $call: identity(['x']) }])), [8, ['x']]);
	assert.deepEqual(await run(identity(['a|b|c'], { chain: [{ method: 'at', args: [0] }, { method: 'split', args: ['|'] }] })), ['a', 'b', 'c']);
	assert.deepEqual(await run({ module: 'mod.mjs', fn: 'boom' }), { threw: { name: 'RangeError', message: 'boom' } });
	assert.deepEqual(await run({ module: 'mod.mjs', fn: 'later' }), { y: { $map: [['k', { $set: [1, { $undefined: true }] }]] }, f: { $function: 'f' } });
});

test('negative: a path outside the checkout, a missing file or module, a broken JSON file and an unbounded repeat are errors in the record, not recorded behaviour', async () => {
	const ctx = L.fixtureContext(dslDir());
	for (const [call, pattern] of [
		[{ module: 'mod.mjs', fn: 'nothing' }, /has no function nothing/],
		[{ module: '../outside.mjs', fn: 'x' }, /not a repo-relative path/],
		[{ module: '/etc/hosts', fn: 'x' }, /not a repo-relative path/],
		[{ module: 'absent.mjs', fn: 'x' }, /cannot load absent\.mjs/],
		[{ module: 'bad.mjs', fn: 'x' }, /cannot load bad\.mjs/],
		[identity([{ $file: 'missing.txt' }]), /cannot read missing\.txt/],
		[identity([{ $file: '../text.txt' }]), /not a repo-relative path/],
		[identity([{ $json: 'broken.json' }]), /broken\.json is not JSON/],
		[identity([{ $repeat: { text: '', times: 2 } }]), /\$repeat needs/],
		[identity([{ $repeat: { text: 'a', times: 0 } }]), /\$repeat needs/],
		[identity([{ $repeat: { text: 'a', times: 1000001 } }]), /\$repeat needs/]
	]) await assert.rejects(L.runFixture({ call }, ctx), dsl(pattern), JSON.stringify(call));
});

test('replay: a fixture is run twice and a differing second run, a differing value and a missing replay are reported; a pointer to nothing is recorded as $missing', async () => {
	const dir = dslDir();
	const rec = { fixtures: [
		{ id: 'steady', call: identity([1]), expect: [['/0', 1]] },
		{ id: 'drifting', call: { module: 'mod.mjs', fn: 'counter' }, expect: [['/n', 'x']] }
	] };
	const out = await L.replay(rec, dir);
	assert.deepEqual(out.map((o) => [o.id, o.deterministic]), [['steady', true], ['drifting', false]]);
	rec.fixtures.forEach((f, i) => { f.output_sha256 = out[i].output_sha256; });
	const problems = L.replayProblems(rec, out);
	mentions(problems, 'drifting: two runs differ');
	mentions(problems, 'drifting: /n is');
	assert.ok(!problems.some((p) => p.startsWith('steady')), problems.join(' | '));
	assert.deepEqual(L.replayProblems({ fixtures: [rec.fixtures[0]] }, out.slice(0, 1)), []);
	mentions(L.replayProblems(rec, out.slice(0, 1)), 'replayed 1 fixtures, record has 2');
	mentions(L.replayProblems({ fixtures: [{ ...rec.fixtures[0], expect: [['/0', 2]] }] }, out.slice(0, 1)), 'steady: /0 is 1, recorded 2');
	const value = { a: [10, 20], 's/l': { 't~i': 1 }, str: 'abc' };
	assert.deepEqual(['/a/1', '/a/length', '/str/length', '/s~1l/t~0i'].map((p) => L.pointerGet(value, p)), [20, 2, 3, 1]);
	assert.deepEqual([L.pointerGet(value, '/a/5'), L.pointerGet(value, '/nope')], [{ $missing: '/a/5' }, { $missing: '/nope' }]);
	assert.equal(L.pointerGet(value, ''), value);
});

test('hashes: the digest helpers return known answers, canonical JSON sorts keys, and flip changes the first digit', () => {
	assert.equal(L.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
	assert.deepEqual([L.sha256('abc'), L.blobSha1(Buffer.from('hello\n'))], ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'ce013625030ba8dba906f756967f9e9ca394464a']);
	assert.deepEqual(L.digestsOf(Buffer.from('hello\n')), { bytes: 6, git_blob_sha1: 'ce013625030ba8dba906f756967f9e9ca394464a', sha256: L.sha256('hello\n') });
	assert.deepEqual([L.flip('0abc'), L.flip('fabc')], ['1abc', '0abc']);
	assert.equal(L.tapCommand(['a.test.mjs', 'b.test.mjs']), 'node --test a.test.mjs b.test.mjs');
	const sealed = structuredClone(record);
	assert.equal(L.artifactDigest(sealed), record.artifact_digest.value);
	sealed.artifact_digest.value = 'edited';
	assert.equal(L.artifactDigest(sealed), record.artifact_digest.value, 'the digest covers everything except its own value');
	assert.equal(fs.readFileSync(path.join(ROOT, L.TRACK.recordFile), 'utf8'), `${JSON.stringify(record, null, 2)}\n`, 'the record file is the canonical serialisation');
});

test('builtins: schemaParity compares one JSON Schema with one runtime validator, exportUsage lists the texts that name each export', async () => {
	const ctx = L.fixtureContext(ROOT);
	const schema = JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } }, additionalProperties: false });
	const runtime = (value, floor = 1) => ({ ok: Number.isInteger(value?.n) && value.n >= floor, errors: ['floor'] });
	const parity = (value, extra, okPointer = '/ok') => L.BUILTINS.schemaParity(ctx, { schema, runtime, okPointer, value, extra });
	assert.deepEqual(await parity({ n: 2 }), { schemaAccepts: true, runtimeAccepts: true, agree: true, runtimeErrors: ['floor'] });
	const apart = await parity({ n: 2 }, [3]);
	assert.deepEqual([apart.schemaAccepts, apart.runtimeAccepts, apart.agree], [true, false, false]);
	assert.equal((await parity({ n: 0 })).agree, true);
	await assert.rejects(parity({ n: 2 }, [], '/missing'), dsl(/is not a boolean/));
	await assert.rejects(L.BUILTINS.schemaParity(ctx, { schema, runtime: 'not a function', okPointer: '/ok', value: {} }), dsl(/schemaParity needs/));
	const usage = L.BUILTINS.exportUsage(ctx, { exports: { zeta: 1, alpha: 2, $dollar: 3, alp: 4 }, texts: { b: 'uses alpha(x) and $dollar', a: 'alphabet alp_ha zeta2 $dollar' } });
	assert.deepEqual(usage, { $dollar: ['a', 'b'], alp: [], alpha: ['b'], zeta: [] });
	assert.throws(() => L.BUILTINS.exportUsage(ctx, { exports: { zeta: 1 }, texts: {} }), dsl(/exportUsage needs/));
	assert.throws(() => L.BUILTINS.exportUsage(ctx, { texts: { a: 'x' } }), dsl(/exportUsage needs/));
	assert.deepEqual(Object.keys(L.BUILTINS).sort(), ['exportUsage', 'schemaParity']);
});
