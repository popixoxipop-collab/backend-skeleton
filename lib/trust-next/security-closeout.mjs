import { validateTrustEvidenceEcho } from './trust-requirements.mjs';
import { evaluateAdversarialResults } from './adversarial-evaluator.mjs';
import { verifyArtifactTrustPolicySignature } from './artifact-trust-signature.mjs';
import {
  CANONICALIZATION_ID,
  publicKeyIdFromPublic,
  verifyPayload,
} from '../attest.mjs';

export const SECURITY_CLOSEOUT_CONTRACT = 'bskel.trust-security-closeout/1';
export const EVIDENCE_ATTESTATION_CONTRACT = 'bskel.trust-evidence-set-attestation/1';
export const EVIDENCE_SET_CONTRACT = 'bskel.trust-evidence-set/1';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_REF = /^sha256:[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{32}$/;
const AUTHORITY_KEYS = new Set([
  'authorityRef',
  'trustedArtifactSignerKeyIds',
  'trustedEvidenceVerifierKeyIds',
  'minimumArtifactTrustGeneration',
]);
const CALLER_AUTHORITY_FIELDS = new Set([
  'expectedArtifactTrustKeyId',
  'expectedEvidenceVerifierKeyId',
  'minimumTrustGeneration',
]);

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refs(value, field, errors, min = 1, verifiedSet = null) {
  if (!Array.isArray(value) || value.length < min || value.length > 64) {
    errors.push({ code: 'CLOSEOUT_EVIDENCE_REFS_INVALID', field, message: `must contain ${min}..64 evidence refs` });
    return [];
  }
  const out = [];
  for (let i = 0; i < Math.min(value.length, 64); i += 1) {
    const ref = value[i];
    if (typeof ref !== 'string' || !EVIDENCE_REF.test(ref)) {
      errors.push({ code: 'CLOSEOUT_EVIDENCE_REF_INVALID', field: `${field}[${i}]` });
    } else {
      out.push(ref);
      if (verifiedSet !== null && !verifiedSet.has(ref)) {
        errors.push({ code: 'CLOSEOUT_EVIDENCE_NOT_VERIFIED', field: `${field}[${i}]`, evidence_ref: ref });
      }
    }
  }
  return [...new Set(out)].sort();
}

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function verifyEvidenceAttestation({
  revisionSha,
  envelope,
  publicKeyPem,
  trustedKeyIds,
}) {
  const errors = [];
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
    errors.push({ code: 'EVIDENCE_VERIFIER_PUBLIC_KEY_INVALID', field: 'evidenceVerifierPublicKeyPem' });
    return { ok: false, errors, refs: [] };
  }
  if (!plain(envelope)) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_INVALID', field: 'evidenceAttestation' });
    return { ok: false, errors, refs: [] };
  }

  const envelopeKeys = new Set(['contract', 'algorithm', 'canonicalization', 'key_id', 'payload', 'signature']);
  for (const key of Object.keys(envelope)) {
    if (!envelopeKeys.has(key)) errors.push({ code: 'EVIDENCE_ATTESTATION_UNKNOWN_FIELD', field: `evidenceAttestation.${key}` });
  }
  if (envelope.contract !== EVIDENCE_ATTESTATION_CONTRACT) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_CONTRACT_MISMATCH', field: 'evidenceAttestation.contract' });
  }
  if (envelope.algorithm !== 'ed25519') {
    errors.push({ code: 'EVIDENCE_ATTESTATION_ALGORITHM_MISMATCH', field: 'evidenceAttestation.algorithm' });
  }
  if (envelope.canonicalization !== CANONICALIZATION_ID) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_CANONICALIZATION_MISMATCH', field: 'evidenceAttestation.canonicalization' });
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0 || envelope.signature.length > 1024) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_SIGNATURE_INVALID', field: 'evidenceAttestation.signature' });
  }

  let observedKeyId = null;
  try {
    observedKeyId = publicKeyIdFromPublic(publicKeyPem);
  } catch {
    errors.push({ code: 'EVIDENCE_VERIFIER_PUBLIC_KEY_INVALID', field: 'evidenceVerifierPublicKeyPem' });
  }
  if (observedKeyId !== null) {
    if (envelope.key_id !== observedKeyId) {
      errors.push({ code: 'EVIDENCE_ATTESTATION_KEY_ID_MISMATCH', field: 'evidenceAttestation.key_id' });
    }
    if (!(trustedKeyIds instanceof Set) || !trustedKeyIds.has(observedKeyId)) {
      errors.push({ code: 'EVIDENCE_ATTESTATION_UNTRUSTED_KEY', field: 'evidenceAttestation.key_id' });
    }
  }

  let verifiedRefs = [];
  if (!plain(envelope.payload)) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_PAYLOAD_INVALID', field: 'evidenceAttestation.payload' });
  } else {
    const payloadKeys = new Set(['contract', 'revision_sha', 'evidence_refs']);
    for (const key of Object.keys(envelope.payload)) {
      if (!payloadKeys.has(key)) errors.push({ code: 'EVIDENCE_ATTESTATION_PAYLOAD_UNKNOWN_FIELD', field: `evidenceAttestation.payload.${key}` });
    }
    if (envelope.payload.contract !== EVIDENCE_SET_CONTRACT) {
      errors.push({ code: 'EVIDENCE_SET_CONTRACT_MISMATCH', field: 'evidenceAttestation.payload.contract' });
    }
    if (envelope.payload.revision_sha !== revisionSha) {
      errors.push({ code: 'EVIDENCE_SET_REVISION_MISMATCH', field: 'evidenceAttestation.payload.revision_sha' });
    }
    verifiedRefs = refs(envelope.payload.evidence_refs, 'evidenceAttestation.payload.evidence_refs', errors, 1);
  }

  if (errors.length === 0 && !verifyPayload(envelope.payload, envelope.signature, publicKeyPem)) {
    errors.push({ code: 'EVIDENCE_ATTESTATION_SIGNATURE_FAILED', field: 'evidenceAttestation.signature' });
  }
  return { ok: errors.length === 0, errors, refs: errors.length === 0 ? verifiedRefs : [] };
}

