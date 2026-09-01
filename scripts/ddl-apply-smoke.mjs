#!/usr/bin/env node
// D-ddl-apply: the first automated, real-Postgres proof of the `ddl-apply` patch-transaction kind
// -- a real CLI propose->approve->apply sequence, independently re-verified via a raw `pg.Client`
// query (never trusting the tool's own report), a real TOCTOU race, a real rollback refusal, a
// real --confirm-mismatch refusal, a real CONCURRENTLY refusal at propose time, and the identical
// apply sequence again over a real HTTP round trip against `bskel serve --database-url-env`.
//
// Same dedicated-job shape as scripts/db-introspect-smoke.mjs -- a real, service-touching check
// kept out of the fast `test` job's default `npm test` path (see .github/workflows/ci.yml's
// ddl-apply job, which provides its own disposable `postgres:16` service container, a separate
// database name from db-introspect's own, so the two jobs never collide even if ever run in
// parallel).
//
// Requires `BSKEL_TEST_DATABASE_URL` in the environment, pointing at a real (throwaway) Postgres
// this script is free to create/drop tables in -- never read from `.env`, matching this whole
// feature's own `--database-url-env`-not-`.env` design.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
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
	console.error(`ddl-apply-smoke: FAIL -- ${message}`);
	process.exit(1);
}

function ok(message) {
	console.log(`ddl-apply-smoke: ${message}`);
}

async function liveTableExists(connectionString, name) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		const res = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', ['public', name]);
		return res.rows.length > 0;
	} finally {
		await client.end();
	}
}

async function rawQuery(connectionString, sql, params = []) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		return await client.query(sql, params);
	} finally {
		await client.end();
	}
}

function writeSqlFile(scratch, name, sql) {
	const p = path.join(scratch, name);
	fs.writeFileSync(p, sql);
	return p;
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}

console.log('ddl-apply-smoke: cleaning any leftover tables from a prior run...');
await rawQuery(connectionString, 'DROP TABLE IF EXISTS widgets, gadgets, unrelated_race_table, index_target');
await rawQuery(connectionString, 'DROP SCHEMA IF EXISTS smoke_test_schema');

console.log('ddl-apply-smoke: setting up a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-ddl-apply-smoke-'));
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n');
sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
fs.writeFileSync(path.join(scratch, 'README.md'), '# scratch\n');
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: ddl-apply-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-ddl-apply-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);
r = bskel(['feature', 'init', '--slug', 'widget-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

// --- CLI path -----------------------------------------------------------------------------

console.log('ddl-apply-smoke: propose refuses CREATE INDEX CONCURRENTLY at propose time (before any write connection opens)...');
const concurrentlySql = writeSqlFile(scratch, 'concurrently.sql', 'CREATE INDEX CONCURRENTLY idx_x ON widgets (id);');
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', concurrentlySql, '--json'], scratch);
if (r.code === 0) fail('expected propose to refuse a CONCURRENTLY statement, but it succeeded');
ok('PASS -- CONCURRENTLY refused at propose time');

console.log('ddl-apply-smoke: propose+approve a widgets-creation transaction (TXN A), then mutate the live schema before apply to prove the TOCTOU re-check...');
const widgetsSql = writeSqlFile(scratch, 'widgets.sql', 'CREATE TABLE widgets (id uuid PRIMARY KEY, name text NOT NULL);');
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', widgetsSql, '--json'], scratch);
if (r.code !== 0) fail(`propose (TXN A): ${r.stderr || r.stdout}`);
const txnA = JSON.parse(r.stdout);

r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--reason', 'smoke test', '--json'], scratch);
if (r.code !== 0) fail(`approve (TXN A): ${r.stderr || r.stdout}`);

await rawQuery(connectionString, 'CREATE TABLE unrelated_race_table (id uuid)');

r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--confirm', txnA.transaction_id, '--json'], scratch);
if (r.code === 0) fail('expected apply (TXN A) to refuse due to the live schema changing since approve, but it succeeded');
if (!/has changed since it was proposed/.test(r.stderr)) fail(`expected a staleness message, got: ${r.stderr}`);
if (await liveTableExists(connectionString, 'widgets')) fail('a refused apply must never have created the table');
ok('PASS -- a real TOCTOU race (live schema mutated between approve and apply) correctly refused the apply, before any DDL ran');

console.log('ddl-apply-smoke: a fresh transaction (TXN B) -- --confirm requirement, then a real successful apply...');
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', widgetsSql, '--json'], scratch);
if (r.code !== 0) fail(`propose (TXN B): ${r.stderr || r.stdout}`);
const txnB = JSON.parse(r.stdout);
r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--reason', 'smoke test', '--json'], scratch);
if (r.code !== 0) fail(`approve (TXN B): ${r.stderr || r.stdout}`);

r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--json'], scratch);
if (r.code === 0) fail('expected apply (TXN B) without --confirm to be refused, but it succeeded');
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--confirm', 'not-the-right-id', '--json'], scratch);
if (r.code === 0) fail('expected apply (TXN B) with a WRONG --confirm to be refused, but it succeeded');
ok('PASS -- apply refused without a matching --confirm');

r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--confirm', txnB.transaction_id, '--json'], scratch);
if (r.code !== 0) fail(`apply (TXN B, correct --confirm): ${r.stderr || r.stdout}`);
if (!(await liveTableExists(connectionString, 'widgets'))) fail('expected the widgets table to exist live after a successful apply -- independently re-verified via a raw pg.Client, not trusting the tool\'s own report');
ok('PASS -- a real DDL apply genuinely created the table, independently re-verified');

console.log('ddl-apply-smoke: rollback of an applied ddl-apply transaction always refuses...');
r = bskel(['patch', 'rollback', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--reason', 'undo', '--json'], scratch);
if (r.code === 0) fail('expected rollback of an applied ddl-apply transaction to be refused, but it succeeded');
if (!/rollback is not supported for kind "ddl-apply"/.test(r.stderr)) fail(`expected the real refusal message, got: ${r.stderr}`);
ok('PASS -- rollback correctly refused, naming the real mitigation');

console.log('ddl-apply-smoke: a DROP TABLE transaction (TXN D) requires retyping the dropped table name, not the transaction id...');
const dropWidgetsSql = writeSqlFile(scratch, 'drop-widgets.sql', 'DROP TABLE widgets;');
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', dropWidgetsSql, '--json'], scratch);
if (r.code !== 0) fail(`propose (TXN D): ${r.stderr || r.stdout}`);
const txnD = JSON.parse(r.stdout);
r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnD.transaction_id, '--reason', 'smoke test', '--json'], scratch);
if (r.code !== 0) fail(`approve (TXN D): ${r.stderr || r.stdout}`);

r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnD.transaction_id, '--confirm', txnD.transaction_id, '--json'], scratch);
if (r.code === 0) fail('expected apply (TXN D) confirmed with the TRANSACTION ID to be refused -- a DROP TABLE now requires the table name instead, but it succeeded');
ok('PASS -- the transaction id is no longer accepted as --confirm for a DROP TABLE transaction');

