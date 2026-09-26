import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICALIZATION_ID,
  generateKeypair,
  publicKeyIdFromPublic,
  signPayload,
} from '../../lib/attest.mjs';
import { signArtifactTrustPolicy } from '../../lib/trust-next/artifact-trust-signature.mjs';
import { buildTrustRequirements } from '../../lib/trust-next/trust-requirements.mjs';
import {
  EVIDENCE_ATTESTATION_CONTRACT,
  EVIDENCE_SET_CONTRACT,
  SECURITY_CLOSEOUT_CONTRACT,
  assertSecurityCloseout,
  evaluateSecurityCloseout,
} from '../../lib/trust-next/security-closeout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'adversarial-fixtures.json'), 'utf8'));
const A = 'a'.repeat(64);
const evidenceRef = (label) => 'sha256:' + crypto.createHash('sha256').update(label).digest('hex');

function evidenceAttestation(revisionSha, refs, keys) {
  const payload = {
    contract: EVIDENCE_SET_CONTRACT,
    revision_sha: revisionSha,
    evidence_refs: [...new Set(refs)].sort(),
  };
  return {
    contract: EVIDENCE_ATTESTATION_CONTRACT,
    algorithm: 'ed25519',
    canonicalization: CANONICALIZATION_ID,
    key_id: publicKeyIdFromPublic(keys.publicKeyPem),
    payload,
    signature: signPayload(payload, keys.privateKeyPem),
  };
}

function fixture() {
  const trustKeys = generateKeypair();
  const evidenceKeys = generateKeypair();
  const revisionSha = '1'.repeat(40);
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

  const trustEchoRef = evidenceRef('trust-echo');
  const runtimeRef = evidenceRef('runtime-profile');
  const secretRef = evidenceRef('secret-scan');
  const cleanupRef = evidenceRef('cleanup');
  const downgradeRef = evidenceRef('downgrade-rehearsal');
  const results = SPEC.cases
    .filter((x) => ['runner', 'evidence'].includes(x.layer))
    .map((x) => ({
      id: x.id,
      outcome: 'pass',
      observer_kind: x.observer.kind,
      evidence_refs: [evidenceRef('adversarial:' + x.id)],
    }));
  const verifiedRefs = [
    trustEchoRef,
    runtimeRef,
    secretRef,
    cleanupRef,
    downgradeRef,
    ...results.flatMap((x) => x.evidence_refs),
  ];

  const echo = {
    contract: 'bskel.trust-evidence-echo/1',
    permission: { ...req.permission, enforced: true },
    artifact_policy: { ...req.artifact_policy, enforced: true },
    evidence_refs: [trustEchoRef],
  };

  const authority = {
    authorityRef: evidenceRef('t20-closeout-authority'),
    trustedArtifactSignerKeyIds: [publicKeyIdFromPublic(trustKeys.publicKeyPem)],
    trustedEvidenceVerifierKeyIds: [publicKeyIdFromPublic(evidenceKeys.publicKeyPem)],
    minimumArtifactTrustGeneration: 9,
  };

  return {
    trustKeys,
    evidenceKeys,
    authority,
    input: {
      revisionSha,
      runtimeProfile: {
        implementation_sha256: '2'.repeat(64),
        profile_sha256: '3'.repeat(64),
        evidence_refs: [runtimeRef],
      },
      trustRequirements: req,
      trustEvidenceEcho: echo,
      adversarialSpec: SPEC,
      adversarialResults: results,
      artifactTrustPolicy: trust,
      artifactTrustSignature: signArtifactTrustPolicy(trust, trustKeys.privateKeyPem),
      artifactTrustPublicKeyPem: trustKeys.publicKeyPem,
      evidenceAttestation: evidenceAttestation(revisionSha, verifiedRefs, evidenceKeys),
      evidenceVerifierPublicKeyPem: evidenceKeys.publicKeyPem,
      secretScan: { leaks: 0, evidence_refs: [secretRef] },
      cleanup: { orphan_resources: 0, evidence_refs: [cleanupRef] },
      downgradeRehearsal: {
        revoked_artifact_denied: true,
        permission_expansion_denied: true,
        trust_generation_rollback_denied: true,
        evidence_refs: [downgradeRef],
      },
      nonwaivableBlockers: [],
    },
  };
}

