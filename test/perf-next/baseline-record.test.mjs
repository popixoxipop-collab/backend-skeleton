import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as L from './baseline-record-lib.mjs';

// T21-01: the hashes, counts, commands, fixture outputs and references of lib/scan-scheduler-next/BASELINE.json, and the figures that INTERFACE_RFC.md states about it, are recomputed here (verification.not_recomputed in the record lists what is not); an unavailable pinned commit FAILS unless BASELINE_ALLOW_UNVERIFIED=1.
const ROOT = L.REPO_ROOT;
const KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const OLD = 'test/perf-next/baselines/2026-09-25-container.json';
const OLD_LIMIT = 'old-container-baseline-is-advisory-not-an-exact-commit-measurement';
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
const shallowCopy = () => L.depthOneCase(L.tmpDir('t21-depth1-'));
const fixture = (id) => { const f = record.fixtures.find((x) => x.id === id); assert.ok(f, `fixture ${id} is missing`); return f; };
const recorded = (id, pointer) => { const pair = fixture(id).expect.find(([p]) => p === pointer); assert.ok(pair, `${id} has no expectation for ${pointer}`); return pair[1]; };
const limit = (id) => { const l = record.limits.find((x) => x.id === id); assert.ok(l, `limit ${id} is missing`); return l; };
const textAt = (rel) => { const buf = L.commitReader(ROOT, commit)(rel); assert.ok(buf, `${rel} cannot be read at the base commit`); return buf.toString('utf8'); };
const fromRecord = (dir) => record.files.map((f) => f.path).filter((p) => p.startsWith(`${dir}/`));
const [codeLimit, dataLimit] = [L.TRACK.codeDirs[0], L.TRACK.dataDirs[0]];

// The T21-01 items of the audit, each with the limit that records it (a missing id means a missing record).
const REQUIRED_LIMITS = [
	'stable-scan-does-not-use-the-layer', 'warm-is-a-same-process-rehash-not-a-cache-hit', 'benchmark-covers-one-adapter-once-in-a-pinned-test',
	'no-consumer-runner-or-provider-integration', 'layer-ships-in-the-npm-package-without-a-packed-import-test', OLD_LIMIT, 'performance-gate-has-no-approved-input-and-no-slo'
];
// The failure cases of the audit, replayed from real calls and recorded as negative fixtures.
const REQUIRED_NEGATIVE = [
	'cache-key-mismatch-is-a-miss', 'store-corrupt-entry-rejected', 'store-budget-refused', 'file-index-budget-refused', 'scheduler-budget-blocked',
	'invalidated-entry-not-reused', 'gc-keeps-referenced-artifacts', 'path-escape-refused'
];
const TIMER = /setTimeout|setInterval|clearTimeout|AbortSignal|AbortController/;
const LOCK = /lock/i;
const copies = (figure, text) => new RegExp(`(?<![\\d.])${figure.replace('.', '\\.')}(?!\\d)`).test(text);
const leaves = (value, key = '') => (value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => leaves(v, k)) : [[key, value]]);

test('the record is well formed, serialised canonically, consistent with itself, and keeps the old file NOT_RECORDED and the performance gate BLOCKED', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.equal(fs.readFileSync(path.join(ROOT, L.TRACK.recordFile), 'utf8'), `${JSON.stringify(record, null, 2)}\n`);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.equal(limit(OLD_LIMIT).status, 'NOT_RECORDED');
	assert.equal(limit('performance-gate-has-no-approved-input-and-no-slo').status, 'BLOCKED');
	for (const id of REQUIRED_LIMITS) limit(id);
	for (const id of REQUIRED_NEGATIVE) assert.equal(fixture(id).class, 'negative', id);
	assert.equal(new Set(record.files.map((f) => f.role)).size, 5);
});

