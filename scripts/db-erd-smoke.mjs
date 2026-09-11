#!/usr/bin/env node
// D-db-erd: the first automated proof that E4's central assumption is actually true against a
// real Postgres -- that a composite/multi-column foreign key comes back from
// scanners/db/introspect.mjs's FOREIGN_KEYS_SQL as an unrecoverable cross product, not a real
// pairing. A hand-built fixture in test/db-erd.test.mjs can only ever confirm the RENDERER handles
// that shape correctly; it cannot prove the shape itself is what Postgres actually returns. This
// script proves both, against a real database, matching scripts/pattern-db-smoke.mjs's precedent:
// a new step in the EXISTING db-introspect CI job (own throwaway schema, so it can't collide with
// db-introspect-smoke.mjs's or pattern-db-smoke.mjs's own tables in the shared container).
//
// Requires `BSKEL_TEST_DATABASE_URL` in the environment, pointing at a real (throwaway) Postgres
// this script is free to create/drop a schema in -- never read from `.env`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { introspectSchema } from '../scanners/db/introspect.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';
const SCHEMA = 'bskel_erd_smoke';

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`db-erd-smoke: FAIL -- ${message}`);
	process.exit(1);
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop a schema in`);
}

console.log('db-erd-smoke: creating a real fixture schema -- composite PK, a genuine composite FK, two single-column FKs to the same parent, nullable/NOT NULL FKs, a self-reference...');
const setupClient = new Client({ connectionString });
await setupClient.connect();
await setupClient.query(`
	DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
	CREATE SCHEMA ${SCHEMA};

	CREATE TABLE ${SCHEMA}.users (
		id UUID PRIMARY KEY,
		name TEXT NOT NULL
	);

	-- self-reference, nullable FK -- non-identifying (parent_id is not part of categories' own PK)
	CREATE TABLE ${SCHEMA}.categories (
		id UUID PRIMARY KEY,
		parent_id UUID REFERENCES ${SCHEMA}.categories (id)
	);

	-- two single-column FKs to the SAME parent -- must stay two distinct relationship lines (E4)
	CREATE TABLE ${SCHEMA}.widgets (
		id UUID PRIMARY KEY,
		created_by UUID NOT NULL REFERENCES ${SCHEMA}.users (id),
		updated_by UUID REFERENCES ${SCHEMA}.users (id),
		price NUMERIC
	);

	-- composite PK; its FK column (user_id) IS part of the PK -- identifying relationship (E5)
	CREATE TABLE ${SCHEMA}.org_members (
		org_id UUID NOT NULL,
		user_id UUID NOT NULL REFERENCES ${SCHEMA}.users (id),
		PRIMARY KEY (org_id, user_id)
	);

	CREATE TABLE ${SCHEMA}.tags (
		tenant_id UUID NOT NULL,
		id UUID NOT NULL,
		slug TEXT NOT NULL,
		PRIMARY KEY (tenant_id, id)
	);

	-- a GENUINE composite FK -- the whole reason E4 exists. widget_id is a plain single-column FK
	-- to widgets, kept alongside the composite one so both shapes are proven in one fixture.
	CREATE TABLE ${SCHEMA}.widget_tags (
		widget_id UUID NOT NULL REFERENCES ${SCHEMA}.widgets (id),
		tenant_id UUID NOT NULL,
		tag_id UUID NOT NULL,
		FOREIGN KEY (tenant_id, tag_id) REFERENCES ${SCHEMA}.tags (tenant_id, id)
	);
`);
await setupClient.end();

console.log('db-erd-smoke: asserting on the RAW introspectSchema() output that the composite FK really does come back as an unpairable cross product...');
const raw = await introspectSchema({ connectionString, schema: SCHEMA });
const widgetTags = raw.tables.find((t) => t.name === 'widget_tags');
if (!widgetTags) fail('expected a widget_tags table in the raw introspection output');
const compositeFkRows = widgetTags.foreign_keys.filter((fk) => fk.references_table === 'tags');
// E4's whole premise: FOREIGN_KEYS_SQL's join produces ONE ROW PER (source_column, target_column)
// PAIR with no constraint_name correlation -- a genuine 2-column FK to a 2-column target therefore
// comes back as a 2x2 = 4-row cross product, INCLUDING pairs that were never declared
// (tag_id -> tenant_id, tenant_id -> id). If this ever changes (Postgres version, a future
// introspect.mjs rewrite that adds constraint_name correlation), this assertion is what catches
// it -- see E4's own EXIT in DECISIONS.md.
if (compositeFkRows.length !== 4) {
	fail(`expected the composite FK to surface as a 4-row cross product (E4's premise), got ${compositeFkRows.length} row(s): ${JSON.stringify(compositeFkRows)}`);
}
const rawPairs = new Set(compositeFkRows.map((fk) => `${fk.column}->${fk.references_column}`));
const NEVER_DECLARED_PAIR = 'tag_id->tenant_id';
if (!rawPairs.has(NEVER_DECLARED_PAIR)) {
	fail(`expected the cross product to include the NEVER-declared pair "${NEVER_DECLARED_PAIR}" (proving the raw rows are not a real pairing) -- got ${JSON.stringify([...rawPairs])}. If Postgres/introspect.mjs now correlates correctly, E4's collapse rule is still SAFE (never wrong), but its EXIT (add constraint_name correlation) is now genuinely available -- update DECISIONS.md accordingly.`);
}
console.log('db-erd-smoke: confirmed -- E4\'s premise holds against a real Postgres 16.');

console.log('db-erd-smoke: `bskel db erd --database-url-env ... --out ... --json` against the real fixture...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-erd-smoke-'));
execFileSync('git', ['init', '--quiet'], { cwd: scratch });