test('synthetic externally anchored inputs exercise closeout semantics without claiming product closeout', () => {
  const { input, authority } = fixture();
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.contract, SECURITY_CLOSEOUT_CONTRACT);
  assert.equal(result.ready, true, JSON.stringify(result.errors));
  assert.equal(result.trust_signature_verified, true);
  assert.equal(result.trust_evidence_verified, true);
  assert.deepEqual({ ...result.adversarial.counts }, { pass: 14, fail: 0, blocked: 0, missing: 0 });
  assert.match(result.note, /T19\/T23\/T00/);
});

test('missing actual runner enforcement evidence blocks closeout', () => {
  const { input, authority } = fixture();
  input.trustEvidenceEcho.permission.enforced = false;
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_TRUST_PERMISSION_NOT_ENFORCED'), true);
});

test('blocked adversarial runner case blocks closeout', () => {
  const { input, authority } = fixture();
  const target = input.adversarialResults.find((x) => x.id === 'TRUST-NET-01');
  target.outcome = 'blocked';
  target.evidence_refs = [];
  target.blocked_reason = 'network isolation profile not admitted';
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_ADVERSARIAL_NOT_READY'), true);
  assert.equal(result.adversarial.counts.blocked, 1);
});

test('secret leak and orphan process/resource are non-closeout states', () => {
  const { input, authority } = fixture();
  input.secretScan.leaks = 1;
  input.cleanup.orphan_resources = 2;
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_SECRET_LEAK'), true);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_ORPHAN_RESOURCES'), true);
});

test('signed but stale trust generation still blocks closeout', () => {
  const { input, authority } = fixture();
  authority.minimumArtifactTrustGeneration = 10;
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.trust_signature_verified, false);
  assert.equal(result.errors.some((x) => x.code.includes('TRUST_POLICY_GENERATION_ROLLBACK')), true);
});

test('failed downgrade rehearsal blocks closeout', () => {
  const { input, authority } = fixture();
  input.downgradeRehearsal.permission_expansion_denied = false;
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_PERMISSION_EXPANSION_NOT_DENIED'), true);
});

test('nonwaivable blocker always blocks closeout even when all positive evidence exists', () => {
  const { input, authority } = fixture();
  input.nonwaivableBlockers = ['SANDBOX_ESCAPE'];
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['SANDBOX_ESCAPE']);
  assert.throws(() => assertSecurityCloseout(input, authority), (e) => e?.code === 'T20_SECURITY_CLOSEOUT_BLOCKED');
});

test('invalid revision/profile/evidence refs fail closed', () => {
  const { input, authority } = fixture();
  input.revisionSha = 'main';
  input.runtimeProfile.profile_sha256 = 'latest';
  input.runtimeProfile.evidence_refs = [];
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  for (const code of [
    'CLOSEOUT_REVISION_INVALID',
    'CLOSEOUT_RUNTIME_PROFILE_DIGEST_INVALID',
    'CLOSEOUT_EVIDENCE_REFS_INVALID',
  ]) assert.equal(result.errors.some((x) => x.code === code), true, code);
});

test('caller-selected trust signing key cannot substitute for externally expected signer identity', () => {
  const { input, authority } = fixture();
  const attacker = generateKeypair();
  input.artifactTrustPublicKeyPem = attacker.publicKeyPem;
  input.artifactTrustSignature = signArtifactTrustPolicy(input.artifactTrustPolicy, attacker.privateKeyPem);
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_TRUST_SIGNER_UNTRUSTED'), true);
});

test('caller-signed evidence set cannot substitute for externally expected evidence verifier identity', () => {
  const { input, authority } = fixture();
  const attacker = generateKeypair();
  input.evidenceVerifierPublicKeyPem = attacker.publicKeyPem;
  input.evidenceAttestation = evidenceAttestation(
    input.revisionSha,
    input.evidenceAttestation.payload.evidence_refs,
    attacker,
  );
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_EVIDENCE_ATTESTATION_UNTRUSTED_KEY'), true);
});