test('the old measurement file is pinned read-only, its caveats are quoted verbatim, and none of its timing or memory figures is copied', () => {
	const text = fs.readFileSync(path.join(ROOT, OLD), 'utf8');
	const pinned = record.files.find((f) => f.path === OLD);
	assert.equal(pinned?.role, 'test_support');
	assert.equal(L.sha256(text), pinned.sha256, `${OLD} was edited; the old measurement file is pinned and never changes`);
	const old = JSON.parse(text);
	const { statement } = limit(OLD_LIMIT);
	assert.ok(statement.startsWith('No timing measurement at an exact commit on a supported platform; no SLO'));
	assert.equal(old.caveats.length, 4);
	for (const caveat of old.caveats) assert.ok(statement.includes(`"${caveat}"`), `caveat not quoted verbatim: ${caveat}`);
	for (const value of [old.status, old.measured_on, old.environment.note, old.environment.node, old.environment.platform, old.implementation.branch]) assert.ok(statement.includes(value), `the statement omits "${value}"`);
	const figures = leaves(old).filter(([key, value]) => typeof value === 'number' && /(_ms|rss)/.test(key)).map(([, value]) => String(value));
	assert.ok(figures.length > 0, 'the old file holds timing figures, otherwise this check means nothing');
	const prose = JSON.stringify([record.title, record.limits, record.fixtures.map((f) => [f.origin, f.expect]), record.verification]);
	for (const figure of figures) assert.equal(copies(figure, prose), false, `the figure ${figure} of the old file is copied into the record`);
	assert.deepEqual([copies('11.411', 'cold took 11.411 ms'), copies('131072', 'size 1310720'), copies('2.427', 'v12.427')], [true, false, false]);
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.id === OLD_LIMIT).status = 'SUPPORTED'; })), 'status SUPPORTED');
});

test('live: pinned files and replayed fixtures equal the record (damage fails, drift skips)', (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read: L.liveReader(ROOT), label: 'live' }), []);
	assert.deepEqual(L.replayProblems(record, computed), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and the layer is referenced from outside only by the recorded files', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	assert.deepEqual(L.listingProblems(record, (dir) => L.listAtCommit(ROOT, commit, dir), 'commit'), []);
	assert.deepEqual(L.runnerSuiteProblems(textAt(L.RUNNER_SCRIPT), record), []);
	for (const { id, references: r } of record.limits.filter((l) => l.references)) assert.deepEqual(L.referencesAtCommit(ROOT, commit, r.pattern, [...record.source_dirs, record.test_dir]), r.paths, id);
});

