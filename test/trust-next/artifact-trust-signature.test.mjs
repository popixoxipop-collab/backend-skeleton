import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair, publicKeyIdFromPublic } from '../../lib/attest.mjs';
import {
  ARTIFACT_TRUST_SIGNATURE_CONTRACT,
  assertArtifactTrustPolicySignature,
  signArtifactTrustPolicy,
  verifyArtifactTrustPolicySignature,
} from '../../lib/trust-next/artifact-trust-signature.mjs';

const A = 'a'.repeat(64);
function policy(generation = 4) {
  return {
    schema: 'bskel.trust-artifact-policy/1',
    generation,
    allow: [{ usage: 'package', sha256: A }],
    revoked: [],
  };
}

test('T20 reuses existing Ed25519 attestation primitives to sign exact policy digest+generation', () => {
  const { publicKeyPem, privateKeyPem } = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(), privateKeyPem);
  assert.equal(envelope.contract, ARTIFACT_TRUST_SIGNATURE_CONTRACT);
  assert.equal(envelope.algorithm, 'ed25519');
  assert.equal(envelope.canonicalization, 'sortkeysdeep-json');
  assert.equal(envelope.key_id, publicKeyIdFromPublic(publicKeyPem));
  assert.match(envelope.payload.policy_sha256, /^[0-9a-f]{64}$/);
  assert.equal(envelope.payload.generation, 4);
  const result = verifyArtifactTrustPolicySignature(policy(), envelope, publicKeyPem, {
    minimumGeneration: 4,
    expectedKeyId: envelope.key_id,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('format-only policy input normalization still verifies the same signed policy identity', () => {
  const { publicKeyPem, privateKeyPem } = generateKeypair();
  const original = {
    schema: 'bskel.trust-artifact-policy/1',
    generation: 4,
    allow: [{ usage: 'package', sha256: A }, { usage: 'package', sha256: A }],
    revoked: [],
  };
  const envelope = signArtifactTrustPolicy(original, privateKeyPem);
  assert.equal(verifyArtifactTrustPolicySignature(policy(), envelope, publicKeyPem).ok, true);
});

test('policy mutation, generation change and wrong key all fail', () => {
  const kp = generateKeypair();
  const wrong = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(), kp.privateKeyPem);

  const changed = policy();
  changed.allow.push({ usage: 'helper', sha256: 'b'.repeat(64) });
  assert.equal(verifyArtifactTrustPolicySignature(changed, envelope, kp.publicKeyPem).ok, false);

  assert.equal(verifyArtifactTrustPolicySignature(policy(5), envelope, kp.publicKeyPem).ok, false);
  assert.equal(verifyArtifactTrustPolicySignature(policy(), envelope, wrong.publicKeyPem).ok, false);
});

test('minimum generation rejects a correctly signed but stale policy', () => {
  const kp = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(3), kp.privateKeyPem);
  const result = verifyArtifactTrustPolicySignature(policy(3), envelope, kp.publicKeyPem, { minimumGeneration: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((x) => x.code === 'TRUST_POLICY_GENERATION_ROLLBACK'), true);
});

test('key id is only accepted when it matches the actual explicitly supplied public key', () => {
  const kp = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(), kp.privateKeyPem);
  const tampered = structuredClone(envelope);
  tampered.key_id = 'ed25519:' + '0'.repeat(32);
  const result = verifyArtifactTrustPolicySignature(policy(), tampered, kp.publicKeyPem);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((x) => x.code === 'SIGNATURE_KEY_ID_MISMATCH'), true);
});

test('unknown signature fields and tampered signature fail closed', () => {
  const kp = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(), kp.privateKeyPem);
  const extra = structuredClone(envelope);
  extra.url = 'https://example.com/policy';
  assert.equal(verifyArtifactTrustPolicySignature(policy(), extra, kp.publicKeyPem).ok, false);

  const tampered = structuredClone(envelope);
  tampered.signature = tampered.signature.slice(0, -4) + 'AAAA';
  assert.equal(verifyArtifactTrustPolicySignature(policy(), tampered, kp.publicKeyPem).ok, false);
});

test('assert helper throws structured error and signing never loads keys implicitly', () => {
  const kp = generateKeypair();
  const envelope = signArtifactTrustPolicy(policy(), kp.privateKeyPem);
  assert.throws(
    () => assertArtifactTrustPolicySignature(policy(9), envelope, kp.publicKeyPem),
    (e) => e?.code === 'ARTIFACT_TRUST_SIGNATURE_INVALID' && Array.isArray(e.details),
  );
  assert.throws(() => signArtifactTrustPolicy(policy(), ''), (e) => e?.code === 'TRUST_SIGNING_KEY_INVALID');
});
