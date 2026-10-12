import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as L from './baseline-record-lib.mjs';

// T17-01: this file recomputes the sizes, hashes, counts, exit codes, fixture outputs, expected values, reference lists and installed versions of adapters/game-next/BASELINE.json and the numbers that README.md, INTERFACE_RFC.md and INTEGRATION.md state about it.
// What it does not recompute (CI observations, environment, prose, files inside installed packages, fixture inputs, explanatory text) is listed in verification.not_recomputed. An unavailable pinned commit FAILS unless BASELINE_ALLOW_UNVERIFIED=1.
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
const shallowCopy = () => L.depthOneCase(L.tmpDir('t17-depth1-'));
const limit = (id) => record.limits.find((l) => l.id === id);
const recorded = (id, pointer) => {
	const pair = record.fixtures.find((f) => f.id === id)?.expect.find(([p]) => p === pointer);
	assert.ok(pair, `fixture ${id} records no value at ${pointer}`);
	return pair[1];
};
// What a limit's references and absent paths state, recomputed from the pinned commit (an empty list proves something only next to its control).
const evidenceProblems = (l, at = commit) => {
	const problems = [];
	if (l.references) {
		const got = L.referenceResult(ROOT, at, record, l.references);
		if (L.canonical(got.found) !== L.canonical(l.references.paths)) problems.push(`${l.id}: references match ${JSON.stringify(got.found)}, recorded ${JSON.stringify(l.references.paths)}`);
		if (l.references.control && L.canonical(got.control) !== L.canonical(l.references.control.paths)) problems.push(`${l.id}: control matches ${JSON.stringify(got.control)}, recorded ${JSON.stringify(l.references.control.paths)}`);
	}
	if (l.absent) problems.push(...L.absentProblems(ROOT, at, l.absent).map((p) => `${l.id}: ${p}`));
	return problems;
};

test('the record is well formed and consistent with itself, and the runtime evidence stays BLOCKED', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.equal(limit('real-engine-export-is-blocked')?.status, 'BLOCKED');
	assert.deepEqual(record.commands.map((c) => c.id).sort(), ['direct-tap', 'legacy-tap', 'nested-runner']);
	assert.ok(record.commands.every((c) => c.exit_code === 0 && c.result.skipped === 0 && c.result.fail === 0), 'a recorded command that skips or fails is not a baseline');
});

