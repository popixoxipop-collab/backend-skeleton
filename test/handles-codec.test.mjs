import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHandle, decodeHandle, uuidv5, deriveHandleUid, resolveJsonPointer } from '../handles/codec.mjs';

// Cross-checked against Python's stdlib: uuid.uuid5(uuid.NAMESPACE_DNS, 'example.com')
// -> cfbff0d1-9375-5685-968c-48ce8b15ae17. If this test ever fails after touching uuidv5(),
// the hand-written RFC 4122 implementation is wrong -- do not "fix the test" instead.
test('uuidv5 matches the standard NAMESPACE_DNS + "example.com" test vector', () => {
	const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
	assert.equal(uuidv5(NAMESPACE_DNS, 'example.com'), 'cfbff0d1-9375-5685-968c-48ce8b15ae17');
});

test('uuidv5 is deterministic and namespace/name both affect the output', () => {
	const ns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
	assert.equal(uuidv5(ns, 'a'), uuidv5(ns, 'a'));
	assert.notEqual(uuidv5(ns, 'a'), uuidv5(ns, 'b'));
	assert.notEqual(uuidv5(ns, 'a'), uuidv5('11111111-1111-1111-1111-111111111111', 'a'));
});

test('encodeHandle/decodeHandle round-trip for a resource handle (kind=r)', () => {
	const parts = { kind: 'r', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' };
	const token = encodeHandle(parts);
	assert.match(token, /^sbf1_[A-Za-z0-9_-]+$/);
	assert.deepEqual(decodeHandle(token), { ...parts, pointer: null });
});

test('encodeHandle/decodeHandle round-trip for a field handle (kind=f) with a nested pointer', () => {
	const parts = { kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/policy/monthlyTokenLimit' };
	const token = encodeHandle(parts);
	assert.deepEqual(decodeHandle(token), parts);
});

test('encodeHandle rejects a field handle (kind=f) without a pointer', () => {
	assert.throws(() => encodeHandle({ kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' }), /require.*Pointer/i);
});

test('decodeHandle rejects a non-sbf1 string', () => {
	assert.throws(() => decodeHandle('not-a-handle'), /sbf1/);
});

test('decodeHandle rejects a well-formed-base64 but malformed payload', () => {
	const bogus = `sbf1_${Buffer.from('not the right shape at all').toString('base64url')}`;
	assert.throws(() => decodeHandle(bogus), /malformed/);
});

test('deriveHandleUid: a resource handle (kind=r) IS the resource\'s own uuid', () => {
	const uuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	assert.equal(deriveHandleUid({ kind: 'r', type: 'Organization', uuid }), uuid);
});

test('deriveHandleUid: a field handle (kind=f) is deterministic and differs per pointer', () => {
	const base = { kind: 'f', type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97' };
	const a1 = deriveHandleUid({ ...base, pointer: '/name' });
	const a2 = deriveHandleUid({ ...base, pointer: '/name' });
	const b = deriveHandleUid({ ...base, pointer: '/status' });
	assert.equal(a1, a2, 'same inputs must derive the same handle_uid every time (no DB round-trip needed)');
	assert.notEqual(a1, b, 'different pointers on the same resource must derive different handle_uids');
	assert.match(a1, /^[0-9a-f-]{36}$/);
});

test('resolveJsonPointer: root, top-level, and nested paths', () => {
	const obj = { name: 'Acme', policy: { monthlyTokenLimit: 500, tiers: ['a', 'b'] } };
	assert.equal(resolveJsonPointer(obj, ''), obj);
	assert.equal(resolveJsonPointer(obj, '/name'), 'Acme');
	assert.equal(resolveJsonPointer(obj, '/policy/monthlyTokenLimit'), 500);
	assert.equal(resolveJsonPointer(obj, '/policy/tiers/1'), 'b');
	assert.equal(resolveJsonPointer(obj, '/nonexistent/path'), undefined);
});

test('end-to-end: mint a field handle, decode it, and use it to resolve the field from a fetched resource', () => {
	const resourceUid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const pointer = '/policy/monthlyTokenLimit';
	const token = encodeHandle({ kind: 'f', type: 'Organization', uuid: resourceUid, pointer });
	const handleUid = deriveHandleUid({ kind: 'f', type: 'Organization', uuid: resourceUid, pointer });

	// Simulates what a resolver does: decode -> (registry lookup would happen here in Java,
	// keyed by handleUid) -> fetch the whole resource -> resolve the pointer.
	const decoded = decodeHandle(token);
	assert.equal(decoded.type, 'Organization');
	assert.equal(decoded.uuid, resourceUid);
	assert.equal(deriveHandleUid(decoded), handleUid, 're-deriving from the decoded token must match the original mint');

	const fetchedResource = { name: 'Acme', policy: { monthlyTokenLimit: 200000000 } };
	assert.equal(resolveJsonPointer(fetchedResource, decoded.pointer), 200000000);
});
