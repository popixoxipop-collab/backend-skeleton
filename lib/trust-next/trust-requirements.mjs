import {
  PERMISSION_MANIFEST_DIGEST_FORMAT,
  permissionManifestDigest,
  validatePermissionManifest,
} from './permission-manifest.mjs';
import {
  ARTIFACT_TRUST_DIGEST_FORMAT,
  artifactTrustPolicyDigest,
  validateArtifactTrustPolicy,
} from './artifact-trust.mjs';

export const TRUST_REQUIREMENTS_CONTRACT = 'bskel.trust-requirements/1';
export const TRUST_ECHO_CONTRACT = 'bskel.trust-evidence-echo/1';

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_REF = /^sha256:[0-9a-f]{64}$/;
const REQUIREMENT_KEYS = new Set(['contract', 'permission', 'artifact_policy']);
const PERMISSION_KEYS = new Set(['format', 'sha256']);
const ARTIFACT_KEYS = new Set(['format', 'sha256', 'generation']);
const ECHO_KEYS = new Set(['contract', 'permission', 'artifact_policy', 'evidence_refs']);
const ECHO_PERMISSION_KEYS = new Set(['format', 'sha256', 'enforced']);
const ECHO_ARTIFACT_KEYS = new Set(['format', 'sha256', 'generation', 'enforced']);

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function push(errors, code, path, message) {
  errors.push({ code, path, message });
}

function onlyKeys(errors, value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) push(errors, 'UNKNOWN_TRUST_REQUIREMENT_FIELD', `${path}.${key}`, 'unknown fields are rejected fail-closed');
}

function normalizeEvidenceRefs(errors, value, path, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > 64) {
    push(errors, 'EVIDENCE_REFS_INVALID', path, `must contain ${min}..64 content-addressed evidence refs`);
    return [];
  }
  const out = [];
  for (let i = 0; i < Math.min(value.length, 64); i += 1) {
    const ref = value[i];
    if (typeof ref !== 'string' || !EVIDENCE_REF.test(ref)) {
      push(errors, 'EVIDENCE_REF_INVALID', `${path}[${i}]`, 'must use sha256:<64 lowercase hex>');
    } else {
      out.push(ref);
    }
  }
  return [...new Set(out)].sort();
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateDigestRecord(errors, value, { path, format, keys, generation = false, echo = false }) {
  if (!plain(value)) {
    push(errors, 'INVALID_TRUST_DIGEST_RECORD', path, 'must be a plain object');
    return;
  }
  onlyKeys(errors, value, keys, path);
  if (value.format !== format) push(errors, 'TRUST_DIGEST_FORMAT_MISMATCH', `${path}.format`, `must equal ${format}`);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) push(errors, 'INVALID_TRUST_DIGEST', `${path}.sha256`, 'must be a lowercase 64-hex SHA-256');
  if (generation && (!Number.isSafeInteger(value.generation) || value.generation < 1)) {
    push(errors, 'INVALID_TRUST_GENERATION', `${path}.generation`, 'must be a positive safe integer');
  }
  if (echo && value.enforced !== true && value.enforced !== false) {
    push(errors, 'INVALID_ENFORCED_FLAG', `${path}.enforced`, 'must be boolean');
  }
}

export function buildTrustRequirements({ permissionManifest, artifactTrustPolicy }) {
  const permission = validatePermissionManifest(permissionManifest);
  if (!permission.ok) {
    const error = new TypeError('invalid permission manifest for trust requirements');
    error.code = 'INVALID_PERMISSION_MANIFEST';
    error.details = permission.errors;
    throw error;
  }
  const artifact = validateArtifactTrustPolicy(artifactTrustPolicy);
  if (!artifact.ok) {
    const error = new TypeError('invalid artifact trust policy for trust requirements');
    error.code = 'INVALID_ARTIFACT_TRUST_POLICY';
    error.details = artifact.errors;
    throw error;
  }
  return deepFreeze({
    contract: TRUST_REQUIREMENTS_CONTRACT,
    permission: {
      format: PERMISSION_MANIFEST_DIGEST_FORMAT,
      sha256: permissionManifestDigest(permission.value),
    },
    artifact_policy: {
      format: ARTIFACT_TRUST_DIGEST_FORMAT,
      sha256: artifactTrustPolicyDigest(artifact.value),
      generation: artifact.value.generation,
    },
  });
}

