import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr, makeEntityId, makeSourceRef, normalizeEntity } from '../../scanners/persistence-next/ir.mjs';

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

test('caller-controlled entity ids cannot override the deterministic persistence identity', () => {
	assert.throws(
		() => normalizeEntity({
			id:'entity:attacker:selected',
			provider:'typeorm',
			name:'User',
			table:{name:'users',source:'explicit'},
			primary_key:{columns:['id'],type:'uuid',source:'source'},
		}),
		/deterministic persistence entity id/,
	);
});

test('source refs are normalized and bound to the entity provider', () => {
	const entity = normalizeEntity({
		provider:'typeorm',
		name:'User',
		table:{name:'users',source:'explicit'},
		primary_key:{columns:['id'],type:'uuid',source:'source'},
		source_refs:[makeSourceRef({kind:'source',provider:'typeorm',file:'src\\models\\User.ts',line:4})],
	});
	assert.equal(entity.source_refs[0].file,'src/models/User.ts');
	assert.equal(entity.source_refs[0].provider,'typeorm');
});

test('source refs reject repository escape, absolute paths, control characters, and provider substitution', () => {
	for (const file of ['../secret.ts','/tmp/secret.ts','C:\\secret.ts','src/evil\n.ts']) {
		assert.throws(
			() => makeSourceRef({kind:'source',provider:'typeorm',file}),
			/source ref file/,
			file,
		);
	}
	assert.throws(
		() => normalizeEntity({
			provider:'typeorm',
			name:'User',
			table:{name:'users',source:'explicit'},
			primary_key:{columns:['id'],type:'uuid',source:'source'},
			source_refs:[{kind:'source',provider:'other',file:'src/User.ts'}],
		}),
		/provider must match/,
	);
});

test('entity file locator is repository-relative before it participates in canonical identity', () => {
	const valid = normalizeEntity({
		provider:'typeorm',
		name:'User',
		file:'src\\models\\User.ts',
		table:{name:'users',source:'explicit'},
		primary_key:{columns:['id'],type:'uuid',source:'source'},
	});
	assert.equal(valid.file,'src/models/User.ts');
	assert.equal(valid.id, makeEntityId({provider:'typeorm',className:'User',file:'src/models/User.ts',table:'users'}));

	for (const file of ['../secret.ts','/tmp/secret.ts','C:\\secret.ts','src/evil\n.ts']) {
		assert.throws(
			() => normalizeEntity({
				provider:'typeorm',
				name:'User',
				file,
				table:{name:'users',source:'explicit'},
				primary_key:{columns:['id'],type:'uuid',source:'source'},
			}),
			/entity\.file/,
			file,
		);
	}
});

test('top-level Persistence IR provider owns every normalized entity', () => {
	assert.throws(
		() => createPersistenceIr({
			provider:'typeorm',
			source_kind:'source',
			entities:[{
				provider:'prisma',
				name:'User',
				table:{name:'users',source:'explicit'},
				primary_key:{columns:['id'],type:'uuid',source:'source'},
			}],
		}),
		/entity.provider must match/,
	);
});