test('negative: a directory listing that holds an unpinned file or lacks a pinned one, and a runner entry for other directories, are reported', () => {
	assert.deepEqual(L.listingProblems(record, fromRecord, 'x'), []);
	const [store, scheduler] = L.TRACK.sourceDirs;
	const plus = (dir, file) => (d) => (d === dir ? [...fromRecord(d), file] : fromRecord(d));
	const minus = (dir, file) => (d) => (d === dir ? fromRecord(d).filter((p) => p !== file) : fromRecord(d));
	mentions(L.listingProblems(record, plus(store, `${store}/new.mjs`), 'x'), `${store} holds files that the record does not pin: ${store}/new.mjs`);
	mentions(L.listingProblems(record, plus(scheduler, `${scheduler}/new.mjs`), 'x'), `${scheduler} holds files that the record does not pin: ${scheduler}/new.mjs`);
	mentions(L.listingProblems(record, plus(L.TRACK.testDir, `${L.TRACK.testDir}/new.mjs`), 'x'), `${L.TRACK.testDir} holds files that the record does not pin`);
	mentions(L.listingProblems(record, plus(codeLimit, `${codeLimit}/new.mjs`), 'x'), `${codeLimit} holds files that the record does not pin`);
	mentions(L.listingProblems(record, plus(dataLimit, `${dataLimit}/new.txt`), 'x'), `${dataLimit} holds files that the record does not pin`);
	assert.deepEqual(L.listingProblems(record, plus(store, `${store}/NOTES.md`), 'x'), [], 'markdown in a source directory is documentation');
	const first = fromRecord(scheduler)[0];
	mentions(L.listingProblems(record, minus(scheduler, first), 'x'), `the record pins files that ${scheduler} does not hold: ${first}`);
	mentions(L.listingProblems(record, (d) => (d === codeLimit ? null : fromRecord(d)), 'x'), `cannot list ${codeLimit}`);
	const runner = "const SUITES = [\n\t{ id: 'T21', sourcePaths: ['lib/artifact-store-next', 'lib/scan-scheduler-next'], testDir: 'test/perf-next' }\n];\n";
	assert.deepEqual(L.runnerSuiteProblems(runner, record), []);
	mentions(L.runnerSuiteProblems(runner.replace("'lib/scan-scheduler-next'", "'lib/other'"), record), 'sourcePaths lib/artifact-store-next, lib/other != recorded source_dirs');
	mentions(L.runnerSuiteProblems(runner.replace("sourcePaths: ['lib/artifact-store-next', 'lib/scan-scheduler-next']", "sourcePaths: ['lib/artifact-store-next']"), record), 'sourcePaths lib/artifact-store-next != recorded source_dirs');
	mentions(L.runnerSuiteProblems(runner.replace("testDir: 'test/perf-next'", "testDir: 'test/other'"), record), 'testDir test/other != recorded test_dir test/perf-next');
	mentions(L.runnerSuiteProblems(runner.replace("id: 'T21'", "id: 'T20'"), record), 'no one-line suite entry for T21');
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t21-baseline-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	L.copyOwnFiles(ROOT, dir, [L.TRACK.scenarioModule]);
	assert.deepEqual(L.linkModules(ROOT, dir, [...record.files.map((f) => f.path), L.TRACK.scenarioModule]), record.environment.loaded_packages);
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	assert.deepEqual(L.replayProblems(record, await L.replay(record, dir)), []);
});

