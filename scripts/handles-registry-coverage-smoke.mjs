#!/usr/bin/env node
// D-write-safety-phase1 (item 3): proof that `bskel handles audit --check-registry-coverage`
// actually answers "does the live registry have a row for this resource" against a genuinely
// running, disposable Postgres -- not a mock. Deliberately lighter than
// scripts/java-integration-smoke.mjs (no Gradle/real Spring Boot app boot): that script already
// proves HandleAspect's own real registration behavior end-to-end; this one only needs to prove
// THIS item's new cross-reference logic (plan.resources with willGenerateResolver vs. real
// sbf_handle rows), so a real migration.sql applied to a real Postgres plus direct SQL rows
// (simulating what HandleAspect would insert) is enough -- same "real DB, minimal moving parts"
// trade-off scripts/db-introspect-smoke.mjs already makes.
//
// Requires `BSKEL_TEST_DATABASE_URL` in the environment, pointing at a real (throwaway) Postgres
// this script is free to create/drop tables in -- never read from `.env`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { bskel, makeFail, establishThroughContract, REPO_ROOT } from './_smoke-lib.mjs';

const { Client } = pg;
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');
const FEATURE_ID = '001-widget-management';
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';

const fail = makeFail('handles-registry-coverage-smoke');

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}

console.log('handles-registry-coverage-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-registry-coverage-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

function git(args) { execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: 'pipe' }); }
git(['init', '--quiet', '--initial-branch=develop']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
git(['add', '-A']);
git(['commit', '--quiet', '-m', 'chore: handles-registry-coverage-smoke fixture']);
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-registry-coverage-smoke-origin-'));
execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin, stdio: 'pipe' });
execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: scratch, stdio: 'pipe' });
execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: scratch, stdio: 'pipe' });

console.log('handles-registry-coverage-smoke: preflight -> feature init -> scan -> contract -> handles emit...');
establishThroughContract(scratch, fail, {
	featureId: FEATURE_ID, slug: 'widget-management', terms: 'widget', mode: 'extend', note: 'test',
	contractStep: { kind: 'force', reason: 'no real OpenAPI oracle for this fixture' },
});

let r = bskel(['handles', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);

const featureRecord = JSON.parse(fs.readFileSync(path.join(scratch, 'specs', FEATURE_ID, 'feature.json'), 'utf8'));
const migrationSql = fs.readFileSync(path.join(scratch, 'specs', FEATURE_ID, 'handles', 'migration.sql'), 'utf8');

console.log('handles-registry-coverage-smoke: applying the real emitted migration.sql to a real Postgres...');
const client = new Client({ connectionString });
await client.connect();
await client.query('DROP TABLE IF EXISTS sbf_handle_snapshot, sbf_handle CASCADE');
await client.query(migrationSql);

console.log('handles-registry-coverage-smoke: with NO row for Widget -> expect NOT COVERED...');
let audit = bskel(['handles', 'audit', '--feature', FEATURE_ID, '--database-url-env', DB_URL_ENV_NAME, '--check-registry-coverage', '--json'], scratch);
if (audit.code !== 0) fail(`handles audit --check-registry-coverage (empty registry): ${audit.stderr || audit.stdout}`);
let report = JSON.parse(audit.stdout);
let widgetCoverage = report.registry_coverage.find((c) => c.resourceType === 'Widget');
if (!widgetCoverage) fail(`registry_coverage has no entry for Widget: ${JSON.stringify(report.registry_coverage)}`);
if (widgetCoverage.covered !== false) fail(`expected Widget NOT covered with an empty registry, got: ${JSON.stringify(widgetCoverage)}`);

console.log('handles-registry-coverage-smoke: inserting a real, non-revoked kind=r row for Widget -> expect COVERED...');
const insertedHandle = await client.query(
	`INSERT INTO sbf_handle (handle_uid, kind, resource_type, resource_uid, pointer, operation_id, contract_ref, feature_uid, created_at)
	 VALUES (gen_random_uuid(), 'r', 'Widget', gen_random_uuid(), NULL, 'findWidget', 'test-contract-ref', $1, now())
	 RETURNING handle_uid`,
	[featureRecord.feature_uid],
);
const testHandleUid = insertedHandle.rows[0].handle_uid;
audit = bskel(['handles', 'audit', '--feature', FEATURE_ID, '--database-url-env', DB_URL_ENV_NAME, '--check-registry-coverage', '--json'], scratch);
if (audit.code !== 0) fail(`handles audit --check-registry-coverage (1 row): ${audit.stderr || audit.stdout}`);
report = JSON.parse(audit.stdout);
widgetCoverage = report.registry_coverage.find((c) => c.resourceType === 'Widget');
if (widgetCoverage.covered !== true) fail(`expected Widget covered after inserting a real row, got: ${JSON.stringify(widgetCoverage)}`);

console.log('handles-registry-coverage-smoke: revoking that row -> expect NOT COVERED again...');
await client.query(`UPDATE sbf_handle SET revoked_at = now(), revoked_reason = 'smoke test' WHERE handle_uid = $1`, [testHandleUid]);
audit = bskel(['handles', 'audit', '--feature', FEATURE_ID, '--database-url-env', DB_URL_ENV_NAME, '--check-registry-coverage', '--json'], scratch);
if (audit.code !== 0) fail(`handles audit --check-registry-coverage (revoked): ${audit.stderr || audit.stdout}`);
report = JSON.parse(audit.stdout);
widgetCoverage = report.registry_coverage.find((c) => c.resourceType === 'Widget');
if (widgetCoverage.covered !== false) fail(`expected Widget NOT covered once its only row is revoked, got: ${JSON.stringify(widgetCoverage)}`);

await client.query('DROP TABLE IF EXISTS sbf_handle_snapshot, sbf_handle CASCADE');
await client.end();
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });

console.log('handles-registry-coverage-smoke: PASS');
