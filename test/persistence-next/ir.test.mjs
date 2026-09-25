import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr, makeEntityId, normalizeEntity } from '../../scanners/persistence-next/ir.mjs';

test('makeEntityId is deterministic and scopes provider/name/location', () => {
	assert.equal(makeEntityId({ provider: 'typeorm', className: 'User', file: 'src/User.ts' }), makeEntityId({ provider: 'typeorm', className: 'User', file: 'src/User.ts' }));
	assert.notEqual(makeEntityId({ provider: 'typeorm', className: 'User', file: 'src/User.ts' }), makeEntityId({ provider: 'sqlmodel', className: 'User', file: 'src/User.ts' }));
});

test('IR refuses duplicate entity identities', () => {
	const entity = { provider: 'x', name: 'User', file: 'u', table: { name: 'users', source: 'explicit' }, primary_key: { columns: ['id'], type: 'uuid', source: 'source' } };
	assert.throws(() => createPersistenceIr({ provider: 'x', source_kind: 'source', entities: [entity, entity] }), /duplicate persistence entity id/);
});

test('relations preserve composite column order and pairing status', () => {
	const entity = normalizeEntity({ provider: 'live', name: 'Child', table: { name: 'child', source: 'observed' }, primary_key: { columns: ['tenant_id','id'], source: 'live' }, relations: [{ columns: ['tenant_id','parent_id'], references_table: 'parent', references_columns: ['tenant_id','id'], pairing: 'resolved', source: 'live' }] });
	assert.deepEqual(entity.primary_key.columns, ['tenant_id','id']);
	assert.deepEqual(entity.relations[0].columns, ['tenant_id','parent_id']);
	assert.equal(entity.relations[0].pairing, 'resolved');
});
