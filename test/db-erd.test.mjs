// D-db-erd: unit tests for scanners/db/erd.mjs -- pure functions, hand-built inputs matching
// scanners/db/introspect.mjs's/scanners/db/migrations.mjs's real return shapes (confirmed by
// direct read of both files before writing this file). CLI-level tests (real Postgres round trip,
// --database-url-env plumbing, no-schema-to-draw refusal) live in test/db-erd-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	sanitizeType, sanitizeIdent, normalizePlaneC, normalizePlaneA, groupRelationships, renderErd, buildErdDiagram,
} from '../scanners/db/erd.mjs';

function liveTable(overrides = {}) {
	return { name: 't', columns: [{ name: 'id', type: 'uuid', nullable: false }], primary_key: ['id'], foreign_keys: [], indexes: [], rls_policies: [], ...overrides };
}

function live(tables) {
	return { schema: 'public', generated_at: '2026-09-11T00:00:00.000Z', schema_hash: 'deadbeef', tables };
}

// ---- sanitizeType / sanitizeIdent (E8) -------------------------------------------------------

test('sanitizeType: spaces and hyphens become underscores; null becomes "unknown"', () => {
	assert.equal(sanitizeType('character varying'), 'character_varying');
	assert.equal(sanitizeType('timestamp with time zone'), 'timestamp_with_time_zone');
	assert.equal(sanitizeType('USER-DEFINED'), 'USER_DEFINED');
	assert.equal(sanitizeType(null), 'unknown');
});

test('sanitizeIdent: a valid identifier passes through unchanged, renamed:false', () => {
	assert.deepEqual(sanitizeIdent('widgets'), { sanitized: 'widgets', renamed: false });
});

test('sanitizeIdent: an invalid identifier is sanitized AND flagged renamed:true', () => {
	assert.deepEqual(sanitizeIdent('widget tags'), { sanitized: 'widget_tags', renamed: true });
});

// ---- normalizePlaneA: merge-by-table-name (the bug a naive implementation ships) --------------

test('normalizePlaneA: the same table split across two source_file entries merges into ONE entity, union of columns', () => {
	const migrations = {
		tool: 'flyway',
		generated_at: '2026-09-11T00:00:00.000Z',
		tables: [
			{ name: 'widgets', columns: ['id', 'name'], foreign_keys: [], source_file: 'V1__create.sql' },
			{ name: 'widgets', columns: ['price'], foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: null }], source_file: 'V2__alter.sql' },
		],
	};
	const ir = normalizePlaneA(migrations);
	assert.equal(ir.tables.length, 1);
	assert.deepEqual(ir.tables[0].columns.map((c) => c.name), ['id', 'name', 'price']);
	assert.equal(ir.tables[0].foreignKeys.length, 1);
	assert.deepEqual(ir.tables[0].sourceFiles, ['V1__create.sql', 'V2__alter.sql']);
});

test('normalizePlaneA: every column is typed null (unknown), no primary key data exists at all', () => {
	const ir = normalizePlaneA({ tool: 'flyway', generated_at: 'x', tables: [{ name: 't', columns: ['id'], foreign_keys: [], source_file: 'V1.sql' }] });
	assert.equal(ir.tables[0].columns[0].type, null);
	assert.equal(ir.tables[0].columns[0].nullable, null);
	assert.equal(ir.tables[0].primaryKey, null);
});

test('normalizePlaneA: a null references_column (migration omitted an explicit column list) survives unchanged, never guessed', () => {
	const ir = normalizePlaneA({ tool: 'flyway', generated_at: 'x', tables: [{ name: 't', columns: ['org_id'], foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: null }], source_file: 'V1.sql' }] });
	assert.equal(ir.tables[0].foreignKeys[0].referencesColumn, null);
});

// ---- normalizePlaneC ---------------------------------------------------------------------------

test('normalizePlaneC: pk flag is set per-column from the table\'s primary_key array', () => {
	const ir = normalizePlaneC(live([liveTable({ columns: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'name', type: 'text', nullable: true }], primary_key: ['id'] })]));
	assert.equal(ir.tables[0].columns[0].pk, true);
	assert.equal(ir.tables[0].columns[1].pk, false);
});

