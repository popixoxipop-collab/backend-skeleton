// Pure-function tests for lib/attest.mjs -- no fs beyond what generateKeyPairSync itself needs, no
// CLI, no git repo. See test/attest-cli.test.mjs for the end-to-end version through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair, canonicalize, signPayload, verifyPayload } from '../lib/attest.mjs';

test('canonicalize: key order does not affect the result -- deep, alphabetical, whitespace-free', () => {
	const a = canonicalize({ b: 2, a: 1, nested: { z: 1, a: 2 } });
	const b = canonicalize({ a: 1, nested: { a: 2, z: 1 }, b: 2 });
	assert.equal(a, b);
	assert.equal(a, '{"a":1,"b":2,"nested":{"a":2,"z":1}}');
});

test('canonicalize: arrays keep their own order (only object keys are sorted)', () => {
	assert.equal(canonicalize({ list: [3, 1, 2] }), '{"list":[3,1,2]}');
});

test('generateKeypair: returns two distinct, real PEM-encoded keys', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	assert.match(publicKeyPem, /-----BEGIN PUBLIC KEY-----/);
	assert.match(privateKeyPem, /-----BEGIN PRIVATE KEY-----/);
	assert.notEqual(publicKeyPem, privateKeyPem);
});

test('generateKeypair: two calls produce two different keypairs (not a fixed/deterministic key)', () => {
	const k1 = generateKeypair();
	const k2 = generateKeypair();
	assert.notEqual(k1.privateKeyPem, k2.privateKeyPem);
	assert.notEqual(k1.publicKeyPem, k2.publicKeyPem);
});

test('signPayload/verifyPayload: a genuine signature verifies against the same payload and key', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const payload = { feature_id: '001-widget-management', gates: { scan: { status: 'pass' } } };
	const sig = signPayload(payload, privateKeyPem);
	assert.equal(typeof sig, 'string');
	assert.ok(sig.length > 0);
	assert.equal(verifyPayload(payload, sig, publicKeyPem), true);
});

test('verifyPayload: a logically-identical payload with different key insertion order still verifies', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const sig = signPayload({ a: 1, b: 2 }, privateKeyPem);
	assert.equal(verifyPayload({ b: 2, a: 1 }, sig, publicKeyPem), true);
});

test('verifyPayload: any real change to the payload fails verification (tamper detection)', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const sig = signPayload({ feature_id: '001-widget-management', pass_count: 2 }, privateKeyPem);
	assert.equal(verifyPayload({ feature_id: '001-widget-management', pass_count: 3 }, sig, publicKeyPem), false);
	assert.equal(verifyPayload({ feature_id: '002-tampered', pass_count: 2 }, sig, publicKeyPem), false);
});

test('verifyPayload: the wrong public key fails verification, even for the exact same payload', () => {
	const { privateKeyPem } = generateKeypair();
	const { publicKeyPem: wrongPublicKey } = generateKeypair();
	const payload = { feature_id: '001-widget-management' };
	const sig = signPayload(payload, privateKeyPem);
	assert.equal(verifyPayload(payload, sig, wrongPublicKey), false);
});

test('verifyPayload: a corrupted/malformed signature string is reported as invalid, not thrown', () => {
	const { publicKeyPem } = generateKeypair();
	assert.equal(verifyPayload({ x: 1 }, 'not-a-real-base64-signature!!!', publicKeyPem), false);
	assert.equal(verifyPayload({ x: 1 }, '', publicKeyPem), false);
});
