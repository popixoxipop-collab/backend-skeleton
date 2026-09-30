// scripts/run-next-nested-tests.mjs decides whether a next-plane suite counts as verified in CI.
// These tests pin its fail-closed contract: a suite with neither source nor tests must not pass
// silently, an intentional absence has to be declared with a reason and a ref, and a declaration
// that no longer matches the tree has to fail. Each scenario builds a throwaway repo root and runs
// the real runSuite in a child process, so the exit code and log lines are what CI would see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { SUITES, REPO_ROOT, inspectSuite } from '../scripts/run-next-nested-tests.mjs';

const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'run-next-nested-tests.mjs')).href;
const DRIVER = [
	`import { runSuite } from ${JSON.stringify(RUNNER_URL)};`,
	'const [root, suiteJson] = process.argv.slice(1);',
	'process.exitCode = runSuite(JSON.parse(suiteJson), root);',
].join('\n');

const SOURCE_FILE = 'export const marker = 1;\n';
const PASSING_TEST = "import test from 'node:test';\ntest('fixture passes', () => {});\n";
const FAILING_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture fails', () => { assert.equal(1, 2); });\n";

const SUITE = { id: 'T99', sourcePaths: ['src-next'], testDir: 'test/next-suite' };
const DECLARED = { reason: 'fixture suite is intentionally absent', ref: 'example-org/example-repo#1' };

function buildRoot(t, files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-nested-runner-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), content);
	}
	return root;
}

function runInFixture(t, files, suite) {
	const root = buildRoot(t, files);
	const env = { ...process.env };
	// The runner starts `node --test` for READY suites; inside this test that would inherit the
	// parent test runner's child-process context and skip reporting.
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER, root, JSON.stringify(suite)], { encoding: 'utf8', env });
	assert.equal(result.error, undefined, String(result.error));
	return { exit: result.status, stdout: result.stdout, stderr: result.stderr, inspected: inspectSuite(suite, root) };
}

test('READY: source and passing tests run and the runner exits 0', (t) => {
	const r = runInFixture(t, { 'src-next/index.mjs': SOURCE_FILE, 'test/next-suite/a.test.mjs': PASSING_TEST }, SUITE);
	assert.equal(r.inspected.status, 'READY');
	assert.equal(r.exit, 0, r.stderr);
	assert.match(r.stdout, /^NESTED_SUITE T99 RUN 1 files$/m);
});

test('READY: a failing test in the suite makes the runner exit non-zero', (t) => {
	const r = runInFixture(t, { 'src-next/index.mjs': SOURCE_FILE, 'test/next-suite/a.test.mjs': FAILING_TEST }, SUITE);
	assert.equal(r.inspected.status, 'READY');
	assert.notEqual(r.exit, 0);
	assert.match(r.stdout, /^NESTED_SUITE T99 RUN 1 files$/m);
});

test('NOT_PRESENT: a suite with no source and no tests fails when its absence is not declared', (t) => {
	const r = runInFixture(t, {}, SUITE);
	assert.equal(r.inspected.status, 'NOT_PRESENT');
	assert.equal(r.exit, 2);
	assert.match(r.stderr, /^NESTED_SUITE T99 NOT_PRESENT$/m);
	assert.doesNotMatch(r.stdout, /EXPECTED_ABSENT|RUN/);
});

test('EXPECTED_ABSENT: a declared absence passes and names its ref', (t) => {
	const r = runInFixture(t, {}, { ...SUITE, expectedAbsent: DECLARED });
	assert.equal(r.inspected.status, 'EXPECTED_ABSENT');
	assert.equal(r.exit, 0, r.stderr);
	assert.match(r.stdout, /^NESTED_SUITE T99 EXPECTED_ABSENT ref=example-org\/example-repo#1$/m);
});

const STALE_CASES = [
	['source and tests exist', { 'src-next/index.mjs': SOURCE_FILE, 'test/next-suite/a.test.mjs': PASSING_TEST }],
	['only source exists', { 'src-next/index.mjs': SOURCE_FILE }],
	['only tests exist', { 'test/next-suite/a.test.mjs': PASSING_TEST }],
	['only an empty test directory exists', { 'test/next-suite/README.md': 'placeholder\n' }],
];
for (const [label, files] of STALE_CASES) {
	test(`FAIL_STALE_EXPECTED_ABSENT: a declared absence fails when ${label}`, (t) => {
		const r = runInFixture(t, files, { ...SUITE, expectedAbsent: DECLARED });
		assert.equal(r.inspected.status, 'FAIL_STALE_EXPECTED_ABSENT');
		assert.equal(r.exit, 2);
		assert.match(r.stderr, /^NESTED_SUITE T99 FAIL_STALE_EXPECTED_ABSENT$/m);
		assert.doesNotMatch(r.stdout, /EXPECTED_ABSENT|RUN/);
	});
}

test('FAIL_ORPHAN_TESTS: tests without source fail', (t) => {
	const r = runInFixture(t, { 'test/next-suite/a.test.mjs': PASSING_TEST }, SUITE);
	assert.equal(r.inspected.status, 'FAIL_ORPHAN_TESTS');
	assert.equal(r.exit, 2);
	assert.match(r.stderr, /^NESTED_SUITE T99 FAIL_ORPHAN_TESTS$/m);
});

const MISSING_TESTS_CASES = [
	['there is no test directory', { 'src-next/index.mjs': SOURCE_FILE }],
	['the test directory holds no test files', { 'src-next/index.mjs': SOURCE_FILE, 'test/next-suite/README.md': 'placeholder\n' }],
];
for (const [label, files] of MISSING_TESTS_CASES) {
	test(`FAIL_MISSING_TESTS: source without tests fails when ${label}`, (t) => {
		const r = runInFixture(t, files, SUITE);
		assert.equal(r.inspected.status, 'FAIL_MISSING_TESTS');
		assert.equal(r.exit, 2);
		assert.match(r.stderr, /^NESTED_SUITE T99 FAIL_MISSING_TESTS$/m);
	});
}

const INVALID_DECLARATIONS = [
	['true', true],
	['null', null],
	['an empty object', {}],
	['a missing ref', { reason: 'no ref given' }],
	['a missing reason', { ref: 'example-org/example-repo#1' }],
	['a blank ref', { reason: 'blank ref', ref: '  ' }],
	['a non-string reason', { reason: 7, ref: 'example-org/example-repo#1' }],
];
for (const [label, declaration] of INVALID_DECLARATIONS) {
	test(`FAIL_INVALID_EXPECTED_ABSENT: a declaration of ${label} does not excuse an absent suite`, (t) => {
		const r = runInFixture(t, {}, { ...SUITE, expectedAbsent: declaration });
		assert.equal(r.inspected.status, 'FAIL_INVALID_EXPECTED_ABSENT');
		assert.equal(r.exit, 2);
		assert.match(r.stderr, /^NESTED_SUITE T99 FAIL_INVALID_EXPECTED_ABSENT$/m);
		assert.doesNotMatch(r.stdout, /EXPECTED_ABSENT|RUN/);
	});
}

test('every suite in the real SUITES is READY or a declared EXPECTED_ABSENT in this checkout', () => {
	for (const suite of SUITES) {
		const { status } = inspectSuite(suite, REPO_ROOT);
		assert.ok(status === 'READY' || status === 'EXPECTED_ABSENT', `${suite.id} is ${status}`);
	}
});
