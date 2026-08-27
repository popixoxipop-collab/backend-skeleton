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

// D-security-10 regression: Node's `Buffer.from(str, 'base64')` silently ignores characters
// outside the base64 alphabet instead of rejecting them, unlike Java's
// `Base64.getUrlDecoder().decode()` which throws -- the "byte-identical JS/Java behavior" claim
// (D5/D6) didn't hold for malformed input before this fix. `!` is not in the base64url alphabet.
test('decodeHandle rejects a payload containing characters outside the base64url alphabet', () => {
	assert.throws(() => decodeHandle('sbf1_not!valid++base64=='), /not valid base64url/);
});

// D-security-10 regression: no upper bound on token length before attempting to decode.
test('decodeHandle rejects a token exceeding the max length', () => {
	const huge = `sbf1_${'A'.repeat(3000)}`;
	assert.throws(() => decodeHandle(huge), /exceeds the maximum length/);
});

// D-security-10 regression: the symmetric case of "field handles require a pointer" -- a
// non-field handle must not be allowed to carry one either, so patch()'s kind-vs-pointer
// consistency isn't left as an unenforced assumption on the encode side.
test('encodeHandle rejects a non-field handle (kind=r or kind=o) that carries a pointer', () => {
	const base = { type: 'Organization', uuid: 'e957347e-3794-4c71-92a8-cec75dec1c97', pointer: '/name' };
	assert.throws(() => encodeHandle({ ...base, kind: 'r' }), /must not carry a JSON Pointer/);
	assert.throws(() => encodeHandle({ ...base, kind: 'o' }), /must not carry a JSON Pointer/);
});

// O3 (D-handle-uid-type-binding): kind=r used to return the resource's own uuid VERBATIM (no type
// binding at all) -- two different resource TYPES sharing the same uuid then derived the SAME
// handle_uid, silently colliding on the same `sbf_handle` registry primary key. Now hashes a
// type:uuid discriminant through UUIDv5, the same shape kind=f/kind=o already used -- deterministic
// and offline-derivable exactly as before, just no longer type-blind.
test('deriveHandleUid: a resource handle (kind=r) is type-bound, deterministic, and no longer the identity function', () => {
	const uuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const derived = deriveHandleUid({ kind: 'r', type: 'Organization', uuid });
	assert.notEqual(derived, uuid, 'must no longer return the raw resource uuid verbatim');
	assert.match(derived, /^[0-9a-f-]{36}$/);
	assert.equal(deriveHandleUid({ kind: 'r', type: 'Organization', uuid }), derived, 'same inputs must derive the same handle_uid every time (no DB round-trip needed)');
});

// O3 (D-handle-uid-type-binding): the real bug this item fixes, reproduced at the JS-reference
// level -- written to fail against the pre-fix formula (kind=r -> uuid verbatim, type-independent)
// and pass only because type now participates in the hash.
test('deriveHandleUid: two different resource types sharing the same UUID derive DIFFERENT kind=r handle_uids', () => {
	const uuid = 'e957347e-3794-4c71-92a8-cec75dec1c97';
	const widget = deriveHandleUid({ kind: 'r', type: 'Widget', uuid });
	const organization = deriveHandleUid({ kind: 'r', type: 'Organization', uuid });
	assert.notEqual(widget, organization, 'two different resource types sharing a UUID must never derive the same handle_uid (registry primary key collision)');
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