export function validateTrustRequirements(input) {
  const errors = [];
  if (!plain(input)) return { ok: false, errors: [{ code: 'INVALID_TRUST_REQUIREMENTS', path: '(root)', message: 'must be a plain object' }] };
  onlyKeys(errors, input, REQUIREMENT_KEYS, '(root)');
  if (input.contract !== TRUST_REQUIREMENTS_CONTRACT) push(errors, 'UNSUPPORTED_TRUST_REQUIREMENTS_CONTRACT', 'contract', `must equal ${TRUST_REQUIREMENTS_CONTRACT}`);
  validateDigestRecord(errors, input.permission, {
    path: 'permission', format: PERMISSION_MANIFEST_DIGEST_FORMAT, keys: PERMISSION_KEYS,
  });
  validateDigestRecord(errors, input.artifact_policy, {
    path: 'artifact_policy', format: ARTIFACT_TRUST_DIGEST_FORMAT, keys: ARTIFACT_KEYS, generation: true,
  });
  return { ok: errors.length === 0, errors };
}

export function validateTrustEvidenceEcho(requirements, echo, { verifiedEvidenceRefs = [] } = {}) {
  const errors = [];
  const reqValidation = validateTrustRequirements(requirements);
  if (!reqValidation.ok) {
    return { ok: false, errors: reqValidation.errors.map((x) => ({ ...x, code: `REQUIREMENTS_${x.code}` })) };
  }
  if (!plain(echo)) return { ok: false, errors: [{ code: 'INVALID_TRUST_ECHO', path: '(root)', message: 'must be a plain object' }] };
  onlyKeys(errors, echo, ECHO_KEYS, '(root)');
  if (echo.contract !== TRUST_ECHO_CONTRACT) push(errors, 'UNSUPPORTED_TRUST_ECHO_CONTRACT', 'contract', `must equal ${TRUST_ECHO_CONTRACT}`);
  const echoEvidenceRefs = normalizeEvidenceRefs(errors, echo.evidence_refs, 'evidence_refs');
  const verifiedRefs = normalizeEvidenceRefs(errors, verifiedEvidenceRefs, 'verifiedEvidenceRefs');
  const verifiedSet = new Set(verifiedRefs);
  for (const ref of echoEvidenceRefs) {
    if (!verifiedSet.has(ref)) push(errors, 'EVIDENCE_REF_NOT_VERIFIED', 'evidence_refs', `external verifier did not accept ${ref}`);
  }
  validateDigestRecord(errors, echo.permission, {
    path: 'permission', format: PERMISSION_MANIFEST_DIGEST_FORMAT, keys: ECHO_PERMISSION_KEYS, echo: true,
  });
  validateDigestRecord(errors, echo.artifact_policy, {
    path: 'artifact_policy', format: ARTIFACT_TRUST_DIGEST_FORMAT, keys: ECHO_ARTIFACT_KEYS, generation: true, echo: true,
  });

  if (plain(echo.permission)) {
    if (echo.permission.sha256 !== requirements.permission.sha256) push(errors, 'PERMISSION_DIGEST_MISMATCH', 'permission.sha256', 'effective evidence does not match the requested permission digest');
    if (echo.permission.enforced !== true) push(errors, 'PERMISSION_NOT_ENFORCED', 'permission.enforced', 'runtime evidence must affirm actual enforcement, not only receipt of a request');
  }
  if (plain(echo.artifact_policy)) {
    if (echo.artifact_policy.sha256 !== requirements.artifact_policy.sha256) push(errors, 'ARTIFACT_POLICY_DIGEST_MISMATCH', 'artifact_policy.sha256', 'effective evidence does not match the requested artifact trust policy digest');
    if (echo.artifact_policy.generation !== requirements.artifact_policy.generation) push(errors, 'ARTIFACT_POLICY_GENERATION_MISMATCH', 'artifact_policy.generation', 'effective policy generation differs from the requested generation');
    if (echo.artifact_policy.enforced !== true) push(errors, 'ARTIFACT_POLICY_NOT_ENFORCED', 'artifact_policy.enforced', 'runtime evidence must affirm actual trust-policy enforcement');
  }
  return { ok: errors.length === 0, errors };
}

export function assertTrustEvidenceEcho(requirements, echo, options) {
  const result = validateTrustEvidenceEcho(requirements, echo, options);
  if (result.ok) return deepFreeze({ ok: true, requirements });
  const error = new Error('runtime trust evidence does not satisfy T20 requirements');
  error.code = 'TRUST_EVIDENCE_MISMATCH';
  error.details = result.errors;
  throw error;
}
