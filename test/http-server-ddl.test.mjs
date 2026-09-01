// D-ddl-apply: end-to-end tests for the new DB/patch-transaction routes gated behind
// `bskel serve --database-url-env`. No real Postgres is available to this fast, no-network suite
// (see scripts/ddl-apply-smoke.mjs for the real, CI-wired, disposable-postgres:16-container proof
// of an actual propose->approve->apply->confirm round trip) -- everything provable WITHOUT a live
// DB is covered here instead: route gating (present only when the opt-in flag was given), CORS
// withheld on every one of these routes (GET included), feature-id/transaction-id path validation,
// propose-time input validation (checked before any DB connection is ever attempted), the
// confirm-must-equal-transaction-id friction on apply, and rollback always refusing for ddl-apply
// -- the last several proven by seeding a transaction record directly via
// lib/patch-transactions.mjs (bypassing HTTP propose, which DOES need a live DB to succeed), then
// exercising the real HTTP route against it.
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, buildTwoFeatureFixtureRepo, initBothFeatures } from './_contract-fixture.mjs';
import { sha256String } from '../lib/fsutil.mjs';
import { proposeTransaction, approveTransaction, saveTransaction, loadTransaction } from '../lib/patch-transactions.mjs';

const FEATURE_ID = '001-widget-management';
const FAKE_DB_ENV = 'BSKEL_HTTP_DDL_TEST_FAKE_URL';

function startServer(root, extraArgs = [], extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--json', ...extraArgs], {
			cwd: root, env: { ...process.env, ...extraEnv },
		});
		let buffer = '';
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`server did not report readiness within 5s (stdout so far: ${JSON.stringify(buffer)})`));
		}, 5000);
		child.stdout.on('data', (chunk) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex === -1) return;
			clearTimeout(timeout);
			const line = buffer.slice(0, newlineIndex);
			try {
				resolve({ child, ...JSON.parse(line) });
			} catch (err) {
				reject(new Error(`could not parse server startup line ${JSON.stringify(line)}: ${err.message}`));
			}
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code !== null && code !== 0) reject(new Error(`server process exited early with code ${code}`));
		});
	});
}

function stopServer(child) {
	return new Promise((resolve) => {
		child.once('exit', resolve);
		child.kill('SIGTERM');
	});
}

async function withDbServer(root, fn) {
	const { child, listening } = await startServer(root, ['--database-url-env', FAKE_DB_ENV], { [FAKE_DB_ENV]: 'postgres://127.0.0.1:1/does-not-exist' });
	try {
		await fn(listening);
	} finally {
		await stopServer(child);
	}
}

async function withPlainServer(root, fn) {
	const { child, listening } = await startServer(root);
	try {
		await fn(listening);
	} finally {
		await stopServer(child);
	}
}

function fakeDdlPlan(schemaHash, sqlText, expectedTables = []) {
	return {
		target: { database_url_env: FAKE_DB_ENV, schema: 'public', sql_text: sqlText },
		preimage: { region_hash: schemaHash, file_hash: sha256String(schemaHash) },
		current_value: `schema_hash ${schemaHash.slice(0, 12)}...`,
		proposed_value: sqlText,
		postcondition: { kind: 'db-schema-diff', schema: 'public', expected_tables: expectedTables },
		originalContent: schemaHash,
		renderedContent: sqlText,
	};
}

test('a plain `bskel serve` (no --database-url-env) never exposes any DB route -- 404, not 403', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withPlainServer(root, async (base) => {
		const res = await fetch(`${base}/api/db/schema`);
		assert.equal(res.status, 404);
		const listRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions`);
		assert.equal(listRes.status, 404);
	});
});

test('GET /api/features/:id/patch-transactions works without ever touching the DB (pure fs read)', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions`);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(body.transactions, []);
	});
});

test('CORS: withheld on DB routes even for GET -- a deliberate deviation from the plain-GET convention', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const listRes = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions`);
		assert.equal(listRes.headers.get('access-control-allow-origin'), null);
		const schemaRes = await fetch(`${base}/api/db/schema`);
		assert.equal(schemaRes.headers.get('access-control-allow-origin'), null);
	});
});

test('OPTIONS preflight on a DB route never grants Access-Control-Allow-Origin, even though /api/... normally does', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/db/schema`, { method: 'OPTIONS' });
		assert.equal(res.status, 204);
		assert.equal(res.headers.get('access-control-allow-origin'), null);
	});
});