test('negative: an installed version that differs from the pinned package-lock.json, a missing package and an import the lock lacks fail, and the copy is then not linked', () => {
	const dir = L.tmpDir('t21-lock-');
	const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^2.0.0' } }, 'node_modules/beta': { version: '2.1.0' }, 'node_modules/@scope/gamma': { version: '3.0.0' }, 'node_modules/unused': { version: '9.9.9' } } };
	const source = "import alpha from 'alpha/lib/x.js';\nimport fs from 'node:fs';\nimport './local.mjs';\nconst lazy = () => import('@scope/gamma');\n// values come from 'not-an-import'\n";
	const installed = { alpha: '1.0.0', beta: '2.1.0', '@scope/gamma': '3.0.0' };
	const checkout = (name, versions) => { for (const [pkg, version] of Object.entries(versions)) write(`${name}/node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version })); return path.join(dir, name); };
	const copy = (name, text = source) => { write(`${name}/main.mjs`, text); write(`${name}/package-lock.json`, JSON.stringify(lock)); return path.join(dir, name); };
	const link = (root, dest, extra = []) => L.linkModules(root, dest, ['main.mjs', 'package-lock.json', ...extra]);
	const aligned = copy('copy-aligned');
	assert.deepEqual(link(checkout('aligned', installed), aligned), { '@scope/gamma': '3.0.0', alpha: '1.0.0', beta: '2.1.0' });
	assert.ok(fs.lstatSync(path.join(aligned, 'node_modules')).isSymbolicLink());
	const refused = (name, root, pattern, text, extra = []) => {
		const dest = copy(name, text);
		assert.throws(() => link(root, dest, extra), pattern);
		assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, `${name} must not be linked`);
	};
	refused('copy-newer', checkout('newer', { ...installed, beta: '2.1.1' }), /beta: installed 2\.1\.1, the pinned package-lock\.json states 2\.1\.0/);
	refused('copy-missing', checkout('missing', { alpha: '1.0.0', '@scope/gamma': '3.0.0' }), /beta: node_modules\/beta\/package\.json cannot be read/);
	refused('copy-extra', checkout('extra', installed), /delta \(required by main\.mjs\) has no node_modules\/delta entry/, `${source}import 'delta';\n`);
	// A script under a data directory is an input of the scanner and never loaded, so its require is not an import of the copy; the same text elsewhere is.
	const dataFile = `${dataLimit}/server.js`;
	const required = 'const express = require("express");\n';
	const withData = copy('copy-data');
	write(`copy-data/${dataFile}`, required);
	assert.deepEqual(link(checkout('data', installed), withData, [dataFile]), { '@scope/gamma': '3.0.0', alpha: '1.0.0', beta: '2.1.0' });
	const elsewhere = copy('copy-elsewhere');
	write('copy-elsewhere/lib/server.js', required);
	assert.throws(() => link(checkout('elsewhere', installed), elsewhere, ['lib/server.js']), /express \(required by lib\/server\.js\) has no node_modules\/express entry/);
});

test('negative: the import scan ignores comments and quoted text and still sees every real import', () => {
	const cases = [
		["// import x from 'commented-out';\n", []],
		["/* import y from 'block-comment';\nimport w from 'inside-block'; */\nimport v from 'real-one';\n", ['real-one']],
		["const glob = 'src/**/*.mjs';\nimport u from 'after-glob';\n", ['after-glob']],
		["const lazy = () => import('lazy-one');\nconst c = require('cjs-one');\n", ['cjs-one', 'lazy-one']],
		["import fs from 'node:fs';\nimport path from 'path';\nimport './local.mjs';\n", []],
		["import ajv from 'ajv/dist/2020.js';\nimport g from '@scope/name/deep/x.js';\n", ['@scope/name', 'ajv']],
		["export * from 'reexported';\nexport { a } from 'named-reexport';\n", ['named-reexport', 'reexported']],
		["// require('quoted-in-a-comment')\nconst x = 1;\n", []],
		["const example = \"require('ghost-package')\";\n", []],
		["const a = 'import(\"ghost-a\")';\nconst b = `require('ghost-b')`;\n", []],
		["const s = 'x'; const m = require('after-a-string');\n", ['after-a-string']],
		["const t = `\nimport d from 'ghost-in-a-template';\n`;\nimport e from 'after-a-template';\n", ['after-a-template']],
		["const u = 'never closed\nimport f from 'after-an-open-quote';\n", ['after-an-open-quote']]
	];
	for (const [source, want] of cases) assert.deepEqual(L.importedPackages(source), want, source);
	assert.equal(L.withoutComments('a // b\nc /* d */ e').replace(/\s+/g, ' '), 'a c e');
});

test('negative: an edit that is not re-sealed is reported through artifact_digest (swapped calls, files, commands, limit text, limit fixtures, expect, class, status)', () => {
	const [a, b] = [0, 1];
	assert.notDeepEqual(record.fixtures[a].call, record.fixtures[b].call);
	const multi = record.limits.findIndex((l) => l.fixtures?.length > 1);
	const statuses = record.limits.flatMap((l, i) => L.LIMIT_STATUSES.filter((s) => s !== l.status).map((s) => (r) => { r.limits[i].status = s; }));
	const edits = [
		(r) => { [r.fixtures[a].call, r.fixtures[b].call] = [r.fixtures[b].call, r.fixtures[a].call]; },
		(r) => { r.limits[multi].statement += ' (edited)'; },
		(r) => { r.limits[multi].fixtures.pop(); },
		(r) => { r.fixtures[a].expect[0][1] = 'edited'; },
		(r) => { r.fixtures[a].class = 'negative'; },
		(r) => { r.fixtures[a].origin += ' (edited)'; },
		(r) => { r.files[0].bytes += 1; },
		(r) => { r.commands[0].result.pass += 1; },
		(r) => { r.ci_observations[0].conclusion = 'failure'; },
		(r) => { r.environment.ripgrep = 'ripgrep 0.0.0'; },
		(r) => { r.limits.find((l) => l.references).references.paths.push('package.json'); },
		(r) => { r.artifact_digest.note = 'edited'; }, (r) => { r.title += ' (edited)'; }, (r) => { r.verification.levels[0] += ' (edited)'; }, (r) => { r.verification.not_recomputed.pop(); },
		...statuses
	];
	for (const edit of edits) mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
	assert.equal(statuses.length, record.limits.length * (L.LIMIT_STATUSES.length - 1));
});

test('documents: the table, every test count, the NESTED_SUITE line and the base commit in INTERFACE_RFC.md and the store README equal the record', () => {
	const docs = L.readDocs();
	assert.deepEqual(L.docProblems(record, docs), []);
	const edit = (name, from, to) => L.docProblems(record, { ...docs, [name]: docs[name].replaceAll(from, to) });
	mentions(edit('rfc', /(\.test\.mjs` \| )\d+/g, (_, head) => `${head}999`), 'RFC table');
	mentions(edit('store', commit, 'f'.repeat(40)), 'store: does not name the base commit');
	mentions(edit('rfc', commit, 'f'.repeat(40)), 'rfc: does not name the base commit');
	mentions(edit('rfc', /RUN \d+ files/g, 'RUN 99 files'), 'NESTED_SUITE T21 RUN 99 files');
	mentions(L.docProblems(record, { ...docs, store: `${docs.store}\n999 tests` }), 'recorded total');
	mentions(L.docProblems(record, { ...docs, rfc: docs.rfc.replace(/^\| `[^`]+\.test\.mjs` \| \d+ \|.*\n/m, '') }), 'RFC table:');
	mentions(L.docProblems(record, { ...docs, rfc: `${docs.rfc}\n| \`t21-unrecorded.test.mjs\` | 3 |\n` }), 'RFC table: t21-unrecorded.test.mjs is not a recorded test file');
	mentions(L.docProblems(record, { ...docs, rfc: docs.rfc.replaceAll('NESTED_SUITE', 'NESTED') }), 'does not state the NESTED_SUITE line');
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
	mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ` see PR ${6 * 2}`; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].origin += ` see ${String.fromCharCode(35)}${6 * 2}`; })), 'not by PR or issue number');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.references).references.paths = []; })), 'references needs');
	mentions(L.verifyRecord(tampered((r) => { r.source_dirs = r.source_dirs.slice(1); })), 'source_dirs must be');
	mentions(L.verifyRecord(tampered((r) => { r.commands[1].first_line = 'NESTED_SUITE T21 RUN 13 files'; })), 'first_line does not match');
	mentions(L.verifyRecord(tampered((r) => { r.fixtures[0].call.module = 'test/perf-next/not-pinned.mjs'; })), 'call must name a pinned module');
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh', () => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: `${record.source_dirs[1]}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file in either source directory or in the test directory, or a changed file, moves the tree away from the baseline; own files, the record file and Markdown in the source directories do not', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t21-moved-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.equal(L.classifyLive(record, dir).fresh, true);
	const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	for (const own of L.TRACK.ownFiles) put(own, 'export {};\n');
	put(L.TRACK.recordFile, '{}\n');
	for (const sourceDir of record.source_dirs) put(`${sourceDir}/NOTES.md`, 'notes\n');
	assert.deepEqual(L.classifyLive(record, dir), { corrupt: [], moved: [], fresh: true }, 'own files, the record file and Markdown in the source directories are accounted for');
	for (const where of [...record.source_dirs, record.test_dir]) {
		put(`${where}/extra.mjs`, 'export {};\n');
		assert.deepEqual(L.classifyLive(record, dir).moved, [`${where}/extra.mjs`], where);
		fs.rmSync(path.join(dir, where, 'extra.mjs'));
	}
	put(`${record.source_dirs[0]}/data.json`, '{}\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dirs[0]}/data.json`], 'a non-markdown file of any kind moves the tree');
	fs.rmSync(path.join(dir, record.source_dirs[0], 'data.json'));
	fs.appendFileSync(path.join(dir, paths('source')[0]), '\n');
	assert.ok(L.classifyLive(record, dir).moved.includes(paths('source')[0]));
});

