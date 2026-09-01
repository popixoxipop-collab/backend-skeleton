// D-ddl-apply: the "ddl-apply" kind for lib/patch-transactions.mjs -- a human-authored DDL
// statement (or `;`-separated statements) proposed, approved, and applied against a REAL live
// Postgres database. This is this project's first live-DB WRITE path, deliberately crossing
// D-migration-scope's "bskel never applies a migration automatically" boundary -- see
// DECISIONS.md's D-ddl-apply for why that boundary is judged safe to lift here specifically, and
// for why this kind's own safety story (real Postgres transaction wrapping with automatic
// rollback on postcondition failure, no automated rollback of an already-applied transaction) is
// deliberately stricter than config-apply's, given the larger blast radius.
//
// Mirrors stack/config-apply.mjs's planConfigApply() contract exactly (the same five required
// plan fields: target/preimage/postcondition/originalContent/renderedContent), reusing
// scanners/db/introspect.mjs's introspectSchema()/introspectWithClient()/describeConnectionError()
// as-is -- Plane C's read machinery, extended here to a write.
import pg from 'pg';
import { sha256String } from '../../lib/fsutil.mjs';
import { introspectSchema, introspectWithClient, describeConnectionError, listSchemaNames } from './introspect.mjs';
import { extractTablesFromSql } from './migrations.mjs';

const { Client } = pg;

export class DdlApplyPlanError extends Error {}
export class DdlApplyExecutionError extends Error {}

// Deliberately a regex allowlist, not a real SQL parser -- same "good-enough regex, not a real
// parser" restraint scanners/db/migrations.mjs's own header already names as this project's
// established restraint for SQL text.
const ALLOWED_STATEMENT_RE = /^\s*(CREATE|ALTER|DROP)\s+(TABLE|INDEX|UNIQUE\s+INDEX|SCHEMA)\b/i;
// CONCURRENTLY forms (CREATE/DROP INDEX CONCURRENTLY) are refused explicitly, HERE, at propose
// time, before any write connection ever opens -- those forms cannot run inside a transaction
// block at all (Postgres itself refuses them there). ALLOWED_STATEMENT_RE alone does NOT exclude
// them (it only anchors what the statement STARTS with, not what follows) -- found live by this
// item's own test suite, not assumed: a first draft relied on ALLOWED_STATEMENT_RE alone and
// silently accepted "CREATE INDEX CONCURRENTLY ..." as allowlisted. This second, independent check
// is the actual enforcement.
const CONCURRENTLY_RE = /\bCONCURRENTLY\b/i;
const DROP_TABLE_RE = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i;
// Fine-grained postcondition precision for INDEX/SCHEMA DDL (closing the gap D-ddl-apply's own
// EXIT list named -- these two forms previously only got the coarser "did schema_hash change at
// all" check, unlike TABLE's exact per-name verification).
const CREATE_INDEX_RE = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i;
const DROP_INDEX_RE = /^\s*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i;
const CREATE_SCHEMA_RE = /^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i;
const DROP_SCHEMA_RE = /^\s*DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i;

export function splitStatements(sqlText) {
	return sqlText.split(';').map((s) => s.trim()).filter(Boolean);
}

export function assertLooksLikeDdl(sqlText) {
	const statements = splitStatements(sqlText);
	if (statements.length === 0) {
		throw new DdlApplyPlanError('sql_text has no non-empty statements');
	}
	for (const stmt of statements) {
		if (!ALLOWED_STATEMENT_RE.test(stmt) || CONCURRENTLY_RE.test(stmt)) {
			throw new DdlApplyPlanError(
				`statement is not in the Slice 1 allowlist (CREATE/ALTER/DROP TABLE/INDEX/SCHEMA, no CONCURRENTLY): "${stmt.slice(0, 80)}${stmt.length > 80 ? '...' : ''}"`,
			);
		}
	}
	return statements;
}

function resolveConnectionString(databaseUrlEnv) {
	const connectionString = process.env[databaseUrlEnv];
	if (!connectionString) {
		throw new DdlApplyPlanError(`--database-url-env ${databaseUrlEnv} names an environment variable that isn't set -- export it first (never read from .env directly; see D-db-schema-plane in DECISIONS.md)`);
	}
	return connectionString;
}

