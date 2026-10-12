import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as L from './baseline-record-lib.mjs';

// T13-01: BASELINE.json pins the HTTP wave B and C layer at one commit. This file derives again the figures that
// record.verification.recomputed lists and compares them with the record; record.verification.not_recomputed lists what stays
// unchecked. An unavailable pinned commit FAILS unless BASELINE_ALLOW_UNVERIFIED=1. A live tree that has left the baseline skips
// the live checks visibly, and the pinned commit then decides.
const ROOT = L.REPO_ROOT;
const KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const loaded = L.tryReadRecord();
const record = loaded.record ?? null;
// A missing or unparsable record fails the first test with the reason instead of stopping this file from loading.
const recorded = () => {
	if (!record) assert.fail(loaded.error);
	return record;
};
const commit = record?.base_commit;
const tree = record ? L.classifyLive(record) : null;
const verdict = record ? L.commitVerdict(ROOT, commit) : null;
let liveReplay;
const replayLive = () => (liveReplay ??= L.replay(record, ROOT));
const paths = (...roles) => record.files.filter((f) => roles.includes(f.role)).map((f) => f.path);
const env = (value) => ({ BASELINE_ALLOW_UNVERIFIED: value });
const damage = (e, key) => ({ ...e, [key]: key === 'bytes' ? e.bytes + 1 : L.flip(e[key]) });
const tampered = (mutate) => {
	const r = structuredClone(record);
	mutate(r);
	r.artifact_digest.value = L.artifactDigest(r);
	return r;
};
const unsealed = (mutate) => {
	const r = structuredClone(record);
	mutate(r);
	return r;
};
const mentions = (list, text) => assert.ok(list.some((p) => p.includes(text)), `no problem mentions "${text}": ${list.join(' | ')}`);
const fixtureIndex = (id) => record.fixtures.findIndex((f) => f.id === id);
const shallowCopy = () => L.depthOneCase(L.tmpDir('t13-depth1-'));
const SCAN_FIXTURE = 'hono-upstream-example-scan';

// The pinned commit in a scratch directory, linked to node_modules when the lock agrees with them.
function extracted(link = true) {
	const dir = L.tmpDir('t13-baseline-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	const versions = link ? L.linkModules(ROOT, dir, record.files.map((f) => f.path)) : null;
	return { dir, versions };
}

// What the record needs from a replay at `root`: outputs by fixture id, the pinned files at `root` and the repository at the pinned commit.
const limitView = (computed, root) => ({ record, outputs: new Map(computed.map((c) => [c.id, c.output])), read: L.liveReader(root), commit: L.commitView(ROOT, commit) });

test('the record is well formed and consistent with itself, and every limit carries a status that is not a pass', () => {
	recorded();
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.deepEqual(record.limits.map((l) => l.id).sort(), Object.keys(L.LIMIT_FACTS).sort());
	for (const l of record.limits) assert.ok(L.LIMIT_STATUSES.includes(l.status), l.id);
	assert.equal(record.limits.find((l) => l.id === 'not-registered')?.status, 'BLOCKED');
	assert.equal(record.limits.find((l) => l.id === 'absent-leaves')?.status, 'UNSUPPORTED');
});

test('targets: 16 catalog targets are recorded, 3 with a leaf and a framework pin and 13 without, and a target without a leaf is UNSUPPORTED', () => {
	recorded();
	const statuses = record.targets.reduce((sum, t) => ({ ...sum, [t.record_status]: (sum[t.record_status] ?? 0) + 1 }), {});
	assert.deepEqual(statuses, { PINNED: 3, NOT_RECORDED: 13 });
	assert.deepEqual(record.targets.filter((t) => t.leaf !== null).map((t) => t.id), ['node-hono', 'node-koa', 'typescript-nextjs']);
	assert.ok(record.targets.filter((t) => t.leaf === null).every((t) => t.support_status === 'UNSUPPORTED' && t.framework_pin === null));
	assert.deepEqual(record.limits.find((l) => l.id === 'absent-leaves').facts, { catalog_targets: 16, targets_with_leaf: 3, targets_without_leaf: 13, without_leaf_with_scope_record: 2, without_leaf_without_scope_record: 11 });
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', async (t) => {
	recorded();
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), live: true, label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, await replayLive()), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and the files that name the layer from outside are the recorded ones', (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	const withReferences = record.limits.filter((l) => l.references);
	assert.deepEqual(withReferences.map((l) => l.id), ['not-registered']);
	for (const { id, references: r } of withReferences) assert.deepEqual(L.referencesAtCommit(ROOT, commit, r.pattern, [record.source_dir, record.test_dir]), r.paths, id);
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	recorded();
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts, the target table, each fixture and each limit fact reproduce at the base commit', async (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	const { dir, versions } = extracted();
	assert.deepEqual(versions, record.environment.loaded_packages);
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	const catalog = (await import(pathToFileURL(path.join(dir, record.source_dir, 'catalog.mjs')).href)).HTTP_WAVE_BC_TARGETS;
	const evidence = JSON.parse(fs.readFileSync(path.join(dir, record.source_dir, 'profile-evidence.json'), 'utf8'));
	assert.deepEqual(L.deriveTargets(catalog, evidence, record.files.map((f) => f.path)), record.targets);
	const computed = await L.replay(record, dir);
	assert.deepEqual(L.replayProblems(record, computed), []);
	assert.deepEqual(L.limitProblems(record, limitView(computed, dir)), []);
	assert.equal(computed.length, record.fixtures.length);
});

