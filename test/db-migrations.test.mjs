// A4 (D-db-schema-plane): Plane A direct unit tests. Real files on a real temp filesystem (`rg
// --files` needs real files to find, same pattern test/handles-plan.test.mjs already uses) --
// unverifiable against the real oracle repo (Team-IZ-Backend has zero migration files, confirmed
// during this item's own grounding), so entirely fixture-driven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMigrations } from '../scanners/db/migrations.mjs';

function fixtureRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-migrations-'));
}

test('scanMigrations: a repo with no db/migration or db/changelog directory reports tool:"none" -- the common, expected case (matches the real oracle repo)', () => {
	const root = fixtureRoot();
	const result = scanMigrations(root);
	assert.deepEqual(result, { tool: 'none', files: [], tables: [] });
});

test('scanMigrations: extracts CREATE TABLE columns, skipping constraint-only lines (PRIMARY KEY/FOREIGN KEY/CHECK)', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__create_widgets.sql'), `
CREATE TABLE IF NOT EXISTS widgets (
	id UUID PRIMARY KEY,
	name VARCHAR(255) NOT NULL,
	price NUMERIC(10,2) CHECK (price > 0),
	org_id UUID,
	FOREIGN KEY (org_id) REFERENCES organizations(id)
);
`);
	const result = scanMigrations(root);
	assert.equal(result.tool, 'flyway');
	assert.equal(result.tables.length, 1);
	assert.deepEqual(result.tables[0].columns, ['id', 'name', 'org_id', 'price']);
	assert.deepEqual(result.tables[0].foreign_keys, [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }]);
});

// D-cross-feature-fk-inference (Plane A FK extraction): the 3 new FK forms, plus a negative case
// proving a plain CHECK/UNIQUE constraint is never misread as one.

test('scanMigrations: inline column-level REFERENCES, with an explicit referenced column', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__t.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY, organization_id UUID REFERENCES organizations(id));\n');
	const result = scanMigrations(root);
	assert.deepEqual(result.tables[0].foreign_keys, [{ column: 'organization_id', references_table: 'organizations', references_column: 'id' }]);
});

test('scanMigrations: a bare inline REFERENCES (referenced column omitted) leaves references_column null -- never guessed as "id"', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__t.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY, organization_id UUID REFERENCES organizations);\n');
	const result = scanMigrations(root);
	assert.deepEqual(result.tables[0].foreign_keys, [{ column: 'organization_id', references_table: 'organizations', references_column: null }]);
});

test('scanMigrations: ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY, a common Flyway later-migration pattern, is recorded against the constrained table', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__t.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY, organization_id UUID);\n');
	fs.writeFileSync(path.join(dir, 'V2__fk.sql'), 'ALTER TABLE widgets ADD CONSTRAINT fk_widgets_org FOREIGN KEY (organization_id) REFERENCES organizations (id);\n');
	const result = scanMigrations(root);
	const v2Table = result.tables.find((t) => t.source_file.endsWith('V2__fk.sql'));
	assert.deepEqual(v2Table.foreign_keys, [{ column: 'organization_id', references_table: 'organizations', references_column: 'id' }]);
});

test('scanMigrations: a plain CHECK/UNIQUE constraint is never misread as a foreign key', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__t.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY, price NUMERIC(10,2) CHECK (price > 0), UNIQUE (id));\n');
	const result = scanMigrations(root);
	assert.deepEqual(result.tables[0].foreign_keys, []);
});

test('scanMigrations: ALTER TABLE ADD COLUMN is recorded against the same table name', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__create_widgets.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY);\n');
	fs.writeFileSync(path.join(dir, 'V2__add_status.sql'), "ALTER TABLE widgets ADD COLUMN status VARCHAR(32) DEFAULT 'active';\n");
	const result = scanMigrations(root);
	const tableNames = result.tables.map((t) => t.name);
	assert.deepEqual(tableNames, ['widgets', 'widgets'], 'one entry per migration file, not silently merged (a real DROP/RENAME COLUMN would corrupt a merged view this module never attempts)');
	assert.deepEqual(result.tables[1].columns, ['status']);
});

test('scanMigrations: VARCHAR(255)/NUMERIC(10,2)\'s own parens are never mistaken for the column-list\'s closing paren', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__t.sql'), 'CREATE TABLE t (a VARCHAR(255), b NUMERIC(10,2));\n');
	const result = scanMigrations(root);
	assert.deepEqual(result.tables[0].columns, ['a', 'b']);
});

test('scanMigrations: Liquibase changelogs are detected (filenames recorded) even though not deep-parsed -- an honestly documented gap, not silent', () => {
	const root = fixtureRoot();
	const dir = path.join(root, 'db/changelog');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'db.changelog-master.yaml'), 'databaseChangeLog:\n  - changeSet:\n      id: 1\n');
	const result = scanMigrations(root);
	assert.equal(result.tool, 'liquibase');
	assert.equal(result.files.length, 1);
	assert.deepEqual(result.tables, [], 'YAML changelogs are not deep-parsed in this pass -- presence is recorded, content is not');
});

test('scanMigrations: Flyway takes priority when a repo somehow has both conventions present', () => {
	const root = fixtureRoot();
	fs.mkdirSync(path.join(root, 'src/main/resources/db/migration'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/main/resources/db/migration/V1__t.sql'), 'CREATE TABLE t (a INT);\n');
	fs.mkdirSync(path.join(root, 'db/changelog'), { recursive: true });
	fs.writeFileSync(path.join(root, 'db/changelog/master.xml'), '<databaseChangeLog/>\n');
	const result = scanMigrations(root);
	assert.equal(result.tool, 'flyway');
});