test('content-addressed evidence still fails when absent from the trusted verifier attestation', () => {
  const { input, authority } = fixture();
  input.runtimeProfile.evidence_refs = [evidenceRef('not-attested-runtime')];
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_EVIDENCE_NOT_VERIFIED'), true);
});

test('evidence attestation is bound to the exact product revision', () => {
  const { input, evidenceKeys, authority } = fixture();
  input.evidenceAttestation = evidenceAttestation(
    'f'.repeat(40),
    input.evidenceAttestation.payload.evidence_refs,
    evidenceKeys,
  );
  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_EVIDENCE_SET_REVISION_MISMATCH'), true);
});


test('caller-generated signer and evidence verifier cannot bootstrap authority from closeout input', () => {
  const { input } = fixture();
  const attackerTrust = generateKeypair();
  const attackerEvidence = generateKeypair();
  input.artifactTrustPublicKeyPem = attackerTrust.publicKeyPem;
  input.artifactTrustSignature = signArtifactTrustPolicy(input.artifactTrustPolicy, attackerTrust.privateKeyPem);
  input.evidenceVerifierPublicKeyPem = attackerEvidence.publicKeyPem;
  input.evidenceAttestation = evidenceAttestation(
    input.revisionSha,
    input.evidenceAttestation.payload.evidence_refs,
    attackerEvidence,
  );
  input.expectedArtifactTrustKeyId = publicKeyIdFromPublic(attackerTrust.publicKeyPem);
  input.expectedEvidenceVerifierKeyId = publicKeyIdFromPublic(attackerEvidence.publicKeyPem);
  input.minimumTrustGeneration = 1;

  const result = evaluateSecurityCloseout(input);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_AUTHORITY_INVALID'), true);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_CALLER_AUTHORITY_FIELD_FORBIDDEN'), true);
  assert.equal(result.trust_signature_verified, true, 'cryptographic signature validity stays separate from signer trust');
});

test('authority is content-addressed and external to candidate closeout input', () => {
  const { input, authority } = fixture();
  const bad = { ...authority, authorityRef: 'latest' };
  const result = evaluateSecurityCloseout(input, bad);
  assert.equal(result.ready, false);
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_AUTHORITY_REF_INVALID'), true);
});

test('actual T16 enforcement matrix remains 4 PASS / 7 FAIL / 3 NOT_RUN and blocks closeout', () => {
  const { input, evidenceKeys, authority } = fixture();
  const passIds = new Set(['TRUST-PROC-02', 'TRUST-ENV-01', 'TRUST-OUT-01', 'TRUST-TIME-01']);
  const failIds = new Set([
    'TRUST-FS-03',
    'TRUST-FS-04',
    'TRUST-PROC-03',
    'TRUST-NET-01',
    'TRUST-NET-03',
    'TRUST-SECRET-02',
    'TRUST-EVID-01',
  ]);
  const notRunIds = new Set(['TRUST-NET-02', 'TRUST-ADAPTER-01', 'TRUST-BUILD-01']);

  input.adversarialResults = SPEC.cases
    .filter((x) => passIds.has(x.id) || failIds.has(x.id))
    .map((x) => ({
      id: x.id,
      outcome: passIds.has(x.id) ? 'pass' : 'fail',
      observer_kind: x.observer.kind,
      evidence_refs: [evidenceRef('actual-t16:' + x.id)],
    }));

  const attestedRefs = [
    ...input.runtimeProfile.evidence_refs,
    ...input.trustEvidenceEcho.evidence_refs,
    ...input.secretScan.evidence_refs,
    ...input.cleanup.evidence_refs,
    ...input.downgradeRehearsal.evidence_refs,
    ...input.adversarialResults.flatMap((x) => x.evidence_refs),
  ];
  input.evidenceAttestation = evidenceAttestation(input.revisionSha, attestedRefs, evidenceKeys);

  const result = evaluateSecurityCloseout(input, authority);
  assert.equal(result.ready, false);
  assert.deepEqual({ ...result.adversarial.counts }, { pass: 4, fail: 7, blocked: 0, missing: 3 });
  assert.deepEqual(result.adversarial.missing, [...notRunIds].sort());
  assert.equal(result.errors.some((x) => x.code === 'CLOSEOUT_ADVERSARIAL_NOT_READY'), true);
});