test('own files: every non-markdown file this PR adds next to the record exists, is not pinned, and does not move the live tree (so no live check is skipped because of it)', () => {
	assert.deepEqual(L.ownFileProblems(record), []);
	assert.deepEqual(tree.moved.filter((p) => L.TRACK.ownFiles.includes(p) || p === L.TRACK.recordFile), []);
	for (const own of L.TRACK.ownFiles) assert.ok(L.TRACK.sourceDirs.some((d) => own.startsWith(`${d}/`)) || own.startsWith(`${L.TRACK.testDir}/`), own);
	mentions(L.ownFileProblems(tampered((r) => { r.files.push({ role: 'test_support', path: L.TRACK.ownFiles[0] }); })), `own file ${L.TRACK.ownFiles[0]} is also pinned in the record`);
	const empty = L.tmpDir('t21-own-');
	assert.equal(L.ownFileProblems(record, empty).filter((p) => p.endsWith('does not exist')).length, L.TRACK.ownFiles.length);
});

test('failure cases: every required negative fixture exists, records a real refusal, and a tampered hash or expectation is reported', () => {
	for (const id of REQUIRED_NEGATIVE) {
		const f = fixture(id);
		assert.equal(f.class, 'negative', id);
		const i = record.fixtures.indexOf(f);
		mentions(L.replayProblems(tampered((r) => { r.fixtures[i].output_sha256 = L.flip(f.output_sha256); }), computed), `${id}: output sha256`);
		mentions(L.replayProblems(tampered((r) => { r.fixtures[i].expect[0][1] = 'tampered'; }), computed), `${id}: ${f.expect[0][0]}`);
	}
	assert.equal(recorded('cache-key-mismatch-is-a-miss', '/the_two_keys_differ'), true);
	assert.deepEqual(recorded('cache-key-mismatch-is-a-miss', '/compute_calls'), ['A', 'B']);
	assert.equal(recorded('store-corrupt-entry-rejected', '/same_size_tamper/threw').code, 'ARTIFACT_CORRUPT');
	assert.equal(recorded('store-corrupt-entry-rejected', '/truncated/threw').code, 'ARTIFACT_CORRUPT');
	assert.equal(recorded('store-corrupt-entry-rejected', '/removed/threw').code, 'ARTIFACT_NOT_FOUND');
	assert.equal(recorded('store-corrupt-entry-rejected', '/tampered_blob_is_not_repaired_by_put/threw').code, 'ARTIFACT_CORRUPT');
	assert.equal(recorded('store-budget-refused', '/one_byte_over/threw').code, 'ARTIFACT_BUDGET_EXCEEDED');
	assert.equal(recorded('file-index-budget-refused', '/file_count_budget/threw').code, 'INDEX_BUDGET_EXCEEDED');
	const blocked = recorded('scheduler-budget-blocked', '/task_over_the_budget_and_its_dependent');
	assert.deepEqual(blocked.results.filter((x) => x.status === 'blocked').map((x) => [x.id, x.reason]), [['after-huge', 'DEPENDENCY_NOT_PASSED'], ['huge', 'RESOURCE_BUDGET_EXCEEDED']]);
	assert.equal(blocked.started.includes('huge'), false);
	assert.deepEqual(recorded('invalidated-entry-not-reused', '/compute_calls'), ['before the edit', 'after the edit']);
	assert.equal(recorded('invalidated-entry-not-reused', '/run_after_invalidation').cache_hit, false);
	assert.equal(recorded('gc-keeps-referenced-artifacts', '/deleted_only_the_orphan'), true);
	assert.equal(recorded('gc-keeps-referenced-artifacts', '/orphan_after/threw').code, 'ARTIFACT_NOT_FOUND');
	assert.equal(recorded('path-escape-refused', '/files_under_the_root_after_all_refusals').length, 1);
	assert.equal(recorded('cache-index-symlinked-directory-is-followed', '/written_outside_the_repo_root').length, 1);
	assert.equal(recorded('file-index-digest-of-the-old-baseline-workload', '/recomputed_digest_equals_old_file'), true);
});