function normalizeTrustedKeyIds(value, field, errors) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    errors.push({ code: 'CLOSEOUT_AUTHORITY_KEY_IDS_INVALID', field, message: 'must contain 1..32 trusted Ed25519 key ids' });
    return new Set();
  }
  const out = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const keyId = value[i];
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) {
      errors.push({ code: 'CLOSEOUT_AUTHORITY_KEY_ID_INVALID', field: `${field}[${i}]` });
    } else {
      out.add(keyId);
    }
  }
  return out;
}

function normalizeAuthority(authority, errors) {
  if (!plain(authority)) {
    errors.push({ code: 'CLOSEOUT_AUTHORITY_INVALID', field: 'authority', message: 'trusted closeout authority must be supplied separately from candidate/input data' });
    return {
      authorityRef: null,
      trustedArtifactSignerKeyIds: new Set(),
      trustedEvidenceVerifierKeyIds: new Set(),
      minimumArtifactTrustGeneration: 1,
    };
  }
  for (const key of Object.keys(authority)) {
    if (!AUTHORITY_KEYS.has(key)) errors.push({ code: 'CLOSEOUT_AUTHORITY_UNKNOWN_FIELD', field: `authority.${key}` });
  }
  const authorityRef = authority.authorityRef;
  if (typeof authorityRef !== 'string' || !EVIDENCE_REF.test(authorityRef)) {
    errors.push({ code: 'CLOSEOUT_AUTHORITY_REF_INVALID', field: 'authority.authorityRef', message: 'authority must be bound to a content-addressed sha256 evidence ref' });
  }
  const trustedArtifactSignerKeyIds = normalizeTrustedKeyIds(
    authority.trustedArtifactSignerKeyIds,
    'authority.trustedArtifactSignerKeyIds',
    errors,
  );
  const trustedEvidenceVerifierKeyIds = normalizeTrustedKeyIds(
    authority.trustedEvidenceVerifierKeyIds,
    'authority.trustedEvidenceVerifierKeyIds',
    errors,
  );
  const minimumArtifactTrustGeneration = authority.minimumArtifactTrustGeneration;
  if (!Number.isSafeInteger(minimumArtifactTrustGeneration) || minimumArtifactTrustGeneration < 1) {
    errors.push({ code: 'CLOSEOUT_AUTHORITY_GENERATION_INVALID', field: 'authority.minimumArtifactTrustGeneration' });
  }
  return {
    authorityRef: typeof authorityRef === 'string' && EVIDENCE_REF.test(authorityRef) ? authorityRef : null,
    trustedArtifactSignerKeyIds,
    trustedEvidenceVerifierKeyIds,
    minimumArtifactTrustGeneration:
      Number.isSafeInteger(minimumArtifactTrustGeneration) && minimumArtifactTrustGeneration >= 1
        ? minimumArtifactTrustGeneration
        : 1,
  };
}

