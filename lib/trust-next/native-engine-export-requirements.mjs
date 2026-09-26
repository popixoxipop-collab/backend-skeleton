import {
  compilePermissionPolicy,
  validatePermissionManifest,
} from './permission-manifest.mjs';
import {
  assertArtifactTrusted,
  validateArtifactTrustPolicy,
} from './artifact-trust.mjs';
import { buildTrustRequirements } from './trust-requirements.mjs';

export const NATIVE_EXPORT_REQUIREMENTS_CONTRACT = 'bskel.native-export-trust-requirements/1';

const ENGINES = new Set(['unreal', 'unity', 'godot']);
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTABLE = /^[A-Za-z0-9._+-]+$/;

function fail(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function stringArray(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((x) => typeof x !== 'string' || x.length === 0)) {
    fail('NATIVE_EXPORT_ARGUMENT_INVALID', `${field} must be an array of non-empty strings with at least ${min} item(s)`);
  }
  return [...value];
}

export function buildNativeEngineExportRequirements({
  engine,
  executable,
  executableSha256,
  artifactTrustPolicy,
  readRoots,
  writeRoots,
  environment = [],
  deviceClasses = [],
  maxChildren,
  limits = {},
}) {
  if (!ENGINES.has(engine)) fail('NATIVE_EXPORT_ENGINE_UNSUPPORTED', 'engine must be unreal, unity, or godot');
  if (typeof executable !== 'string' || !EXECUTABLE.test(executable) || executable === '.' || executable === '..' || executable.includes('/') || executable.includes('\\')) {
    fail('NATIVE_EXPORT_EXECUTABLE_INVALID', 'executable must be an exact basename, never a path or shell fragment');
  }
  if (typeof executableSha256 !== 'string' || !SHA256.test(executableSha256)) {
    fail('NATIVE_EXPORT_EXECUTABLE_DIGEST_INVALID', 'executableSha256 must be the independently observed lowercase SHA-256 of the engine executable');
  }
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 1) {
    fail('NATIVE_EXPORT_CHILD_LIMIT_REQUIRED', 'maxChildren must be an explicit positive safe integer');
  }
  const reads = stringArray(readRoots, 'readRoots', { min: 1 });
  const writes = stringArray(writeRoots, 'writeRoots', { min: 1 });
  const env = stringArray(environment, 'environment');
  const devices = stringArray(deviceClasses, 'deviceClasses');

  const trustValidation = validateArtifactTrustPolicy(artifactTrustPolicy);
  if (!trustValidation.ok) fail('NATIVE_EXPORT_TRUST_POLICY_INVALID', 'artifact trust policy is invalid', trustValidation.errors);
  let executableTrust;
  try {
    executableTrust = assertArtifactTrusted(trustValidation.value, { usage: 'helper', sha256: executableSha256 });
  } catch (cause) {
    const error = new Error('engine executable bytes are not trusted for native export');
    error.code = cause?.code === 'ARTIFACT_REVOKED'
      ? 'NATIVE_EXPORT_EXECUTABLE_REVOKED'
      : 'NATIVE_EXPORT_EXECUTABLE_UNTRUSTED';
    error.cause = cause;
    throw error;
  }

  const candidate = {
    schema: 'bskel.trust-permissions/1',
    read_roots: reads,
    write_roots: writes,
    network: { mode: 'deny', allow: [] },
    process: { mode: 'argv-allowlist', executables: [executable], max_children: maxChildren },
    environment: { allow: env },
    secret_refs: [],
    devices: devices.length === 0
      ? { mode: 'deny', allow: [] }
      : { mode: 'allowlist', allow: devices },
    limits: { ...limits },
  };
  const permissionValidation = validatePermissionManifest(candidate);
  if (!permissionValidation.ok) fail('NATIVE_EXPORT_PERMISSION_REJECTED', 'T20 rejected native export permission request', permissionValidation.errors);
  const permissionManifest = compilePermissionPolicy(permissionValidation.value).manifest;
  const trustRequirements = buildTrustRequirements({
    permissionManifest,
    artifactTrustPolicy: trustValidation.value,
  });

  return Object.freeze({
    contract: NATIVE_EXPORT_REQUIREMENTS_CONTRACT,
    engine,
    executable: Object.freeze({ basename: executable, sha256: executableSha256, trust: executableTrust }),
    permission_manifest: permissionManifest,
    trust_requirements: trustRequirements,
    executable_now: false,
    runtime_binding_required: true,
    external_isolation_required: true,
    cleanup_proof_required: true,
    source_export_hashing_required: true,
    runtime_behavior_certified: false,
    note: 'This object describes T20-approved trust inputs only. T16/T00 runtime/profile enforcement and external evidence are still required before any editor/headless process may run.',
  });
}
