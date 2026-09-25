import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from '../../lib/attest.mjs';
import { signArtifactTrustPolicy } from '../../lib/trust-next/artifact-trust-signature.mjs';
import { buildTrustRequirements } from '../../lib/trust-next/trust-requirements.mjs';
import {
  SECURITY_CLOSEOUT_CONTRACT,
  assertSecurityCloseout,
  evaluateSecurityCloseout,
} from '../../lib/trust-next/security-closeout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'adversarial-fixtures.json'), 'utf8'));
const A = 'a'.repeat(64);

function fixture() {
  const keys = generateKeypair();
  const permission = {
    schema: 'bskel.trust-permissions/1',
    read_roots: ['src'],
    network: { mode: 'deny', allow: [] },
    listen: { mode: 'deny', allow: [] },
  };
  const trust = {
    schema: 'bskel.trust-artifact-policy/1',
    generation: 9,
    allow: [{ usage: 'runner', sha256: A }],
    revoked: [],
  };
  const req = buildTrustRequirements({ permissionManifest: permission, artifactTrustPolicy: trust });
  const echo = {
    contract: 'bskel.trust-evidence-echo/1',
    permission: { ...req.permission, enforced: true },
    artifact_policy: { ...req.artifact_policy, enforced: true },
  };
  const results = SPEC.cases
    .filter((x) => ['runner', 'evidence'].includes(x.layer))
    .map((x) => ({
      id: x.id,
      outcome: 'pass',
      observer_kind: x.observer.kind,
      evidence_refs: [`artifact:${x.id.toLowerCase()}`],
    }));
  return {
    input: {
      revisionSha: '1'.repeat(40),
      runtimeProfile: {
        implementation_sha256: '2'.repeat(64),
        profile_sha256: '3'.repeat(64),
        evidence_refs: ['artifact:runtime-profile'],
      },
      trustRequirements: req,
      trustEvidenceEcho: echo,
      adversarialSpec: SPEC,
      adversarialResults: results,
      artifactTrustPolicy: trust,
      artifactTrustSignature: signArtifactTrustPolicy(trust, keys.privateKeyPem),
      artifactTrustPublicKeyPem: keys.publicKeyPem,
      minimumTrustGeneration: 9,
      secretScan: { leaks: 0, evidence_refs: ['artifact:secret-scan'] },
      cleanup: { orphan_resources: 0, evidence_refs: ['artifact:cleanup'] },
      downgradeRehearsal: {
        revoked_artifact_denied: true,
        permission_expansion_denied: true,
        trust_generation_rollback_denied: true,
        evidence_refs: ['artifact:downgrade-rehearsal'],
      },
      nonwaivableBlockers: [],
    },
  };
}

test('synthetic all-green inputs exercise closeout semantics without claiming product closeout', () => {
  const { input } = fixture();
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.contract, SECURITY_CLOSEOUT_CONTRACT);
  assert.equal(result.ready, true, JSON.stringify(result.errors));
  assert.equal(result.trust_signature_verified, true);
  assert.equal(result.trust_evidence_verified, true);
  assert.deepEqual({ ...result.adversarial.counts }, { pass: 14, fail: 0, blocked: 0, missing: 0 });
  assert.match(result.note, /T19\/T23\/T00/);
});

test('missing actual runner enforcement evidence blocks closeout', () => {
  const { input } = fixture();
  input.trustEvidenceEcho.permission.enforced = false;
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_TRUST_PERMISSION_NOT_ENFORCED'), true);
});

test('blocked adversarial runner case blocks closeout', () => {
  const { input } = fixture();
  const target = input.adversarialResults.find((x) => x.id === 'TRUST-NET-01');
  target.outcome = 'blocked';
  target.evidence_refs = [];
  target.blocked_reason = 'network isolation profile not admitted';
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_ADVERSARIAL_NOT_READY'), true);
  assert.equal(result.adversarial.counts.blocked, 1);
});

test('secret leak and orphan process/resource are non-closeout states', () => {
  const { input } = fixture();
  input.secretScan.leaks = 1;
  input.cleanup.orphan_resources = 2;
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_SECRET_LEAK'), true);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_ORPHAN_RESOURCES'), true);
});

test('signed but stale trust generation still blocks closeout', () => {
  const { input } = fixture();
  input.minimumTrustGeneration = 10;
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.trust_signature_verified, false);
  assert.equal(result.errors.some((x) => x.code.includes('TRUST_POLICY_GENERATION_ROLLBACK')), true);
});

test('failed downgrade rehearsal blocks closeout', () => {
  const { input } = fixture();
  input.downgradeRehearsal.permission_expansion_denied = false;
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_PERMISSION_EXPANSION_NOT_DENIED'), true);
});

test('nonwaivable blocker always blocks closeout even when all positive evidence exists', () => {
  const { input } = fixture();
  input.nonwaivableBlockers = ['SANDBOX_ESCAPE'];
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['SANDBOX_ESCAPE']);
  assert.throws(() => assertSecurityCloseout(input), (e) => e?.code === 'T20_SECURITY_CLOSEOUT_BLOCKED');
});

test('invalid revision/profile/evidence refs fail closed', () => {
  const { input } = fixture();
  input.revisionSha = 'main';
  input.runtimeProfile.profile_sha256 = 'latest';
  input.runtimeProfile.evidence_refs = [];
  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  for (const code of [
    'CLOSEOUT_REVISION_INVALID',
    'CLOSEOUT_RUNTIME_PROFILE_DIGEST_INVALID',
    'CLOSEOUT_EVIDENCE_REFS_INVALID',
  ]) assert.equal(result.errors.some((x) => x.code === code), true, code);
});
