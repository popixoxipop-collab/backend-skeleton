import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr, makeEntityId } from '../../scanners/persistence-next/ir.mjs';
import { composeResourceBindings, matchPhysicalTable, verifyResourceBindingsAgainstObserved, normalizeKeyType } from '../../scanners/persistence-next/bindings.mjs';

function entityId(provider, name, table) {
	return makeEntityId({ provider, className:name, table });
}

function persistence({provider='test',keyType='uuid',columns=['tenant_id','id']}={}) {
	return createPersistenceIr({ provider, source_kind: 'source', entities: [
		{ provider, name: 'User', table: { name: 'users', schema: 'public', source: 'explicit' }, primary_key: { columns, type: keyType, source: 'source' } },
		{ provider, name: 'Audit', table: { name: 'audit', schema: 'public', source: 'explicit' }, primary_key: { columns: [], type: 'unknown', source: 'unknown' } },
	] });
}
const SNAPSHOT_REF='sha256:'+'a'.repeat(64);

function live({provider='postgres-introspection',snapshotRef=SNAPSHOT_REF,columns=['tenant_id','id'],types={tenant_id:'uuid',id:'uuid'}}={}) {
	return createPersistenceIr({ provider, source_kind:'live', metadata:{snapshot_ref:snapshotRef}, entities:[{
		provider,name:'users',table:{name:'users',schema:'public',source:'observed'},
		primary_key:{columns,type:'unknown',source:'live'},
		fields:columns.map((name)=>({name,type:types[name]??null,nullable:false,source:'live'})),
	}]});
}

test('normalizeKeyType folds known UUID spellings only',()=>{
	assert.equal(normalizeKeyType('UUID'),'uuid');
	assert.equal(normalizeKeyType('java.util.UUID'),'uuid');
	assert.equal(normalizeKeyType('uuid'),'uuid');
	assert.equal(normalizeKeyType('String'),'String');
	assert.equal(normalizeKeyType('unknown'),'unknown');
});

test('same-looking resource name never auto-binds', () => {
	const out = composeResourceBindings({ resources: [{ id: 'users', name: 'User', table: 'users' }], persistence: persistence() });
	assert.equal(out.bindings.length, 0);
	assert.equal(out.unbound_resources.length, 1);
	assert.match(out.unbound_resources[0].reason, /name\/table similarity is deliberately not used/);
});

test('exact entity_ref binds and preserves persistence identity + composite key shape', () => {
	const out = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('jpa-hibernate','User','users') }], persistence: persistence({provider:'jpa-hibernate'}) });
	assert.equal(out.bindings.length, 1);
	assert.equal(out.bindings[0].persistence_id,'jpa-hibernate');
	assert.equal(out.bindings[0].persistence_source_kind,'source');
	assert.equal(out.bindings[0].capabilities.key_shape, 'composite');
	assert.equal(out.bindings[0].capabilities.candidate_read_by_primary_key, true);
	assert.equal(out.bindings[0].capabilities.verified_read_by_primary_key, false);
	assert.equal(out.bindings[0].capabilities.write, false);
});

test('conflicting explicit bindings are blocked instead of picking one', () => {
	const out = composeResourceBindings({ resources: [{ id: 'r' }], persistence: persistence(), explicit_bindings: [
		{ resource_id: 'r', entity_id: entityId('test','User','users') }, { resource_id: 'r', entity_id: entityId('test','Audit','audit') },
	] });
	assert.equal(out.bindings.length, 0);
	assert.equal(out.conflicts[0].code, 'multiple-entities');
});

test('physical table matching requires exact schema + table', () => {
	assert.equal(matchPhysicalTable({ persistence: persistence(), schema: 'public', table: 'users' }).length, 1);
	assert.equal(matchPhysicalTable({ persistence: persistence(), schema: 'tenant2', table: 'users' }).length, 0);
});

test('live verification preserves ordered composite PK and recognizes compatible UUID source/live types', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	const verified = verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: live(), expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF });
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, true);
	assert.equal(verified.bindings[0].capabilities.key_type_status,'source-only','composite key has no single observed key type');
	assert.deepEqual(verified.bindings[0].verification,{source_kind:'live',provider:'verified',expected_provider:'postgres-introspection',observed_provider:'postgres-introspection',expected_snapshot_ref:SNAPSHOT_REF,observed_snapshot_ref:SNAPSHOT_REF,table:'verified',primary_key:'verified',key_type:'source-only'});
});

