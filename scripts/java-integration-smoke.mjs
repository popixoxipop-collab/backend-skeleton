#!/usr/bin/env node
// O4 (D-handle-lifecycle): the deepest verification this project has attempted -- proof that the
// full handle read/snapshot lifecycle (register -> real HTTP PATCH -> HandleAspect fires ->
// real HTTP GET recover) actually works against a genuinely running Spring Boot app and a real,
// disposable Postgres. Same overall shape as scripts/java-compile-smoke.mjs (full CLI pipeline
// against a scratch copy of test/fixtures/java-compile/) plus scripts/db-introspect-smoke.mjs's
// own real-Postgres wiring (BSKEL_TEST_DATABASE_URL, never .env, never a value this script
// hardcodes) -- this script combines both rather than inventing a third convention.
//
// Requires `gradle` on PATH (used once, to generate the wrapper -- CI installs it via
// gradle/actions/setup-gradle, same as java-compile-smoke.mjs) and `BSKEL_TEST_DATABASE_URL`
// pointing at a real (throwaway) Postgres this script is free to create/drop tables in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const FEATURE_ID = '001-widget-management';
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`java-integration-smoke: FAIL -- ${message}`);
	process.exit(1);
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}
const dbUrl = new URL(connectionString);
const dbName = dbUrl.pathname.replace(/^\//, '');
const dbUser = dbUrl.username || 'postgres';
const dbPassword = dbUrl.password || '';

console.log('java-integration-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-integration-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: java-integration-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-integration-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('java-integration-smoke: generating the Gradle wrapper (gradle wrapper --gradle-version 8.8)...');
try {
	sh('gradle', ['wrapper', '--gradle-version', '8.8'], scratch, { quiet: true });
} catch (err) {
	fail(`could not generate the Gradle wrapper -- is \`gradle\` on PATH? (${err.message})`);
}

console.log('java-integration-smoke: preflight -> feature init -> scan -> disposition -> contract emit -> handles patch approve -> handles emit...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'widget-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'widget'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'reuse', '--note', 'java-integration-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

r = bskel(['contract', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`contract emit: ${r.stderr || r.stdout}`);

r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'java-integration-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (label): ${r.stderr || r.stdout}`);
r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'capacity', '--strategy', 'null-means-unchanged', '--reason', 'java-integration-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (capacity): ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);

const migrationPath = path.join(scratch, 'specs', FEATURE_ID, 'handles', 'migration.sql');
if (!fs.existsSync(migrationPath)) fail(`expected ${migrationPath} to exist after handles emit`);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

console.log('java-integration-smoke: applying the REAL emitted migration.sql (not a hand-copied duplicate) + a widgets table...');
const setupClient = new Client({ connectionString });
await setupClient.connect();
await setupClient.query('drop table if exists sbf_handle_snapshot, sbf_handle, widgets cascade');
await setupClient.query(migrationSql);
// O4 (D-handle-lifecycle): matches Widget.java's own real JPA mapping exactly (id uuid PK, name
// nullable varchar) -- ddl-auto is `none` (application-test.yml) precisely so this script's own
// explicit SQL is the only thing that ever creates this table, never Hibernate.
await setupClient.query('create table widgets (id uuid primary key, name varchar(255))');
await setupClient.end();

console.log('java-integration-smoke: running the real @SpringBootTest suite (./gradlew test) against it...');
const testEnv = {
	...process.env,
	SPRING_PROFILES_ACTIVE: 'test',
	BSKEL_TEST_DB_NAME: dbName,
	BSKEL_TEST_DB_USER: dbUser,
	BSKEL_TEST_DB_PASSWORD: dbPassword,
};
try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.global.handle.HandleLifecycleIntegrationTest', '--console=plain'], scratch, { env: testEnv });
} catch (err) {
	fail(`./gradlew test failed (exit ${err.status}) -- see output above`);
}

console.log('java-integration-smoke: PASS -- the full handle lifecycle ran for real against a real Postgres (registry enforcement OFF, the default).');

// O3 (D-handle-registry-enforcement): a SEPARATE phase, not a second assertion inside the same
// test class -- ENFORCE_REGISTRY is baked in at `handles emit` time as a compile-time constant,
// not runtime-configurable, so exercising the enforced posture genuinely needs a second `handles
// emit` + recompile, not a flag flipped mid-JVM. Reuses the same scratch repo/Postgres -- the
// schema (sbf_handle/sbf_handle_snapshot/widgets) is unchanged; only HandleController.java is
// re-rendered.
console.log('java-integration-smoke: re-emitting with --enforce-registry on...');
r = bskel(['handles', 'emit', '--feature', FEATURE_ID, '--enforce-registry', 'on'], scratch);
if (r.code !== 0) fail(`handles emit --enforce-registry on: ${r.stderr || r.stdout}`);

console.log('java-integration-smoke: clearing widget/handle rows for a clean enforcement-phase run...');
const resetClient = new Client({ connectionString });
await resetClient.connect();
await resetClient.query('delete from sbf_handle_snapshot; delete from sbf_handle; delete from widgets');
await resetClient.end();

console.log('java-integration-smoke: running the real @SpringBootTest suite (./gradlew test) with registry enforcement ON...');
try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.global.handle.HandleRegistryEnforcementIntegrationTest', '--console=plain'], scratch, { env: testEnv });
} catch (err) {
	fail(`./gradlew test (enforcement ON) failed (exit ${err.status}) -- see output above`);
}

console.log('java-integration-smoke: PASS -- registry enforcement genuinely gates fetch()/patch() for real, against a real Postgres.');

console.log('java-integration-smoke: cleaning up...');
const cleanupClient = new Client({ connectionString });
await cleanupClient.connect();
await cleanupClient.query('drop table if exists sbf_handle_snapshot, sbf_handle, widgets cascade');
await cleanupClient.end();
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
