// D-attestation-payload-completeness: pure module tests for lib/gate-export.mjs's report
// construction, against a real fixture repo -- separate from test/gate-export-cli.test.mjs (which
// stays CLI-level) and test/attest-cli.test.mjs (signing e2e). See DECISIONS.md's own entry for
// what this item closes: gate export's report now carries tool version, git tree identity, a
// RECOMPUTED live gate verdict distinct from the stored `current` record, unconditional artifact
// hashes, and a forced/revoked/waiver roll-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, buildFixtureRepo, buildTwoFeatureFixtureRepo, initThroughScanDisposition, contractSchemaPath } from './_contract-fixture.mjs';
import { buildGateExportReport, ARTIFACT_SOURCES } from '../lib/gate-export.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

const FEATURE = '001-widget-management';
// Plain fs read + JSON.parse (not an import assertion) -- this project's engines floor is
// Node >=18, and `import ... with { type: 'json' }` needs a newer runtime.
const schema = JSON.parse(fs.readFileSync(new URL('../schemas/gate-export.schema.json', import.meta.url), 'utf8'));

test('ARTIFACT_SOURCES key set equals schemas/gate-export.schema.json artifacts.properties key set (anti-drift)', () => {
	assert.deepEqual(
		[...Object.keys(ARTIFACT_SOURCES)].sort(),
		[...Object.keys(schema.properties.artifacts.properties)].sort(),
	);
});

test('a freshly-initialized feature: artifacts key set matches ARTIFACT_SOURCES, contract_hash null, scan_report_hash real', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const report = buildGateExportReport(root, FEATURE);
	assert.deepEqual([...Object.keys(report.artifacts)].sort(), [...Object.keys(ARTIFACT_SOURCES)].sort());
	assert.equal(report.artifacts.contract_hash, null);
	assert.match(report.artifacts.scan_report_hash, /^[0-9a-f]{64}$/);
});

test('handles_manifest_hash: null before handles emit, real after -- the concrete proof of genuinely new coverage', () => {
	// buildTwoFeatureFixtureRepo (not buildFixtureRepo) -- `handles emit` needs a detectable Spring
	// Boot base package (*Application.java under src/main/java), which only this fixture provides;
	// only feature 001 is ever initialized/touched below, the second feature is simply unused here.
	const root = buildTwoFeatureFixtureRepo();
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);
	assert.equal(buildGateExportReport(root, FEATURE).artifacts.handles_manifest_hash, null);

	assert.equal(run(['scan', 'cross-feature-check', '--feature', FEATURE], root).code, 0);
	const emit = run(['handles', 'emit', '--feature', FEATURE, '--json'], root);
	assert.equal(emit.code, 0, emit.stderr);

	assert.match(buildGateExportReport(root, FEATURE).artifacts.handles_manifest_hash, /^[0-9a-f]{64}$/);
});

test('the headline fix: a gate whose stored record still says pass, but whose inputs have since changed, reports live.status "stale" (never re-signed as pass)', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const fresh = buildGateExportReport(root, FEATURE);
	assert.equal(fresh.gates.contract.current.status, 'pass');
	assert.equal(fresh.gates.contract.live.status, 'pass');

	fs.writeFileSync(contractSchemaPath(root), `${fs.readFileSync(contractSchemaPath(root), 'utf8')}\n`);

	const restale = buildGateExportReport(root, FEATURE);
	assert.equal(restale.gates.contract.current.status, 'pass', 'the STORED record must not silently change');
	assert.equal(restale.gates.contract.live.status, 'stale', 'the RECOMPUTED verdict must catch the drift');
	assert.ok(restale.gates.contract.live.changed_inputs.includes('contract_hash'));
	assert.ok(restale.verdict.blocking_gates.includes('contract'));
	assert.equal(restale.verdict.ok, false);
});

test('decisions.forced carries the real gate + verbatim reason after `gate force`', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	assert.equal(run(['gate', 'force', 'handles', '--feature', FEATURE, '--reason', 'manual override for testing'], root).code, 0);

	const report = buildGateExportReport(root, FEATURE);
	const forced = report.decisions.forced.find((f) => f.gate === 'handles');
	assert.ok(forced);
	assert.equal(forced.reason, 'manual override for testing');
	assert.equal(forced.scope, FEATURE);
});

test('decisions.revoked carries the real gate + verbatim reason after `gate revoke`', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	run(['gate', 'force', 'handles', '--feature', FEATURE, '--reason', 'x'], root);
	run(['gate', 'revoke', 'handles', '--feature', FEATURE, '--reason', 'revoking the override'], root);

	const report = buildGateExportReport(root, FEATURE);
	const revoked = report.decisions.revoked.find((r) => r.gate === 'handles');
	assert.ok(revoked);
	assert.equal(revoked.reason, 'revoking the override');
});

test('git.head_tree_sha matches a real `git rev-parse HEAD^{tree}` on the fixture', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const report = buildGateExportReport(root, FEATURE);
	const realTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
	assert.equal(report.git.head_tree_sha, realTree);
});

test('git.dirty_files is sorted by path, dirty_file_count matches the real count, and a cap truncates deterministically', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	fs.writeFileSync(path.join(root, 'z-file.txt'), 'x');
	fs.writeFileSync(path.join(root, 'a-file.txt'), 'x');
	fs.writeFileSync(path.join(root, 'm-file.txt'), 'x');

	const full = buildGateExportReport(root, FEATURE);
	assert.equal(full.git.dirty_file_count, 3);
	assert.deepEqual(full.git.dirty_files.map((f) => f.path), ['a-file.txt', 'm-file.txt', 'z-file.txt']);
	assert.equal(full.git.dirty_files_truncated, false);

	const capped = buildGateExportReport(root, FEATURE, { dirtyCap: 1 });
	assert.equal(capped.git.dirty_file_count, 3);
	assert.equal(capped.git.dirty_files.length, 1);
	assert.equal(capped.git.dirty_files[0].path, 'a-file.txt');
	assert.equal(capped.git.dirty_files_truncated, true);
});

test('two buildGateExportReport calls with the same injected `now` on an unchanged repo produce byte-identical canonicalize() output', async () => {
	const { canonicalize } = await import('../lib/attest.mjs');
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const now = new Date('2026-01-01T00:00:00.000Z');
	const a = canonicalize(buildGateExportReport(root, FEATURE, { now }));
	const b = canonicalize(buildGateExportReport(root, FEATURE, { now }));
	assert.equal(a, b);
});

test('a report built after contract emit + handles emit validates against schemas/gate-export.schema.json', () => {
	const root = buildTwoFeatureFixtureRepo();
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);
	assert.equal(run(['scan', 'cross-feature-check', '--feature', FEATURE], root).code, 0);
	const emit = run(['handles', 'emit', '--feature', FEATURE, '--json'], root);
	assert.equal(emit.code, 0, emit.stderr);
	const report = buildGateExportReport(root, FEATURE);
	assert.equal(report.schema, 'sbf.gate-export/4');
	const { ok, errors } = validateAgainstSchema('gate-export.schema.json', report);
	assert.equal(ok, true, formatSchemaErrors(errors).join('; '));
});
