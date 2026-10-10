import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/persistence/js-orm-oracle.mjs');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const step = (id, code, extra = {}) => ({ id, argv: ['node', '-e', code], expect_exit: 0, capture: [{ kind: 'stdout' }], result_file: `oracle/results/${id}.out`, ...extra });

// A throwaway copy of the runner beside a minimal record whose oracle steps are plain node one-liners.
function sandbox(t, steps) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-oracle-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	for (const sub of ['fixtures', 'oracle/results']) fs.mkdirSync(path.join(dir, 'prisma', sub), { recursive: true });
	fs.copyFileSync(RUNNER, path.join(dir, 'js-orm-oracle.mjs'));
	const file = (rel) => fs.readFileSync(path.join(dir, 'prisma', rel), 'utf8');
	const box = {
		file,
		scope: () => JSON.parse(file('SCOPE.json')),
		save: (scope) => fs.writeFileSync(path.join(dir, 'prisma/SCOPE.json'), `${JSON.stringify(scope, null, '\t')}\n`),
		put: (rel, text) => fs.writeFileSync(path.join(dir, 'prisma', rel), text),
		results: () => fs.readdirSync(path.join(dir, 'prisma/oracle/results')).sort(),
		leftovers: () => fs.readdirSync(dir).filter((name) => name.startsWith('orm-oracle-')),
		run: (...args) => spawnSync(process.execPath, [path.join(dir, 'js-orm-oracle.mjs'), 'prisma', ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: dir } }),
	};
	box.save({ pins: { packages: [] }, oracle: { steps } });
	return box;
}

test('an unknown or empty --only id, an empty step list and --only with --pins fail before anything is installed or written', (t) => {
	const box = sandbox(t, [step('changed', 'console.log("new")')]);
	const empty = sandbox(t, []);
	const before = box.file('SCOPE.json');
	for (const only of [['--only', 'no-such-step'], ['--only', ''], ['--only']]) {
		const run = box.run('--write', ...only);
		assert.equal(run.status, 2, run.stderr);
		assert.match(run.stderr, /unknown step id/);
	}
	const pins = box.run('--pins', '--only', 'changed');
	assert.equal(pins.status, 2, pins.stderr);
	assert.match(pins.stderr, /cannot be combined/);
	for (const mode of ['--check', '--write']) {
		const run = empty.run(mode);
		assert.equal(run.status, 2, run.stderr);
		assert.match(run.stderr, /no oracle steps/);
	}
	assert.deepEqual([box.file('SCOPE.json'), box.results(), box.leftovers(), empty.leftovers()], [before, [], [], []]);
});

test('--write stages every result: a failing selected step leaves the frozen file and the record untouched', (t) => {
	const failing = sandbox(t, [step('changed', 'console.log("new")'), step('broken', 'process.exit(3)')]);
	const passing = sandbox(t, [step('changed', 'console.log("new")'), step('broken', 'process.exit(3)', { expect_exit: 3 })]);
	failing.put('oracle/results/changed.out', 'old\n');
	const before = failing.file('SCOPE.json');
	assert.equal(failing.run('--write').status, 1);
	assert.deepEqual([failing.file('oracle/results/changed.out'), failing.file('SCOPE.json'), failing.results()], ['old\n', before, ['changed.out']]);
	assert.equal(passing.run('--write').status, 0);
	assert.deepEqual(passing.results(), ['broken.out', 'changed.out']);
	assert.equal(passing.file('oracle/results/changed.out'), 'new\n');
	assert.equal(passing.scope().oracle.steps[0].output_sha256, digest('new\n'));
});

test('a missing capture file or directory fails the step and freezes nothing', (t) => {
	const make = (code, ...capture) => sandbox(t, [step('probe', code, { capture: [{ kind: 'stdout' }, ...capture] })]);
	const file = { kind: 'file', path: 'out/a.txt' };
	const listing = { kind: 'listing', path: 'out/dir' };
	const makesFileInstead = "const fs = require('fs'); fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/dir', 'x')";
	const makesAll = "const fs = require('fs'); fs.mkdirSync('out/dir', { recursive: true }); fs.writeFileSync('out/a.txt', 'A'); fs.writeFileSync('out/dir/y', ''); fs.writeFileSync('out/dir/x', '')";
	const failures = [
		[make('0', file), /expected output file out\/a\.txt was not produced/],
		[make('0', listing), /expected output directory out\/dir was not produced/],
		[make(makesFileInstead, listing), /expected output directory out\/dir was not produced/],
	];
	for (const [box, message] of failures) {
		const before = box.file('SCOPE.json');
		const run = box.run('--write');
		assert.equal(run.status, 1, run.stderr);
		assert.match(run.stderr, message);
		assert.deepEqual([box.file('SCOPE.json'), box.results(), box.leftovers()], [before, [], []]);
	}
	const control = make(makesAll, file, listing);
	assert.equal(control.run('--write').status, 0);
	assert.equal(control.file('oracle/results/probe.out'), '### stdout\n\n### file out/a.txt\nA\n### listing out/dir\nx\ny\n');
});

test('--write --only leaves the recorded environment untouched and refuses to run under a different runtime', (t) => {
	const box = sandbox(t, [step('changed', 'console.log("v1")'), step('other', 'console.log("o")')]);
	assert.equal(box.run('--write').status, 0);
	const seeded = box.scope();
	assert.deepEqual([seeded.oracle.environment.node, seeded.oracle.environment.platform, seeded.oracle.environment.arch], [process.version, process.platform, process.arch]);
	seeded.oracle.environment.recorded_by = 'seeded by a full --write';
	seeded.oracle.steps[0].argv[2] = 'console.log("v2")';
	box.save(seeded);

	const partial = box.run('--write', '--only', 'changed');
	assert.equal(partial.status, 0, partial.stderr);
	const after = box.scope();
	assert.deepEqual(after.oracle.environment, seeded.oracle.environment);
	assert.deepEqual([after.oracle.steps[0].output_sha256, after.oracle.steps[1]], [digest('v2\n'), seeded.oracle.steps[1]]);
	assert.equal(box.file('oracle/results/changed.out'), 'v2\n');

	for (const [field, value] of [['node', 'v0.0.0'], ['npm', '0.0.0'], ['platform', 'plan9'], ['arch', 'vax']]) {
		const foreign = box.scope();
		foreign.oracle.environment = { ...seeded.oracle.environment, [field]: value };
		foreign.oracle.steps[0].argv[2] = 'console.log("v3")';
		box.save(foreign);
		const before = box.file('SCOPE.json');
		const refused = box.run('--write', '--only', 'changed');
		assert.equal(refused.status, 1, `${field}: ${refused.stderr}`);
		assert.match(refused.stderr, /would mix runtimes/);
		assert.deepEqual([box.file('SCOPE.json'), box.file('oracle/results/changed.out'), box.leftovers()], [before, 'v2\n', []], field);
	}

	assert.equal(box.run('--write').status, 0);
	assert.equal(box.scope().oracle.environment.node, process.version);
	assert.equal(box.file('oracle/results/changed.out'), 'v3\n');
});
