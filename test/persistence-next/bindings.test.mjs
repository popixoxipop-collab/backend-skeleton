import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { composeResourceBindings, matchPhysicalTable, verifyResourceBindingsAgainstObserved, normalizeKeyType } from '../../scanners/persistence-next/bindings.mjs';

function persistence({provider='test',keyType='uuid',columns=['tenant_id','id']}={}) {
	return createPersistenceIr({ provider, source_kind: 'source', entities: [
		{ id: 'entity:user', provider, name: 'User', table: { name: 'users', schema: 'public', source: 'explicit' }, primary_key: { columns, type: keyType, source: 'source' } },
		{ id: 'entity:audit', provider, name: 'Audit', table: { name: 'audit', schema: 'public', source: 'explicit' }, primary_key: { columns: [], type: 'unknown', source: 'unknown' } },
	] });
}
function live({columns=['tenant_id','id'],types={tenant_id:'uuid',id:'uuid'}}={}) {
	return createPersistenceIr({ provider:'postgres-introspection', source_kind:'live', entities:[{
		provider:'postgres-introspection',name:'users',table:{name:'users',schema:'public',source:'observed'},
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
	const out = composeResourceBindings({ resources: [{ id: 'users', entity_ref: 'entity:user' }], persistence: persistence({provider:'jpa-hibernate'}) });
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
		{ resource_id: 'r', entity_id: 'entity:user' }, { resource_id: 'r', entity_id: 'entity:audit' },
	] });
	assert.equal(out.bindings.length, 0);
	assert.equal(out.conflicts[0].code, 'multiple-entities');
});

test('physical table matching requires exact schema + table', () => {
	assert.equal(matchPhysicalTable({ persistence: persistence(), schema: 'public', table: 'users' }).length, 1);
	assert.equal(matchPhysicalTable({ persistence: persistence(), schema: 'tenant2', table: 'users' }).length, 0);
});

test('live verification preserves ordered composite PK and recognizes compatible UUID source/live types', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: 'entity:user' }], persistence: persistence() });
	const verified = verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: live() });
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, true);
	assert.equal(verified.bindings[0].capabilities.key_type_status,'source-only','composite key has no single observed key type');
	assert.deepEqual(verified.bindings[0].verification,{source_kind:'live',table:'verified',primary_key:'verified',key_type:'source-only'});
});

test('unknown source key type adopts single live DB key type after exact PK verification',()=>{
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:'entity:user'}],persistence:persistence({provider:'sqlalchemy-sqlmodel',keyType:'unknown',columns:['id']})});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed:live({columns:['id'],types:{id:'uuid'}})});
	const caps=verified.bindings[0].capabilities;
	assert.equal(caps.verified_read_by_primary_key,true);
	assert.equal(caps.observed_key_type,'uuid');
	assert.equal(caps.effective_key_type,'uuid');
	assert.equal(caps.key_type_status,'observed');
});

test('source/live key type contradiction blocks verified read',()=>{
	const bound=composeResourceBindings({resources:[{id:'users',entity_ref:'entity:user'}],persistence:persistence({provider:'typeorm',keyType:'uuid',columns:['id']})});
	const verified=verifyResourceBindingsAgainstObserved({binding_result:bound,observed:live({columns:['id'],types:{id:'bigint'}})});
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key,false);
	assert.equal(verified.bindings[0].capabilities.key_type_status,'mismatch');
});

test('live verification refuses reordered composite PK', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: 'entity:user' }], persistence: persistence() });
	const verified = verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: live({columns:['id','tenant_id']}) });
	assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, false);
	assert.equal(verified.bindings[0].verification.primary_key, 'mismatch');
});

test('non-live evidence cannot be used to runtime-verify a binding', () => {
	const bound = composeResourceBindings({ resources: [{ id: 'users', entity_ref: 'entity:user' }], persistence: persistence() });
	assert.throws(() => verifyResourceBindingsAgainstObserved({ binding_result: bound, observed: persistence() }), /source_kind=live/);
});
