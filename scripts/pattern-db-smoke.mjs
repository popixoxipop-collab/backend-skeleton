#!/usr/bin/env node
// D-pattern-accrual: the first automated proof this feature's real database round trip works --
// reuses the EXISTING db-introspect CI job's own postgres:16 service container (own table,
// sbf_pattern, dropped/recreated here so this script never depends on that job's other tables or
// ordering) rather than standing up a dedicated job. Same `BSKEL_TEST_DATABASE_URL` convention as
// scripts/db-introspect-smoke.mjs -- never read from `.env`.
//
// Unlike db-introspect-smoke.mjs, none of `bskel new`/`bskel pattern *` need an existing git
// repo/remote -- `bskel new` creates its own throwaway repo per invocation, and the `pattern`
// commands never touch git at all -- so this script skips db-introspect-smoke.mjs's whole
// fixture-repo/bare-origin/preflight setup entirely.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const SCHEMA_SQL = path.join(REPO_ROOT, 'patterns', 'schema.sql');
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`pattern-db-smoke: FAIL -- ${message}`);
	process.exit(1);
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}

console.log('pattern-db-smoke: negative path -- `bskel pattern list` before patterns/schema.sql is applied...');
{
	const dropClient = new Client({ connectionString });
	await dropClient.connect();
	await dropClient.query('DROP TABLE IF EXISTS sbf_pattern');
	await dropClient.end();

	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-pattern-smoke-'));
	const r = bskel(['pattern', 'list', '--pattern-database-url-env', DB_URL_ENV_NAME], scratch);
	if (r.code !== 18) fail(`expected exit 18 (REFRESH_FAILED) with no sbf_pattern table, got ${r.code}: ${r.stderr}`);
	if (!r.stderr.includes('patterns/schema.sql')) fail(`expected the missing-table message to name patterns/schema.sql, got: ${r.stderr}`);
	console.log('pattern-db-smoke: negative path OK -- clean REFRESH_FAILED naming patterns/schema.sql.');
}

console.log('pattern-db-smoke: applying patterns/schema.sql (the same file a real user would run by hand)...');
{
	const client = new Client({ connectionString });
	await client.connect();
	await client.query(fs.readFileSync(SCHEMA_SQL, 'utf8'));
	await client.end();
}

console.log('pattern-db-smoke: three real `bskel new --stack fastapi --record-pattern` runs, deliberately differing params...');
const RUNS = [
	{ slug: 'proj-a', pythonVersion: '3.12', port: '9000', license: 'MIT', database: 'postgres' },
	{ slug: 'proj-b', pythonVersion: '3.12', port: '8000', license: 'MIT', database: 'sqlite' },
	{ slug: 'proj-c', pythonVersion: '3.11', port: '9000', license: 'MIT', database: 'postgres' },
];
const scratchParent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-pattern-smoke-runs-'));
for (const run of RUNS) {
	const dir = path.join(scratchParent, run.slug);
	const r = bskel([
		'new', '--stack', 'fastapi', '--slug', run.slug, '--dir', dir,
		'--python-version', run.pythonVersion, '--port', run.port, '--license', run.license, '--database', run.database,
		'--record-pattern', '--pattern-database-url-env', DB_URL_ENV_NAME,
	], scratchParent);
	if (r.code !== 0) fail(`bskel new (${run.slug}): exit ${r.code}: ${r.stderr || r.stdout}`);
	if (r.stderr && r.stderr.includes('warning: --record-pattern')) fail(`bskel new (${run.slug}) warned about recording even though the DB is reachable and schema.sql was applied: ${r.stderr}`);
	if (!fs.existsSync(path.join(dir, 'pyproject.toml'))) fail(`bskel new (${run.slug}): project was not actually scaffolded`);
}
console.log('pattern-db-smoke: all three runs scaffolded and recorded with no warning.');

