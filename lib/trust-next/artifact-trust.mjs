import crypto from 'node:crypto';

export const ARTIFACT_TRUST_POLICY_SCHEMA = 'bskel.trust-artifact-policy/1';
export const ARTIFACT_TRUST_DIGEST_FORMAT = 'bskel.trust-artifact-policy-json/1';

const TOP_KEYS = new Set(['schema', 'generation', 'allow', 'revoked']);
const ALLOW_KEYS = new Set(['usage', 'sha256']);
const REVOKED_KEYS = new Set(['sha256', 'reason']);
const USAGES = new Set(['adapter', 'grammar', 'helper', 'image', 'package', 'runner', 'schema']);
const SHA256 = /^[0-9a-f]{64}$/;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function err(errors, code, path, message) {
  errors.push({ code, path, message });
}

function unknown(errors, obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) err(errors, 'UNKNOWN_TRUST_FIELD', `${path}.${key}`, 'unknown fields are rejected fail-closed');
  }
}

function validSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function normalizeAllow(errors, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err(errors, 'INVALID_ALLOWLIST', 'allow', 'must be an array');
    return [];
  }
  const byKey = new Map();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `allow[${i}]`;
    if (!plain(item)) {
      err(errors, 'INVALID_ALLOW_ENTRY', path, 'must be a plain object');
      continue;
    }
    unknown(errors, item, ALLOW_KEYS, path);
    if (!USAGES.has(item.usage)) err(errors, 'INVALID_ARTIFACT_USAGE', `${path}.usage`, 'unsupported artifact usage');
    if (!validSha(item.sha256)) err(errors, 'INVALID_ARTIFACT_SHA256', `${path}.sha256`, 'must be a lowercase 64-hex SHA-256');
    if (USAGES.has(item.usage) && validSha(item.sha256)) byKey.set(`${item.usage}:${item.sha256}`, { usage: item.usage, sha256: item.sha256 });
  }
  return [...byKey.values()].sort((a, b) => a.usage.localeCompare(b.usage) || a.sha256.localeCompare(b.sha256));
}

function normalizeRevoked(errors, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err(errors, 'INVALID_REVOCATION_LIST', 'revoked', 'must be an array');
    return [];
  }
  const byDigest = new Map();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `revoked[${i}]`;
    if (!plain(item)) {
      err(errors, 'INVALID_REVOCATION_ENTRY', path, 'must be a plain object');
      continue;
    }
    unknown(errors, item, REVOKED_KEYS, path);
    if (!validSha(item.sha256)) err(errors, 'INVALID_ARTIFACT_SHA256', `${path}.sha256`, 'must be a lowercase 64-hex SHA-256');
    if (typeof item.reason !== 'string' || item.reason.trim().length < 8 || item.reason.length > 500) {
      err(errors, 'INVALID_REVOCATION_REASON', `${path}.reason`, 'must be 8..500 non-blank characters');
    }
    if (validSha(item.sha256) && typeof item.reason === 'string' && item.reason.trim().length >= 8 && item.reason.length <= 500) {
      const reason = item.reason.trim();
      const existing = byDigest.get(item.sha256);
      if (existing && existing.reason !== reason) {
        err(errors, 'CONFLICTING_REVOCATION_REASON', path, 'the same digest cannot carry two different revocation reasons in one policy');
      } else {
        byDigest.set(item.sha256, { sha256: item.sha256, reason });
      }
    }
  }
  return [...byDigest.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateArtifactTrustPolicy(input) {
  const errors = [];
  if (!plain(input)) return { ok: false, errors: [{ code: 'INVALID_TRUST_POLICY', path: '(root)', message: 'must be a plain object' }], value: null };
  unknown(errors, input, TOP_KEYS, '(root)');
  if (input.schema !== ARTIFACT_TRUST_POLICY_SCHEMA) err(errors, 'UNSUPPORTED_TRUST_POLICY_SCHEMA', 'schema', `must equal ${ARTIFACT_TRUST_POLICY_SCHEMA}`);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) err(errors, 'INVALID_TRUST_GENERATION', 'generation', 'must be a positive safe integer');
  const allow = normalizeAllow(errors, input.allow);
  const revoked = normalizeRevoked(errors, input.revoked);
  const revokedSet = new Set(revoked.map((x) => x.sha256));
  const shadowed = allow.filter((x) => revokedSet.has(x.sha256));
  if (shadowed.length > 0) {
    for (const item of shadowed) err(errors, 'ALLOWLIST_CONTAINS_REVOKED_DIGEST', 'allow', `${item.usage}:${item.sha256} is also revoked; remove it from allow rather than relying on precedence`);
  }
  const value = { schema: ARTIFACT_TRUST_POLICY_SCHEMA, generation: input.generation, allow, revoked };
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? deepFreeze(value) : null };
}

