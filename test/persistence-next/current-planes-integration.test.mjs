import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanMigrations } from '../../scanners/db/migrations.mjs';
import { normalizePlaneC } from '../../scanners/db/erd.mjs';
import { fromMigrationScan, fromLivePostgres } from '../../scanners/persistence-next/legacy.mjs';

test('current Plane A scan feeds Persistence IR without losing later migration columns', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-persistence-next-a-'));
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__users.sql'), 'CREATE TABLE users (id UUID, org_id UUID REFERENCES organizations(id));\n');
	fs.writeFileSync(path.join(dir, 'V2__users_status.sql'), 'ALTER TABLE users ADD COLUMN status VARCHAR(32);\n');
	const current = scanMigrations(root);
	const ir = fromMigrationScan(current);
	assert.equal(current.tables.length, 2, 'current Plane A remains one entry per migration file');
	assert.equal(ir.entities.length, 1, 'next bridge merges physical-table evidence for comparison only');
	assert.deepEqual(ir.entities[0].fields.map((field) => field.name), ['id', 'org_id', 'status']);
	assert.equal(ir.entities[0].relations[0].references_table, 'organizations');
	assert.deepEqual(ir.entities[0].primary_key.columns, [], 'Plane A still has no PK fact');
});

test('current Plane C and Persistence IR agree on observed PK columns while keeping FK ambiguity explicit', () => {
	const current = {
		schema: 'public', schema_hash: 'fixture', generated_at: '2026-09-25T00:00:00.000Z',
		tables: [{
			name: 'memberships',
			columns: [
				{ name: 'tenant_id', type: 'uuid', nullable: false },
				{ name: 'user_id', type: 'uuid', nullable: false },
			],
			primary_key: ['tenant_id', 'user_id'],
			foreign_keys: [
				{ column: 'tenant_id', references_table: 'tenants', references_column: 'id' },
				{ column: 'user_id', references_table: 'users', references_column: 'id' },
			],
			indexes: [], rls_policies: [],
		}],
	};
	const existing = normalizePlaneC(current);
	const next = fromLivePostgres(current);
	assert.deepEqual(next.entities[0].primary_key.columns, existing.tables[0].primaryKey);
	assert.equal(next.entities[0].primary_key.source, 'live');
	assert.equal(next.entities[0].fields[0].nullable, existing.tables[0].columns[0].nullable);
	assert.equal(next.entities[0].relations.length, 2, 'different parents stay separate single-column FK facts');
	assert.ok(next.entities[0].relations.every((relation) => relation.pairing === 'resolved'));
});
