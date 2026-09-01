// A4 (D-db-schema-plane): computeDbDrift() unit tests + runScan()'s dbSchema wiring + the CLI's
// own error paths (unset --database-url-env, --db alone never attempting a connection). Plane C's
// real live-database behavior is proven separately by scripts/db-introspect-smoke.mjs (a real
// Postgres, not mocked) -- see DECISIONS.md D-db-schema-plane for why that lives outside the
// default `npm test` gate, matching java-compile-smoke/python-import-smoke's own precedent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScan, computeDbDrift } from '../scanners/index.mjs';
import { describeConnectionError } from '../scanners/db/introspect.mjs';

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

// ---- computeDbDrift ---------------------------------------------------------------

const RELATED_MODULES = [
	{ module: 'widget', entities: [{ className: 'Widget', table: 'widgets' }] },
];

test('computeDbDrift: no findings when every live table has a matching entity and vice versa', () => {
	const findings = computeDbDrift([{ name: 'widgets' }], RELATED_MODULES);
	assert.deepEqual(findings, []);
});

test('computeDbDrift: a live table with no matching source entity is flagged', () => {
	const findings = computeDbDrift([{ name: 'widgets' }, { name: 'orphan_table' }], RELATED_MODULES);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /"orphan_table"/);
	assert.match(findings[0], /no matching source entity/);
});

test('computeDbDrift: an entity whose declared table is missing from the live DB is flagged', () => {
	const findings = computeDbDrift([], RELATED_MODULES);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /Widget/);
	assert.match(findings[0], /"widgets"/);
	assert.match(findings[0], /not found in the live DB/);
});

test('computeDbDrift: table name comparison is case-insensitive (Postgres lowercases unquoted identifiers; JPA @Table names are frequently mixed-case)', () => {
	const findings = computeDbDrift([{ name: 'widgets' }], [{ module: 'widget', entities: [{ className: 'Widget', table: 'Widgets' }] }]);
	assert.deepEqual(findings, []);
});

// ---- runScan()'s dbSchema wiring -------------------------------------------------

function minimalScanReportInputs() {
	return {
		repoRoot: '/nonexistent',
		terms: ['widget'],
	};
}

test('runScan: includeDb:false (the default) reports the original "not scanned at all" unknown, db_schema is absent', () => {
	const report = runScan(minimalScanReportInputs());
	assert.equal(report.db_schema, undefined);
	assert.ok(report.unknowns.some((u) => u.includes('DB not scanned')));
});

test('runScan: includeDb:true with dbSchema.live:null reports "not live-introspected" (Plane A ran, Plane C did not)', () => {
	const report = runScan({ ...minimalScanReportInputs(), includeDb: true, dbSchema: { migrations: { tool: 'none', files: [], tables: [] }, live: null } });
	assert.deepEqual(report.db_schema, { migrations: { tool: 'none', files: [], tables: [] }, live: null });
	assert.ok(report.unknowns.some((u) => u.includes('not live-introspected')));
	assert.ok(!report.unknowns.some((u) => u.includes('DB not scanned')), 'the --db-not-passed-at-all message must not appear once --db WAS passed');
});

test('runScan: a live schema with drift adds the drift finding to unknowns, alongside the report\'s existing unknowns machinery', () => {
	const report = runScan({
		...minimalScanReportInputs(),
		includeDb: true,
		dbSchema: { migrations: { tool: 'none', files: [], tables: [] }, live: { schema: 'public', tables: [{ name: 'orphan_table' }], schema_hash: 'abc' } },
	});
	assert.ok(report.unknowns.some((u) => u.includes('orphan_table') && u.includes('Plane C drift')));
	assert.ok(!report.unknowns.some((u) => u.includes('not live-introspected')), 'live WAS introspected here -- that message must not also appear');
});

// ---- describeConnectionError -------------------------------------------------------

test('describeConnectionError: a plain Error with a message uses it directly', () => {
	assert.equal(describeConnectionError(new Error('connection timed out')), 'connection timed out');
});

test('describeConnectionError: an AggregateError with an empty top-level message (the real Node/pg dual-stack shape, reproduced live during this item\'s own verification) falls back to the individual sub-errors', () => {
	const err = new AggregateError([new Error('connect ECONNREFUSED ::1:1'), new Error('connect ECONNREFUSED 127.0.0.1:1')], '');
	assert.equal(describeConnectionError(err), 'connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1');
});

test('describeConnectionError: no message and no .errors[] falls back to .code, then to String(err)', () => {
	const err = new Error('');
	err.code = 'ECONNREFUSED';
	assert.equal(describeConnectionError(err), 'ECONNREFUSED');
});

// ---- CLI: bskel scan --db / --database-url-env ------------------------------------

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-schema-cli-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.mkdirSync(path.join(root, 'src/main/java/com/example/app'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/main/java/com/example/app/App.java'), 'package com.example.app;\npublic class App {}\n');
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'java' }\n");
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	return root;
}

test('bskel scan --db --database-url-env <unset var>: fails BAD_ARGS before ever attempting a connection', () => {
	const root = buildFixtureRepo();
	const result = run(['scan', '--terms', 'app', '--db', '--database-url-env', 'BSKEL_TOTALLY_UNSET_VAR_XYZ'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /isn't set/);
	assert.match(result.stderr, /never read from \.env directly/);
});

test('bskel scan --db (no --database-url-env): runs Plane A only, never attempts a connection, exits 0', () => {
	const root = buildFixtureRepo();
	const result = run(['scan', '--terms', 'app', '--db', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	const { generated_at, ...restMigrations } = report.db_schema.migrations;
	assert.deepEqual({ migrations: restMigrations, live: report.db_schema.live }, { migrations: { tool: 'none', files: [], tables: [] }, live: null });
	// D-cross-feature-fk-inference (staleness/freshness token): a real ISO-8601 timestamp, not a
	// literal -- can't be part of the deepEqual above.
	assert.match(generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('bskel scan (no --db at all): db_schema is absent, byte-identical to pre-A4 behavior', () => {
	const root = buildFixtureRepo();
	const result = run(['scan', '--terms', 'app', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(Object.hasOwn(report, 'db_schema'), false);
});