console.log('pattern-db-smoke: `bskel pattern list --stack fastapi --json` returns exactly the 3 real rows...');
let listReport;
{
	const r = bskel(['pattern', 'list', '--stack', 'fastapi', '--pattern-database-url-env', DB_URL_ENV_NAME, '--json'], scratchParent);
	if (r.code !== 0) fail(`pattern list: exit ${r.code}: ${r.stderr || r.stdout}`);
	try {
		listReport = JSON.parse(r.stdout);
	} catch {
		fail(`pattern list --json produced no parseable JSON: ${r.stdout}`);
	}
}
if (listReport.records.length !== 3) fail(`expected 3 recorded rows, got ${listReport.records.length}: ${JSON.stringify(listReport)}`);
for (const rec of listReport.records) {
	if (rec.schema !== 'sbf.pattern/1') fail(`expected schema sbf.pattern/1, got ${JSON.stringify(rec.schema)}`);
	if (rec.stack !== 'fastapi') fail(`expected stack fastapi, got ${JSON.stringify(rec.stack)}`);
}
const portsRecorded = listReport.records.map((r) => r.params.port).sort();
if (JSON.stringify(portsRecorded) !== JSON.stringify(['8000', '9000', '9000'])) {
	fail(`expected recorded ports [8000, 9000, 9000], got ${JSON.stringify(portsRecorded)}`);
}
console.log('pattern-db-smoke: `pattern list` OK -- 3 real rows, correct schema/stack/params.');

console.log('pattern-db-smoke: `bskel pattern show <id>` returns the exact same record `pattern list` reported...');
{
	const target = listReport.records[0];
	const r = bskel(['pattern', 'show', target.pattern_id, '--pattern-database-url-env', DB_URL_ENV_NAME, '--json'], scratchParent);
	if (r.code !== 0) fail(`pattern show: exit ${r.code}: ${r.stderr || r.stdout}`);
	let shown;
	try {
		shown = JSON.parse(r.stdout);
	} catch {
		fail(`pattern show --json produced no parseable JSON: ${r.stdout}`);
	}
	if (JSON.stringify(shown) !== JSON.stringify(target)) {
		fail(`pattern show returned a different record than pattern list reported for the same id:\n  list: ${JSON.stringify(target)}\n  show: ${JSON.stringify(shown)}`);
	}
}
console.log('pattern-db-smoke: `pattern show` OK -- byte-identical to the row `pattern list` reported.');

console.log('pattern-db-smoke: `bskel pattern suggest --stack fastapi --json` reports correct real per-value frequencies...');
{
	const r = bskel(['pattern', 'suggest', '--stack', 'fastapi', '--pattern-database-url-env', DB_URL_ENV_NAME, '--json'], scratchParent);
	if (r.code !== 0) fail(`pattern suggest: exit ${r.code}: ${r.stderr || r.stdout}`);
	let suggestion;
	try {
		suggestion = JSON.parse(r.stdout);
	} catch {
		fail(`pattern suggest --json produced no parseable JSON: ${r.stdout}`);
	}
	if (suggestion.total_records !== 3) fail(`expected total_records 3, got ${suggestion.total_records}`);
	const byParam = Object.fromEntries(suggestion.summary.map((s) => [s.param, s.values]));

	const expect = (param, value, count, total) => {
		const top = byParam[param]?.[0];
		if (!top || top.value !== value || top.count !== count || top.total !== total) {
			fail(`expected --${param} ${value} to rank first at ${count}/${total}, got ${JSON.stringify(byParam[param])}`);
		}
	};
	expect('port', '9000', 2, 3);
	expect('python-version', '3.12', 2, 3);
	expect('database', 'postgres', 2, 3);
	expect('license', 'MIT', 3, 3);

	for (const fragment of ['--python-version 3.12', '--port 9000', '--database postgres', '--license MIT']) {
		if (!suggestion.suggested_command.includes(fragment)) {
			fail(`expected suggested_command to include "${fragment}" (the top-ranked value), got: ${suggestion.suggested_command}`);
		}
	}
}
console.log('pattern-db-smoke: `pattern suggest` OK -- real per-value frequencies match the 3 real runs exactly.');

console.log('pattern-db-smoke: PASS -- the pattern-accrual DB round trip works end-to-end against a real Postgres.');

console.log('pattern-db-smoke: cleaning up...');
const cleanupClient = new Client({ connectionString });
await cleanupClient.connect();
await cleanupClient.query('DROP TABLE IF EXISTS sbf_pattern');
await cleanupClient.end();
fs.rmSync(scratchParent, { recursive: true, force: true });
