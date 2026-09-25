import { compilePermissionPolicy, permissionManifestDigest, validatePermissionManifest } from './permission-manifest.mjs';
import { assertArtifactTrusted, validateArtifactTrustPolicy } from './artifact-trust.mjs';
import { buildTrustRequirements } from './trust-requirements.mjs';

export const EXTERNAL_ADAPTER_SECURITY_REVIEW = 'bskel.external-adapter-security-review/1';
const SDK_MANIFEST = 'sbf.adapter-sdk-manifest/1';
const ACTIVATION_MODE = 'manual-approval-required';
const PERMISSION_KEYS = new Set(['readRoots', 'writeRoots', 'network', 'environment', 'subprocess']);
const ID = /^[a-z][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function validateSecurityCriticalSdkFields(manifest) {
  if (!plain(manifest) || manifest.contract !== SDK_MANIFEST) {
    fail('EXTERNAL_ADAPTER_MANIFEST_UNSUPPORTED', `manifest.contract must equal ${SDK_MANIFEST}`);
  }
  if (!plain(manifest.adapter) || typeof manifest.adapter.id !== 'string' || !ID.test(manifest.adapter.id)) {
    fail('EXTERNAL_ADAPTER_MANIFEST_INVALID', 'manifest.adapter.id must be a lowercase kebab-case identifier');
  }
  if (!plain(manifest.activation) || manifest.activation.mode !== ACTIVATION_MODE) {
    fail('EXTERNAL_ADAPTER_ACTIVATION_UNSAFE', `manifest.activation.mode must equal ${ACTIVATION_MODE}`);
  }
  const permissions = manifest.permissions;
  if (!plain(permissions)) fail('EXTERNAL_ADAPTER_PERMISSIONS_INVALID', 'manifest.permissions must be a plain object');
  for (const key of Object.keys(permissions)) {
    if (!PERMISSION_KEYS.has(key)) fail('EXTERNAL_ADAPTER_PERMISSIONS_INVALID', `unknown manifest.permissions field: ${key}`);
  }
  if (!Array.isArray(permissions.readRoots) || !Array.isArray(permissions.writeRoots) || !Array.isArray(permissions.environment)) {
    fail('EXTERNAL_ADAPTER_PERMISSIONS_INVALID', 'readRoots, writeRoots, and environment must be arrays');
  }
  if (permissions.network !== 'deny-by-default') {
    fail('EXTERNAL_ADAPTER_NETWORK_UNSUPPORTED', 'T22 preview may request only deny-by-default network; wider network requires a separate T20-reviewed profile');
  }
  if (permissions.subprocess !== 'deny-by-default') {
    fail('EXTERNAL_ADAPTER_PROCESS_UNSUPPORTED', 'T22 preview may request only deny-by-default subprocess; wider process execution requires a separate T20-reviewed profile');
  }
  return permissions;
}

export function translateAdapterSdkPermissions(manifest) {
  const permissions = validateSecurityCriticalSdkFields(manifest);
  const candidate = {
    schema: 'bskel.trust-permissions/1',
    read_roots: [...permissions.readRoots],
    write_roots: [...permissions.writeRoots],
    network: { mode: 'deny', allow: [] },
    process: { mode: 'deny', executables: [], max_children: 0 },
    environment: { allow: [...permissions.environment] },
    secret_refs: [],
  };
  const validation = validatePermissionManifest(candidate);
  if (!validation.ok) {
    fail('EXTERNAL_ADAPTER_PERMISSION_TRANSLATION_REJECTED', 'T20 rejected the external adapter permission request', validation.errors);
  }
  return compilePermissionPolicy(validation.value).manifest;
}

export function reviewAdapterSdkSecurity(manifest) {
  const permissionManifest = translateAdapterSdkPermissions(manifest);
  return Object.freeze({
    schema: EXTERNAL_ADAPTER_SECURITY_REVIEW,
    adapter_id: manifest.adapter.id,
    permission_manifest_digest: permissionManifestDigest(permissionManifest),
    permission_manifest: permissionManifest,
    executable: false,
    requires_approval: true,
    package_trust_required: true,
    runtime_isolation_required: true,
    note: 'T20 permission translation is necessary but never sufficient to authorize external adapter execution.',
  });
}


export function buildExternalAdapterActivationRequirements({
  manifest,
  packageSha256,
  artifactTrustPolicy,
}) {
  const review = reviewAdapterSdkSecurity(manifest);
  if (typeof packageSha256 !== 'string' || !SHA256.test(packageSha256)) {
    fail('EXTERNAL_ADAPTER_PACKAGE_DIGEST_INVALID', 'packageSha256 must be the independently observed lowercase 64-hex SHA-256 of the package/archive bytes');
  }
  const trustValidation = validateArtifactTrustPolicy(artifactTrustPolicy);
  if (!trustValidation.ok) {
    fail('EXTERNAL_ADAPTER_TRUST_POLICY_INVALID', 'artifact trust policy is invalid', trustValidation.errors);
  }
  let packageTrust;
  try {
    packageTrust = assertArtifactTrusted(trustValidation.value, { usage: 'package', sha256: packageSha256 });
  } catch (cause) {
    const error = new Error('external adapter package bytes are not trusted for activation review');
    error.code = cause?.code === 'ARTIFACT_REVOKED'
      ? 'EXTERNAL_ADAPTER_PACKAGE_REVOKED'
      : 'EXTERNAL_ADAPTER_PACKAGE_UNTRUSTED';
    error.cause = cause;
    error.package_sha256 = packageSha256;
    throw error;
  }
  const trustRequirements = buildTrustRequirements({
    permissionManifest: review.permission_manifest,
    artifactTrustPolicy: trustValidation.value,
  });
  return Object.freeze({
    schema: 'bskel.external-adapter-activation-requirements/1',
    adapter_id: review.adapter_id,
    package_sha256: packageSha256,
    package_trust: packageTrust,
    trust_requirements: trustRequirements,
    executable: false,
    requires_approval: true,
    runtime_binding_required: true,
    note: 'This object proves only that the requested permissions normalize and the exact observed package digest is trusted; T16 runtime isolation/evidence is still required.',
  });
}
