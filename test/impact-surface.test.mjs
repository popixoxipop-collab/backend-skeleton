// D-cross-feature-impact-graph (IG2/IG3): pure unit tests for lib/impact-surface.mjs's
// diffSurface()/changeKey() -- no git repo, no CLI, no filesystem for most cases (computeSurface()
// itself is exercised end-to-end through test/impact-cli.test.mjs instead, since it genuinely
// needs real files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSurface, changeKey } from '../lib/impact-surface.mjs';

function emptySurface() {
	return { operations: {}, resources: {}, fields: {} };
}

test('a brand-new operation reports operation_added, with zero prior surface', () => {
	const after = { ...emptySurface(), operations: { createWidget: { verb: 'POST', path: '/widgets', request_shape_hash: 'a', response_shape_hash: 'b', error_shape_hash: null } } };
	const changes = diffSurface(null, after);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].kind, 'operation_added');
	assert.equal(changes[0].subject, 'createWidget');
});

test('a removed operation reports operation_removed', () => {
	const before = { ...emptySurface(), operations: { createWidget: { verb: 'POST', path: '/widgets', request_shape_hash: 'a', response_shape_hash: 'b', error_shape_hash: null } } };
	const changes = diffSurface(before, emptySurface());
	assert.equal(changes.length, 1);
	assert.equal(changes[0].kind, 'operation_removed');
});

test('an unchanged operation between two identical surfaces reports zero changes', () => {
	const op = { verb: 'GET', path: '/widgets', request_shape_hash: null, response_shape_hash: 'x', error_shape_hash: 'y' };
	const surface = { ...emptySurface(), operations: { readWidgets: { ...op } } };
	assert.deepEqual(diffSurface(surface, { ...surface, operations: { readWidgets: { ...op } } }), []);
});

test('each of verb/path/request/response/error shape changing independently reports its own distinct kind', () => {
	const base = { verb: 'GET', path: '/widgets', request_shape_hash: 'r1', response_shape_hash: 's1', error_shape_hash: 'e1' };
	const before = { ...emptySurface(), operations: { op: { ...base } } };
	const cases = [
		[{ verb: 'POST' }, 'operation_verb_changed'],
		[{ path: '/widgets/{id}' }, 'operation_path_changed'],
		[{ request_shape_hash: 'r2' }, 'operation_request_shape_changed'],
		[{ response_shape_hash: 's2' }, 'operation_response_shape_changed'],
		[{ error_shape_hash: 'e2' }, 'operation_error_shape_changed'],
	];
	for (const [patch, expectedKind] of cases) {
		const after = { ...emptySurface(), operations: { op: { ...base, ...patch } } };
		const changes = diffSurface(before, after);
		assert.equal(changes.length, 1, `expected exactly one change for ${JSON.stringify(patch)}`);
		assert.equal(changes[0].kind, expectedKind);
	}
});

test('resource_removed fires when a resource disappears; a brand-new resource fires nothing (nothing could depend on what did not exist)', () => {
	const before = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'a', table: 'widgets', table_source: 'explicit' } } };
	assert.deepEqual(diffSurface(before, emptySurface()).map((c) => c.kind), ['resource_removed']);
	assert.deepEqual(diffSurface(emptySurface(), before), []);
});

test('resource_table_changed fires only when .table itself differs, not file_sha256 alone', () => {
	const before = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'a', table: 'widgets', table_source: 'explicit' } } };
	const sameTable = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'b', table: 'widgets', table_source: 'explicit' } } };
	assert.deepEqual(diffSurface(before, sameTable), []);
	const differentTable = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'a', table: 'widget_items', table_source: 'explicit' } } };
	const changes = diffSurface(before, differentTable);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].kind, 'resource_table_changed');
	assert.equal(changes[0].from, 'widgets');
	assert.equal(changes[0].to, 'widget_items');
});

test('field_source_moved fires only when the field exists on BOTH sides and its hash differs -- add/remove of a field is not this item\'s concern', () => {
	const before = { ...emptySurface(), fields: { 'WidgetDto.name': { source_file_sha256: 'a' } } };
	const moved = { ...emptySurface(), fields: { 'WidgetDto.name': { source_file_sha256: 'b' } } };
	assert.equal(diffSurface(before, moved)[0].kind, 'field_source_moved');
	// present only in "after" -- no field_added kind exists, and no change is reported for it.
	assert.deepEqual(diffSurface(emptySurface(), before), []);
	// present only in "before" -- no field_removed kind exists either.
	assert.deepEqual(diffSurface(before, emptySurface()), []);
});

test('every change carries a change_key computed by changeKey()', () => {
	const before = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'a', table: 'widgets', table_source: 'explicit' } } };
	const after = { ...emptySurface(), resources: { WidgetDto: { file_sha256: 'a', table: 'widget_items', table_source: 'explicit' } } };
	const [change] = diffSurface(before, after);
	assert.equal(change.change_key, changeKey({ kind: change.kind, subject: change.subject, to: change.to }));
});

// IG3's anti-rubber-stamp property, at the unit level: change_key embeds a hash of the NEW value,
// so two structurally different changes to the SAME subject produce two DIFFERENT keys.
test('changeKey: same kind+subject, different "to" value, produces a different key -- no wildcard by construction', () => {
	const keyA = changeKey({ kind: 'operation_response_shape_changed', subject: 'createWidget', to: 'hash-a' });
	const keyB = changeKey({ kind: 'operation_response_shape_changed', subject: 'createWidget', to: 'hash-b' });
	assert.notEqual(keyA, keyB);
	assert.match(keyA, /^operation_response_shape_changed:createWidget:[0-9a-f]{12}$/);
});

test('changeKey: identical kind+subject+to produces an identical key, deterministically', () => {
	const change = { kind: 'resource_removed', subject: 'WidgetDto', to: null };
	assert.equal(changeKey(change), changeKey({ ...change }));
});

test('multiple independent changes in one diff each get their own distinct change_key', () => {
	const before = {
		operations: { op: { verb: 'GET', path: '/x', request_shape_hash: null, response_shape_hash: 'a', error_shape_hash: null } },
		resources: { WidgetDto: { file_sha256: 'a', table: 'widgets', table_source: 'explicit' } },
		fields: {},
	};
	const after = {
		operations: { op: { verb: 'GET', path: '/x', request_shape_hash: null, response_shape_hash: 'b', error_shape_hash: null } },
		resources: { WidgetDto: { file_sha256: 'a', table: 'widget_items', table_source: 'explicit' } },
		fields: {},
	};
	const changes = diffSurface(before, after);
	assert.equal(changes.length, 2);
	assert.equal(new Set(changes.map((c) => c.change_key)).size, 2);
});