function validated(input) {
  const result = validateArtifactTrustPolicy(input);
  if (result.ok) return result.value;
  const error = new TypeError('invalid artifact trust policy');
  error.code = 'INVALID_ARTIFACT_TRUST_POLICY';
  error.details = result.errors;
  throw error;
}

function validateArtifactRef(input) {
  if (!plain(input) || !USAGES.has(input.usage) || !validSha(input.sha256)) {
    const error = new TypeError('artifact trust lookup requires {usage, sha256} with an approved usage and lowercase SHA-256');
    error.code = 'INVALID_ARTIFACT_TRUST_REF';
    throw error;
  }
  for (const key of Object.keys(input)) {
    if (!ALLOW_KEYS.has(key)) {
      const error = new TypeError(`unknown artifact trust lookup field: ${key}`);
      error.code = 'INVALID_ARTIFACT_TRUST_REF';
      throw error;
    }
  }
  return { usage: input.usage, sha256: input.sha256 };
}

export function evaluateArtifactTrust(policyInput, artifactInput) {
  const policy = validated(policyInput);
  const artifact = validateArtifactRef(artifactInput);
  const revoked = policy.revoked.find((x) => x.sha256 === artifact.sha256);
  if (revoked) return deepFreeze({ decision: 'revoked', usage: artifact.usage, sha256: artifact.sha256, reason: revoked.reason, generation: policy.generation });
  const allowed = policy.allow.some((x) => x.usage === artifact.usage && x.sha256 === artifact.sha256);
  return deepFreeze({ decision: allowed ? 'trusted' : 'untrusted', usage: artifact.usage, sha256: artifact.sha256, generation: policy.generation });
}

export function assertArtifactTrusted(policyInput, artifactInput) {
  const decision = evaluateArtifactTrust(policyInput, artifactInput);
  if (decision.decision === 'trusted') return decision;
  const error = new Error(decision.decision === 'revoked' ? `artifact digest is revoked: ${decision.reason}` : 'artifact digest is not trusted for this usage');
  error.code = decision.decision === 'revoked' ? 'ARTIFACT_REVOKED' : 'ARTIFACT_UNTRUSTED';
  error.decision = decision;
  throw error;
}

function canonicalPolicyObject(policy) {
  return {
    schema: policy.schema,
    generation: policy.generation,
    allow: policy.allow.map((x) => ({ usage: x.usage, sha256: x.sha256 })),
    revoked: policy.revoked.map((x) => ({ sha256: x.sha256, reason: x.reason })),
  };
}

export function serializeArtifactTrustPolicy(policyInput) {
  const policy = validated(policyInput);
  return `${JSON.stringify(canonicalPolicyObject(policy))}\n`;
}

export function artifactTrustPolicyDigest(policyInput) {
  const bytes = Buffer.from(`${ARTIFACT_TRUST_DIGEST_FORMAT}\n${serializeArtifactTrustPolicy(policyInput)}`, 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function allowSet(policy) {
  return new Set(policy.allow.map((x) => `${x.usage}:${x.sha256}`));
}
function revokedSet(policy) {
  return new Set(policy.revoked.map((x) => x.sha256));
}

export function diffArtifactTrustPolicies(beforeInput, afterInput) {
  const before = validated(beforeInput);
  const after = validated(afterInput);
  const beforeAllow = allowSet(before);
  const afterAllow = allowSet(after);
  const beforeRevoked = revokedSet(before);
  const afterRevoked = revokedSet(after);

  const expansions = [];
  const reductions = [];
  for (const key of [...afterAllow].filter((x) => !beforeAllow.has(x)).sort()) expansions.push({ change: 'allow-added', value: key });
  for (const key of [...beforeAllow].filter((x) => !afterAllow.has(x)).sort()) reductions.push({ change: 'allow-removed', value: key });
  for (const digest of [...beforeRevoked].filter((x) => !afterRevoked.has(x)).sort()) expansions.push({ change: 'revocation-removed', sha256: digest });
  for (const digest of [...afterRevoked].filter((x) => !beforeRevoked.has(x)).sort()) reductions.push({ change: 'revocation-added', sha256: digest });
  if (after.generation < before.generation) expansions.push({ change: 'generation-rollback', before: before.generation, after: after.generation });

  return deepFreeze({
    expanded: expansions.length > 0,
    reduced: reductions.length > 0,
    expansions,
    reductions,
    before_digest: artifactTrustPolicyDigest(before),
    after_digest: artifactTrustPolicyDigest(after),
  });
}