test('unknown source key type adopts single live DB key type after exact PK verification',()=>{
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:entityId('sqlalchemy-sqlmodel','User','users')}],persistence:persistence({provider:'sqlalchemy-sqlmodel',keyType:'unknown',columns:['id']})});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed:live({columns:['id'],types:{id:'uuid'}}),expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF});
	const caps=verified.bindings[0].capabilities;
	assert.equal(caps.verified_read_by_primary_key,true);
	assert.equal(caps.observed_key_type,'uuid');
	assert.equal(caps.effective_key_type,'uuid');
	assert.equal(caps.key_type_status,'observed');
});

test('source/live key type contradiction blocks verified read',()=>{
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:entityId('typeorm','User','users')}],persistence:persistence({provider:'typeorm',keyType:'uuid',columns:['id']})});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed:live({columns:['id'],types:{id:'bigint'}}),expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF});
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key,false);
	assert.equal(verified.bindings[0].capabilities.key_type_status,'mismatch');
});

test('live verification refuses reordered composite PK', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	const verified = verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: live({columns:['id','tenant_id']}), expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF });
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, false);
	assert.equal(verified.bindings[0].verification.primary_key, 'mismatch');
});

test('non-live evidence cannot be used to runtime-verify a binding', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	assert.throws(() => verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: persistence(), expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF }), /source_kind=live/);
});

test('live verification rejects an unapproved live provider even when table and key shape match', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	assert.throws(
		() => verifyResourceBindingsAgainstObserved({
			binding_result: bound,
			observed: live({ provider:'lookalike-introspector' }),
			expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF,
		}),
		/live provider mismatch/,
	);
});

test('live verification rejects same-provider evidence from a different snapshot', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	assert.throws(
		() => verifyResourceBindingsAgainstObserved({
			binding_result: bound,
			observed: live({ snapshotRef:'sha256:'+'b'.repeat(64) }),
			expected_live_provider:'postgres-introspection',
			expected_live_snapshot_ref:SNAPSHOT_REF,
		}),
		/live snapshot mismatch/,
	);
});

test('live verification requires explicit content-addressed snapshot authority', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: entityId('test','User','users') }], persistence: persistence() });
	assert.throws(
		() => verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: live(), expected_live_provider:'postgres-introspection' }),
		/expected_live_snapshot_ref/,
	);
});


test('live verification defaults an unspecified source schema to the observed live schema',()=>{
	const source=createPersistenceIr({provider:'jpa-hibernate',source_kind:'source',entities:[{
		provider:'jpa-hibernate',name:'User',
		table:{name:'users',schema:null,source:'explicit'},
		primary_key:{columns:['id'],type:'uuid',source:'source'},
	}]});
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:entityId('jpa-hibernate','User','users')}],persistence:source});
	const observed=createPersistenceIr({provider:'postgres-introspection',source_kind:'live',metadata:{schema:'public',snapshot_ref:SNAPSHOT_REF},entities:[{
		provider:'postgres-introspection',name:'users',
		table:{name:'users',schema:'public',source:'observed'},
		primary_key:{columns:['id'],type:'unknown',source:'live'},
		fields:[{name:'id',type:'uuid',nullable:false,source:'live'}],
	}]});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed,expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF});
	assert.equal(verified.bindings[0].verification.table,'verified');
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key,true);
});

test('an explicit source schema never falls through to a different observed schema',()=>{
	const source=createPersistenceIr({provider:'jpa-hibernate',source_kind:'source',entities:[{
		provider:'jpa-hibernate',name:'User',
		table:{name:'users',schema:'tenant_a',source:'explicit'},
		primary_key:{columns:['id'],type:'uuid',source:'source'},
	}]});
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:entityId('jpa-hibernate','User','users')}],persistence:source});
	const observed=createPersistenceIr({provider:'postgres-introspection',source_kind:'live',metadata:{schema:'public',snapshot_ref:SNAPSHOT_REF},entities:[{
		provider:'postgres-introspection',name:'users',
		table:{name:'users',schema:'public',source:'observed'},
		primary_key:{columns:['id'],type:'unknown',source:'live'},
		fields:[{name:'id',type:'uuid',nullable:false,source:'live'}],
	}]});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed,expected_live_provider:'postgres-introspection',expected_live_snapshot_ref:SNAPSHOT_REF});
	assert.equal(verified.bindings[0].verification.table,'missing');
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key,false);
});