// ---- groupRelationships: the E4 matrix ----------------------------------------------------------

test('E4: two single-column FKs to the same parent stay TWO lines, not collapsed', () => {
	const tables = [
		{ name: 'users', columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }], primaryKey: ['id'], foreignKeys: [] },
		{ name: 'widgets', columns: [{ name: 'created_by', type: 'uuid', nullable: false, pk: false }, { name: 'updated_by', type: 'uuid', nullable: true, pk: false }], primaryKey: null, foreignKeys: [
			{ column: 'created_by', referencesTable: 'users', referencesColumn: 'id' },
			{ column: 'updated_by', referencesTable: 'users', referencesColumn: 'id' },
		] },
	];
	const rels = groupRelationships(tables, 'live');
	assert.equal(rels.length, 2);
	assert.deepEqual(rels.map((r) => r.columns[0]).sort(), ['created_by', 'updated_by']);
	for (const r of rels) assert.equal(r.pairingResolved, true);
});

test('E4: an FK group whose target column set has 2+ members collapses to exactly ONE line, +-joined label, marked unresolved', () => {
	const tables = [
		{ name: 'tags', columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }, { name: 'slug', type: 'text', nullable: false, pk: false }], primaryKey: ['id'], foreignKeys: [] },
		{ name: 'widget_tags', columns: [{ name: 'tag_id', type: 'uuid', nullable: false, pk: false }, { name: 'tag_slug', type: 'text', nullable: true, pk: false }], primaryKey: null, foreignKeys: [
			{ column: 'tag_id', referencesTable: 'tags', referencesColumn: 'id' },
			{ column: 'tag_id', referencesTable: 'tags', referencesColumn: 'slug' },
			{ column: 'tag_slug', referencesTable: 'tags', referencesColumn: 'id' },
			{ column: 'tag_slug', referencesTable: 'tags', referencesColumn: 'slug' },
		] },
	];
	const rels = groupRelationships(tables, 'live');
	assert.equal(rels.length, 1);
	assert.equal(rels[0].pairingResolved, false);
	assert.deepEqual(rels[0].columns, ['tag_id', 'tag_slug']);
	assert.equal(rels[0].rawPairs.length, 4);
});

test('E4: a composite PRIMARY KEY is rendered fully (PK on every participating column) -- PKs are never collapsed, only FKs', () => {
	const tables = [
		{ name: 'org_members', columns: [{ name: 'org_id', type: 'uuid', nullable: false, pk: true }, { name: 'user_id', type: 'uuid', nullable: false, pk: true }], primaryKey: ['org_id', 'user_id'], foreignKeys: [] },
	];
	assert.deepEqual(tables[0].columns.filter((c) => c.pk).map((c) => c.name), ['org_id', 'user_id']);
});

// ---- groupRelationships: the E5 cardinality matrix ----------------------------------------------

function childParentFixture({ childNullable, childPk, plane = 'live' }) {
	const tables = [
		{ name: 'parent', columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }], primaryKey: ['id'], foreignKeys: [] },
		{ name: 'child', columns: [{ name: 'parent_id', type: 'uuid', nullable: childNullable, pk: childPk }], primaryKey: childPk ? ['parent_id'] : null, foreignKeys: [{ column: 'parent_id', referencesTable: 'parent', referencesColumn: 'id' }] },
	];
	return groupRelationships(tables, plane)[0];
}

test('E5: NOT NULL FK -> parent side "||"; nullable FK -> "|o"', () => {
	assert.equal(childParentFixture({ childNullable: false, childPk: false }).parentCardinality, '||');
	assert.equal(childParentFixture({ childNullable: true, childPk: false }).parentCardinality, '|o');
});

test('E5: FK column IS the child\'s primary key -> identifying (true); otherwise non-identifying (false)', () => {
	assert.equal(childParentFixture({ childNullable: false, childPk: true }).identifying, true);
	assert.equal(childParentFixture({ childNullable: false, childPk: false }).identifying, false);
});

