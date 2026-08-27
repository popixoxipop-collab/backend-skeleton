// O7/B2 (D-handle-audit-report): live query over `sbf_handle`/`sbf_handle_snapshot` -- the tables
// O4's `HandleService.recordSnapshot`/`@RecordHandleSnapshot` (java-spring, python-fastapi) already
// write to, when a target app opts into recording. Both providers' migration.sql.tmpl/tables.py.tmpl
// generate the SAME table names and columns (confirmed by reading both templates directly, not
// assumed) -- one query works regardless of which provider backed a given feature.
// Reuses A4/D-db-schema-plane's own `pg`/connection conventions unchanged: `Client`, one connection,
// sequential queries, `BEGIN TRANSACTION READ ONLY` as structural defense-in-depth (this is a
// read-only report; the transaction means the DB itself refuses any write attempt, not just "we
// didn't write any queries that would").
import pg from 'pg';

const { Client } = pg;

const HANDLES_SQL_BASE = `
	SELECT
		h.handle_uid, h.kind, h.resource_type, h.resource_uid, h.pointer,
		h.operation_id, h.contract_ref, h.created_at, h.revoked_at, h.revoked_reason,
		count(s.snapshot_id)::int AS snapshot_count,
		max(s.recorded_at) AS last_recorded_at
	FROM sbf_handle h
	LEFT JOIN sbf_handle_snapshot s ON s.handle_uid = h.handle_uid
	WHERE h.feature_uid = $1`;

// `= ANY($2)` -- an array bind, not string-interpolated -- for the multi-value --resource filter,
// matching `handles plan`/`handles emit`'s own `--resource type1,type2` convention exactly (see
// bin/bskel.mjs's existing `flags.resource.split(',')...` idiom) rather than inventing a
// singular `--resource-type` flag.
const RESOURCE_FILTER_SQL = ' AND h.resource_type = ANY($2)';
const GROUP_ORDER_SQL = ' GROUP BY h.handle_uid ORDER BY h.created_at DESC';

// Postgres error code for "relation does not exist" -- the real, expected shape when a target
// app's migration.sql was never applied (D-migration-scope: bskel never applies it automatically).
const UNDEFINED_TABLE = '42P01';

export function isMissingHandleTables(err) {
	return err?.code === UNDEFINED_TABLE;
}

// `GROUP BY h.handle_uid` then selecting other `h.*` columns is valid Postgres (functional
// dependency on the grouped table's own primary key) -- verified live against a real Postgres
// (see D-handle-audit-report's verification note), not assumed from the SQL standard alone, since
// this specific form is a Postgres extension MySQL/older engines don't share.
export async function auditHandles({ connectionString, featureUid, resourceTypes }) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		const params = [featureUid];
		let sql = HANDLES_SQL_BASE;
		if (resourceTypes && resourceTypes.length > 0) {
			params.push(resourceTypes);
			sql += RESOURCE_FILTER_SQL;
		}
		sql += GROUP_ORDER_SQL;
		const res = await client.query(sql, params);
		await client.query('COMMIT');
		return res.rows.map((row) => ({
			handle_uid: row.handle_uid,
			kind: row.kind,
			resource_type: row.resource_type,
			resource_uid: row.resource_uid,
			pointer: row.pointer,
			operation_id: row.operation_id,
			contract_ref: row.contract_ref,
			created_at: row.created_at,
			revoked_at: row.revoked_at,
			revoked_reason: row.revoked_reason,
			snapshot_count: row.snapshot_count,
			last_recorded_at: row.last_recorded_at,
		}));
	} finally {
		await client.end();
	}
}

export function summarizeAudit(rows) {
	return {
		total_handles: rows.length,
		revoked_handles: rows.filter((r) => r.revoked_at !== null).length,
		never_snapshotted: rows.filter((r) => r.snapshot_count === 0).length,
		total_snapshots: rows.reduce((sum, r) => sum + r.snapshot_count, 0),
	};
}
