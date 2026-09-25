import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { composeResourceBindings, matchPhysicalTable } from '../../scanners/persistence-next/bindings.mjs';

function persistence() {
	return createPersistenceIr({ provider: 'test', source_kind: 'source', entities: [
		{ id: 'entity:user', provider: 'test', name: 'User', table: { name: 'users', schema: 'public', source: 'explicit' }, primary_key: { columns: ['tenant_id','id'], type: 'uuid', source: 'source' } },
		{ id: 'entity:audit', provider: 'test', name: 'Audit', table: { name: 'audit', schema: 'public', source: 'explicit' }, primary_key: { columns: [], type: 'unknown', source: 'unknown' } },
	] });
}

test('same-looking resource name never auto-binds', () => {
	const out = composeResourceBindings({ resources: [{ id: 'users', name: 'User', table: 'users' }], persistence: persistence() });
	assert.equal(out.bindings.length, 0);
	assert.equal(out.unbound_resources.length, 1);
	assert.match(out.unbound_resources[0].reason, /name\/table similarity is deliberately not used/);
});

test('exact entity_ref binds and preserves composite key shape', () => {
	const out = composeResourceBindings({ resources: [{ id: 'users', entity_ref: 'entity:user' }], persistence: persistence() });
	assert.equal(out.bindings.length, 1);
	assert.equal(out.bindings[0].capabilities.key_shape, 'composite');
	assert.equal(out.bindings[0].capabilities.read_by_primary_key, true);
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
