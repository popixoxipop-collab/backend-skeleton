import { validateTrustEvidenceEcho } from './trust-requirements.mjs';
import { evaluateAdversarialResults } from './adversarial-evaluator.mjs';
import { verifyArtifactTrustPolicySignature } from './artifact-trust-signature.mjs';

export const SECURITY_CLOSEOUT_CONTRACT = 'bskel.trust-security-closeout/1';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_REF = /^[A-Za-z0-9._:@/+\-=]{1,256}$/;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refs(value, field, errors, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > 64) {
    errors.push({ code: 'CLOSEOUT_EVIDENCE_REFS_INVALID', field, message: `must contain ${min}..64 evidence refs` });
    return [];
  }
  const out = [];
  for (let i = 0; i < Math.min(value.length, 64); i += 1) {
    const ref = value[i];
    if (typeof ref !== 'string' || !EVIDENCE_REF.test(ref) || /[\u0000-\u001f\u007f]/.test(ref)) {
      errors.push({ code: 'CLOSEOUT_EVIDENCE_REF_INVALID', field: `${field}[${i}]` });
    } else out.push(ref);
  }
  return [...new Set(out)].sort();
}

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
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

export function evaluateSecurityCloseout({
  revisionSha,
  runtimeProfile,
  trustRequirements,
  trustEvidenceEcho,
  adversarialSpec,
  adversarialResults,
  artifactTrustPolicy,
  artifactTrustSignature,
  artifactTrustPublicKeyPem,
  minimumTrustGeneration,
  secretScan,
  cleanup,
  downgradeRehearsal,
  nonwaivableBlockers = [],
}) {
  const errors = [];
  const blockers = normalizeBlockers(nonwaivableBlockers, errors);

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
    refs(runtimeProfile.evidence_refs, 'runtimeProfile.evidence_refs', errors);
  }

  const trustEcho = validateTrustEvidenceEcho(trustRequirements, trustEvidenceEcho);
  if (!trustEcho.ok) {
    for (const item of trustEcho.errors) errors.push({ code: `CLOSEOUT_TRUST_${item.code}`, field: item.path ?? item.field ?? null });
  }

  let adversarial = null;
  try {
    adversarial = evaluateAdversarialResults(adversarialSpec, adversarialResults);
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
    { minimumGeneration: minimumTrustGeneration },
  );
  if (!signature.ok) {
    for (const item of signature.errors) errors.push({ code: `CLOSEOUT_SIGNATURE_${item.code}`, field: item.field ?? null });
  }

  if (!plain(secretScan) || !Number.isSafeInteger(secretScan.leaks) || secretScan.leaks < 0) {
    errors.push({ code: 'CLOSEOUT_SECRET_SCAN_INVALID', field: 'secretScan' });
  } else {
    refs(secretScan.evidence_refs, 'secretScan.evidence_refs', errors);
    if (secretScan.leaks !== 0) {
      errors.push({ code: 'CLOSEOUT_SECRET_LEAK', field: 'secretScan.leaks', count: secretScan.leaks });
    }
  }

  if (!plain(cleanup) || !Number.isSafeInteger(cleanup.orphan_resources) || cleanup.orphan_resources < 0) {
    errors.push({ code: 'CLOSEOUT_CLEANUP_INVALID', field: 'cleanup' });
  } else {
    refs(cleanup.evidence_refs, 'cleanup.evidence_refs', errors);
    if (cleanup.orphan_resources !== 0) {
      errors.push({ code: 'CLOSEOUT_ORPHAN_RESOURCES', field: 'cleanup.orphan_resources', count: cleanup.orphan_resources });
    }
  }

  if (!plain(downgradeRehearsal)) {
    errors.push({ code: 'CLOSEOUT_DOWNGRADE_REHEARSAL_INVALID', field: 'downgradeRehearsal' });
  } else {
    refs(downgradeRehearsal.evidence_refs, 'downgradeRehearsal.evidence_refs', errors);
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

export function assertSecurityCloseout(input) {
  const result = evaluateSecurityCloseout(input);
  if (result.ready) return result;
  const error = new Error('T20 security closeout is not ready');
  error.code = 'T20_SECURITY_CLOSEOUT_BLOCKED';
  error.details = result.errors;
  throw error;
}