test('GET /api/db/schema attempts a real connection and fails cleanly (no hang, no crash) against an unreachable DB', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/db/schema`);
		assert.notEqual(res.status, 200);
		const body = await res.json();
		assert.match(body.error, /could not introspect the live database/);
	});
});

test('POST propose --kind config-apply requires {choice, target}, checked before any DB connection', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/propose`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'config-apply' }),
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /requires \{choice, target\}/);
	});
});

test('POST propose --kind ddl-apply requires {databaseUrlEnv, sqlText}, checked before any DB connection', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/propose`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'ddl-apply' }),
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /requires \{databaseUrlEnv, sqlText\}/);
	});
});

test('POST propose with an unknown kind is refused, naming known kinds', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/propose`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'nonsense' }),
		});
		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error, /unknown kind "nonsense"/);
	});
});

test('a malformed transaction id in the action URL is rejected with 400, never reaching a filesystem/schema lookup', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${encodeURIComponent('../../etc')}/approve`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
		});
		assert.equal(res.status, 400);
	});
});

test('an unknown (but well-formed) transaction id returns 404', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/pt-00000000-0000-0000-0000-000000000000/approve`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
		});
		assert.equal(res.status, 404);
	});
});

test('approve without {reason} is refused', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const plan = fakeDdlPlan(sha256String('empty schema'), 'CREATE TABLE widgets (id uuid PRIMARY KEY);', [{ name: 'widgets', expect: 'present' }]);
	const proposed = proposeTransaction(root, FEATURE_ID, 'ddl-apply', plan, { database_url_env: FAKE_DB_ENV, schema: 'public' });
	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${proposed.transaction_id}/approve`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /requires \{reason\}/);
	});
});

test('apply for a ddl-apply transaction requires {confirm} to exactly equal the transaction id -- checked before any DB connection', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const plan = fakeDdlPlan(sha256String('empty schema'), 'CREATE TABLE widgets (id uuid PRIMARY KEY);', [{ name: 'widgets', expect: 'present' }]);
	const proposed = proposeTransaction(root, FEATURE_ID, 'ddl-apply', plan, { database_url_env: FAKE_DB_ENV, schema: 'public' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'looks fine', plan);

	await withDbServer(root, async (base) => {
		// preflight is required for apply -- run it first so the confirm-mismatch check (which fires
		// BEFORE the preflight check) is what's actually being isolated here.
		const noConfirm = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${proposed.transaction_id}/apply`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
		});
		assert.equal(noConfirm.status, 400);
		assert.match((await noConfirm.json()).error, /requires \{confirm\}/);

		const wrongConfirm = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${proposed.transaction_id}/apply`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'not-the-right-id' }),
		});
		assert.equal(wrongConfirm.status, 400);
	});
	// the transaction must still be exactly 'approved' -- a refused confirm check must never advance status
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'approved');
});

test('rollback of a ddl-apply transaction always refuses, over HTTP, naming the real mitigation', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const schemaHash = sha256String('some schema state');
	const plan = fakeDdlPlan(schemaHash, 'CREATE TABLE widgets (id uuid PRIMARY KEY);', [{ name: 'widgets', expect: 'present' }]);
	const proposed = proposeTransaction(root, FEATURE_ID, 'ddl-apply', plan, { database_url_env: FAKE_DB_ENV, schema: 'public' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'looks fine', plan);
	// Seed status:'applied' directly (bypassing the real, DB-requiring applyTransaction()) -- the
	// rollback route's refusal is purely a function of txn.kind, proven identically either way.
	const txn = loadTransaction(root, FEATURE_ID, proposed.transaction_id);
	txn.apply = { at: new Date().toISOString(), postimage_schema_hash: sha256String('new schema state'), executed_statements: ['CREATE TABLE widgets (id uuid PRIMARY KEY)'] };
	txn.status = 'applied';
	saveTransaction(root, FEATURE_ID, txn);

	await withDbServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${FEATURE_ID}/patch-transactions/${proposed.transaction_id}/rollback`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'undo' }),
		});
		assert.equal(res.status, 500);
		const body = await res.json();
		assert.match(body.error, /rollback is not supported for kind "ddl-apply"/);
	});
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'applied', 'a refused rollback must not silently advance the status');
});
