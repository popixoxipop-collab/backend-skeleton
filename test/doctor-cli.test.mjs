// D5: end-to-end CLI tests for `bskel doctor --workflow ...`/`--json`, plus a couple of unit
// tests for lib/doctor.mjs's pure decision logic. Fixture/`run()` conventions copied from
// test/generic-grep-cli.test.mjs, which this file does not modify. See DECISIONS.md
// D-doctor-workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeDoctorChecks, WORKFLOWS } from '../lib/doctor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd, env) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildFixtureRepo({ withGradlew = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-doctor-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	if (withGradlew) fs.writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\necho fixture gradlew\n');
	fs.writeFileSync(path.join(root, '.gitkeep'), '');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	return root;
}

test('bskel doctor --workflow bogus fails with exit 14 and lists the known workflow names', () => {
	const root = buildFixtureRepo();
	const result = run(['doctor', '--workflow', 'bogus'], root);
	assert.equal(result.code, 14);
	for (const w of WORKFLOWS) assert.match(result.stderr, new RegExp(w));
});

test('bskel doctor --workflow stack --json: no rg/gh/build-wrapper checks, curl+ngrok sourced from the ngrok catalog entry', () => {
	const root = buildFixtureRepo();
	const result = run(['doctor', '--workflow', 'stack', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.equal(report.workflow, 'stack');
	const names = report.checks.map((c) => c.name);
	assert.ok(!names.includes('binary: rg'));
	assert.ok(!names.includes('binary: gh'));
	assert.ok(!names.includes('build wrapper'));
	assert.ok(names.includes('binary: curl'), 'curl check must be sourced from stack/catalog/ngrok.yml\'s runtime.requires');
	assert.ok(names.includes('binary: ngrok'), 'ngrok check must be sourced from stack/catalog/ngrok.yml\'s runtime.requires');
	const curlCheck = report.checks.find((c) => c.name === 'binary: curl');
	assert.equal(curlCheck.required, false, 'stack tooling is never required -- it only matters once a human runs the generated bootstrap script');
	assert.deepEqual(report.adapters, [], 'stack workflow has nothing to do with scanner adapters');
});

test('bskel doctor --workflow handles --json: rg required, no gh, build-wrapper check reflects the target repo', () => {
	const withoutGradlew = buildFixtureRepo();
	const r1 = run(['doctor', '--workflow', 'handles', '--json'], withoutGradlew);
	const report1 = JSON.parse(r1.stdout);
	const names1 = report1.checks.map((c) => c.name);
	assert.ok(names1.includes('binary: rg'));
	assert.ok(!names1.includes('binary: gh'));
	assert.ok(!names1.includes('binary: curl'));
	const buildCheck1 = report1.checks.find((c) => c.name === 'build wrapper');
	assert.equal(buildCheck1.ok, false);
	assert.equal(buildCheck1.required, false, 'no build wrapper must not fail doctor -- handles emit itself never compiles anything');

	const withGradlew = buildFixtureRepo({ withGradlew: true });
	const r2 = run(['doctor', '--workflow', 'handles', '--json'], withGradlew);
	const report2 = JSON.parse(r2.stdout);
	const buildCheck2 = report2.checks.find((c) => c.name === 'build wrapper');
	assert.equal(buildCheck2.ok, true);
	assert.match(buildCheck2.detail, /gradle/);
});

test('bskel doctor --json produces valid JSON with the documented top-level shape', () => {
	const root = buildFixtureRepo();
	const result = run(['doctor', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(Object.keys(report).sort(), ['adapters', 'checks', 'load_errors', 'ok', 'workflow']);
	assert.equal(report.workflow, null);
	assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
});

test('a missing gh binary does not fail bskel doctor overall -- it is optional, matching preflight\'s own soft-guard on it', () => {
	const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
	const rgPath = execFileSync('which', ['rg'], { encoding: 'utf8' }).trim();
	const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-doctor-restricted-path-'));
	fs.symlinkSync(gitPath, path.join(tmpBin, 'git'));
	fs.symlinkSync(rgPath, path.join(tmpBin, 'rg'));
	// Deliberately no `gh` symlink -- this PATH cannot possibly find it, real machine install or not.

	const root = buildFixtureRepo();
	const result = run(['doctor', '--json'], root, { ...process.env, PATH: tmpBin });
	const report = JSON.parse(result.stdout);
	const ghCheck = report.checks.find((c) => c.name === 'binary: gh');
	assert.ok(ghCheck, 'gh check should still be present (informational) even though it cannot be found');
	assert.equal(ghCheck.ok, false);
	assert.equal(ghCheck.required, false);
	assert.equal(report.ok, true, 'overall doctor verdict must stay true -- gh is optional and everything else (git, rg, Node) is genuinely fine');
	assert.equal(result.code, 0);
});

// Pure lib/doctor.mjs unit coverage, independent of the CLI.
test('computeDoctorChecks throws on an unknown workflow, naming every valid one', () => {
	assert.throws(() => computeDoctorChecks(process.cwd(), { workflow: 'nope' }), /unknown workflow "nope".*scan.*handles.*stack/s);
});

test('computeDoctorChecks: only git/node/rg are required -- gh/build-wrapper/stack tooling are all optional', () => {
	const { checks } = computeDoctorChecks(process.cwd());
	const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
	assert.equal(byName['inside a git repo'].required, true);
	assert.equal(byName['binary: git'].required, true);
	assert.equal(byName['Node version'].required, true);
	assert.equal(byName['binary: rg'].required, true);
	assert.equal(byName['binary: gh'].required, false);
	if (byName['build wrapper']) assert.equal(byName['build wrapper'].required, false);
});

test('computeDoctorChecks: showAdapters is true for scan/handles/unscoped, false for stack', () => {
	assert.equal(computeDoctorChecks(process.cwd()).showAdapters, true);
	assert.equal(computeDoctorChecks(process.cwd(), { workflow: 'scan' }).showAdapters, true);
	assert.equal(computeDoctorChecks(process.cwd(), { workflow: 'handles' }).showAdapters, true);
	assert.equal(computeDoctorChecks(process.cwd(), { workflow: 'stack' }).showAdapters, false);
});
