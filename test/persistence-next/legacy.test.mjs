import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLegacyAdapterScan, fromMigrationScan, fromLivePostgres, LEGACY_ADAPTER_PERSISTENCE_IDS } from '../../scanners/persistence-next/legacy.mjs';

test('legacy adapter ids map to persistence identities expected by composition', () => {
	assert.deepEqual(LEGACY_ADAPTER_PERSISTENCE_IDS, {
		'java-spring':'jpa-hibernate',
		'python-fastapi':'sqlalchemy-sqlmodel',
		'typescript-express':'typeorm',
		'ruby-rails':'active-record',
	});
});

test('legacy JPA bridge preserves explicit table and UUID key evidence under jpa-hibernate identity', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'java-spring', repoRoot: '/repo', scan: { modules: [{ module: 'users', entities: [{ className: 'User', table: 'users', tableSource: 'explicit', idField: 'id', idFieldType: 'UUID', idFieldIsUuid: true, file: '/repo/src/User.java', line: 8 }] }] } });
	assert.equal(ir.provider,'jpa-hibernate');
	assert.equal(ir.metadata.legacy_adapter_id,'java-spring');
	assert.equal(ir.entities[0].provider,'jpa-hibernate');
	assert.equal(ir.entities[0].table.name, 'users');
	assert.equal(ir.entities[0].table.source, 'explicit');
	assert.equal(ir.entities[0].primary_key.type, 'UUID');
	assert.equal(ir.entities[0].source_refs[0].file, 'src/User.java');
});

test('legacy Java bridge does not invent a physical table when @Table is absent', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'java-spring', scan: { modules: [{ module: 'users', entities: [{ className: 'User', table: null, tableSource: null, idField: 'id', idFieldType: 'UUID', idFieldIsUuid: true, file: 'User.java', line: 1 }] }] } });
	assert.equal(ir.entities[0].table.name, null);
	assert.equal(ir.entities[0].table.source, 'unknown');
	assert.ok(ir.diagnostics.some((x) => x.code === 'table-name-unknown'));
});

test('SQLModel inferred table remains inferred under sqlalchemy-sqlmodel identity', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'python-fastapi', scan: { modules: [{ module: 'items', entities: [{ className: 'Item', table: 'item', tableSource: 'inferred', idField: 'id', file: 'models.py', line: 3 }] }] } });
	assert.equal(ir.provider,'sqlalchemy-sqlmodel');
	assert.equal(ir.entities[0].table.source, 'inferred');
	assert.equal(ir.entities[0].primary_key.type, 'unknown');
});

test('TypeORM non-UUID key is represented under typeorm identity', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'typescript-express', scan: { modules: [{ module: 'users', entities: [{ className: 'User', table: 'users', tableSource: 'explicit', idField: 'id', idFieldIsUuid: false, file: 'User.ts', line: 4 }] }] } });
	assert.equal(ir.provider,'typeorm');
	assert.equal(ir.entities[0].primary_key.type, 'non-uuid');
	assert.deepEqual(ir.entities[0].primary_key.columns, ['id']);
});

test('legacy Rails bridge accepts only explicit table/key evidence under active-record identity', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'ruby-rails', scan: { modules: [{ module: 'users', entities: [{ className: 'User', table: 'users', tableSource: 'explicit', idField: 'uuid', idFieldIsUuid: null, file: 'app/models/user.rb', line: 1 }] }] } });
	assert.equal(ir.provider,'active-record');
	assert.equal(ir.entities[0].table.name, 'users');
	assert.equal(ir.entities[0].table.source, 'explicit');
	assert.deepEqual(ir.entities[0].primary_key.columns, ['uuid']);
	assert.equal(ir.entities[0].primary_key.type, 'unknown');
});

test('legacy Rails bridge keeps conventional table/key absent instead of inferring them', () => {
	const ir = fromLegacyAdapterScan({ adapterId: 'ruby-rails', scan: { modules: [{ module: '_models', entities: [{ className: 'Person', table: null, tableSource: null, idField: null, idFieldIsUuid: null, file: 'app/models/person.rb', line: 1 }] }] } });
	assert.equal(ir.entities[0].table.name, null);
	assert.deepEqual(ir.entities[0].primary_key.columns, []);
	assert.ok(ir.diagnostics.some((x) => x.code === 'table-name-unknown'));
	assert.ok(ir.diagnostics.some((x) => x.code === 'primary-key-unknown'));
});

test('migration bridge merges table entries across files without inventing a primary key', () => {
	const ir = fromMigrationScan({ tool: 'flyway', files: ['V1.sql','V2.sql'], generated_at: 't', tables: [
		{ name: 'users', columns: ['id'], foreign_keys: [], source_file: 'V1.sql' },
		{ name: 'users', columns: ['org_id'], foreign_keys: [{ column: 'org_id', references_table: 'orgs', references_column: 'id' }], source_file: 'V2.sql' },
	] });
	assert.equal(ir.entities.length, 1);
	assert.deepEqual(ir.entities[0].fields.map((x) => x.name), ['id','org_id']);
	assert.deepEqual(ir.entities[0].primary_key.columns, []);
	assert.equal(ir.entities[0].relations[0].pairing, 'resolved');
});

test('live bridge refuses to fabricate pairings from flat multi-row FK introspection', () => {
	const ir = fromLivePostgres({ schema: 'public', generated_at: 't', schema_hash: 'h', tables: [{ name: 'child', columns: [{ name: 'a', type: 'uuid', nullable: false },{ name: 'b', type: 'uuid', nullable: false }], primary_key: ['a','b'], foreign_keys: [
		{ column: 'a', references_table: 'parent', references_column: 'x' },
		{ column: 'b', references_table: 'parent', references_column: 'y' },
	] }] });
	assert.deepEqual(ir.entities[0].primary_key.columns, ['a','b']);
	assert.equal(ir.entities[0].relations[0].pairing, 'ambiguous-flat-introspection');
});
