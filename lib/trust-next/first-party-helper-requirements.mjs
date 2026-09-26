import {
  compilePermissionPolicy,
  validatePermissionManifest,
} from './permission-manifest.mjs';
import {
  assertArtifactTrusted,
  validateArtifactTrustPolicy,
} from './artifact-trust.mjs';
import { buildTrustRequirements } from './trust-requirements.mjs';

export const FIRST_PARTY_HELPER_REQUIREMENTS_CONTRACT = 'bskel.first-party-helper-requirements/1';

const HELPER_CLASSES = new Set(['static-worker', 'compiler-helper']);
const INPUT_MODES = new Set(['bounded-stdin', 'approved-files']);
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9._-]{0,127}$/;
const EXECUTABLE = /^[A-Za-z0-9._+-]+$/;

function fail(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactExecutable(value, field) {
  if (typeof value !== 'string' || value === '.' || value === '..' ||
      !EXECUTABLE.test(value) || value.includes('/') || value.includes('\\')) {
    fail('FIRST_PARTY_HELPER_EXECUTABLE_INVALID', `${field} must be an exact executable basename`);
  }
  return value;
}

function exactSha(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('FIRST_PARTY_HELPER_DIGEST_INVALID', `${field} must be a lowercase 64-hex SHA-256`);
  }
  return value;
}

function stringArray(value, field, { min = 0, max = 256 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      value.some((x) => typeof x !== 'string' || x.length === 0)) {
    fail('FIRST_PARTY_HELPER_ARGUMENT_INVALID', `${field} must be an array of ${min}..${max} non-empty strings`);
  }
  return [...value];
}

function validateTrustedAsset(policy, asset, field) {
  if (!plain(asset) || !ID.test(asset.id ?? '')) {
    fail('FIRST_PARTY_HELPER_ASSET_INVALID', `${field}.id must be a stable lowercase identifier`);
  }
  const sha256 = exactSha(asset.sha256, `${field}.sha256`);
  let trust;
  try {
    trust = assertArtifactTrusted(policy, { usage: 'helper', sha256 });
  } catch (cause) {
    const error = new Error(`${field} is not trusted as helper bytes`);
    error.code = cause?.code === 'ARTIFACT_REVOKED'
      ? 'FIRST_PARTY_HELPER_ASSET_REVOKED'
      : 'FIRST_PARTY_HELPER_ASSET_UNTRUSTED';
    error.cause = cause;
    error.asset_id = asset.id;
    throw error;
  }
  return Object.freeze({ id: asset.id, sha256, trust });
}

function acquisitionPermission({ networkAllow = [], limits = {} }) {
  const candidate = {
    schema: 'bskel.trust-permissions/1',
    read_roots: [],
    write_roots: ['scratch/acquisition'],
    network: networkAllow.length === 0
      ? { mode: 'deny', allow: [] }
      : { mode: 'allowlist', allow: networkAllow },
    process: { mode: 'deny', executables: [], max_children: 0 },
    environment: { allow: [] },
    secret_refs: [],
    devices: { mode: 'deny', allow: [] },
    limits: { ...limits },
  };
  const validation = validatePermissionManifest(candidate);
  if (!validation.ok) fail('FIRST_PARTY_HELPER_ACQUISITION_PERMISSION_REJECTED', 'T20 rejected acquisition permissions', validation.errors);
  return compilePermissionPolicy(validation.value).manifest;
}

function runtimePermission({
  executableBasenames,
  readRoots,
  writeRoots,
  environment,
  maxChildren,
  limits,
}) {
  const candidate = {
    schema: 'bskel.trust-permissions/1',
    read_roots: readRoots,
    write_roots: writeRoots,
    network: { mode: 'deny', allow: [] },
    process: { mode: 'argv-allowlist', executables: executableBasenames, max_children: maxChildren },
    environment: { allow: environment },
    secret_refs: [],
    devices: { mode: 'deny', allow: [] },
    limits: { ...limits },
  };
  const validation = validatePermissionManifest(candidate);
  if (!validation.ok) fail('FIRST_PARTY_HELPER_RUNTIME_PERMISSION_REJECTED', 'T20 rejected runtime permissions', validation.errors);
  return compilePermissionPolicy(validation.value).manifest;
}