test('semantics: unknown and unsupported inputs are recorded as refused, blocked or partial, no claim is ever true, and nothing is marked supported', () => {
	assert.equal(recorded('unsupported-engines-are-blocked', '/completeness').status, 'blocked');
	assert.deepEqual(recorded('unsupported-engines-are-blocked', '/engines'), []);
	assert.equal(recorded('invalid-package-json-is-blocked', '/completeness').status, 'blocked');
	assert.equal(recorded('dependency-without-scene-is-partial', '/completeness').status, 'partial');
	assert.match(recorded('contract-refuses-a-blocked-scan', '/threw/message'), /no supported webgame engine was detected/);
	assert.match(recorded('unknown-engine-is-refused', '/threw/message'), /^unsupported native engine: /);
	assert.match(recorded('godot-refuses-editor-export', '/threw/message'), /^unsupported evidence class for godot: /);
	assert.match(recorded('unreal-refuses-headless-export', '/threw/message'), /^unsupported evidence class for unreal: /);
	assert.match(recorded('source-ref-rejects-an-unknown-role', '/threw/message'), /^unsupported source role: /);
	assert.equal(recorded('verify-rejects-an-unknown-engine', '/valid'), false);
	assert.equal(recorded('verify-rejects-a-true-claim', '/valid'), false);
	assert.equal(recorded('invariants-reject-a-true-source-structure-claim', '/valid'), false);
	assert.equal(recorded('unreal-envelope-is-bound-and-uninterpreted', '/status'), 'bound-uninterpreted');
	assert.equal(recorded('unreal-export-is-normalized-as-declared-structure', '/status'), 'declared-structure-only');
	const claims = record.fixtures.flatMap((f) => f.expect.filter(([pointer]) => pointer === '/claims' || pointer.endsWith('/claims')).map(([, value]) => value));
	assert.ok(claims.length > 0, 'no recorded fixture states claims');
	for (const value of claims) assert.ok(Object.keys(value).length > 0 && Object.values(value).every((v) => v === false), JSON.stringify(value));
	assert.ok(record.limits.every((l) => ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'].includes(l.status)));
	assert.equal(limit('verifier-checks-less-than-the-envelope-states')?.status, 'UNKNOWN');
	assert.equal(limit('bridge-is-described-but-not-on-main')?.status, 'UNSUPPORTED');
	assert.equal(limit('scanner-detects-only-three-and-react-three-fiber')?.status, 'UNSUPPORTED');
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, computed), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and every limit\'s references and absent paths are recomputed from it', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	assert.deepEqual(record.limits.flatMap((l) => evidenceProblems(l)), []);
	assert.ok(record.limits.some((l) => l.references?.paths.length === 0 && l.references.control), 'an empty reference list is recorded together with its control');
	assert.ok(record.limits.some((l) => l.absent), 'absent paths are recorded');
});

test('negative: a reference list, a control list or an absent path that disagrees with the pinned commit is reported', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const withPaths = limit('scanner-is-reached-only-through-the-cli');
	const empty = record.limits.find((l) => l.references?.paths.length === 0 && l.references.control);
	const absent = record.limits.find((l) => l.absent);
	assert.deepEqual(evidenceProblems(withPaths), []);
	const edit = (base, change) => { const copy = structuredClone(base); change(copy); return evidenceProblems(copy); };
	mentions(edit(withPaths, (l) => { l.references.paths = l.references.paths.slice(1); }), 'references match');
	mentions(edit(withPaths, (l) => { l.references.paths = [...l.references.paths, 'package.json']; }), 'references match');
	mentions(edit(empty, (l) => { l.references.pattern = l.references.control.pattern; }), 'references match');
	mentions(edit(empty, (l) => { l.references.control.paths = l.references.control.paths.slice(1); }), 'control matches');
	mentions(edit(absent, (l) => { l.absent = [...l.absent, 'package.json']; }), 'package.json exists at');
	mentions(edit(absent, (l) => { l.absent = [`${l.absent[0].split('/')[0]}/no-such-directory/file.mjs`]; }), 'its directory does not exist');
	mentions(L.verifyRecord(tampered((r) => { delete r.limits.find((l) => l.references?.paths.length === 0).references.control; })), 'references needs');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.absent).absent = []; })), 'absent needs a non-empty list');
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: the three recorded commands, the per-file counts, the text-only package names and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t17-baseline-');
	const all = record.files.map((f) => f.path);
	L.extractCommit(ROOT, commit, all, dir);
	assert.deepEqual(L.linkModules(ROOT, dir, all), record.environment.loaded_packages);
	assert.deepEqual(L.fixtureTextNames(dir, all), record.environment.fixture_text_packages);
	const [direct, nested, legacy] = ['direct-tap', 'nested-runner', 'legacy-tap'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.command, nested.exit_code, nested.first_line, nested.result], [`node ${L.RUNNER_SCRIPT} ${record.suite_id}`, run.exit_code, run.first_line, run.result]);
	const old = L.runTapTests(dir, [L.TRACK.legacyTest], { TMPDIR: L.tmpDir('t17-legacy-') });
	assert.deepEqual([legacy.command, legacy.exit_code, legacy.result], [L.tapCommand([L.TRACK.legacyTest]), old.exit_code, old.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, dir)), []);
});

test('negative: an installed version that differs from the pinned package-lock.json, a missing package and an import the lock lacks fail, and the copy is then not linked', () => {
	const dir = L.tmpDir('t17-lock-');
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

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit fixtures, expect, class, status, shared input, observation)', () => {
	const equalOutput = record.fixtures.flatMap((f, i) => record.fixtures.flatMap((g, j) => (j > i && g.output_sha256 === f.output_sha256 && L.canonical(g.call) !== L.canonical(f.call) ? [[i, j]] : [])));
	assert.ok(equalOutput.length > 0, 'two fixtures with different calls and the same recorded output are needed to show that swapped calls pass the replay');
	const [a, b] = equalOutput[0];
	const many = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const statuses = record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }));
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[many].statement += ' (edited)'; },
		(r) => { r.limits[many].fixtures.pop(); },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = r.fixtures[a].class === 'normal' ? 'negative' : 'normal'; },
		(r) => { r.shared[Object.keys(r.shared)[0]] = 'edited'; },
		(r) => { r.ci_observations[0].conclusion = 'failure'; },
		(r) => { r.environment.platform = 'edited'; },
		(r) => { r.artifact_digest.note = 'edited'; }, (r) => { r.title += ' (edited)'; }, (r) => { r.verification.levels[0] += ' (edited)'; },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
});

