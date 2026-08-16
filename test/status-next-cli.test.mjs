// D1: end-to-end CLI tests for `bskel status`/`bskel next`. Fixture/helper conventions copied
// from test/verify-cli.test.mjs (`buildFixtureRepo`/`run`/`runWorkflowThroughContract`), which
// this file does not modify. See DECISIONS.md D-status-next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildFixtureRepo({ unmatchedEndpoint } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-status-next-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const pkgDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation');
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() { return "ok"; }
${unmatchedEndpoint ? `
	@Operation(summary = "delete a widget")
	@DeleteMapping("/{widgetId}")
	public String deleteWidget(@PathVariable String widgetId) { return "ok"; }` : ''}
}
`);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-status-next-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('bskel next before preflight recommends preflight', () => {
	const root = buildFixtureRepo();
	const result = run(['next', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(report.blocked_by, ['preflight']);
	assert.equal(report.next_actions[0].command, 'bskel preflight');
	assert.equal(report.next_actions[0].mutating, true);
});

test('bskel next after preflight, with no feature yet, recommends feature init', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const result = run(['next', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(report.blocked_by, []);
	assert.equal(report.next_actions[0].command, 'bskel feature init --slug <name>');
});

test('bskel next after preflight, with an existing feature but none given, points at --feature and lists known features', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const result = run(['next', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.next_actions[0].command, 'bskel next --feature <id>');
	assert.match(report.next_actions[0].reason, /001-widget-management/);
});

test('bskel next --feature right after feature init recommends scan', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const result = run(['next', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(report.blocked_by, ['scan', 'contract']);
	assert.equal(report.next_actions[0].command, 'bskel scan --feature 001-widget-management --terms <a,b,c>');
	assert.equal(report.next_actions[0].reason, 'scan gate has not run yet');
});

// The case that would catch a real bug: a collided scan needs `scan disposition`, not a re-run
// of `scan` itself -- next_actions must reflect the gate-specific awaiting_disposition remediation,
// not the generic "gate has not run yet" establish command.
test('bskel next after a colliding scan recommends scan disposition, not re-running scan', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	const result = run(['next', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.equal(report.next_actions[0].command, 'bskel scan disposition --feature 001-widget-management --mode reuse|extend|replace|parallel --note "..."');
	assert.equal(report.next_actions[0].reason, 'scan gate is awaiting disposition');
});

// Same shape for a partial (A5) contract -- must recommend `contract waive`, matching
// cmdHandlesEmit's own awaiting_disposition hint verbatim, not a generic re-run.
test('bskel next after a partial contract recommends contract waive, matching the exact remediation cmdHandlesEmit itself uses', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	const emit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 3, 'sanity: partial contract must block');

	const result = run(['next', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.match(report.next_actions[0].command, /^bskel contract waive --feature 001-widget-management --code <CODE>/);
	assert.equal(report.next_actions[0].reason, 'contract gate is awaiting disposition');
});

test('bskel next once all required gates pass recommends verify, and surfaces handles/stack as optional', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const result = run(['next', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(report.blocked_by, []);
	assert.equal(report.next_actions[0].command, 'bskel verify --feature 001-widget-management');
	assert.equal(report.next_actions[0].mutating, false);
	assert.deepEqual(report.optional_not_run.sort(), ['handles', 'stack']);
});

// S2 integration: a stale contract (resolution.json deleted) must surface through `next` too,
// with the exact changed_inputs S2 computes -- not just "something is stale".
test('bskel next reflects a stale gate with the exact S2 changed_inputs reason', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'test'], root);

	fs.rmSync(path.join(root, 'specs', '001-widget-management', 'contracts', '001-widget-management.resolution.json'));

	const result = run(['next', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.equal(report.next_actions[0].command, 'bskel contract emit --feature 001-widget-management');
	assert.equal(report.next_actions[0].reason, 'contract gate is stale: resolution_hash');
});

test('bskel status --json exposes the same gates/artifacts data verify computes', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const statusResult = run(['status', '--feature', '001-widget-management', '--json'], root);
	const verifyResult = run(['verify', '--feature', '001-widget-management', '--json'], root);
	const status = JSON.parse(statusResult.stdout);
	const verify = JSON.parse(verifyResult.stdout);

	assert.deepEqual(status.gates.map((g) => g.gate), verify.gates.map((g) => g.gate));
	assert.deepEqual(status.gates.map((g) => g.status), verify.gates.map((g) => g.status));
	assert.deepEqual(status.artifacts, verify.artifacts);
});

test('bskel next without --json prints exactly one command on stdout, with the reason on stderr', () => {
	const root = buildFixtureRepo();
	const result = run(['next'], root);
	assert.equal(result.stdout.trim().split('\n').length, 1, 'stdout must be exactly one line -- safe for $(bskel next)');
	assert.equal(result.stdout.trim(), 'bskel preflight');
});