export function buildFirstPartyHelperRequirements({
  helperId,
  helperClass,
  inputMode,
  launcher,
  assets,
  artifactTrustPolicy,
  executableBasenames,
  readRoots = [],
  writeRoots = [],
  environment = [],
  maxChildren,
  limits = {},
  acquisition = null,
  targetCodeExecution = false,
}) {
  if (typeof helperId !== 'string' || !ID.test(helperId)) fail('FIRST_PARTY_HELPER_ID_INVALID', 'helperId must be a stable lowercase identifier');
  if (!HELPER_CLASSES.has(helperClass)) fail('FIRST_PARTY_HELPER_CLASS_INVALID', 'helperClass must be static-worker or compiler-helper');
  if (!INPUT_MODES.has(inputMode)) fail('FIRST_PARTY_HELPER_INPUT_MODE_INVALID', 'inputMode must be bounded-stdin or approved-files');
  if (targetCodeExecution !== false) fail('FIRST_PARTY_HELPER_TARGET_EXECUTION_FORBIDDEN', 'first-party helper profile cannot authorize target application/build-script execution');
  if (!plain(launcher)) fail('FIRST_PARTY_HELPER_LAUNCHER_INVALID', 'launcher must be an object');
  const launcherBasename = exactExecutable(launcher.basename, 'launcher.basename');
  const launcherSha256 = exactSha(launcher.sha256, 'launcher.sha256');

  const trustValidation = validateArtifactTrustPolicy(artifactTrustPolicy);
  if (!trustValidation.ok) fail('FIRST_PARTY_HELPER_TRUST_POLICY_INVALID', 'artifact trust policy is invalid', trustValidation.errors);
  let launcherTrust;
  try {
    launcherTrust = assertArtifactTrusted(trustValidation.value, { usage: 'helper', sha256: launcherSha256 });
  } catch (cause) {
    const error = new Error('launcher bytes are not trusted as helper');
    error.code = cause?.code === 'ARTIFACT_REVOKED'
      ? 'FIRST_PARTY_HELPER_LAUNCHER_REVOKED'
      : 'FIRST_PARTY_HELPER_LAUNCHER_UNTRUSTED';
    error.cause = cause;
    throw error;
  }

  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 256) {
    fail('FIRST_PARTY_HELPER_ASSET_INVALID', 'assets must contain 1..256 exact helper assets');
  }
  const seenAssets = new Set();
  const trustedAssets = assets.map((asset, index) => {
    const trusted = validateTrustedAsset(trustValidation.value, asset, `assets[${index}]`);
    if (seenAssets.has(trusted.id)) fail('FIRST_PARTY_HELPER_ASSET_DUPLICATE', `duplicate helper asset id: ${trusted.id}`);
    seenAssets.add(trusted.id);
    return trusted;
  });

  const executables = stringArray(executableBasenames, 'executableBasenames', { min: 1, max: 128 });
  if (!executables.includes(launcherBasename)) {
    fail('FIRST_PARTY_HELPER_LAUNCHER_NOT_ALLOWED', 'launcher.basename must be included in executableBasenames');
  }
  const reads = stringArray(readRoots, 'readRoots', { max: 256 });
  const writes = stringArray(writeRoots, 'writeRoots', { max: 256 });
  const env = stringArray(environment, 'environment', { max: 128 });
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 1) fail('FIRST_PARTY_HELPER_CHILD_LIMIT_REQUIRED', 'maxChildren must be an explicit positive safe integer');

  if (helperClass === 'static-worker') {
    if (inputMode !== 'bounded-stdin') fail('FIRST_PARTY_HELPER_STATIC_INPUT_INVALID', 'static-worker must receive target source through bounded-stdin');
    if (reads.length !== 0 || writes.length !== 0) fail('FIRST_PARTY_HELPER_STATIC_FS_INVALID', 'static-worker target filesystem roots must remain empty');
    if (env.length !== 0) fail('FIRST_PARTY_HELPER_STATIC_ENV_INVALID', 'static-worker must inherit no environment variables');
    if (acquisition !== null) fail('FIRST_PARTY_HELPER_STATIC_ACQUISITION_INVALID', 'static-worker may not request a dependency acquisition phase');
  }

  if (helperClass === 'compiler-helper' && inputMode !== 'approved-files') {
    fail('FIRST_PARTY_HELPER_COMPILER_INPUT_INVALID', 'compiler-helper must use approved-files so exact source-byte checks can precede execution');
  }

  const runtime = runtimePermission({
    executableBasenames: executables,
    readRoots: reads,
    writeRoots: writes,
    environment: env,
    maxChildren,
    limits,
  });
  const runtimeTrust = buildTrustRequirements({
    permissionManifest: runtime,
    artifactTrustPolicy: trustValidation.value,
  });

  let acquisitionResult = null;
  if (acquisition !== null) {
    if (helperClass !== 'compiler-helper' || !plain(acquisition)) {
      fail('FIRST_PARTY_HELPER_ACQUISITION_INVALID', 'acquisition is permitted only for compiler-helper and must be an object');
    }
    const networkAllow = Array.isArray(acquisition.networkAllow) ? acquisition.networkAllow : [];
    const permission = acquisitionPermission({ networkAllow, limits: acquisition.limits ?? {} });
    acquisitionResult = Object.freeze({
      separated_from_runtime: true,
      permission_manifest: permission,
      trust_requirements: buildTrustRequirements({
        permissionManifest: permission,
        artifactTrustPolicy: trustValidation.value,
      }),
    });
  }

  return Object.freeze({
    contract: FIRST_PARTY_HELPER_REQUIREMENTS_CONTRACT,
    helper_id: helperId,
    helper_class: helperClass,
    input_mode: inputMode,
    launcher: Object.freeze({ basename: launcherBasename, sha256: launcherSha256, trust: launcherTrust }),
    assets: Object.freeze(trustedAssets),
    runtime: Object.freeze({
      permission_manifest: runtime,
      trust_requirements: runtimeTrust,
    }),
    acquisition: acquisitionResult,
    runner_owned_assets_outside_repository_roots: true,
    target_code_execution: false,
    executable_now: false,
    runtime_binding_required: true,
    evidence_required: true,
    note: 'Runner-owned launcher/assets are exact-digest trust inputs outside repository read_roots. T16/T00 enforcement and evidence remain required before promotion.',
  });
}