test('documents: the table, every test count, the NESTED_SUITE line and the base commit in README.md, INTERFACE_RFC.md and INTEGRATION.md equal the record', () => {
	const docs = L.readDocs();
	assert.deepEqual(L.docProblems(record, docs), []);
	const edit = (name, from, to) => L.docProblems(record, { ...docs, [name]: docs[name].replaceAll(from, to) });
	mentions(edit('readme', /(\.test\.mjs` \| )\d+/g, (_, head) => `${head}999`), 'README table');
	mentions(edit('rfc', commit, 'f'.repeat(40)), 'rfc: does not name the base commit');
	mentions(edit('integration', commit, 'f'.repeat(40)), 'integration: does not name the base commit');
	mentions(edit('readme', /RUN \d+ files/g, 'RUN 99 files'), 'NESTED_SUITE T17 RUN 99 files');
	mentions(edit('readme', /NESTED_SUITE \w+ RUN \d+ files/g, ''), 'does not state the NESTED_SUITE line');
	mentions(L.docProblems(record, { ...docs, integration: `${docs.integration}\n999 tests` }), 'recorded total');
	mentions(L.docProblems(record, { ...docs, rfc: `${docs.rfc}\n999 legacy tests` }), 'recorded legacy total');
	mentions(L.docProblems(record, { ...docs, readme: `${docs.readme}\n| \`extra.test.mjs\` | 3 |\n` }), 'not a recorded test file');
	// What the test does not recompute is named in the README by the record's own labels, and no document claims that everything is recomputed.
	assert.ok(record.verification.not_recomputed.length >= 6);
	for (const label of ['ci_observations', 'fixture inputs', 'the files inside the installed packages']) mentions(L.docProblems(record, { ...docs, readme: docs.readme.replaceAll(label, 'x') }), `does not name "${label}"`);
	for (const name of ['readme', 'rfc', 'integration']) mentions(L.docProblems(record, { ...docs, [name]: `${docs[name]}\nThis test recomputes everything that BASELINE.json states.\n` }), `${name}: says that a test recomputes everything`);
});

test('the record and the three documents pin by commit id and carry no pull request or issue number', () => {
	const byNumber = /#\d|\bPR\s*\d|\/pull\/\d|\/issues\/\d|\bGH-\d|refs\/pull/;
	assert.equal(byNumber.test(JSON.stringify(record)), false, 'BASELINE.json');
	for (const [name, text] of Object.entries(L.readDocs())) assert.equal(byNumber.test(text), false, name);
	assert.equal(byNumber.test('see PR 12'), true);
	assert.equal(byNumber.test(['refs', 'pull', 'head'].join('/')), true);
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id or PR number is reported', () => {
	const pointed = record.fixtures.findIndex((f) => f.expect[0][0] !== '');
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	mentions(L.replayProblems(hash, computed), `${first.id}: output sha256`);
	mentions(L.verifyRecord(hash), 'artifact_digest');
	mentions(L.replayProblems(tampered((r) => { r.fixtures[pointed].expect[0][1] = 'tampered'; }), computed), `${record.fixtures[pointed].id}: ${record.fixtures[pointed].expect[0][0]}`);
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'test').test_count += 1; })), 'sum of per-file test_count');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].exit_code = '0'; })), 'exit_code must be an integer');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].result.fail = 1; })), 'contradicts failing tests');
	mentions(L.verifyRecord(tampered((r) => { r.commands.find((c) => c.id === 'legacy-tap').result.tests = 0; })), 'legacy-tap ran no test');
	mentions(L.verifyRecord(tampered((r) => { r.commands.find((c) => c.id === 'legacy-tap').command += ' extra'; })), 'legacy-tap command must run exactly');
	mentions(L.verifyRecord(tampered((r) => { r.commands.find((c) => c.id === 'nested-runner').runner_files += 1; })), 'runner_files');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].status = 'SUPPORTED'; })), 'status SUPPORTED');
	mentions(L.verifyRecord(tampered((r) => { r.base_commit = r.base_commit.slice(1); })), 'base_commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ' see PR 12'; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.ci_observations[0].head_sha = 'f'.repeat(40); })), 'head_sha is not the base commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].fixtures = ['no-such-fixture']; })), 'unknown fixture no-such-fixture');
	mentions(L.verifyRecord(tampered((r) => { r.fixtures.forEach((f) => { f.class = 'normal'; }); })), 'needs at least one negative fixture');
	mentions(L.verifyRecord(tampered((r) => { r.environment.fixture_text_packages = [...r.environment.fixture_text_packages].reverse(); })), 'fixture_text_packages');
	mentions(L.verifyRecord(tampered((r) => { r.environment.fixture_text_packages.push(Object.keys(r.environment.loaded_packages)[0]); })), 'fixture_text_packages');
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh', () => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: `${record.source_dir}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline, the files this track adds do not', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t17-moved-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.equal(L.classifyLive(record, dir).fresh, true);
	const own = L.TRACK.ownFiles.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
	assert.ok(own.includes(path.relative(ROOT, fileURLToPath(import.meta.url))), 'this test file is one of the files the record library lists as its own');
	for (const rel of [...own, L.TRACK.recordFile]) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
	}
	assert.deepEqual(L.classifyLive(record, dir), { corrupt: [], moved: [], fresh: true });
	fs.writeFileSync(path.join(dir, record.source_dir, 'NOTES.md'), 'a markdown file is documentation, not a source file\n');
	assert.equal(L.classifyLive(record, dir).fresh, true);
	fs.writeFileSync(path.join(dir, record.source_dir, 'extra.mjs'), 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`]);
	fs.writeFileSync(path.join(dir, record.test_dir, 'extra.test.mjs'), 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`, `${record.test_dir}/extra.test.mjs`]);
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