r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnD.transaction_id, '--confirm', 'widgets', '--json'], scratch);
if (r.code !== 0) fail(`apply (TXN D, correct table-name --confirm): ${r.stderr || r.stdout}`);
if (await liveTableExists(connectionString, 'widgets')) fail('expected the widgets table to no longer exist live after a real DROP TABLE apply');
ok('PASS -- a real DROP TABLE apply, confirmed by retyping the exact table name, genuinely dropped the table');

console.log('ddl-apply-smoke: fine-grained INDEX/SCHEMA postcondition checks (TXN E, TXN F)...');
const createIndexTargetSql = writeSqlFile(scratch, 'index-target.sql', 'CREATE TABLE index_target (id uuid PRIMARY KEY, name text);');
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', createIndexTargetSql, '--json'], scratch);
if (r.code !== 0) fail(`propose (TXN E): ${r.stderr || r.stdout}`);
const txnE = JSON.parse(r.stdout);
r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnE.transaction_id, '--reason', 'smoke test', '--json'], scratch);
if (r.code !== 0) fail(`approve (TXN E): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnE.transaction_id, '--confirm', txnE.transaction_id, '--json'], scratch);
if (r.code !== 0) fail(`apply (TXN E): ${r.stderr || r.stdout}`);

const indexAndSchemaSql = writeSqlFile(
	scratch, 'index-and-schema.sql',
	'CREATE INDEX idx_index_target_name ON index_target (name); CREATE SCHEMA smoke_test_schema;',
);
r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'ddl-apply', '--database-url-env', DB_URL_ENV_NAME, '--sql-file', indexAndSchemaSql, '--json'], scratch);
if (r.code !== 0) fail(`propose (TXN F): ${r.stderr || r.stdout}`);
const txnF = JSON.parse(r.stdout);
if (JSON.stringify(txnF.postcondition.expected_indexes) !== JSON.stringify([{ name: 'idx_index_target_name', expect: 'present' }])) {
	fail(`expected TXN F's postcondition.expected_indexes to name idx_index_target_name, got: ${JSON.stringify(txnF.postcondition.expected_indexes)}`);
}
if (JSON.stringify(txnF.postcondition.expected_schemas) !== JSON.stringify([{ name: 'smoke_test_schema', expect: 'present' }])) {
	fail(`expected TXN F's postcondition.expected_schemas to name smoke_test_schema, got: ${JSON.stringify(txnF.postcondition.expected_schemas)}`);
}
r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnF.transaction_id, '--reason', 'smoke test', '--json'], scratch);
if (r.code !== 0) fail(`approve (TXN F): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnF.transaction_id, '--confirm', txnF.transaction_id, '--json'], scratch);
if (r.code !== 0) fail(`apply (TXN F): ${r.stderr || r.stdout}`);

const liveIndexes = (await rawQuery(connectionString, "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_index_target_name'")).rows;
if (liveIndexes.length !== 1) fail(`expected idx_index_target_name to exist live after apply -- independently re-verified via a raw pg.Client, got: ${JSON.stringify(liveIndexes)}`);
const liveSchemas = (await rawQuery(connectionString, "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'smoke_test_schema'")).rows;
if (liveSchemas.length !== 1) fail(`expected smoke_test_schema to exist live after apply -- independently re-verified via a raw pg.Client, got: ${JSON.stringify(liveSchemas)}`);
ok('PASS -- a real CREATE INDEX + CREATE SCHEMA apply was verified against a live re-introspection, not just the coarser schema-hash-changed check, and independently re-confirmed via a raw pg.Client');

// --- HTTP path ------------------------------------------------------------------------------

console.log('ddl-apply-smoke: the identical propose->approve->apply sequence again, over a real HTTP round trip against `bskel serve`...');
const server = spawn('node', [CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--database-url-env', DB_URL_ENV_NAME, '--json'], { cwd: scratch, env: process.env });
const base = await new Promise((resolve, reject) => {
	let buffer = '';
	const timeout = setTimeout(() => { server.kill('SIGKILL'); reject(new Error('server did not report readiness within 5s')); }, 5000);
	server.stdout.on('data', (chunk) => {
		buffer += chunk.toString();
		const newlineIndex = buffer.indexOf('\n');
		if (newlineIndex === -1) return;
		clearTimeout(timeout);
		resolve(JSON.parse(buffer.slice(0, newlineIndex)).listening);
	});
	server.on('error', reject);
});

try {
	const gadgetsSql = 'CREATE TABLE gadgets (id uuid PRIMARY KEY);';
	const proposeRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/propose`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ kind: 'ddl-apply', databaseUrlEnv: DB_URL_ENV_NAME, schema: 'public', sqlText: gadgetsSql }),
	});
	if (proposeRes.status !== 201) fail(`HTTP propose: expected 201, got ${proposeRes.status}: ${await proposeRes.text()}`);
	const txnC = await proposeRes.json();

	const approveRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${txnC.transaction_id}/approve`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'http smoke test' }),
	});
	if (approveRes.status !== 200) fail(`HTTP approve: expected 200, got ${approveRes.status}: ${await approveRes.text()}`);

	const wrongConfirmRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${txnC.transaction_id}/apply`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'wrong' }),
	});
	if (wrongConfirmRes.status !== 400) fail(`HTTP apply with wrong confirm: expected 400, got ${wrongConfirmRes.status}`);

	const applyRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${txnC.transaction_id}/apply`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: txnC.transaction_id }),
	});
	if (applyRes.status !== 200) fail(`HTTP apply: expected 200, got ${applyRes.status}: ${await applyRes.text()}`);
	if (!(await liveTableExists(connectionString, 'gadgets'))) fail('expected the gadgets table to exist live after a successful HTTP apply -- independently re-verified');

	const schemaRes = await fetch(`${base}/api/db/schema`);
	if (schemaRes.status !== 200) fail(`HTTP GET /api/db/schema: expected 200, got ${schemaRes.status}`);
	const liveSchema = await schemaRes.json();
	if (!liveSchema.tables.some((t) => t.name === 'gadgets')) fail(`expected /api/db/schema to report the live gadgets table, got: ${JSON.stringify(liveSchema.tables.map((t) => t.name))}`);

	if (schemaRes.headers.get('access-control-allow-origin') !== null) fail('expected NO Access-Control-Allow-Origin on a DB route, even for GET');

	ok('PASS -- the full propose->approve->confirm->apply sequence works over a real HTTP round trip, and /api/db/schema reflects the real live change');
} finally {
	server.kill('SIGTERM');
	await new Promise((resolve) => server.once('exit', resolve));
}

console.log('ddl-apply-smoke: ALL CHECKS PASSED.');

console.log('ddl-apply-smoke: cleaning up...');
await rawQuery(connectionString, 'DROP TABLE IF EXISTS widgets, gadgets, unrelated_race_table, index_target');
await rawQuery(connectionString, 'DROP SCHEMA IF EXISTS smoke_test_schema');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
