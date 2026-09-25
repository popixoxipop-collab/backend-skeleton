import { permissionManifestDigest, validatePermissionManifest } from './permission-manifest.mjs';

export const EXTERNAL_ADAPTER_SECURITY_REVIEW = 'bskel.external-adapter-security-review/1';
const SDK_MANIFEST = 'sbf.adapter-sdk-manifest/1';
const ACTIVATION_MODE = 'manual-approval-required';
const PERMISSION_KEYS = new Set(['readRoots', 'writeRoots', 'network', 'environment', 'subprocess']);
const ID = /^[a-z][a-z0-9-]*$/;

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
  return validation.value;
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