test('code facts: the pinned modules hold what the limits say they lack (no timer or abort signal in the scheduler, no lock in the collector, no realpath in the cache index or the project runner, nothing in the two cache runners that retires an entry)', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const stripped = (rel) => L.withoutComments(textAt(rel));
	assert.equal(TIMER.test(stripped('lib/scan-scheduler-next/scheduler.mjs')), false);
	assert.equal(LOCK.test(stripped('lib/artifact-store-next/gc.mjs')), false);
	assert.equal(/realpath/.test(stripped('lib/artifact-store-next/cache-index.mjs')), false);
	assert.match(stripped('lib/artifact-store-next/cache-index.mjs'), /path\.relative\(root, statePath\)/);
	assert.match(stripped('lib/artifact-store-next/cache-index.mjs'), /withLockSync/);
	const projectRunner = stripped('lib/scan-scheduler-next/project-cache-runner.mjs');
	assert.equal(/realpath/.test(projectRunner), false);
	assert.match(projectRunner, /path\.relative\(base, target\)/);
	assert.match(projectRunner, /project root escapes repository/);
	const retiring = /invalidateDependencies|\.remove\(/;
	assert.equal(retiring.test(stripped('lib/scan-scheduler-next/legacy-cache.mjs') + projectRunner), false);
	assert.match(stripped('lib/artifact-store-next/cache-index.mjs'), /function invalidateDependencies/);
	assert.deepEqual([retiring.test('index.remove(key)'), retiring.test('index.invalidateDependencies(paths)'), retiring.test('index.set(key, entry)')], [true, true, false]);
	assert.deepEqual([TIMER.test('setTimeout(run, 1)'), TIMER.test('signal: AbortSignal.timeout(5)'), LOCK.test("import { withLockSync } from '../lock.mjs'"), LOCK.test('const total = 1;')], [true, true, true, false]);
	assert.ok(textAt('test/perf-next/benchmark.mjs').includes("measure('same-process-second-pass-no-cache-yet')"));
	const legacy = textAt('test/perf-next/legacy-cache-benchmark.mjs');
	for (const phrase of ['performance gate must remain BLOCKED until approved external peak-RSS measurements are supplied', 'cache hit still rebuilds the content index before key lookup', 'peak RSS is deliberately absent']) assert.ok(legacy.includes(phrase), phrase);
});