test('negative: an installed version that differs from the pinned package-lock.json, a missing package and an import the lock lacks fail, and the copy is then not linked', () => {
	const dir = L.tmpDir('t13-lock-');
	const write = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	};
	const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^2.0.0' } }, 'node_modules/beta': { version: '2.1.0' }, 'node_modules/@scope/gamma': { version: '3.0.0' }, 'node_modules/unused': { version: '9.9.9' } } };
	const source = "import alpha from 'alpha/lib/x.js';\nimport fs from 'node:fs';\nimport './local.mjs';\nconst lazy = () => import('@scope/gamma');\n// values come from 'not-an-import'\n";
	const installed = { alpha: '1.0.0', beta: '2.1.0', '@scope/gamma': '3.0.0' };
	const checkout = (name, versions) => {
		for (const [pkg, version] of Object.entries(versions)) write(`${name}/node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version }));
		return path.join(dir, name);
	};
	const copy = (name, text = source) => {
		write(`${name}/main.mjs`, text);
		write(`${name}/package-lock.json`, JSON.stringify(lock));
		return path.join(dir, name);
	};
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

test('import scan: a require() inside a string literal is text, a real import is found, built-in modules are told apart, and a specifier built at run time is counted as opaque', () => {
	const source = "const fixture = \"const app = require('koa')\";\nimport alpha from 'alpha/lib/x.js';\nimport fs from 'node:fs';\nimport path from 'path';\nconst lazy = () => import('@scope/gamma');\n";
	assert.deepEqual(L.importedPackages(source), ['@scope/gamma', 'alpha']);
	assert.deepEqual(L.builtinsImported(source), ['fs', 'path']);
	const { specs, opaque } = L.importsOf("import a from './a.mjs';\nconst x = require('y');\nimport(name);\n// import b from './b.mjs'\n");
	assert.deepEqual(specs, ['./a.mjs']);
	assert.equal(opaque.length, 2);
});

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, limit text, limit facts, limit fixtures, expect, class, target, status)', () => {
	recorded();
	const [a, b] = ['hono-variable-route-path', 'hono-routes-in-loop'].map(fixtureIndex);
	assert.equal(record.fixtures[a].output_sha256, record.fixtures[b].output_sha256);
	assert.notDeepEqual(record.fixtures[a].call, record.fixtures[b].call);
	const limit = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const statuses = record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }));
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[limit].statement += ' (edited)'; },
		(r) => { r.limits[limit].fixtures.pop(); },
		(r) => { r.limits[0].facts.catalog_targets += 1; },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = 'normal'; },
		(r) => { r.targets[3].profile_state = 'edited'; },
		(r) => { r.artifact_digest.note = 'edited'; },
		(r) => { r.title += ' (edited)'; },
		(r) => { r.verification.levels[0] += ' (edited)'; },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(unsealed(edit)), 'artifact_digest');
	assert.deepEqual(L.verifyRecord(tampered((r) => { r.title += ' (edited and sealed again)'; })), [], 'a record that is sealed again after an edit passes this check: artifact_digest detects accidental edits only');
});

test('negative: an edit that is sealed again is caught by the recomputation it concerns (output hash, expected value, limit fact, missing limit, statement figure, counts, status)', async (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	const { dir } = extracted(false);
	const computed = await L.replay(record, dir);
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	assert.deepEqual(L.verifyRecord(hash), []);
	mentions(L.replayProblems(hash, computed), `${first.id}: output sha256`);
	mentions(L.verifyRecord(unsealed((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); })), 'artifact_digest');
	mentions(L.replayProblems(tampered((r) => { r.fixtures[0].expect[0][1] = 'tampered'; }), computed), `${first.id}: ${first.expect[0][0]}`);
	const view = limitView(computed, dir);
	assert.deepEqual(L.limitProblems(record, view), []);
	mentions(L.limitProblems(tampered((r) => { r.limits.find((l) => l.id === 'authored-inputs').facts.fixtures_with_an_authored_tree += 1; }), view), 'limit authored-inputs: facts');
	mentions(L.limitProblems(tampered((r) => { r.limits.find((l) => l.id === 'not-registered').facts.files_importing_a_t13_module += 1; }), view), 'limit not-registered: facts');
	mentions(L.limitProblems(tampered((r) => { r.limits = r.limits.filter((l) => l.id !== 'silent-drop'); }), view), 'limit silent-drop is not recorded');
	mentions(L.limitProblems(tampered((r) => { r.limits.push({ id: 'invented', status: 'UNKNOWN', statement: 'x', facts: { n: 1 } }); }), view), 'limit invented: its facts have no recomputation');
	mentions(L.verifyRecord(tampered((r) => { const l = r.limits.find((x) => x.id === 'absent-leaves'); l.statement = l.statement.replace('13', '12'); })), 'the statement says 12');
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'test').test_count += 1; })), 'sum of per-file test_count');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].exit_code = '0'; })), 'exit_code must be an integer');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].result.fail = 1; })), 'contradicts failing tests');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].status = 'SUPPORTED'; })), 'status SUPPORTED');
	mentions(L.verifyRecord(tampered((r) => { r.base_commit = r.base_commit.slice(1); })), 'base_commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ` see PR ${12}`; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.references).references.paths = []; })), 'references needs');
	const edited = tampered((r) => { r.limits.find((l) => l.id === 'withheld-forms').fixtures.pop(); });
	assert.notDeepEqual(withheldProblems(edited), []);
	assert.deepEqual(withheldProblems(record), []);
});

// The withheld-forms limit lists exactly the fixtures of the withheld-form category (the defect limits are checked by verifyRecord).
function withheldProblems(r) {
	const listed = [...r.limits.find((l) => l.id === 'withheld-forms').fixtures].sort();
	const shown = r.fixtures.filter((f) => f.category === 'withheld-form').map((f) => f.id).sort();
	return JSON.stringify(listed) === JSON.stringify(shown) ? [] : [`withheld-forms lists ${listed.join(',')} but the withheld-form fixtures are ${shown.join(',')}`];
}

test('negative: a target that names an unpinned file, a status that does not follow from its leaf, or a scope record that is not pinned is reported', () => {
	recorded();
	mentions(L.verifyRecord(tampered((r) => { r.targets[0].leaf = `${r.source_dir}/node-hono/not-pinned.mjs`; })), 'leaf must be null or a pinned file');
	mentions(L.verifyRecord(tampered((r) => { r.targets[3].record_status = 'PINNED'; })), 'record_status must be NOT_RECORDED');
	mentions(L.verifyRecord(tampered((r) => { r.targets[0].framework_pin.commit = 'abc'; })), 'framework_pin.commit must be a 40-hex commit id');
	mentions(L.verifyRecord(tampered((r) => { r.targets[3].scope_record = `${r.source_dir}/nowhere.json`; })), 'scope_record must be null or a pinned file');
	mentions(L.verifyRecord(tampered((r) => { r.targets[5].leaf = r.targets[0].leaf; })), 'support_status does not follow from leaf');
	mentions(L.verifyRecord(tampered((r) => { r.targets = []; })), 'targets must record the catalog targets');
});

test('negative: a fixture that names an unpinned file or module, mislabels its origin, category or defect, or leaves a leaf without a category is reported', () => {
	recorded();
	const at = (id, mutate) => tampered((r) => mutate(r.fixtures[fixtureIndex(id)]));
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.call.args[0] = { $path: `${record.test_dir}/fixtures/not-there` }; })), `$path ${record.test_dir}/fixtures/not-there is neither a pinned file nor a directory of pinned files`);
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.call.args[0] = { $file: `${record.source_dir}/not-pinned.json` }; })), `$file ${record.source_dir}/not-pinned.json is not a pinned file`);
	mentions(L.verifyRecord(at('catalog-rejects-invalid-id', (f) => { f.call.args[0].$call.module = `${record.source_dir}/not-pinned.mjs`; })), `call module ${record.source_dir}/not-pinned.mjs is not a pinned file`);
	mentions(L.verifyRecord(at('hono-variable-route-path', (f) => { f.origin = 'pinned fixture directory'; })), 'an inline $tree is origin');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.origin = L.AUTHORED; })), 'an inline $tree is origin');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.category = 'dynamic-route-factory'; })), 'a dynamic-route-factory fixture is negative');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.target = 'no-such-target'; })), 'target must be a catalog target id');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.defect = 'silent-drop'; })), 'defect must be a negative fixture');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.category = 'upstream-scan'; })), 'category must be one of');
	mentions(L.verifyRecord(at(SCAN_FIXTURE, (f) => { f.expect = []; })), 'expect needs');
	mentions(L.verifyRecord(at('hono-computed-method-name', (f) => { delete f.defect; })), 'limit silent-drop: fixtures must be exactly the fixtures that flag the defect');
	for (const cat of ['upstream-example', 'descriptor', 'not-detected', 'dynamic-route-factory', 'generated-routes']) {
		mentions(L.verifyRecord(tampered((r) => { r.fixtures = r.fixtures.filter((f) => !(f.target === 'node-koa' && f.category === cat)); })), `node-koa: needs a ${cat} fixture`);
	}
	mentions(L.verifyRecord(tampered((r) => { r.fixtures = r.fixtures.filter((f) => f.class !== 'negative'); })), 'needs at least one negative fixture');
});

test('negative: a universal word, a figure that no fact states, a PR number in a text and a status outside the four are reported', () => {
	recorded();
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ' Every target is covered.'; })), 'the universal word "Every"');
	mentions(L.verifyRecord(tampered((r) => { r.verification.recomputed += ' It recomputes the record.'; })), 'verification uses a universal word');
	mentions(L.verifyRecord(tampered((r) => { r.verification.not_recomputed = []; })), 'verification needs');
	mentions(L.verifyRecord(tampered((r) => { r.ci_observations[0].head_sha = 'f'.repeat(40); })), 'head_sha is not the base commit');
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].origin += ` see #${12}`; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.ci_observations[0].observed_via += ` /pull/${12}`; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.limits[1].facts = {}; })), 'facts must be a non-empty object');
	mentions(L.verifyRecord(tampered((r) => { r.limits[1].status = 'PASS'; })), 'status PASS');
	mentions(L.verifyRecord(tampered((r) => { r.limits[1].fixtures = ['no-such-fixture']; })), 'unknown fixture no-such-fixture');
	assert.deepEqual(L.statementProblems({ id: 'x', facts: { n: [3, 4] }, statement: 'items 3 and 4 and file-5.json at 2026-10-12' }), []);
	assert.deepEqual(L.statementProblems({ id: 'x', facts: { n: 3 }, statement: 'items 3 and 4' }), ['limit x: the statement says 4 but no fact of the limit has that value']);
});

test('the README agrees with the record on its table rows, its figures, the NESTED_SUITE line and the base commit', () => {
	recorded();
	assert.deepEqual(L.docProblems(record, L.readDocs()), []);
});

// Change and fail for the README check (docProblems). Each row changes one part of the README, by replacing it, by appending a
// wrong copy of it or by removing it, and runs docProblems on the result. A row without `says` is reported: the problem it names
// must appear. A row with `says` is a survivor: docProblems must give no problem at all. The phrases of the survivors are also
// written in verification.not_recomputed, so a survivor that starts to be reported fails here, and so does a text that names a
// change this table does not pin.
const readmeTests = () => record.files.filter((f) => f.role === 'test').map((f) => ({ name: path.posix.basename(f.path), count: f.test_count }));
const recordedTotal = () => record.commands.find((c) => c.id === 'direct-tap').result.tests;
const recordedFirstLine = () => record.commands.find((c) => c.id === 'nested-runner').first_line;
const swapOnce = (text, from, to) => {
	assert.equal(text.split(from).length, 2, `the README holds ${JSON.stringify(from)} exactly once`);
	return text.replace(from, () => to);
};
const rowOf = (readme, name) => {
	const found = readme.match(new RegExp(`^\\| \`${name.replaceAll('.', '\\.')}\` \\| \\d+ \\|.*\n`, 'm'));
	assert.ok(found, `the README has a table row for ${name}`);
	return found[0];
};
const LINE = 'a line changed or appended, a heading included';
const FIGURES = [['tests', recordedTotal, 'the recorded total is'], ['test files', () => readmeTests().length, 'the record pins']];
const README_ROWS = [
	{ part: 'count in a table row', kind: 'replace', variants: (r) => readmeTests().map(({ name, count }) => [name, swapOnce(r, rowOf(r, name), rowOf(r, name).replace(`| ${count} |`, `| ${count + 1} |`)), `README table: ${name} states ${count + 1}, recorded ${count}`]) },
	// A second row for a recorded file is changed in three ways: a wrong row at the end of the README, a wrong row directly before
	// the right row (docProblems once kept the last row of a name, so this one passed) and the right row written twice.
	{ part: 'table row of a recorded test file', kind: 'append or insert before the right row', variants: (r) => readmeTests().flatMap(({ name, count }) => {
		const wrongRow = `| \`${name}\` | ${count + 1} |\n`;
		const wrongCount = `README table: ${name} states ${count + 1}, recorded ${count}`;
		return [
			[`${name}, wrong row at the end`, `${r}\n${wrongRow}`, wrongCount],
			[`${name}, wrong row before the right row`, swapOnce(r, rowOf(r, name), wrongRow + rowOf(r, name)), wrongCount],
			[`${name}, the right row twice`, swapOnce(r, rowOf(r, name), rowOf(r, name).repeat(2)), `README table: ${name} has 2 rows`]
		];
	}) },
	{ part: 'table row of a recorded test file', kind: 'remove', variants: (r) => readmeTests().map(({ name, count }) => [name, swapOnce(r, rowOf(r, name), ''), `README table: ${name} states undefined, recorded ${count}`]) },
	{ part: 'table row of a test file that is not recorded', kind: 'append', variants: (r) => [['extra.test.mjs', `${r}\n| \`extra.test.mjs\` | 1 |\n`, 'README table: extra.test.mjs is not a recorded test file']] },
	{ part: 'table row', kind: 'replace', says: 'a table row with a further column', variants: (r) => [['catalog.test.mjs', swapOnce(r, rowOf(r, 'catalog.test.mjs'), rowOf(r, 'catalog.test.mjs').replace(/ \|\n$/, ' | 999 |\n')), null]] },
	{ part: 'base commit', kind: 'replace', variants: (r) => [['forty f', r.replaceAll(record.base_commit, 'f'.repeat(40)), 'does not name the base commit']] },
	{ part: 'base commit', kind: 'remove', variants: (r) => [['removed', r.replaceAll(record.base_commit, ''), 'does not name the base commit']] },
	{ part: 'base commit', kind: 'append', says: 'a second commit named', variants: (r) => [['another commit', `${r}\nThe tree moved on at commit ${'e'.repeat(40)}.\n`, null]] },
	...FIGURES.flatMap(([noun, figure, said]) => [
		{ part: `figure "<n> ${noun}"`, kind: 'replace', variants: (r) => [['plus one', swapOnce(r, `${figure()} ${noun}`, `${figure() + 1} ${noun}`), `"${figure() + 1} ${noun}" but ${said} ${figure()}`]] },
		{ part: `figure "<n> ${noun}"`, kind: 'append', variants: (r) => [['plus one', `${r}\nThe suite has ${figure() + 1} ${noun}.\n`, `"${figure() + 1} ${noun}" but ${said} ${figure()}`]] },
		{ part: `figure "<n> ${noun}"`, kind: 'remove', says: 'a deleted figure', variants: (r) => [['deleted', swapOnce(r, `${figure()} ${noun}`, noun), null]] },
		{ part: `figure "<n> ${noun}"`, kind: 'replace by another noun', says: 'a figure followed by another noun', variants: (r) => [['checks', swapOnce(r, `${figure()} ${noun}`, `${figure()} checks`), null]] }
	]),
	{ part: 'NESTED_SUITE line', kind: 'replace', variants: (r) => [['run count', swapOnce(r, recordedFirstLine(), recordedFirstLine().replace(/RUN \d+/, 'RUN 99')), 'RUN 99 files'], ['suite name', swapOnce(r, recordedFirstLine(), recordedFirstLine().replace(/NESTED_SUITE \w+/, 'NESTED_SUITE T99')), 'NESTED_SUITE T99 RUN']] },
	{ part: 'NESTED_SUITE line', kind: 'append', variants: (r) => [['run count', `${r}\n${recordedFirstLine().replace(/RUN \d+/, 'RUN 99')}\n`, 'RUN 99 files']] },
	{ part: 'NESTED_SUITE line', kind: 'remove', variants: (r) => [['removed', swapOnce(r, recordedFirstLine(), ''), 'does not state the NESTED_SUITE line']] },
	{ part: 'prose', kind: 'replace', says: LINE, variants: (r) => [['sentence', swapOnce(r, 'The record describes observed behaviour.', 'The record describes expected behaviour.'), null], ['heading', swapOnce(r, '## Baseline record and interface RFC', '## Notes'), null], ['exit status', swapOnce(r, 'each exited 0', 'each exited 1'), null]] },
	{ part: 'prose', kind: 'append', says: LINE, variants: (r) => [['sentence', `${r}\nThe record supports a framework.\n`, null]] }
];
for (const row of README_ROWS) {
	test(`change and fail: README ${row.part}, ${row.kind}, is ${row.says ? `not reported (${row.says})` : 'reported'}`, () => {
		recorded();
		const docs = L.readDocs();
		const variants = row.variants(docs.readme);
		assert.ok(variants.length > 0, 'the row makes at least one change');
		for (const [label, text, needle] of variants) {
			assert.notEqual(text, docs.readme, `${label}: the change alters the README`);
			const problems = L.docProblems(record, { ...docs, readme: text });
			if (row.says) assert.deepEqual(problems, [], `${label}: a survivor gives no problem`);
			else mentions(problems, needle);
		}
	});
}

const survivorPhrases = (item) => item.slice(item.lastIndexOf(': ') + 2).split('; ').sort();
test('the survivors named in verification.not_recomputed are the survivor rows of this file, and a changed text is told apart', () => {
	recorded();
	const item = record.verification.not_recomputed.find((text) => text.includes('pins each as a survivor'));
	assert.ok(item, 'verification.not_recomputed has an item that names the README survivors');
	const rows = [...new Set(README_ROWS.filter((row) => row.says).map((row) => row.says))].sort();
	assert.deepEqual(survivorPhrases(item), rows);
	assert.notDeepEqual(survivorPhrases(item.replace('a second commit named', 'a second hash named')), rows);
	assert.notDeepEqual(survivorPhrases(`${item}; a table without a header`), rows);
	assert.notDeepEqual(survivorPhrases(item.replace('a deleted figure; ', '')), rows);
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh, and live_after_change is judged on its own', () => {
	recorded();
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: `${record.source_dir}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
	const after = Buffer.from('export const pinned = 3;\n');
	const edited = { ...entry, live_after_change: L.digestsOf(after) };
	assert.equal(L.classifyEntry(L.effectiveEntry(edited), after).state, 'fresh');
	assert.equal(L.classifyEntry(edited, after).state, 'drift');
	assert.equal(L.classifyEntry(L.effectiveEntry(edited), buf).state, 'drift');
	for (const key of KEYS) assert.equal(L.classifyEntry(L.effectiveEntry({ ...edited, live_after_change: damage(edited.live_after_change, key) }), after).state, 'corrupt', key);
	const pinned = record.files.find((f) => f.live_after_change);
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.live_after_change).live_after_change = { bytes: pinned.bytes, git_blob_sha1: pinned.git_blob_sha1, sha256: pinned.sha256 }; })), 'live_after_change equals the base digests');
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.live_after_change).live_after_change.extra = 1; })), 'live_after_change needs');
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'runner').live_after_change = L.digestsOf(after); })), 'carries no live_after_change');
});

test('live: the three pinned files this change edits differ from their base digests and equal live_after_change', (t) => {
	recorded();
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(record.files.filter((f) => f.live_after_change).map((f) => f.path).sort(), ['adapters/http-wave-bc/profile-evidence.json', 'adapters/http-wave-bc/t19-review-request.json', 'test/http-wave-bc/profile-evidence.test.mjs']);
	const withoutEdit = L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'base-digests' });
	assert.deepEqual([...new Set(withoutEdit.map((p) => p.split(' ')[1]))].sort(), record.files.filter((f) => f.live_after_change).map((f) => f.path).sort());
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), live: true, label: 'live' }), []);
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline, the track own files do not, and a moved tree is a visible skip and not a throw', async (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	const { dir } = extracted(false);
	assert.deepEqual(L.classifyLive(record, dir).moved, record.files.filter((f) => f.live_after_change).map((f) => f.path), 'a pristine copy of the base commit is not the live baseline: exactly the files this change edits differ');
	const baseRecord = structuredClone(record);
	for (const f of baseRecord.files) delete f.live_after_change;
	assert.deepEqual(L.classifyLive(baseRecord, dir), { corrupt: [], moved: [], fresh: true });
	for (const own of [...L.TRACK.ownFiles, L.TRACK.recordFile]) {
		fs.mkdirSync(path.dirname(path.join(dir, own)), { recursive: true });
		fs.writeFileSync(path.join(dir, own), 'export {};\n');
	}
	assert.equal(L.classifyLive(baseRecord, dir).fresh, true, 'the files this track adds are not drift');
	fs.writeFileSync(path.join(dir, record.source_dir, 'extra.mjs'), 'export {};\n');
	fs.writeFileSync(path.join(dir, record.test_dir, 'extra.test.mjs'), 'export {};\n');
	assert.deepEqual(L.classifyLive(baseRecord, dir).moved, [`${record.source_dir}/extra.mjs`, `${record.test_dir}/extra.test.mjs`]);
	fs.rmSync(path.join(dir, record.source_dir, 'extra.mjs'));
	fs.rmSync(path.join(dir, record.test_dir, 'extra.test.mjs'));
	fs.appendFileSync(path.join(dir, paths('source')[0]), '\n');
	assert.deepEqual(L.classifyLive(baseRecord, dir).moved, [paths('source')[0]]);
	const gone = paths('source').find((p) => p.endsWith('/node-koa/adapter.mjs'));
	fs.rmSync(path.join(dir, gone));
	const state = L.classifyLive(baseRecord, dir);
	assert.ok(state.moved.includes(gone));
	const notes = [];
	assert.equal(L.requireFresh({ skip: (message) => notes.push(message) }, state), false);
	assert.equal(notes.length, 1);
	assert.ok(notes[0].includes(gone), notes[0]);
	const problems = L.replayProblems(record, await L.replay(record, dir));
	assert.ok(problems.some((p) => p.startsWith('koa-upstream-example-scan: ')), 'a replay over a tree that lost a module reports it and does not throw');
	assert.throws(() => L.requireFresh({ skip: () => assert.fail('a corrupt record must not skip') }, { corrupt: ['x'], moved: [], fresh: false }), /the record disagrees with the live files: x/);
	assert.equal(L.requireFresh({ skip: () => assert.fail('a fresh tree must not skip') }, { corrupt: [], moved: [], fresh: true }), true);
});

test('replay: fixture hashes do not depend on where the temporary trees are created (two TMPDIR values), and the temporary paths are scrubbed from the output', async (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	const { dir } = extracted(false);
	const trees = record.fixtures.filter((f) => f.origin === L.AUTHORED);
	assert.equal(trees.length, record.limits.find((l) => l.id === 'authored-inputs').facts.fixtures_with_an_authored_tree);
	const before = process.env.TMPDIR;
	try {
		for (const prefix of ['t13-tmp-one-', 't13-tmp-two-longer-name-']) {
			process.env.TMPDIR = L.tmpDir(prefix);
			for (const f of trees) {
				const output = await L.runFixture(f, dir);
				assert.equal(L.sha256(L.canonical(output)), f.output_sha256, `${f.id} under ${prefix}`);
				assert.ok(!JSON.stringify(output).includes(prefix), `${f.id}: the temporary path is scrubbed`);
			}
		}
	} finally {
		if (before === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = before;
	}
	assert.deepEqual(L.scrub({ a: '/tmp/x/y and /tmp/x', b: ['/tmp/x/z', 7] }, [['/tmp/x', '<tree>'], ['/tmp/x/y', '<deep>']]), { a: '<deep> and <tree>', b: ['<tree>/z', 7] });
	assert.deepEqual(L.normalize({ m: new Map([[1, new Set([2])]]), u: undefined, f() {} }), { m: { $map: [[1, { $set: [2] }]] }, u: { $undefined: true }, f: { $function: 'f' } });
	assert.deepEqual([L.pointerGet({ a: [1, 2] }, '/a/length'), L.pointerGet({ a: [1, 2] }, '/a/1'), L.pointerGet({}, '/a')], [2, 2, { $missing: '/a' }]);
});

test('a call that names a member the module lacks is recorded as a throw, and a hostile key cannot reach a prototype member', async (t) => {
	recorded();
	if (!L.needCommit(t, verdict)) return;
	const { dir } = extracted(false);
	const out = await L.runFixture({ call: { module: `${record.source_dir}/catalog.mjs`, fn: 'noSuchExport' } }, dir);
	assert.deepEqual(out, { threw: { name: 'TypeError', message: `${record.source_dir}/catalog.mjs has no member noSuchExport` } });
	const proto = await L.runFixture({ call: { module: `${record.source_dir}/catalog.mjs`, fn: 'HTTP_WAVE_BC_TARGETS.constructor' } }, dir);
	assert.equal(proto.threw?.name, 'TypeError');
});

test('limits: the withheld-forms limit lists the withheld-form fixtures, each defect limit lists the fixtures that carry its label, and the audit figures follow from the record', () => {
	recorded();
	assert.deepEqual(withheldProblems(record), []);
	for (const d of L.DEFECTS) {
		const flagged = record.fixtures.filter((f) => f.defect === d).map((f) => f.id).sort();
		assert.deepEqual([...record.limits.find((l) => l.id === d).fixtures].sort(), flagged, d);
		assert.ok(flagged.length > 0, `${d} has a fixture`);
	}
	assert.equal(record.fixtures.filter((f) => f.class === 'normal').length + record.fixtures.filter((f) => f.class === 'negative').length, record.fixtures.length);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.category))].sort(), [...L.CATEGORIES].sort());
	assert.equal(record.commands.length, 2);
	assert.deepEqual(record.commands.map((c) => c.exit_code), [0, 0]);
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
	spawnSync('git', ['config', 'remote.origin.url', 'file:///nonexistent'], { cwd: broken.checkout });
	assert.equal(L.commitVerdict(broken.checkout, broken.record.base_commit, env('')).verdict, 'fail');
	assert.deepEqual(verdicts((e) => L.ancestryVerdict(broken.checkout, broken.record.base_commit, e)), ['fail', 'fail', 'unverified']);
});
