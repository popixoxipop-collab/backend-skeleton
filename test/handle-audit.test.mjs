// O7 (D-handle-audit-report): unit tests for the pure logic in handles/audit.mjs, plus CLI tests
// for every pre-connection guard `bskel handles audit` can hit without a live database. The real
// query (GROUP BY functional dependency, the LEFT JOIN/COUNT shape, the resource-type filter, and
// the real `42P01` "relation does not exist" error code) was verified live against a real,
// disposable Docker Postgres during this item's own development -- not re-attempted here, matching
// test/db-schema-plane.test.mjs's own established precedent (that file's `describeConnectionError`
// tests reconstruct the real error SHAPES as fixtures rather than re-opening a live connection on
// every `npm test` run). See D-handle-audit-report in DECISIONS.md for the full verification note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingHandleTables, summarizeAudit } from '../handles/audit.mjs';
import { run, CLI } from './_contract-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---- unit: isMissingHandleTables --------------------------------------------------

test('isMissingHandleTables: true for the real Postgres 42P01 "relation does not exist" code', () => {
	const err = new Error('relation "sbf_handle" does not exist');
	err.code = '42P01';
	assert.equal(isMissingHandleTables(err), true);
});

test('isMissingHandleTables: false for an unrelated Postgres error code (e.g. invalid UUID input, 22P02)', () => {
	const err = new Error('invalid input syntax for type uuid: ""');
	err.code = '22P02';
	assert.equal(isMissingHandleTables(err), false);
});

test('isMissingHandleTables: false for an error with no .code at all', () => {
	assert.equal(isMissingHandleTables(new Error('connection reset')), false);
});

// ---- unit: summarizeAudit ----------------------------------------------------------

test('summarizeAudit: counts total/revoked/never-snapshotted/total-snapshots correctly over a mixed set', () => {
	const rows = [
		{ revoked_at: null, snapshot_count: 2 },
		{ revoked_at: null, snapshot_count: 0 },
		{ revoked_at: '2026-01-01T00:00:00Z', snapshot_count: 1 },
	];
	assert.deepEqual(summarizeAudit(rows), {
		total_handles: 3,
		revoked_handles: 1,
		never_snapshotted: 1,
		total_snapshots: 3,
	});
});

test('summarizeAudit: all-zero on an empty handle set', () => {
	assert.deepEqual(summarizeAudit([]), { total_handles: 0, revoked_handles: 0, never_snapshotted: 0, total_snapshots: 0 });
});

// ---- CLI: bskel handles audit -- pre-connection guards only ------------------------

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handle-audit-cli-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handle-audit-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('bskel handles audit (no args at all): BAD_ARGS -- --feature/--database-url-env are both required', () => {
	const root = buildFixtureRepo();
	const result = run(['handles', 'audit'], root);
	assert.equal(result.code, 14);
});

test('bskel handles audit --feature <id> (no --database-url-env): BAD_ARGS before ever touching the feature file', () => {
	const root = buildFixtureRepo();
	const result = run(['handles', 'audit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 14);
});

test('an invalid --feature id is refused the same way every other feature-scoped command refuses one', () => {
	const root = buildFixtureRepo();
	const result = run(['handles', 'audit', '--feature', 'not-a-valid-id', '--database-url-env', 'BSKEL_TOTALLY_UNSET_XYZ'], root);
	assert.notEqual(result.code, 0);
});

test('a --feature id with no feature.json yet reports MISSING_ARTIFACT (exit 2), same as every other command reading loadFeatureRecord', () => {
	const root = buildFixtureRepo();
	execFileSync('node', [CLI, 'preflight'], { cwd: root });
	const result = run(['handles', 'audit', '--feature', '001-widget-management', '--database-url-env', 'BSKEL_TOTALLY_UNSET_XYZ'], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /no feature\.json/);
});

test('--database-url-env <unset var>, after the feature exists: BAD_ARGS naming the unset variable, before ever attempting a connection', () => {
	const root = buildFixtureRepo();
	execFileSync('node', [CLI, 'preflight'], { cwd: root });
	execFileSync('node', [CLI, 'feature', 'init', '--slug', 'widget-management'], { cwd: root });
	const result = run(['handles', 'audit', '--feature', '001-widget-management', '--database-url-env', 'BSKEL_TOTALLY_UNSET_XYZ'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /isn't set/);
	assert.match(result.stderr, /never read from \.env directly/);
});

test('e2e: `handles audit --help` renders its own usage and exits 0', () => {
	const root = buildFixtureRepo();
	const result = run(['handles', 'audit', '--help'], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /usage: bskel handles audit/);
});