// The prose of a limit is bound only by artifact_digest, which an editor can re-seal. What the media-type limit says about a parameter is therefore held to the fixtures that the replay recomputes:
// a parameter written without white space is accepted and kept as it is, one with a space after the semicolon is refused, and the statement says so in the words of the fixtures.
const parameterProse = (r) => {
	const l = r.limits.find((x) => x.id === 'source-media-types-are-restricted');
	const withParameter = l.fixtures.map((id) => r.fixtures.find((f) => f.id === id)).filter((f) => f.call.args[1].mediaType.includes(';'));
	const problems = withParameter.length === 2 ? [] : [`${l.id}: expected one fixture that accepts a parameter and one that refuses it, got ${withParameter.length}`];
	for (const f of withParameter) {
		const mediaType = f.call.args[1].mediaType;
		const refused = f.expect.some(([pointer]) => pointer === '/threw/name');
		if (refused !== /\s/.test(mediaType)) problems.push(`${f.id}: the recorded verdict does not follow white space`);
		if (!refused && f.expect.find(([pointer]) => pointer === '/artifact/media_type')?.[1] !== mediaType) problems.push(`${f.id}: the accepted media type is not kept as it is`);
		if (!l.statement.includes(`${mediaType} is ${refused ? 'refused' : 'accepted'}`)) problems.push(`${l.id}: the statement does not say that ${mediaType} is ${refused ? 'refused' : 'accepted'}`);
	}
	return problems;
};
test('prose: the media-type limit says what its fixtures record about a parameter (accepted without white space, refused with a space)', () => {
	assert.deepEqual(parameterProse(record), []);
	const accepting = 'source-ref-accepts-a-media-type-parameter-without-a-space';
	const earlier = 'A source media type is accepted only as type/subtype without any white space: a type with a parameter, a no-break space or a line separator inside, or without a slash, is refused with the message media type is invalid, while a structured-suffix type such as image/svg+xml is accepted. Media type parameters are not supported.';
	mentions(parameterProse(tampered((r) => { r.limits.find((x) => x.id === 'source-media-types-are-restricted').statement = earlier; })), 'the statement does not say that text/plain;charset=utf-8 is accepted');
	mentions(parameterProse(tampered((r) => { r.fixtures.find((f) => f.id === accepting).expect = [['/threw/name', 'TypeError'], ['/threw/message', 'media type is invalid']]; })), 'the recorded verdict does not follow white space');
	mentions(parameterProse(tampered((r) => { r.fixtures.find((f) => f.id === accepting).expect = [['/artifact/media_type', 'text/plain'], ['/role', 'active']]; })), 'is not kept as it is');
	mentions(parameterProse(tampered((r) => { const x = r.limits.find((l) => l.id === 'source-media-types-are-restricted'); x.fixtures = x.fixtures.filter((id) => id !== accepting); })), 'expected one fixture that accepts a parameter');
});