test('ripgrep: the fixtures that run a stable adapter need rg on PATH, and a PATH without rg fails the replay instead of skipping it', () => {
	const rg = spawnSync('rg', ['--version'], { encoding: 'utf8' });
	assert.equal(rg.status, 0, 'ripgrep (rg) must be installed and on PATH: the legacy cache and project graph fixtures run the stable scanner adapters, which call it (limit hashes-generated-on-one-platform)');
	assert.match(rg.stdout, /^ripgrep \d+\.\d+\.\d+/);
	const needing = limit('hashes-generated-on-one-platform').fixtures;
	assert.ok(needing.length > 0);
	const without = L.tmpDir('t21-no-rg-');
	const script = [
		`import * as L from ${JSON.stringify(pathToFileURL(path.join(ROOT, L.TRACK.testDir, 'baseline-record-lib.mjs')).href)};`,
		'const record = L.readRecord();',
		`const one = { ...record, fixtures: record.fixtures.filter((f) => f.id === ${JSON.stringify(needing[0])}) };`,
		'console.log(JSON.stringify(L.replayProblems(one, await L.replay(one, L.REPO_ROOT))));'
	].join('\n');
	const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', env: { PATH: without, HOME: process.env.HOME ?? without, TMPDIR: process.env.TMPDIR ?? without } });
	assert.equal(run.status, 0, run.stderr);
	mentions(JSON.parse(run.stdout.trim().split('\n').pop()), `${needing[0]}: output sha256`);
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
