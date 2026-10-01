import crypto from 'node:crypto';
import path from 'node:path';

import {
  artifactTrustPolicyDigest,
  diffArtifactTrustPolicies,
  validateArtifactTrustPolicy,
} from '../../../lib/trust-next/artifact-trust.mjs';
import { permissionManifestDigest } from '../../../lib/trust-next/permission-manifest.mjs';
import { buildMujocoEffectiveModelHelperPlan } from './helper-requirements.mjs';

export const MUJOCO_RUNTIME_INVENTORY_SCHEMA = 'sbf.sim-mujoco-runtime-inventory/draft-1';
export const MUJOCO_EXECUTION_ADMISSION_CANDIDATE =
  'sbf.sim-mujoco-execution-admission-candidate/draft-1';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_ENTRIES = 20_000;
const MAX_PATH = 8192;

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
}

function hash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function size(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function text(value, label, { absolute = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded non-empty control-free string`);
  }
  if (absolute && !value.startsWith('/')) {
    throw new TypeError(`${label} must be an absolute POSIX path`);
  }
  return value;
}

function relativePath(value, label) {
  text(value, label);
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`${label} must be a normalized relative POSIX path`);
  }
  return value;
}

function fileIdentity(value, label, { absolutePath = false, pathField = 'path' } = {}) {
  exactKeys(value, [pathField, 'sha256', 'size_bytes'], label);
  const rawPath = absolutePath
    ? text(value[pathField], `${label}.${pathField}`, { absolute:true })
    : relativePath(value[pathField], `${label}.${pathField}`);
  return Object.freeze({
    [pathField]:rawPath,
    sha256:hash(value.sha256, `${label}.sha256`),
    size_bytes:size(value.size_bytes, `${label}.size_bytes`),
  });
}

function launcherIdentity(value) {
  exactKeys(value, ['requested_path','resolved_path','sha256','size_bytes'], 'runtime inventory launcher');
  return Object.freeze({
    requested_path:text(value.requested_path, 'runtime inventory launcher.requested_path', { absolute:true }),
    resolved_path:text(value.resolved_path, 'runtime inventory launcher.resolved_path', { absolute:true }),
    sha256:hash(value.sha256, 'runtime inventory launcher.sha256'),
    size_bytes:size(value.size_bytes, 'runtime inventory launcher.size_bytes'),
  });
}

function closureEntry(value, index) {
  exactKeys(value, ['path','sha256','size_bytes'], `runtime closure entry[${index}]`);
  return Object.freeze({
    path:relativePath(value.path, `runtime closure entry[${index}].path`),
    sha256:hash(value.sha256, `runtime closure entry[${index}].sha256`),
    size_bytes:size(value.size_bytes, `runtime closure entry[${index}].size_bytes`),
  });
}

function stableClosureDigest(entries) {
  const payload=JSON.stringify(entries);
  return crypto.createHash('sha256')
    .update(Buffer.from('sbf.sim-mujoco-runtime-closure/draft-1\n'+payload+'\n','utf8'))
    .digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,stableJson(value[key])]));
  }
  return value;
}

export function mujocoRuntimeInventoryDigest(inventory) {
  const normalized=validateMujocoRuntimeInventory(inventory);
  return crypto.createHash('sha256')
    .update(Buffer.from(
      'sbf.sim-mujoco-runtime-inventory-json/draft-1\n'+JSON.stringify(stableJson(normalized))+'\n',
      'utf8',
    ))
    .digest('hex');
}

export function validateMujocoRuntimeInventory(value) {
  exactKeys(value, [
    'schema','status','mujoco_version','python_abi','venv_root','site_packages',
    'launcher','helper','record','metadata','runtime_closure','native_library',
    'bindings','claims',
  ], 'MuJoCo runtime inventory');

  if (value.schema !== MUJOCO_RUNTIME_INVENTORY_SCHEMA) {
    throw new TypeError('MuJoCo runtime inventory schema is invalid');
  }
  if (value.status !== 'INVENTORY_OBSERVED_NOT_ADMITTED') {
    throw new TypeError('MuJoCo runtime inventory status must remain INVENTORY_OBSERVED_NOT_ADMITTED');
  }
  if (value.mujoco_version !== '3.12.0') {
    throw new TypeError('MuJoCo runtime inventory must be pinned to 3.12.0');
  }
  if (typeof value.python_abi !== 'string' || !/^\d+\.\d+$/.test(value.python_abi)) {
    throw new TypeError('MuJoCo runtime inventory python_abi is invalid');
  }

  const venv_root=text(value.venv_root, 'runtime inventory venv_root', { absolute:true });
  const site_packages=text(value.site_packages, 'runtime inventory site_packages', { absolute:true });
  const launcher=launcherIdentity(value.launcher);
  const helper=fileIdentity(value.helper, 'runtime inventory helper', { absolutePath:true });
  const record=(()=>{
    exactKeys(value.record, ['path','sha256','size_bytes','verified_entry_count'], 'runtime inventory record');
    return Object.freeze({
      path:text(value.record.path, 'runtime inventory record.path', { absolute:true }),
      sha256:hash(value.record.sha256, 'runtime inventory record.sha256'),
      size_bytes:size(value.record.size_bytes, 'runtime inventory record.size_bytes'),
      verified_entry_count:size(value.record.verified_entry_count, 'runtime inventory record.verified_entry_count'),
    });
  })();
  const metadata=fileIdentity(value.metadata, 'runtime inventory metadata', { absolutePath:true });

  exactKeys(value.runtime_closure, [
    'contract','sha256','entry_count','total_size_bytes','entries',
  ], 'runtime inventory runtime_closure');
  if (value.runtime_closure.contract !== 'sbf.sim-mujoco-runtime-closure/draft-1') {
    throw new TypeError('runtime closure contract is invalid');
  }
  if (
    !Array.isArray(value.runtime_closure.entries) ||
    value.runtime_closure.entries.length === 0 ||
    value.runtime_closure.entries.length > MAX_ENTRIES
  ) {
    throw new TypeError(`runtime closure entries must contain 1..${MAX_ENTRIES} items`);
  }
  const entries=value.runtime_closure.entries.map(closureEntry);
  const keys=entries.map((entry)=>entry.path);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('runtime closure entries contain duplicate paths');
  }
  const sorted=[...entries].sort((a,b)=>a.path.localeCompare(b.path));
  if (sorted.some((entry,index)=>entry.path!==entries[index].path)) {
    throw new TypeError('runtime closure entries must be sorted by path');
  }
  const entryCount=size(value.runtime_closure.entry_count, 'runtime closure entry_count');
  if (entryCount!==entries.length || record.verified_entry_count!==entries.length) {
    throw new TypeError('runtime closure entry count does not match verified RECORD count');
  }
  const totalSize=size(value.runtime_closure.total_size_bytes, 'runtime closure total_size_bytes');
  const actualTotal=entries.reduce((sum,entry)=>sum+entry.size_bytes,0);
  if (actualTotal!==totalSize) {
    throw new TypeError('runtime closure total_size_bytes does not match entries');
  }
  const closureSha=hash(value.runtime_closure.sha256, 'runtime closure sha256');
  if (stableClosureDigest(entries)!==closureSha) {
    throw new TypeError('runtime closure sha256 does not match canonical verified entries');
  }

  const native_library=fileIdentity(value.native_library, 'runtime inventory native_library');
  const byPath=new Map(entries.map((entry)=>[entry.path,entry]));
  const nativeEntry=byPath.get(native_library.path);
  if (
    !nativeEntry ||
    nativeEntry.sha256!==native_library.sha256 ||
    nativeEntry.size_bytes!==native_library.size_bytes
  ) {
    throw new TypeError('native library identity is not bound to the verified runtime closure');
  }

  if (!Array.isArray(value.bindings) || value.bindings.length===0) {
    throw new TypeError('runtime inventory bindings must contain at least one extension module');
  }
  const bindings=value.bindings.map((entry,index)=>fileIdentity(entry,`runtime inventory bindings[${index}]`));
  for (const binding of bindings) {
    const recorded=byPath.get(binding.path);
    if (!recorded || recorded.sha256!==binding.sha256 || recorded.size_bytes!==binding.size_bytes) {
      throw new TypeError(`runtime binding is not bound to verified runtime closure: ${binding.path}`);
    }
  }

  exactKeys(value.claims, [
    'filesystem_inventory_verified',
    'wheel_record_reverified_against_installed_bytes',
    'mujoco_imported',
    'helper_executed',
    'mjcf_compiled',
    'execution_admitted',
  ], 'runtime inventory claims');
  if (
    value.claims.filesystem_inventory_verified!==true ||
    value.claims.wheel_record_reverified_against_installed_bytes!==true
  ) {
    throw new TypeError('runtime inventory must prove filesystem and RECORD verification');
  }
  for (const field of ['mujoco_imported','helper_executed','mjcf_compiled','execution_admitted']) {
    if (value.claims[field]!==false) {
      throw new TypeError(`runtime inventory cannot claim ${field}`);
    }
  }

  return Object.freeze({
    schema:MUJOCO_RUNTIME_INVENTORY_SCHEMA,
    status:'INVENTORY_OBSERVED_NOT_ADMITTED',
    mujoco_version:'3.12.0',
    python_abi:value.python_abi,
    venv_root,
    site_packages,
    launcher,
    helper,
    record,
    metadata,
    runtime_closure:Object.freeze({
      contract:'sbf.sim-mujoco-runtime-closure/draft-1',
      sha256:closureSha,
      entry_count:entries.length,
      total_size_bytes:totalSize,
      entries:Object.freeze(entries),
    }),
    native_library,
    bindings:Object.freeze(bindings),
    claims:Object.freeze({...value.claims}),
  });
}

function validatedPolicy(value) {
  const result=validateArtifactTrustPolicy(value);
  if (!result.ok) {
    const error=new TypeError('current artifact trust policy is invalid');
    error.details=result.errors;
    throw error;
  }
  return result.value;
}

function proposedTrustPolicy(current, digests) {
  const revoked=new Set(current.revoked.map((entry)=>entry.sha256));
  for (const digest of digests) {
    if (revoked.has(digest)) {
      throw new TypeError(`required runtime digest is revoked: ${digest}`);
    }
  }
  const allow=[...current.allow];
  const have=new Set(allow.map((entry)=>entry.usage+':'+entry.sha256));
  let added=false;
  for (const digest of digests) {
    const key='helper:'+digest;
    if (have.has(key)) continue;
    allow.push({usage:'helper',sha256:digest});
    have.add(key);
    added=true;
  }
  return validatedPolicy({
    schema:current.schema,
    generation:current.generation+(added?1:0),
    allow,
    revoked:[...current.revoked],
  });
}

export function buildMujocoExecutionAdmissionCandidate(input) {
  exactKeys(input, [
    'm3CandidateSha','runtimeInventory','currentArtifactTrustPolicy','readRoots','limits',
  ], 'MuJoCo execution admission input');

  if (typeof input.m3CandidateSha!=='string' || !GIT_SHA.test(input.m3CandidateSha)) {
    throw new TypeError('m3CandidateSha must be an exact 40-hex Git SHA');
  }
  const inventory=validateMujocoRuntimeInventory(input.runtimeInventory);
  const currentPolicy=validatedPolicy(input.currentArtifactTrustPolicy);
  if (!Array.isArray(input.readRoots) || input.readRoots.length===0) {
    throw new TypeError('readRoots must be a non-empty array');
  }
  plain(input.limits, 'limits');

  const requiredDigests=[
    inventory.launcher.sha256,
    inventory.helper.sha256,
    inventory.runtime_closure.sha256,
    inventory.native_library.sha256,
  ];
  if (new Set(requiredDigests).size!==requiredDigests.length) {
    throw new TypeError('launcher/helper/runtime-closure/native-library identities must be distinct');
  }

  const proposedPolicy=proposedTrustPolicy(currentPolicy,requiredDigests);
  const trustDelta=diffArtifactTrustPolicies(currentPolicy,proposedPolicy);
  const launcherBasename=path.posix.basename(inventory.launcher.requested_path);
  if (!launcherBasename || launcherBasename==='.' || launcherBasename==='..') {
    throw new TypeError('runtime launcher basename is invalid');
  }

  const helperPlan=buildMujocoEffectiveModelHelperPlan({
    launcher:{basename:launcherBasename,sha256:inventory.launcher.sha256},
    assets:[
      {id:'effective-model-helper',sha256:inventory.helper.sha256},
      {id:'mujoco-runtime-closure',sha256:inventory.runtime_closure.sha256},
      {id:'mujoco-native-library',sha256:inventory.native_library.sha256},
    ],
    artifactTrustPolicy:proposedPolicy,
    readRoots:input.readRoots,
    limits:input.limits,
  });

  const permissionManifest=helperPlan.helper_requirements.runtime.permission_manifest;
  const unresolved=[
    ...(trustDelta.expanded?['artifact-trust-expansion-requires-independent-approval']:[]),
    'runtime-inventory-requires-independent-review',
    'runner-implementation-hash-not-bound',
    'runtime-execution-policy-hash-not-bound',
    'read-only-immutable-staging-enforcement-not-proven',
    'toctou-hardlink-denial-not-proven',
    'runtime-plugin-decoder-resource-provider-closure-not-independently-admitted',
    't16-runtime-binding-not-created',
    'unique-execution-attempt-not-created',
    'independent-t20-t16-admission-verdict-required',
  ];

  return Object.freeze({
    schema:MUJOCO_EXECUTION_ADMISSION_CANDIDATE,
    state:'NOT_ADMITTED',
    m3_candidate_sha:input.m3CandidateSha,
    runtime_inventory_digest:mujocoRuntimeInventoryDigest(inventory),
    runtime_inventory:inventory,
    proposed_artifact_trust_policy:proposedPolicy,
    proposed_artifact_trust_policy_digest:artifactTrustPolicyDigest(proposedPolicy),
    artifact_trust_delta:trustDelta,
    helper_plan:helperPlan,
    permission_manifest_digest:permissionManifestDigest(permissionManifest),
    required_runtime_identities:Object.freeze({
      launcher_sha256:inventory.launcher.sha256,
      helper_sha256:inventory.helper.sha256,
      runtime_closure_sha256:inventory.runtime_closure.sha256,
      native_library_sha256:inventory.native_library.sha256,
    }),
    unresolved:Object.freeze(unresolved),
    execution_authorized:false,
    note:'A1 evidence bundle only. Independent T20/T16 review must close every unresolved item before a real MuJoCo process may be launched.',
  });
}