// Classifies every table named by a DROP TABLE statement as expected to be 'absent' afterward,
// and every table named by a CREATE TABLE/ALTER TABLE ADD COLUMN statement (via Plane A's own
// extractTablesFromSql -- reused, not reimplemented) as expected to be 'present'. Other DDL forms
// (CREATE/DROP INDEX, CREATE/DROP SCHEMA, and any ALTER TABLE variant other than ADD COLUMN)
// contribute no entries here -- Slice 1 only checks their effect via the coarser
// schema-hash-changed check (see executeDdlApply below), named explicitly, not hidden.
export function classifyTableExpectations(statements) {
	const expectations = new Map();
	for (const stmt of statements) {
		const dropMatch = stmt.match(DROP_TABLE_RE);
		if (dropMatch) {
			expectations.set(dropMatch[1], 'absent');
			continue;
		}
		for (const t of extractTablesFromSql(`${stmt};`, '(ddl-apply proposal)')) {
			expectations.set(t.name, 'present');
		}
	}
	return [...expectations.entries()].map(([name, expect]) => ({ name, expect })).sort((a, b) => a.name.localeCompare(b.name));
}

// Same shape and reasoning as classifyTableExpectations(), for CREATE/DROP INDEX statements.
export function classifyIndexExpectations(statements) {
	const expectations = new Map();
	for (const stmt of statements) {
		const dropMatch = stmt.match(DROP_INDEX_RE);
		if (dropMatch) { expectations.set(dropMatch[1], 'absent'); continue; }
		const createMatch = stmt.match(CREATE_INDEX_RE);
		if (createMatch) expectations.set(createMatch[1], 'present');
	}
	return [...expectations.entries()].map(([name, expect]) => ({ name, expect })).sort((a, b) => a.name.localeCompare(b.name));
}

// Same shape and reasoning as classifyTableExpectations(), for CREATE/DROP SCHEMA statements.
export function classifySchemaExpectations(statements) {
	const expectations = new Map();
	for (const stmt of statements) {
		const dropMatch = stmt.match(DROP_SCHEMA_RE);
		if (dropMatch) { expectations.set(dropMatch[1], 'absent'); continue; }
		const createMatch = stmt.match(CREATE_SCHEMA_RE);
		if (createMatch) expectations.set(createMatch[1], 'present');
	}
	return [...expectations.entries()].map(([name, expect]) => ({ name, expect })).sort((a, b) => a.name.localeCompare(b.name));
}

// D-ddl-apply (DROP-TABLE-specific confirmation): a non-drop ddl-apply transaction keeps the
// original design (confirm = transaction id). Any transaction whose SQL drops one or more tables
// requires retyping the sorted, comma-joined dropped-table name(s) instead -- a materially
// stronger attention check than a random-looking UUID for the one statement type in the Slice 1
// allowlist that causes real, irreversible data loss. Consulted by both bin/bskel.mjs's
// cmdPatchApply and lib/http-server.mjs's apply route via lib/patch-kinds.mjs's dispatch table --
// neither hardcodes this logic itself.
export function requiredConfirmValue(txn) {
	const droppedTables = (txn.postcondition.expected_tables ?? [])
		.filter((t) => t.expect === 'absent')
		.map((t) => t.name)
		.sort();
	if (droppedTables.length > 0) return droppedTables.join(',');
	return txn.transaction_id;
}

// Planner. Mirrors planConfigApply(root, catalogEntry, targetPath)'s contract exactly. Opens a
// READ-ONLY introspection connection (introspectSchema(), unchanged) purely to compute the
// preimage -- this function itself never writes to the database; the actual DDL execution only
// ever happens inside executeDdlApply(), which lib/patch-transactions.mjs calls after its own
// TOCTOU re-check (comparing a freshly re-planned preimage against the stored one) has passed.
export async function planDdlApply(root, { databaseUrlEnv, schema = 'public', sqlText }) {
	const statements = assertLooksLikeDdl(sqlText);
	const connectionString = resolveConnectionString(databaseUrlEnv);

	let live;
	try {
		live = await introspectSchema({ connectionString, schema });
	} catch (err) {
		throw new DdlApplyPlanError(`could not introspect the live database: ${describeConnectionError(err)}`);
	}

	const originalContent = JSON.stringify(live.tables);
	return {
		target: { database_url_env: databaseUrlEnv, schema, sql_text: sqlText },
		// region_hash === file_hash today, honestly -- Slice 1 has no sub-schema "region" concept
		// for DDL (unlike config-apply's single-key-within-a-file span); both are the whole live
		// schema's own hash. See DECISIONS.md D-ddl-apply.
		preimage: { region_hash: live.schema_hash, file_hash: sha256String(originalContent) },
		current_value: `schema_hash ${live.schema_hash.slice(0, 12)}...`,
		proposed_value: sqlText,
		postcondition: {
			kind: 'db-schema-diff',
			schema,
			expected_tables: classifyTableExpectations(statements),
			expected_indexes: classifyIndexExpectations(statements),
			expected_schemas: classifySchemaExpectations(statements),
		},
		originalContent,
		renderedContent: sqlText,
	};
}

