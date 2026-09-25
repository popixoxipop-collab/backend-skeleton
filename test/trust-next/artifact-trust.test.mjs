import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_TRUST_DIGEST_FORMAT,
  ARTIFACT_TRUST_POLICY_SCHEMA,
  artifactTrustPolicyDigest,
  assertArtifactTrusted,
  assertNoArtifactTrustExpansion,
  diffArtifactTrustPolicies,
  evaluateArtifactTrust,
  serializeArtifactTrustPolicy,
  validateArtifactTrustPolicy,
} from '../../lib/trust-next/artifact-trust.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

test('artifact trust is exact digest + usage and defaults to untrusted', () => {
  const policy = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'adapter', sha256: A }], revoked: [] };
  assert.equal(evaluateArtifactTrust(policy, { usage: 'adapter', sha256: A }).decision, 'trusted');
  assert.equal(evaluateArtifactTrust(policy, { usage: 'grammar', sha256: A }).decision, 'untrusted');
  assert.equal(evaluateArtifactTrust(policy, { usage: 'adapter', sha256: B }).decision, 'untrusted');
});

test('revoked digest may not remain in allowlist and revoked lookup fails closed', () => {
  const invalid = validateArtifactTrustPolicy({
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1,
    allow: [{ usage: 'helper', sha256: A }],
    revoked: [{ sha256: A, reason: 'known vulnerable helper' }],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.some((x) => x.code === 'ALLOWLIST_CONTAINS_REVOKED_DIGEST'), true);

  const policy = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 2, allow: [],
    revoked: [{ sha256: A, reason: 'known vulnerable helper' }],
  };
  const decision = evaluateArtifactTrust(policy, { usage: 'helper', sha256: A });
  assert.equal(decision.decision, 'revoked');
  assert.throws(() => assertArtifactTrusted(policy, { usage: 'helper', sha256: A }), (e) => e?.code === 'ARTIFACT_REVOKED');
});

test('policy normalization is deterministic across input order and duplicates', () => {
  const p1 = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 7,
    allow: [{ usage: 'schema', sha256: B }, { usage: 'adapter', sha256: A }, { usage: 'adapter', sha256: A }],
    revoked: [{ sha256: C, reason: 'superseded and unsafe' }],
  };
  const p2 = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 7,
    allow: [{ usage: 'adapter', sha256: A }, { usage: 'schema', sha256: B }],
    revoked: [{ sha256: C, reason: 'superseded and unsafe' }, { sha256: C, reason: 'superseded and unsafe' }],
  };
  assert.equal(serializeArtifactTrustPolicy(p1), serializeArtifactTrustPolicy(p2));
  assert.equal(artifactTrustPolicyDigest(p1), artifactTrustPolicyDigest(p2));
  assert.match(artifactTrustPolicyDigest(p1), /^[0-9a-f]{64}$/);
  assert.equal(ARTIFACT_TRUST_DIGEST_FORMAT, 'bskel.trust-artifact-policy-json/1');
});

test('policy digest changes when a grant or revocation changes', () => {
  const p1 = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [], revoked: [] };
  const p2 = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'runner', sha256: A }], revoked: [] };
  const p3 = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [], revoked: [{ sha256: A, reason: 'runner digest withdrawn' }] };
  assert.notEqual(artifactTrustPolicyDigest(p1), artifactTrustPolicyDigest(p2));
  assert.notEqual(artifactTrustPolicyDigest(p1), artifactTrustPolicyDigest(p3));
});

test('trust policy diff treats new allows, revocation removal and generation rollback as expansions', () => {
  const before = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 4,
    allow: [{ usage: 'adapter', sha256: A }],
    revoked: [{ sha256: C, reason: 'withdrawn artifact digest' }],
  };
  const after = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 3,
    allow: [{ usage: 'adapter', sha256: A }, { usage: 'helper', sha256: B }],
    revoked: [],
  };
  const delta = diffArtifactTrustPolicies(before, after);
  assert.equal(delta.expanded, true);
  assert.equal(delta.expansions.some((x) => x.change === 'allow-added'), true);
  assert.equal(delta.expansions.some((x) => x.change === 'revocation-removed'), true);
  assert.equal(delta.expansions.some((x) => x.change === 'generation-rollback'), true);
});

