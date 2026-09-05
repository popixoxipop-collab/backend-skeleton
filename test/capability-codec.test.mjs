// ROADMAP.md Phase 6, item 1 (D-sbf2-capability-codec): pure unit tests for
// handles/capability-codec.mjs -- no CLI, no filesystem, no network. See that file's own header
// for why this is infrastructure-only (not wired into any real authorization flow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair, signPayload } from '../lib/attest.mjs';
import { encodeCapabilityToken, decodeCapabilityToken } from '../handles/capability-codec.mjs';

function keypair() {
	return generateKeypair();
}

test('encodeCapabilityToken -> decodeCapabilityToken: a real round trip with a real Ed25519 keypair', () => {
	const { publicKeyPem, privateKeyPem } = keypair();
	const now = 1_000_000_000;
	const token = encodeCapabilityToken({ iss: 'backend-skeleton-pilot', aud: 'team-iz-backend', exp: now + 3600, scope: ['cohort:read'] }, privateKeyPem);
	assert.ok(token.startsWith('sbf2_'));
	const result = decodeCapabilityToken(token, publicKeyPem, { now });
	assert.equal(result.ok, true);
	assert.deepEqual(result.payload, { iss: 'backend-skeleton-pilot', aud: 'team-iz-backend', exp: now + 3600, scope: ['cohort:read'] });
});

test('decodeCapabilityToken: scope is carried through uninterpreted -- a string, an array, and an object all round-trip', () => {
	const { publicKeyPem, privateKeyPem } = keypair();
	const now = 1_000_000_000;
	for (const scope of ['cohort:read', ['cohort:read', 'cohort:patch'], { resourceType: 'Cohort', action: 'read' }]) {
		const token = encodeCapabilityToken({ iss: 'a', aud: 'b', exp: now + 60, scope }, privateKeyPem);
		const result = decodeCapabilityToken(token, publicKeyPem, { now });
		assert.equal(result.ok, true);
		assert.deepEqual(result.payload.scope, scope);
	}
});

test('decodeCapabilityToken: a tampered payload (signed by a DIFFERENT keypair) fails closed with invalid signature, not a thrown error', () => {
	const real = keypair();
	const attacker = keypair();
	const now = 1_000_000_000;
	const token = encodeCapabilityToken({ iss: 'a', aud: 'b', exp: now + 60, scope: 'x' }, attacker.privateKeyPem);
	const result = decodeCapabilityToken(token, real.publicKeyPem, { now });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'invalid signature');
});

test('decodeCapabilityToken: a byte-flipped token fails closed with invalid signature or malformed token, never throws', () => {
	const { publicKeyPem, privateKeyPem } = keypair();
	const now = 1_000_000_000;
	const token = encodeCapabilityToken({ iss: 'a', aud: 'b', exp: now + 60, scope: 'x' }, privateKeyPem);
	const tampered = token.slice(0, -4) + (token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
	assert.doesNotThrow(() => decodeCapabilityToken(tampered, publicKeyPem, { now }));
	const result = decodeCapabilityToken(tampered, publicKeyPem, { now });
	assert.equal(result.ok, false);
});

test('decodeCapabilityToken: an expired token fails closed with reason "expired"', () => {
	const { publicKeyPem, privateKeyPem } = keypair();
	const now = 1_000_000_000;
	const token = encodeCapabilityToken({ iss: 'a', aud: 'b', exp: now - 1, scope: 'x' }, privateKeyPem);
	const result = decodeCapabilityToken(token, publicKeyPem, { now });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'expired');
});

test('decodeCapabilityToken: a token at exactly its expiry second is already expired -- the boundary is exclusive, not an off-by-one trap', () => {
	const { publicKeyPem, privateKeyPem } = keypair();
	const now = 1_000_000_000;
	const token = encodeCapabilityToken({ iss: 'a', aud: 'b', exp: now, scope: 'x' }, privateKeyPem);
	const result = decodeCapabilityToken(token, publicKeyPem, { now });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'expired');
});

test('decodeCapabilityToken: missing the sbf2_ prefix is rejected, distinct from a real sbf1_ handle token', () => {
	const { publicKeyPem } = keypair();
	const result = decodeCapabilityToken('sbf1_dGVzdA', publicKeyPem);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'missing sbf2_ prefix');
});

test('decodeCapabilityToken: not valid base64url after the prefix is rejected as malformed, never throws', () => {
	const { publicKeyPem } = keypair();
	assert.doesNotThrow(() => decodeCapabilityToken('sbf2_not valid base64url!!', publicKeyPem));
	const result = decodeCapabilityToken('sbf2_not valid base64url!!', publicKeyPem);
	assert.equal(result.ok, false);
	assert.match(result.reason, /malformed token/);
});

test('decodeCapabilityToken: valid base64url but not JSON is rejected as malformed', () => {
	const { publicKeyPem } = keypair();
	const notJson = `sbf2_${Buffer.from('not json at all').toString('base64url')}`;
	const result = decodeCapabilityToken(notJson, publicKeyPem);
	assert.equal(result.ok, false);
	assert.match(result.reason, /malformed token/);
});

test('decodeCapabilityToken: a token longer than MAX_CAPABILITY_TOKEN_LENGTH is refused before attempting to decode', () => {
	const { publicKeyPem } = keypair();
	const huge = `sbf2_${'A'.repeat(5000)}`;
	const result = decodeCapabilityToken(huge, publicKeyPem);
	assert.equal(result.ok, false);
	assert.match(result.reason, /exceeds the maximum length/);
});

test('encodeCapabilityToken: refuses to encode without a real iss/aud/exp/scope rather than silently substituting a default', () => {
	const { privateKeyPem } = keypair();
	assert.throws(() => encodeCapabilityToken({ aud: 'b', exp: 1, scope: 'x' }, privateKeyPem), /iss/);
	assert.throws(() => encodeCapabilityToken({ iss: 'a', exp: 1, scope: 'x' }, privateKeyPem), /aud/);
	assert.throws(() => encodeCapabilityToken({ iss: 'a', aud: 'b', scope: 'x' }, privateKeyPem), /exp/);
	assert.throws(() => encodeCapabilityToken({ iss: 'a', aud: 'b', exp: 1 }, privateKeyPem), /scope/);
});

test('decodeCapabilityToken: a well-formed, VALIDLY SIGNED envelope whose payload is missing a required field fails closed as a malformed payload', () => {
	// Constructs the envelope directly (bypassing encodeCapabilityToken's own validation) to prove
	// decodeCapabilityToken defends itself independently, not only via the encoder's own checks --
	// a real, adversarially-crafted token would skip the encoder entirely. The signature is REAL
	// and valid (signed with signPayload, the exact function the module itself uses), so this
	// proves the payload-shape check catches it, not signature verification.
	const { publicKeyPem, privateKeyPem } = keypair();
	const badPayload = { iss: 'a', aud: 'b', scope: 'x' }; // missing exp
	const sig = signPayload(badPayload, privateKeyPem);
	const envelope = { payload: badPayload, sig };
	const token = `sbf2_${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
	const result = decodeCapabilityToken(token, publicKeyPem);
	assert.equal(result.ok, false);
	assert.match(result.reason, /malformed payload: missing exp/);
});