// The apply executor lib/patch-transactions.mjs's applyTransaction() calls (via lib/patch-kinds.mjs's
// injection) once its own preimage TOCTOU re-check has already passed. Opens ONE read-write
// `pg.Client`, runs every allowlisted statement inside a single real Postgres transaction,
// re-introspects using that SAME open, uncommitted transaction (introspectWithClient()) to check
// the postcondition, and COMMITs only if it holds -- ROLLBACKs (the SQL never takes effect at
// all) and throws otherwise, leaving the patch-transaction record `approved`, unchanged.
export async function executeDdlApply(root, featureId, txn, freshKindPlan) {
	const statements = splitStatements(txn.target.sql_text);
	const connectionString = resolveConnectionString(txn.target.database_url_env);
	const schema = txn.target.schema;

	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('BEGIN');
		try {
			for (const stmt of statements) {
				await client.query(stmt);
			}
			const after = await introspectWithClient(client, schema);

			if (after.schema_hash === freshKindPlan.preimage.region_hash) {
				throw new DdlApplyExecutionError('the proposed DDL executed without error, but the live schema is byte-identical to before -- refusing to report this transaction as applied when nothing observably changed (this usually means the statement(s) were already no-ops, e.g. re-running an idempotent IF NOT EXISTS against a schema that already has it)');
			}

			const liveTableNames = new Set(after.tables.map((t) => t.name));
			for (const { name, expect } of txn.postcondition.expected_tables ?? []) {
				const present = liveTableNames.has(name);
				if (expect === 'present' && !present) {
					throw new DdlApplyExecutionError(`postcondition failed: table "${name}" does not exist live after execution`);
				}
				if (expect === 'absent' && present) {
					throw new DdlApplyExecutionError(`postcondition failed: table "${name}" was targeted by a DROP TABLE statement but still exists live after execution`);
				}
			}

			const liveIndexNames = new Set(after.tables.flatMap((t) => t.indexes));
			for (const { name, expect } of txn.postcondition.expected_indexes ?? []) {
				const present = liveIndexNames.has(name);
				if (expect === 'present' && !present) {
					throw new DdlApplyExecutionError(`postcondition failed: index "${name}" does not exist live after execution`);
				}
				if (expect === 'absent' && present) {
					throw new DdlApplyExecutionError(`postcondition failed: index "${name}" was targeted by a DROP INDEX statement but still exists live after execution`);
				}
			}

			const expectedSchemas = txn.postcondition.expected_schemas ?? [];
			if (expectedSchemas.length > 0) {
				const liveSchemaNames = await listSchemaNames(client);
				for (const { name, expect } of expectedSchemas) {
					const present = liveSchemaNames.has(name);
					if (expect === 'present' && !present) {
						throw new DdlApplyExecutionError(`postcondition failed: schema "${name}" does not exist live after execution`);
					}
					if (expect === 'absent' && present) {
						throw new DdlApplyExecutionError(`postcondition failed: schema "${name}" was targeted by a DROP SCHEMA statement but still exists live after execution`);
					}
				}
			}

			await client.query('COMMIT');
			return { postimage_schema_hash: after.schema_hash, executed_statements: statements };
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {}); // best-effort -- the connection may already be unusable
			throw err;
		}
	} finally {
		await client.end();
	}
}

// D-ddl-apply: rollback of an APPLIED ddl-apply transaction is explicitly out of scope for Slice
// 1 -- there is no live-DB equivalent of config-apply's "restore exact original bytes from a
// blob" (a dropped table's rows are gone; reversing an ALTER COLUMN TYPE can lose precision), and
// auto-generating reverse DDL is itself a lossy, risky guess this project has repeatedly refused
// to ship elsewhere (patchField()'s permanent manual stub, D-config-patch's own "a wrong automatic
// edit is worse than asking a human" framing). Refuses immediately and always, naming the real
// mitigation.
export async function executeDdlRollback() {
	throw new DdlApplyExecutionError(
		'rollback is not supported for kind "ddl-apply" in Slice 1 -- propose a new forward ddl-apply transaction containing the reverse DDL instead, and run it through the same propose/approve/apply/confirm flow (see D-ddl-apply in DECISIONS.md)',
	);
}