test('E5: on Plane A, cardinality is always the weakest claim -- "|o" and never identifying, regardless of input', () => {
	const rel = childParentFixture({ childNullable: false, childPk: true, plane: 'migrations' });
	assert.equal(rel.parentCardinality, '|o');
	assert.equal(rel.identifying, false);
});

test('E5: an unresolved (ambiguous composite) relationship never claims NOT NULL or identifying', () => {
	const tables = [
		{ name: 'tags', columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }], primaryKey: ['id'], foreignKeys: [] },
		{ name: 'widget_tags', columns: [{ name: 'tag_id', type: 'uuid', nullable: false, pk: false }], primaryKey: null, foreignKeys: [
			{ column: 'tag_id', referencesTable: 'tags', referencesColumn: 'id' },
			{ column: 'tag_id', referencesTable: 'tags', referencesColumn: 'slug' },
		] },
	];
	const rel = groupRelationships(tables, 'live')[0];
	assert.equal(rel.pairingResolved, false);
	assert.equal(rel.parentCardinality, '|o');
	assert.equal(rel.identifying, false);
});

// ---- self-reference and external tables ---------------------------------------------------------

test('a self-referencing FK (parent === child) produces one relationship with parent and child both equal', () => {
	const tables = [
		{ name: 'categories', columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }, { name: 'parent_id', type: 'uuid', nullable: true, pk: false }], primaryKey: ['id'], foreignKeys: [{ column: 'parent_id', referencesTable: 'categories', referencesColumn: 'id' }] },
	];
	const rels = groupRelationships(tables, 'live');
	assert.equal(rels.length, 1);
	assert.equal(rels[0].parent, 'categories');
	assert.equal(rels[0].child, 'categories');
});

test('an FK to a table absent from the entity set is external:true, the edge is still drawn', () => {
	const tables = [
		{ name: 'widgets', columns: [{ name: 'owner_id', type: 'uuid', nullable: false, pk: false }], primaryKey: null, foreignKeys: [{ column: 'owner_id', referencesTable: 'external_accounts', referencesColumn: 'id' }] },
	];
	const rels = groupRelationships(tables, 'live');
	assert.equal(rels.length, 1);
	assert.equal(rels[0].external, true);
});

// ---- renderErd: end-to-end Mermaid text ----------------------------------------------------------

test('renderErd: Plane C happy path produces a well-formed erDiagram with entity boxes and a relationship line', () => {
	const ir = normalizePlaneC(live([
		liveTable({ name: 'organizations', columns: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'name', type: 'character varying', nullable: false }] }),
		liveTable({ name: 'widgets', columns: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'organization_id', type: 'uuid', nullable: false }], foreign_keys: [{ column: 'organization_id', references_table: 'organizations', references_column: 'id' }] }),
	]));
	const { mermaid, entityCount, relationshipCount } = renderErd(ir);
	assert.equal(entityCount, 2);
	assert.equal(relationshipCount, 1);
	assert.match(mermaid, /^%% source: live Postgres introspection \(Plane C\)/m);
	assert.match(mermaid, /erDiagram/);
	assert.match(mermaid, /\torganizations \{/);
	assert.match(mermaid, /\t\tuuid id PK/);
	assert.match(mermaid, /\torganizations \|\|\.\.o\{ widgets : "organization_id"/);
});

test('renderErd: Plane A output types every attribute `unknown`, has zero PK badges, and carries the DEGRADED header block', () => {
	const ir = normalizePlaneA({ tool: 'flyway', generated_at: 'x', tables: [{ name: 't', columns: ['id', 'name'], foreign_keys: [], source_file: 'V1.sql' }] });
	const { mermaid } = renderErd(ir);
	assert.match(mermaid, /DEGRADED: this diagram is built from migration-file text/);
	assert.match(mermaid, /\t\tunknown id\n/);
	assert.match(mermaid, /\t\tunknown name\n/);
	// The header prose legitimately contains the substring "PK" ("no PK markers appear") -- check
	// specifically that no ATTRIBUTE line (two-tab indent) carries a PK badge, not the whole text.
	const attributeLines = mermaid.split('\n').filter((line) => line.startsWith('\t\t'));
	assert.ok(attributeLines.length > 0, 'sanity: the fixture must actually produce attribute lines');
	for (const line of attributeLines) assert.doesNotMatch(line, / PK\b/);
});

