// D-gate-export: `bskel gate export` is a pure reader over `.sbf/*.history.jsonl` + current
// gate state -- the concrete mitigation for "what did this PR actually get verified against"
// when CI itself can't be trusted to have run at all (see the project's own real
// GitHub-Actions-billing outage this was built during).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, buildFixtureRepo, initThroughScanDisposition } from './_contract-fixture.mjs';

const FEATURE = '001-widget-management';

test('a freshly-initialized feature (no gates run yet beyond preflight/scan) exports null current + empty history for untouched gates', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root); // runs preflight + scan + scan disposition only
	const result = run(['gate', 'export', '--feature', FEATURE], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.schema, 'sbf.gate-export/1');
	assert.equal(report.feature_id, FEATURE);
	assert.equal(report.gates.preflight.current.status, 'pass');
	assert.equal(report.gates.scan.current.status, 'pass');
	assert.equal(report.gates.contract.current, null, 'contract emit was never run');
	assert.deepEqual(report.gates.contract.history, []);
});

test('every gate carries the real per-scope history, preflight scoped to _repo not the feature id', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const report = JSON.parse(run(['gate', 'export', '--feature', FEATURE], root).stdout);
	assert.equal(report.gates.preflight.scope, '_repo');
	assert.equal(report.gates.scan.scope, FEATURE);
	assert.equal(report.gates.contract.scope, FEATURE);
	assert.equal(report.gates.contract.current.status, 'pass');
	assert.ok(report.gates.contract.history.length >= 1);
	assert.equal(report.gates.contract.history[0].event, 'pass');
	assert.equal(report.gates.contract.history[0].gate, 'contract');
});

test('a forced gate is disclosed in history with its real reason, distinct from an ordinary pass', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	// Force the handles gate without ever running `handles emit` -- a real, honest forced-pass.
	assert.equal(run(['gate', 'force', 'handles', '--feature', FEATURE, '--reason', 'manual override for testing'], root).code, 0);

	const report = JSON.parse(run(['gate', 'export', '--feature', FEATURE], root).stdout);
	assert.equal(report.gates.handles.current.forced, true);
	const forceEvent = report.gates.handles.history.find((e) => e.event === 'force');
	assert.ok(forceEvent);
	assert.equal(forceEvent.reason, 'manual override for testing');
});

test('--out writes the report to a file and prints a summary line with a real pass count and git provenance', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', FEATURE], root);

	const result = run(['gate', 'export', '--feature', FEATURE, '--out', 'evidence.json'], root);
	assert.equal(result.code, 0);
	// D-runtime-conformance-receipts: 6 gates now (preflight/scan/contract/handles/stack/conformance).
	assert.match(result.stdout, /wrote evidence\.json -- \d\/6 gate\(s\) currently passing/);

	const written = JSON.parse(fs.readFileSync(path.join(root, 'evidence.json'), 'utf8'));
	assert.equal(written.schema, 'sbf.gate-export/1');
	assert.equal(written.git.branch, 'develop');
	assert.equal(written.git.dirty, false);
	const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	assert.equal(written.git.head_sha, realHead);
});

test('an uncommitted change is disclosed as dirty:true -- the report never silently implies HEAD == working tree', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	fs.writeFileSync(path.join(root, 'untracked-scratch-file.txt'), 'x');

	const report = JSON.parse(run(['gate', 'export', '--feature', FEATURE], root).stdout);
	assert.equal(report.git.dirty, true);
});

test('an invalid --feature id is refused the same way every other feature-scoped command refuses one', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const result = run(['gate', 'export', '--feature', 'not-a-valid-id'], root);
	assert.notEqual(result.code, 0);
});

test('gate export never mutates any gate -- state.json is byte-identical before and after', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', FEATURE], root);
	const statePath = path.join(root, '.sbf', `${FEATURE}.json`);
	const before = fs.readFileSync(statePath, 'utf8');
	run(['gate', 'export', '--feature', FEATURE], root);
	run(['gate', 'export', '--feature', FEATURE, '--json'], root);
	const after = fs.readFileSync(statePath, 'utf8');
	assert.equal(before, after);
});
