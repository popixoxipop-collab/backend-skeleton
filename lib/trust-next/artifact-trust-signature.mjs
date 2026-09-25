import {
  CANONICALIZATION_ID,
  publicKeyIdFromPrivate,
  publicKeyIdFromPublic,
  signPayload,
  verifyPayload,
} from '../attest.mjs';
import {
  ARTIFACT_TRUST_DIGEST_FORMAT,
  ARTIFACT_TRUST_POLICY_SCHEMA,
  artifactTrustPolicyDigest,
  validateArtifactTrustPolicy,
} from './artifact-trust.mjs';

export const ARTIFACT_TRUST_SIGNATURE_CONTRACT = 'bskel.trust-artifact-policy-signature/1';
export const ARTIFACT_TRUST_SIGNATURE_ALGORITHM = 'ed25519';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function policyValue(policyInput) {
  const validation = validateArtifactTrustPolicy(policyInput);
  if (!validation.ok) fail('INVALID_ARTIFACT_TRUST_POLICY', 'artifact trust policy is invalid', validation.errors);
  return validation.value;
}

function signedPayload(policy) {
  return {
    contract: ARTIFACT_TRUST_SIGNATURE_CONTRACT,
    policy_schema: ARTIFACT_TRUST_POLICY_SCHEMA,
    digest_format: ARTIFACT_TRUST_DIGEST_FORMAT,
    policy_sha256: artifactTrustPolicyDigest(policy),
    generation: policy.generation,
  };
}

export function signArtifactTrustPolicy(policyInput, privateKeyPem) {
  const policy = policyValue(policyInput);
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    fail('TRUST_SIGNING_KEY_INVALID', 'privateKeyPem must be supplied explicitly; T20 does not load keys from ambient storage');
  }
  const payload = signedPayload(policy);
  const signature = signPayload(payload, privateKeyPem);
  return Object.freeze({
    contract: ARTIFACT_TRUST_SIGNATURE_CONTRACT,
    algorithm: ARTIFACT_TRUST_SIGNATURE_ALGORITHM,
    canonicalization: CANONICALIZATION_ID,
    key_id: publicKeyIdFromPrivate(privateKeyPem),
    payload: Object.freeze(payload),
    signature,
  });
}

export function verifyArtifactTrustPolicySignature(policyInput, envelope, publicKeyPem, {
  minimumGeneration = 1,
  expectedKeyId = null,
} = {}) {
  const errors = [];
  let policy;
  try {
    policy = policyValue(policyInput);
  } catch (error) {
    return { ok: false, errors: [{ code: 'POLICY_INVALID', message: error.message }] };
  }
  if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1) {
    return { ok: false, errors: [{ code: 'MINIMUM_GENERATION_INVALID', message: 'minimumGeneration must be a positive safe integer' }] };
  }
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
    return { ok: false, errors: [{ code: 'PUBLIC_KEY_INVALID', message: 'publicKeyPem must be supplied explicitly' }] };
  }
  if (!plain(envelope)) return { ok: false, errors: [{ code: 'ENVELOPE_INVALID', message: 'signature envelope must be a plain object' }] };

  const allowedKeys = new Set(['contract', 'algorithm', 'canonicalization', 'key_id', 'payload', 'signature']);
  for (const key of Object.keys(envelope)) {
    if (!allowedKeys.has(key)) errors.push({ code: 'UNKNOWN_SIGNATURE_FIELD', field: key, message: 'unknown signature envelope fields are rejected' });
  }
  if (envelope.contract !== ARTIFACT_TRUST_SIGNATURE_CONTRACT) errors.push({ code: 'SIGNATURE_CONTRACT_MISMATCH', field: 'contract' });
  if (envelope.algorithm !== ARTIFACT_TRUST_SIGNATURE_ALGORITHM) errors.push({ code: 'SIGNATURE_ALGORITHM_MISMATCH', field: 'algorithm' });
  if (envelope.canonicalization !== CANONICALIZATION_ID) errors.push({ code: 'SIGNATURE_CANONICALIZATION_MISMATCH', field: 'canonicalization' });
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0 || envelope.signature.length > 1024) errors.push({ code: 'SIGNATURE_VALUE_INVALID', field: 'signature' });

  let observedKeyId = null;
  try {
    observedKeyId = publicKeyIdFromPublic(publicKeyPem);
  } catch {
    errors.push({ code: 'PUBLIC_KEY_INVALID', field: 'publicKeyPem' });
  }
  if (observedKeyId !== null) {
    if (envelope.key_id !== observedKeyId) errors.push({ code: 'SIGNATURE_KEY_ID_MISMATCH', field: 'key_id' });
    if (expectedKeyId !== null && expectedKeyId !== observedKeyId) errors.push({ code: 'SIGNATURE_UNTRUSTED_KEY', field: 'key_id' });
  }

  const expectedPayload = signedPayload(policy);
  if (!plain(envelope.payload)) {
    errors.push({ code: 'SIGNATURE_PAYLOAD_INVALID', field: 'payload' });
  } else {
    const payloadKeys = new Set(['contract', 'policy_schema', 'digest_format', 'policy_sha256', 'generation']);
    for (const key of Object.keys(envelope.payload)) {
      if (!payloadKeys.has(key)) errors.push({ code: 'UNKNOWN_SIGNATURE_PAYLOAD_FIELD', field: `payload.${key}` });
    }
    for (const [key, value] of Object.entries(expectedPayload)) {
      if (envelope.payload[key] !== value) errors.push({ code: 'SIGNATURE_POLICY_BINDING_MISMATCH', field: `payload.${key}` });
    }
  }
  if (policy.generation < minimumGeneration) {
    errors.push({ code: 'TRUST_POLICY_GENERATION_ROLLBACK', field: 'payload.generation', message: `generation ${policy.generation} is below required minimum ${minimumGeneration}` });
  }

  if (errors.length === 0 && !verifyPayload(envelope.payload, envelope.signature, publicKeyPem)) {
    errors.push({ code: 'SIGNATURE_VERIFICATION_FAILED', field: 'signature' });
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    policy_sha256: expectedPayload.policy_sha256,
    generation: policy.generation,
    key_id: observedKeyId,
  });
}

export function assertArtifactTrustPolicySignature(policyInput, envelope, publicKeyPem, options) {
  const result = verifyArtifactTrustPolicySignature(policyInput, envelope, publicKeyPem, options);
  if (result.ok) return result;
  const error = new Error('artifact trust policy signature verification failed');
  error.code = 'ARTIFACT_TRUST_SIGNATURE_INVALID';
  error.details = result.errors;
  throw error;
}
