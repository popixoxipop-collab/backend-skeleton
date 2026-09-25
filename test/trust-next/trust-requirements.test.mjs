import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRUST_ECHO_CONTRACT,
  TRUST_REQUIREMENTS_CONTRACT,
  assertTrustEvidenceEcho,
  buildTrustRequirements,
  validateTrustEvidenceEcho,
  validateTrustRequirements,
} from '../../lib/trust-next/trust-requirements.mjs';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { ARTIFACT_TRUST_POLICY_SCHEMA } from '../../lib/trust-next/artifact-trust.mjs';

const A = 'a'.repeat(64);
const permission = () => ({
  schema: PERMISSION_MANIFEST_SCHEMA,
  read_roots: ['src'],
  environment: { allow: ['CI'] },
});
const trust = () => ({
  schema: ARTIFACT_TRUST_POLICY_SCHEMA,
  generation: 7,
  allow: [{ usage: 'runner', sha256: A }],
  revoked: [],
});

function echo(req) {
  return {
    contract: TRUST_ECHO_CONTRACT,
    permission: { ...req.permission, enforced: true },
    artifact_policy: { ...req.artifact_policy, enforced: true },
  };
}

test('trust requirements bind exact normalized permission and artifact-policy identities', () => {
  const req = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  assert.equal(req.contract, TRUST_REQUIREMENTS_CONTRACT);
  assert.match(req.permission.sha256, /^[0-9a-f]{64}$/);
  assert.match(req.artifact_policy.sha256, /^[0-9a-f]{64}$/);
  assert.equal(req.artifact_policy.generation, 7);
  assert.equal(Object.isFrozen(req), true);
  assert.equal(Object.isFrozen(req.permission), true);
  assert.equal(Object.isFrozen(req.artifact_policy), true);
  assert.equal(validateTrustRequirements(req).ok, true);
});

test('semantically equivalent input manifests produce the same trust requirements', () => {
  const a = buildTrustRequirements({
    permissionManifest: {
      schema: PERMISSION_MANIFEST_SCHEMA,
      read_roots: ['src', 'src'],
      environment: { allow: ['CI', 'CI'] },
    },
    artifactTrustPolicy: {
      schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 7,
      allow: [{ usage: 'runner', sha256: A }, { usage: 'runner', sha256: A }],
      revoked: [],
    },
  });
  const b = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  assert.deepEqual(a, b);
});

test('matching enforced evidence echo passes', () => {
  const req = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  const result = validateTrustEvidenceEcho(req, echo(req));
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(assertTrustEvidenceEcho(req, echo(req)).ok, true);
});

test('receipt without enforcement is not enough', () => {
  const req = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  const observed = echo(req);
  observed.permission.enforced = false;
  observed.artifact_policy.enforced = false;
  const result = validateTrustEvidenceEcho(req, observed);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((x) => x.code === 'PERMISSION_NOT_ENFORCED'), true);
  assert.equal(result.errors.some((x) => x.code === 'ARTIFACT_POLICY_NOT_ENFORCED'), true);
});

test('digest and generation mismatch fail closed', () => {
  const req = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  const observed = echo(req);
  observed.permission.sha256 = 'b'.repeat(64);
  observed.artifact_policy.sha256 = 'c'.repeat(64);
  observed.artifact_policy.generation = 6;
  const result = validateTrustEvidenceEcho(req, observed);
  assert.equal(result.ok, false);
  for (const code of ['PERMISSION_DIGEST_MISMATCH', 'ARTIFACT_POLICY_DIGEST_MISMATCH', 'ARTIFACT_POLICY_GENERATION_MISMATCH']) {
    assert.equal(result.errors.some((x) => x.code === code), true, code);
  }
  assert.throws(() => assertTrustEvidenceEcho(req, observed), (error) => error?.code === 'TRUST_EVIDENCE_MISMATCH');
});

test('echo cannot smuggle runner, display-name, URL, or mutable authority fields', () => {
  const req = buildTrustRequirements({ permissionManifest: permission(), artifactTrustPolicy: trust() });
  for (const [container, key, value] of [
    ['root', 'runner', 'docker'],
    ['root', 'profile', 'latest'],
    ['permission', 'name', 'default'],
    ['artifact_policy', 'url', 'https://example.com/policy'],
  ]) {
    const observed = echo(req);
    if (container === 'root') observed[key] = value;
    else observed[container][key] = value;
    const result = validateTrustEvidenceEcho(req, observed);
    assert.equal(result.ok, false, `${container}.${key}`);
    assert.equal(result.errors.some((x) => x.code === 'UNKNOWN_TRUST_REQUIREMENT_FIELD'), true, `${container}.${key}`);
  }
});

test('invalid input policies never produce trusted requirement identities', () => {
  assert.throws(
    () => buildTrustRequirements({
      permissionManifest: { schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['../secret'] },
      artifactTrustPolicy: trust(),
    }),
    (error) => error?.code === 'INVALID_PERMISSION_MANIFEST',
  );
  assert.throws(
    () => buildTrustRequirements({
      permissionManifest: permission(),
      artifactTrustPolicy: { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: 0, allow: [], revoked: [] },
    }),
    (error) => error?.code === 'INVALID_ARTIFACT_TRUST_POLICY',
  );
});
