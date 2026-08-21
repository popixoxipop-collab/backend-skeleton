#!/usr/bin/env node
// A4 (D-db-schema-plane): the first automated proof that Plane C (live Postgres introspection)
// actually works against a real database -- previously verified only once, by hand, against a
// local Homebrew Postgres during this item's own development. Same dedicated-job shape as
// java-compile-smoke.mjs/python-import-smoke.mjs -- a real, service-touching check kept out of
// the fast `test` job's default `npm test` path (see .github/workflows/ci.yml's db-introspect
// job, which provides a disposable `postgres:16` service container for exactly this).
//
// Requires `BSKEL_TEST_DATABASE_URL` in the environment, pointing at a real (throwaway) Postgres
// this script is free to create/drop tables in -- never read from `.env`, matching this whole
// item's own `--database-url-env`-not-`.env` design. Reuses test/fixtures/java-compile/ (the
// SOURCE files only -- no gradle build here, this script never compiles anything) purely because
// its Widget entity already declares `@Table(name = "widgets")`, giving a real source-vs-live
// name to cross-check drift against without inventing a fourth fixture corpus.
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

function bskel(args, cwd, env = {}) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`db-introspect-smoke: FAIL -- ${message}`);
	process.exit(1);
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}

console.log('db-introspect-smoke: creating real test tables (widgets = matches the fixture entity, orphan_table = deliberately unmatched, to prove drift detection)...');
const setupClient = new Client({ connectionString });
await setupClient.connect();
await setupClient.query('DROP TABLE IF EXISTS widgets, orphan_table');
await setupClient.query('CREATE TABLE widgets (id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL)');
await setupClient.query('CREATE TABLE orphan_table (id UUID PRIMARY KEY)');
await setupClient.end();

console.log('db-introspect-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-introspect-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: db-introspect-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-introspect-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('db-introspect-smoke: preflight -> feature init -> real `bskel scan --db --database-url-env`...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'widget-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

// The env var is passed through to the CHILD `bskel` process under its OWN name
// (BSKEL_TEST_DATABASE_URL) -- exactly reproducing how a real user would export a variable and
// reference it by name via --database-url-env, never via a value this script hardcodes or reads
// from a file.
r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'widget', '--db', '--database-url-env', DB_URL_ENV_NAME, '--json'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);
let report;
try {
	report = JSON.parse(r.stdout);
} catch {
	fail(`scan --json produced no parseable JSON: ${r.stdout}`);
}

if (!report.db_schema?.live) fail(`expected report.db_schema.live to be present -- got ${JSON.stringify(report.db_schema)}`);
const liveTableNames = report.db_schema.live.tables.map((t) => t.name).sort();
if (JSON.stringify(liveTableNames) !== JSON.stringify(['orphan_table', 'widgets'])) {
	fail(`expected live tables [orphan_table, widgets], got ${JSON.stringify(liveTableNames)}`);
}
const widgetsTable = report.db_schema.live.tables.find((t) => t.name === 'widgets');
if (!widgetsTable.columns.some((c) => c.name === 'name' && c.type === 'character varying')) {
	fail(`expected widgets.name to be introspected as character varying -- got ${JSON.stringify(widgetsTable.columns)}`);
}
if (!report.unknowns.some((u) => u.includes('orphan_table') && u.includes('no matching source entity'))) {
	fail(`expected an unknowns entry naming the real drift (orphan_table has no matching entity) -- got ${JSON.stringify(report.unknowns)}`);
}

console.log('db-introspect-smoke: PASS -- Plane C introspected a real Postgres and correctly found the real drift.');

console.log('db-introspect-smoke: cleaning up...');
const cleanupClient = new Client({ connectionString });
await cleanupClient.connect();
await cleanupClient.query('DROP TABLE IF EXISTS widgets, orphan_table');
await cleanupClient.end();
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