test('adding a revocation and removing an allow are reductions', () => {
  const before = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'adapter', sha256: A }], revoked: [] };
  const after = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 2, allow: [], revoked: [{ sha256: B, reason: 'untrusted test artifact' }] };
  const delta = diffArtifactTrustPolicies(before, after);
  assert.equal(delta.reduced, true);
  assert.equal(delta.expanded, false);
  assert.deepEqual(delta.reductions.map((x) => x.change).sort(), ['allow-removed', 'revocation-added']);
});

test('invalid hashes, usages, fields and conflicting revocation reasons fail closed', () => {
  for (const policy of [
    { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'adapter', sha256: 'A'.repeat(64) }], revoked: [] },
    { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'unknown', sha256: A }], revoked: [] },
    { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [], revoked: [], latest: true },
    { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [], revoked: [{ sha256: A, reason: 'first reason long enough' }, { sha256: A, reason: 'second reason also long enough' }] },
  ]) assert.equal(validateArtifactTrustPolicy(policy).ok, false);
});

test('lookup input cannot smuggle mutable names, URLs or extra fields', () => {
  const policy = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 1, allow: [{ usage: 'package', sha256: A }], revoked: [] };
  for (const ref of [
    { usage: 'package', sha256: A, tag: 'latest' },
    { usage: 'package', sha256: A, url: 'https://example.com/pkg' },
    { usage: 'package', sha256: A, version: '1.2.3' },
  ]) assert.throws(() => evaluateArtifactTrust(policy, ref), (e) => e?.code === 'INVALID_ARTIFACT_TRUST_REF');
});


test('artifact trust expansion guard allows tightening and rejects new trust or revocation removal', () => {
  const broad = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 2,
    allow: [{ usage: 'adapter', sha256: A }],
    revoked: [],
  };
  const narrow = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 3,
    allow: [],
    revoked: [{ sha256: B, reason: 'blocked by security review' }],
  };
  const reduction = assertNoArtifactTrustExpansion(broad, narrow);
  assert.equal(reduction.expanded, false);
  assert.equal(reduction.reduced, true);

  const before = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 4,
    allow: [],
    revoked: [{ sha256: C, reason: 'withdrawn after review' }],
  };
  const after = {
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 5,
    allow: [{ usage: 'helper', sha256: B }],
    revoked: [],
  };
  assert.throws(
    () => assertNoArtifactTrustExpansion(before, after),
    (error) => error?.code === 'ARTIFACT_TRUST_EXPANSION_REQUIRES_APPROVAL'
      && error.delta?.expansions.some((x) => x.change === 'allow-added')
      && error.delta?.expansions.some((x) => x.change === 'revocation-removed'),
  );
});


test('artifact trust policy rejects oversized allow/revoke collections and control-character reasons', () => {
  const tooManyAllow = validateArtifactTrustPolicy({
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 1,
    allow: Array.from({ length: 1025 }, (_, i) => ({
      usage: 'adapter',
      sha256: i.toString(16).padStart(64, '0').slice(-64),
    })),
    revoked: [],
  });
  assert.equal(tooManyAllow.ok, false);
  assert.equal(tooManyAllow.errors.some((x) => x.code === 'TOO_MANY_TRUST_ALLOW_ENTRIES'), true);

  const tooManyRevoked = validateArtifactTrustPolicy({
    schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    generation: 1,
    allow: [],
    revoked: Array.from({ length: 1025 }, (_, i) => ({
      sha256: i.toString(16).padStart(64, '0').slice(-64),
      reason: `security review revoked artifact ${i}`,
    })),
  });
  assert.equal(tooManyRevoked.ok, false);
  assert.equal(tooManyRevoked.errors.some((x) => x.code === 'TOO_MANY_REVOCATIONS'), true);

  for (const reason of ['bad\nreason text', 'bad\treason text', 'bad\u0000reason text']) {
    const result = validateArtifactTrustPolicy({
      schema: ARTIFACT_TRUST_POLICY_SCHEMA,
      generation: 1,
      allow: [],
      revoked: [{ sha256: A, reason }],
    });
    assert.equal(result.ok, false, JSON.stringify(reason));
    assert.equal(result.errors.some((x) => x.code === 'INVALID_REVOCATION_REASON'), true);
  }
});