// E10: --json only produces a machine-readable summary alongside --out -- without --out, stdout
// IS the diagram, and --json alone is a documented no-op. --out is required here to get the JSON
// summary this script asserts against.
const jsonResult = bskel(['db', 'erd', '--database-url-env', DB_URL_ENV_NAME, '--schema', SCHEMA, '--out', 'schema.mmd', '--json'], scratch);
if (jsonResult.code !== 0) fail(`db erd --out --json: exit ${jsonResult.code}: ${jsonResult.stderr || jsonResult.stdout}`);
let summary;
try {
	summary = JSON.parse(jsonResult.stdout);
} catch {
	fail(`db erd --json produced no parseable JSON: ${jsonResult.stdout}`);
}
if (summary.schema !== 'sbf.db-erd/1') fail(`expected schema sbf.db-erd/1, got ${JSON.stringify(summary.schema)}`);
if (summary.plane !== 'live') fail(`expected plane "live", got ${JSON.stringify(summary.plane)}`);
if (summary.degraded !== false) fail(`expected degraded:false for a real live-DB diagram, got ${summary.degraded}`);
if (summary.entity_count !== 6) fail(`expected 6 entities, got ${summary.entity_count}`);
if (summary.unresolved_relationships !== 1) fail(`expected exactly 1 unresolved relationship (the composite FK), got ${summary.unresolved_relationships}`);

console.log('db-erd-smoke: `bskel db erd` (plain Mermaid text) matches every E4/E5 rendering rule...');
const mermaidResult = bskel(['db', 'erd', '--database-url-env', DB_URL_ENV_NAME, '--schema', SCHEMA], scratch);
if (mermaidResult.code !== 0) fail(`db erd: exit ${mermaidResult.code}: ${mermaidResult.stderr || mermaidResult.stdout}`);
const mermaid = mermaidResult.stdout;

const EXPECTED_LINES = [
	// E4: two single-column FKs to the same parent stay two lines.
	'\tusers ||..o{ widgets : "created_by"', // NOT NULL, non-identifying
	'\tusers |o..o{ widgets : "updated_by"', // nullable, non-identifying
	// E5: FK column IS part of the child's composite PK -- identifying.
	'\tusers ||--o{ org_members : "user_id"',
	// E4: the genuine composite FK collapses to exactly one line, +-joined, weakest cardinality claim.
	'\ttags |o..o{ widget_tags : "tag_id+tenant_id"',
	// self-reference, nullable, non-identifying.
	'\tcategories |o..o{ categories : "parent_id"',
	// a plain single-column FK alongside the composite one on the same child table.
	'\twidgets ||..o{ widget_tags : "widget_id"',
];
for (const line of EXPECTED_LINES) {
	if (!mermaid.includes(line)) fail(`expected the rendered Mermaid to contain the line ${JSON.stringify(line)} -- full output:\n${mermaid}`);
}
if (!/uuid org_id PK\n\t\tuuid user_id PK, FK/.test(mermaid)) {
	fail(`expected org_members' composite PK to render fully (both columns PK-badged, user_id also FK-badged) -- full output:\n${mermaid}`);
}

console.log('db-erd-smoke: PASS -- ERD renders every E2/E3/E4/E5/E8 rule correctly against a real Postgres.');

console.log('db-erd-smoke: cleaning up...');
const cleanupClient = new Client({ connectionString });
await cleanupClient.connect();
await cleanupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await cleanupClient.end();
fs.rmSync(scratch, { recursive: true, force: true });
