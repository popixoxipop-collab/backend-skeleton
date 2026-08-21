// A4 (D-db-schema-plane): Plane C -- live Postgres introspection. The one place in this whole
// tool that opens a network connection to something other than a git remote/GitHub API. Reads the
// connection string ONLY from `process.env[databaseUrlEnv]` at call time -- NEVER from `.env`
// directly (this codebase's own convention, and Team-IZ-Backend's own CLAUDE.md `.env` caution).
// `pg` is this project's first-ever SQL dependency -- confirmed no existing dependency does SQL.
import pg from 'pg';
import { sha256String } from '../../lib/fsutil.mjs';

const { Client } = pg;

// information_schema is the SQL-standard view (portable across schemas/versions); pg_indexes and
// pg_policies are Postgres-specific catalog views with no information_schema equivalent for
// indexes/RLS. All four queries are parameterized on `schemaName` -- never string-interpolated --
// even though `schemaName` here only ever comes from a CLI flag this process's own owner typed,
// not untrusted network input; parameterizing anyway costs nothing and is simply correct SQL
// hygiene, matching this project's own "parameterized queries only" global rule (CLAUDE.md §6).
const TABLES_SQL = `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`;
const COLUMNS_SQL = `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`;
const PRIMARY_KEYS_SQL = `
	SELECT tc.table_name, kcu.column_name
	FROM information_schema.table_constraints tc
	JOIN information_schema.key_column_usage kcu
		ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
	WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
	ORDER BY tc.table_name, kcu.ordinal_position`;
const FOREIGN_KEYS_SQL = `
	SELECT
		tc.table_name, kcu.column_name,
		ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
	FROM information_schema.table_constraints tc
	JOIN information_schema.key_column_usage kcu
		ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
	JOIN information_schema.constraint_column_usage ccu
		ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
	WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
	ORDER BY tc.table_name, kcu.column_name`;
const INDEXES_SQL = `SELECT tablename AS table_name, indexname AS index_name FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`;
const RLS_POLICIES_SQL = `SELECT tablename AS table_name, policyname AS policy_name FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`;

function groupByTable(rows, tableKey = 'table_name') {
	const map = new Map();
	for (const row of rows) {
		const key = row[tableKey];
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(row);
	}
	return map;
}

// A real, live-tested Node quirk (not hypothetical): a refused TCP connection surfaces as an
// `AggregateError` (dual-stack IPv6+IPv4 connection attempts, both failing) whose own top-level
// `.message` is an EMPTY STRING -- `.code` (e.g. `ECONNREFUSED`) and `.errors[]` (the individual
// per-address failures) carry the actual information. A plain `err.message` alone would surface
// nothing useful to the user here; this builds a real message from whichever shape the error is.
export function describeConnectionError(err) {
	if (err.message) return err.message;
	if (Array.isArray(err.errors) && err.errors.length > 0) {
		return err.errors.map((e) => e.message).join('; ');
	}
	return err.code ?? String(err);
}

// Entry point. `connectionString` is whatever `process.env[databaseUrlEnv]` resolved to -- the
// caller (scanners/index.mjs) owns reading that env var and failing loudly if it's unset; this
// function only ever receives an already-resolved string. `BEGIN TRANSACTION READ ONLY` is
// structural defense-in-depth -- every query here is already a SELECT, but a read-only
// transaction means the database itself refuses any write this connection could ever attempt,
// not just "we didn't write any queries that would".
export async function introspectSchema({ connectionString, schema = 'public' }) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');

		// Sequential, not Promise.all -- a single pg.Client processes one query at a time over one
		// connection; issuing several concurrently on the same client is deprecated (pg queues them
		// internally today, but warns, and that queuing behavior is going away in pg 9). A Pool
		// would allow real concurrency, but this is a one-shot CLI invocation, not a long-lived
		// server -- the simplicity of one client, one connection, sequential queries is the right
		// trade-off here, not premature optimization for concurrency nothing needs.
		const tablesRes = await client.query(TABLES_SQL, [schema]);
		const columnsRes = await client.query(COLUMNS_SQL, [schema]);
		const pkRes = await client.query(PRIMARY_KEYS_SQL, [schema]);
		const fkRes = await client.query(FOREIGN_KEYS_SQL, [schema]);
		const indexesRes = await client.query(INDEXES_SQL, [schema]);
		const policiesRes = await client.query(RLS_POLICIES_SQL, [schema]);

		await client.query('COMMIT');

		const columnsByTable = groupByTable(columnsRes.rows);
		const pkByTable = groupByTable(pkRes.rows);
		const fkByTable = groupByTable(fkRes.rows);
		const indexesByTable = groupByTable(indexesRes.rows);
		const policiesByTable = groupByTable(policiesRes.rows);

		const tables = tablesRes.rows.map(({ table_name: name }) => ({
			name,
			columns: (columnsByTable.get(name) ?? []).map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })),
			primary_key: (pkByTable.get(name) ?? []).map((r) => r.column_name),
			foreign_keys: (fkByTable.get(name) ?? []).map((r) => ({ column: r.column_name, references_table: r.foreign_table_name, references_column: r.foreign_column_name })),
			indexes: (indexesByTable.get(name) ?? []).map((r) => r.index_name),
			rls_policies: (policiesByTable.get(name) ?? []).map((r) => r.policy_name),
		}));

		return { schema, tables, schema_hash: sha256String(JSON.stringify(tables)) };
	} finally {
		await client.end();
	}
}