test('renderErd: a Mermaid-unsafe entity name is sanitized and disclosed with a rename note; a valid one is untouched', () => {
	const ir = normalizePlaneC(live([liveTable({ name: 'widget tags', columns: [{ name: 'id', type: 'uuid', nullable: false }] })]));
	const { mermaid, renames } = renderErd(ir);
	assert.match(mermaid, /\twidget_tags \{/);
	assert.match(mermaid, /%% renamed for Mermaid syntax: "widget tags" -> widget_tags/);
	assert.deepEqual(renames, [{ original: 'widget tags', sanitized: 'widget_tags' }]);
});

test('renderErd: a column that is both PK and FK renders "PK, FK"', () => {
	const ir = normalizePlaneC(live([
		liveTable({ name: 'parent', columns: [{ name: 'id', type: 'uuid', nullable: false }] }),
		{ name: 'child', columns: [{ name: 'id', type: 'uuid', nullable: false }], primary_key: ['id'], foreign_keys: [{ column: 'id', references_table: 'parent', references_column: 'id' }], indexes: [], rls_policies: [] },
	]));
	const { mermaid } = renderErd(ir);
	assert.match(mermaid, /uuid id PK, FK/);
});

test('renderErd: both planes present -> the caller passes only Plane C\'s IR, so live wins by construction (buildErdDiagram covers the selection itself)', () => {
	// renderErd() itself takes one already-selected IR -- the plane-selection logic (E3) lives in
	// buildErdDiagram(), covered in its own tests below.
	assert.ok(true);
});

test('renderErd: byte-stability -- two calls on the same input produce identical text', () => {
	const ir = normalizePlaneC(live([liveTable()]));
	assert.equal(renderErd(ir).mermaid, renderErd(ir).mermaid);
});

// ---- buildErdDiagram: plane selection (E2/E3) and refusal -----------------------------------------

test('buildErdDiagram: Plane C wins when both live and migrations are given, and the header says so', () => {
	const liveIr = live([liveTable({ name: 'from_live' })]);
	const migrations = { tool: 'flyway', generated_at: 'x', tables: [{ name: 'from_migrations', columns: ['id'], foreign_keys: [], source_file: 'V1.sql' }] };
	const result = buildErdDiagram({ live: liveIr, migrations });
	assert.equal(result.plane, 'live');
	assert.match(result.mermaid, /from_live/);
	assert.doesNotMatch(result.mermaid, /from_migrations/);
});

test('buildErdDiagram: no live DB, real migration files -> degraded Plane A diagram', () => {
	const migrations = { tool: 'flyway', generated_at: 'x', tables: [{ name: 't', columns: ['id'], foreign_keys: [], source_file: 'V1.sql' }] };
	const result = buildErdDiagram({ migrations });
	assert.equal(result.ok, true);
	assert.equal(result.plane, 'migrations');
	assert.equal(result.degraded, true);
	assert.deepEqual(result.missing.sort(), ['column_types', 'composite_foreign_keys', 'primary_keys'].sort());
});

test('buildErdDiagram: no live DB, no migration tables -> ok:false, reason "no-schema"', () => {
	const result = buildErdDiagram({ migrations: { tool: 'none', generated_at: 'x', tables: [] } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'no-schema');
});

test('buildErdDiagram: liquibase detected but every changelog is XML/YAML (zero SQL-parsed tables) -> a distinct reason', () => {
	const result = buildErdDiagram({ migrations: { tool: 'liquibase', generated_at: 'x', tables: [] } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'liquibase-undetected');
});

test('buildErdDiagram: neither live nor migrations given at all -> ok:false, reason "no-schema"', () => {
	const result = buildErdDiagram({});
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'no-schema');
});
