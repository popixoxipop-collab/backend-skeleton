// D-pattern-accrual: a database the USER owns for THEIR OWN past `bskel new` invocations --
// never bskel's own repo state, never a shared/external source (see D-pattern-accrual's own WHY
// for the line this draws against `.bskel/config.yml`'s standing refusal). Reuses A4/D-db-schema-plane's
// own `pg`/connection conventions unchanged: one `pg.Client`, sequential queries, `BEGIN TRANSACTION
// READ ONLY` on every read path (structural defense-in-depth, same as scanners/db/introspect.mjs and
// handles/audit.mjs). The one write path here (recordPattern) is a plain INSERT, no transaction
// needed for a single statement.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

const { Client } = pg;

// Postgres error code for "relation does not exist" -- the real, expected shape when
// patterns/schema.sql was never applied to this database (D-migration-scope: bskel never applies
// it automatically). Byte-identical convention to handles/audit.mjs's own isMissingHandleTables.
const UNDEFINED_TABLE = '42P01';

export function isMissingPatternTable(err) {
	return err?.code === UNDEFINED_TABLE;
}

function rowToRecord(row) {
	return {
		schema: 'sbf.pattern/1',
		pattern_id: row.pattern_id,
		stack: row.stack,
		params: row.params,
		recorded_at: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
	};
}

function validateRecord(record) {
	const { ok, errors } = validateAgainstSchema('pattern-record.schema.json', record);
	if (!ok) {
		throw new Error(`refusing to write invalid pattern record:\n${formatSchemaErrors(errors).join('\n')}`);
	}
}

// `params` here is already the raw, user-typed CLI flag values for whatever
// `new/index.mjs`'s reusableParamsFor(stack) names -- the caller (cmdNew) owns filtering down to
// that set; this function only validates the resulting record's shape and writes it. Best-effort
// from the CALLER's perspective (bin/bskel.mjs never lets a failure here fail `bskel new` itself) --
// this function itself throws on any real failure, same as every other patterns/store.mjs function.
export async function recordPattern({ connectionString, stack, params }) {
	const record = {
		schema: 'sbf.pattern/1',
		pattern_id: randomUUID(),
		stack,
		params,
		recorded_at: new Date().toISOString(),
	};
	validateRecord(record);
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query(
			'INSERT INTO sbf_pattern (pattern_id, stack, params, recorded_at) VALUES ($1, $2, $3, $4)',
			[record.pattern_id, record.stack, JSON.stringify(record.params), record.recorded_at],
		);
	} finally {
		await client.end();
	}
	return record;
}

export async function listPatterns({ connectionString, stack = null }) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		const sql = stack
			? 'SELECT pattern_id, stack, params, recorded_at FROM sbf_pattern WHERE stack = $1 ORDER BY recorded_at DESC'
			: 'SELECT pattern_id, stack, params, recorded_at FROM sbf_pattern ORDER BY recorded_at DESC';
		const res = await client.query(sql, stack ? [stack] : []);
		await client.query('COMMIT');
		return res.rows.map(rowToRecord);
	} finally {
		await client.end();
	}
}

export async function getPattern({ connectionString, patternId }) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		const res = await client.query(
			'SELECT pattern_id, stack, params, recorded_at FROM sbf_pattern WHERE pattern_id = $1',
			[patternId],
		);
		await client.query('COMMIT');
		return res.rows.length > 0 ? rowToRecord(res.rows[0]) : null;
	} finally {
		await client.end();
	}
}

// Pure -- no DB access, unit-testable directly (test/pattern-store.test.mjs). For each name in
// `reusableParams`, ranks every distinct value actually seen across `records` by how many records
// carried it, denominator always `records.length` (the full recorded-run count for this stack,
// NOT just the runs that happened to set this particular param -- an omitted param is real
// information, not missing data). Never collapses to one "best" value -- see D-pattern-accrual's
// WHY for the confidence-label posture this mirrors (D-cross-feature-collision).
export function summarizePatternFrequency(records, reusableParams) {
	const total = records.length;
	const summary = [];
	for (const param of reusableParams) {
		const counts = new Map();
		for (const record of records) {
			const value = record.params[param];
			if (value == null) continue;
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
		if (counts.size === 0) continue;
		const values = [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([value, count]) => ({ value, count, total }));
		summary.push({ param, values });
	}
	return summary;
}