function normalizeBlockers(value, errors) {
  if (!Array.isArray(value) || value.length > 64) {
    errors.push({ code: 'CLOSEOUT_BLOCKERS_INVALID', field: 'nonwaivable_blockers' });
    return [];
  }
  const out = [];
  for (let i = 0; i < Math.min(value.length, 64); i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || item.length < 1 || item.length > 128 ||
        !/^[A-Z0-9][A-Z0-9_.:-]*$/.test(item)) {
      errors.push({ code: 'CLOSEOUT_BLOCKER_INVALID', field: `nonwaivable_blockers[${i}]` });
    } else out.push(item);
  }
  return [...new Set(out)].sort();
}

export function evaluateSecurityCloseout(input, authorityInput = null) {
  const errors = [];
  if (!plain(input)) {
    errors.push({ code: 'CLOSEOUT_INPUT_INVALID', field: '(root)' });
    input = {};
  }
  for (const field of CALLER_AUTHORITY_FIELDS) {
    if (Object.hasOwn(input, field)) {
      errors.push({
        code: 'CLOSEOUT_CALLER_AUTHORITY_FIELD_FORBIDDEN',
        field,
        message: 'trust roots and minimum generation are verifier authority, not caller-controlled closeout input',
      });
    }
  }
  const {
    revisionSha,
    runtimeProfile,
    trustRequirements,
    trustEvidenceEcho,
    adversarialSpec,
    adversarialResults,
    artifactTrustPolicy,
    artifactTrustSignature,
    artifactTrustPublicKeyPem,
    evidenceAttestation,
    evidenceVerifierPublicKeyPem,
    secretScan,
    cleanup,
    downgradeRehearsal,
    nonwaivableBlockers = [],
  } = input;

  const authority = normalizeAuthority(authorityInput, errors);
  const blockers = normalizeBlockers(nonwaivableBlockers, errors);
  const evidenceVerification = verifyEvidenceAttestation({
    revisionSha,
    envelope: evidenceAttestation,
    publicKeyPem: evidenceVerifierPublicKeyPem,
    trustedKeyIds: authority.trustedEvidenceVerifierKeyIds,
  });
  for (const item of evidenceVerification.errors) {
    errors.push({ code: `CLOSEOUT_${item.code}`, field: item.field ?? null });
  }
  const verifiedRefs = evidenceVerification.refs;
  const verifiedSet = new Set(verifiedRefs);

  let artifactSignerKeyId = null;
  try {
    artifactSignerKeyId = publicKeyIdFromPublic(artifactTrustPublicKeyPem);
  } catch {}
  if (artifactSignerKeyId === null || !authority.trustedArtifactSignerKeyIds.has(artifactSignerKeyId)) {
    errors.push({ code: 'CLOSEOUT_TRUST_SIGNER_UNTRUSTED', field: 'artifactTrustPublicKeyPem' });
  }

  if (typeof revisionSha !== 'string' || !GIT_SHA.test(revisionSha)) {
    errors.push({ code: 'CLOSEOUT_REVISION_INVALID', field: 'revisionSha' });
  }

  if (!plain(runtimeProfile)) {
    errors.push({ code: 'CLOSEOUT_RUNTIME_PROFILE_INVALID', field: 'runtimeProfile' });
  } else {
    if (typeof runtimeProfile.implementation_sha256 !== 'string' || !SHA256.test(runtimeProfile.implementation_sha256)) {
      errors.push({ code: 'CLOSEOUT_RUNNER_IMPLEMENTATION_INVALID', field: 'runtimeProfile.implementation_sha256' });
    }
    if (typeof runtimeProfile.profile_sha256 !== 'string' || !SHA256.test(runtimeProfile.profile_sha256)) {
      errors.push({ code: 'CLOSEOUT_RUNTIME_PROFILE_DIGEST_INVALID', field: 'runtimeProfile.profile_sha256' });
    }
    refs(runtimeProfile.evidence_refs, 'runtimeProfile.evidence_refs', errors, 1, verifiedSet);
  }

  const trustEcho = validateTrustEvidenceEcho(trustRequirements, trustEvidenceEcho, { verifiedEvidenceRefs: verifiedRefs });
  if (!trustEcho.ok) {
    for (const item of trustEcho.errors) errors.push({ code: `CLOSEOUT_TRUST_${item.code}`, field: item.path ?? item.field ?? null });
  }

  let adversarial = null;
  try {
    adversarial = evaluateAdversarialResults(adversarialSpec, adversarialResults, { verifiedEvidenceRefs: verifiedRefs });
    if (!adversarial.ready) {
      errors.push({
        code: 'CLOSEOUT_ADVERSARIAL_NOT_READY',
        field: 'adversarialResults',
        counts: adversarial.counts,
        missing: adversarial.missing,
      });
    }
  } catch (error) {
    errors.push({ code: 'CLOSEOUT_ADVERSARIAL_INVALID', field: 'adversarialResults', message: error.message });
  }

  const signature = verifyArtifactTrustPolicySignature(
    artifactTrustPolicy,
    artifactTrustSignature,
    artifactTrustPublicKeyPem,
    { minimumGeneration: authority.minimumArtifactTrustGeneration },
  );
  if (!signature.ok) {
    for (const item of signature.errors) errors.push({ code: `CLOSEOUT_SIGNATURE_${item.code}`, field: item.field ?? null });
  }

  if (!plain(secretScan) || !Number.isSafeInteger(secretScan.leaks) || secretScan.leaks < 0) {
    errors.push({ code: 'CLOSEOUT_SECRET_SCAN_INVALID', field: 'secretScan' });
  } else {
    refs(secretScan.evidence_refs, 'secretScan.evidence_refs', errors, 1, verifiedSet);
    if (secretScan.leaks !== 0) {
      errors.push({ code: 'CLOSEOUT_SECRET_LEAK', field: 'secretScan.leaks', count: secretScan.leaks });
    }
  }

  if (!plain(cleanup) || !Number.isSafeInteger(cleanup.orphan_resources) || cleanup.orphan_resources < 0) {
    errors.push({ code: 'CLOSEOUT_CLEANUP_INVALID', field: 'cleanup' });
  } else {
    refs(cleanup.evidence_refs, 'cleanup.evidence_refs', errors, 1, verifiedSet);
    if (cleanup.orphan_resources !== 0) {
      errors.push({ code: 'CLOSEOUT_ORPHAN_RESOURCES', field: 'cleanup.orphan_resources', count: cleanup.orphan_resources });
    }
  }

  if (!plain(downgradeRehearsal)) {
    errors.push({ code: 'CLOSEOUT_DOWNGRADE_REHEARSAL_INVALID', field: 'downgradeRehearsal' });
  } else {
    refs(downgradeRehearsal.evidence_refs, 'downgradeRehearsal.evidence_refs', errors, 1, verifiedSet);
    if (downgradeRehearsal.revoked_artifact_denied !== true) {
      errors.push({ code: 'CLOSEOUT_REVOKED_ARTIFACT_NOT_DENIED', field: 'downgradeRehearsal.revoked_artifact_denied' });
    }
    if (downgradeRehearsal.permission_expansion_denied !== true) {
      errors.push({ code: 'CLOSEOUT_PERMISSION_EXPANSION_NOT_DENIED', field: 'downgradeRehearsal.permission_expansion_denied' });
    }
    if (downgradeRehearsal.trust_generation_rollback_denied !== true) {
      errors.push({ code: 'CLOSEOUT_TRUST_ROLLBACK_NOT_DENIED', field: 'downgradeRehearsal.trust_generation_rollback_denied' });
    }
  }

  if (blockers.length > 0) {
    errors.push({ code: 'CLOSEOUT_NONWAIVABLE_BLOCKERS', field: 'nonwaivable_blockers', blockers });
  }

  const ready = errors.length === 0;
  return Object.freeze({
    contract: SECURITY_CLOSEOUT_CONTRACT,
    revision_sha: typeof revisionSha === 'string' ? revisionSha : null,
    authority_ref: authority.authorityRef,
    ready,
    blockers: Object.freeze(blockers),
    errors: Object.freeze(errors),
    adversarial: adversarial === null ? null : Object.freeze({
      ready: adversarial.ready,
      counts: adversarial.counts,
      missing: adversarial.missing,
    }),
    trust_signature_verified: signature.ok,
    trust_evidence_verified: trustEcho.ok,
    note: ready
      ? 'T20 security closeout inputs satisfy this evaluator. Release/support promotion still requires T19/T23/T00 and exact-head integration evidence.'
      : 'T20 security closeout is blocked; no security-complete or Runtime-tested claim may be emitted.',
  });
}

export function assertSecurityCloseout(input, authority) {
  const result = evaluateSecurityCloseout(input, authority);
  if (result.ready) return result;
  const error = new Error('T20 security closeout is not ready');
  error.code = 'T20_SECURITY_CLOSEOUT_BLOCKED';
  error.details = result.errors;
  throw error;
}
