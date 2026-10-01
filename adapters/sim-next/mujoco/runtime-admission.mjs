import crypto from 'node:crypto';

import { artifactTrustPolicyDigest } from '../../../lib/trust-next/artifact-trust.mjs';
import { permissionManifestDigest } from '../../../lib/trust-next/permission-manifest.mjs';
import { buildMujocoEffectiveModelHelperPlan } from './helper-requirements.mjs';

export const MUJOCO_RUNTIME_INVENTORY_SCHEMA='sbf.sim-mujoco-runtime-inventory/draft-1';
export const MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA='sbf.sim-mujoco-execution-enforcement/draft-1';
export const MUJOCO_ADMISSION_CANDIDATE_SCHEMA='sbf.sim-mujoco-execution-admission-candidate/draft-1';

const SHA256=/^[0-9a-f]{64}$/;
const VERSION='3.12.0';
const REQUIRED_BINDINGS=Object.freeze([
  'mujoco/__init__.py',
  'mujoco/_enums.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_functions.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_specs.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_structs.cpython-312-x86_64-linux-gnu.so',
]);
const REQUIRED_NATIVE='mujoco/libmujoco.so.3.12.0';

function plain(value,label){
  if(value===null||typeof value!=='object'||Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value,keys,label){
  plain(value,label);
  const actual=Object.keys(value).sort();
  const wanted=[...keys].sort();
  if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index])){
    throw new TypeError(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
}

function digest(value,label){
  if(typeof value!=='string'||!SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function integer(value,label,{min=0}={}){
  if(!Number.isSafeInteger(value)||value<min) throw new TypeError(`${label} must be a safe integer >= ${min}`);
  return value;
}

function bounded(value,label){
  if(typeof value!=='string'||value.length===0||value.length>4096||/[\x00-\x1f\x7f]/.test(value)){
    throw new TypeError(`${label} must be a bounded control-free string`);
  }
  return value;
}

function relativePath(value,label){
  bounded(value,label);
  if(value.includes('\\')||value.startsWith('/')||/^[A-Za-z]:\//.test(value)||
     /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)||
     value.split('/').some((part)=>!part||part==='.'||part==='..')){
    throw new TypeError(`${label} must be a normalized relative POSIX path`);
  }
  return value;
}

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])]));
  }
  return value;
}

function hashJson(value){
  return crypto.createHash('sha256')
    .update(Buffer.from(JSON.stringify(canonical(value))+'\n','utf8'))
    .digest('hex');
}

function fileEntry(value,label){
  exactKeys(value,['path','sha256','size_bytes','kind'],label);
  const kind=bounded(value.kind,`${label}.kind`);
  if(!['python','extension','native','plugin','metadata','resource','stdlib','wrapper'].includes(kind)){
    throw new TypeError(`${label}.kind is unsupported`);
  }
  return Object.freeze({
    path:relativePath(value.path,`${label}.path`),
    sha256:digest(value.sha256,`${label}.sha256`),
    size_bytes:integer(value.size_bytes,`${label}.size_bytes`),
    kind,
  });
}

function validateFiles(value){
  if(!Array.isArray(value)||value.length===0||value.length>20000) throw new TypeError('runtime_closure.files must contain 1..20000 entries');
  const files=value.map((entry,index)=>fileEntry(entry,`runtime_closure.files[${index}]`));
  const sorted=[...files].sort((a,b)=>a.path.localeCompare(b.path));
  if(new Set(sorted.map((x)=>x.path)).size!==sorted.length) throw new TypeError('runtime_closure.files contains duplicate paths');
  return Object.freeze(sorted);
}

function fileMap(files){
  return new Map(files.map((entry)=>[entry.path,entry]));
}

export function runtimeClosureDigest(files){
  const normalized=validateFiles(files);
  return hashJson(normalized);
}

export function validateMujocoRuntimeInventory(value){
  exactKeys(value,[
    'schema','target','platform','python_version','mujoco_version',
    'launcher','helper','wrapper','runtime_closure','native_library',
    'required_bindings','plugin_libraries','startup',
  ],'MuJoCo runtime inventory');
  if(value.schema!==MUJOCO_RUNTIME_INVENTORY_SCHEMA) throw new TypeError('runtime inventory schema is invalid');
  if(value.target!=='SIM-mujoco') throw new TypeError('runtime inventory target must be SIM-mujoco');
  if(value.mujoco_version!==VERSION) throw new TypeError(`runtime inventory mujoco_version must be ${VERSION}`);

  exactKeys(value.launcher,['basename','sha256'],'runtime inventory launcher');
  const launcher={
    basename:bounded(value.launcher.basename,'launcher.basename'),
    sha256:digest(value.launcher.sha256,'launcher.sha256'),
  };
  if(/[\\/]/.test(launcher.basename)||launcher.basename==='.'||launcher.basename==='..'){
    throw new TypeError('launcher.basename must be an executable basename');
  }

  exactKeys(value.helper,['sha256'],'runtime inventory helper');
  exactKeys(value.wrapper,['sha256'],'runtime inventory wrapper');
  const helper={sha256:digest(value.helper.sha256,'helper.sha256')};
  const wrapper={sha256:digest(value.wrapper.sha256,'wrapper.sha256')};

  exactKeys(value.runtime_closure,[
    'closure_sha256','record_sha256','record_entries_expected','record_entries_verified',
    'unlisted_files','symlinks','files',
  ],'runtime_closure');
  const files=validateFiles(value.runtime_closure.files);
  const closureSha=runtimeClosureDigest(files);
  if(value.runtime_closure.closure_sha256!==closureSha){
    throw new TypeError('runtime_closure.closure_sha256 does not bind the exact sorted file inventory');
  }
  digest(value.runtime_closure.record_sha256,'runtime_closure.record_sha256');
  const expected=integer(value.runtime_closure.record_entries_expected,'record_entries_expected',{min:1});
  const verified=integer(value.runtime_closure.record_entries_verified,'record_entries_verified',{min:0});
  if(expected!==verified) throw new TypeError('all hashed RECORD entries must be verified against installed bytes');
  if(!Array.isArray(value.runtime_closure.unlisted_files)||value.runtime_closure.unlisted_files.length!==0){
    throw new TypeError('runtime closure must contain no unlisted files');
  }
  if(!Array.isArray(value.runtime_closure.symlinks)||value.runtime_closure.symlinks.length!==0){
    throw new TypeError('runtime closure must contain no symlink entries');
  }

  exactKeys(value.native_library,['path','sha256'],'native_library');
  const nativeLibrary={
    path:relativePath(value.native_library.path,'native_library.path'),
    sha256:digest(value.native_library.sha256,'native_library.sha256'),
  };
  if(nativeLibrary.path!==REQUIRED_NATIVE) throw new TypeError(`native_library.path must be ${REQUIRED_NATIVE}`);

  if(!Array.isArray(value.required_bindings)) throw new TypeError('required_bindings must be an array');
  const requiredBindings=value.required_bindings.map((entry,index)=>{
    exactKeys(entry,['path','sha256'],`required_bindings[${index}]`);
    return Object.freeze({
      path:relativePath(entry.path,`required_bindings[${index}].path`),
      sha256:digest(entry.sha256,`required_bindings[${index}].sha256`),
    });
  });

  if(!Array.isArray(value.plugin_libraries)) throw new TypeError('plugin_libraries must be an array');
  const plugins=value.plugin_libraries.map((entry,index)=>{
    exactKeys(entry,['path','sha256'],`plugin_libraries[${index}]`);
    return Object.freeze({
      path:relativePath(entry.path,`plugin_libraries[${index}].path`),
      sha256:digest(entry.sha256,`plugin_libraries[${index}].sha256`),
    });
  }).sort((a,b)=>a.path.localeCompare(b.path));

  const byPath=fileMap(files);
  const nativeEntry=byPath.get(nativeLibrary.path);
  if(!nativeEntry||nativeEntry.sha256!==nativeLibrary.sha256||nativeEntry.kind!=='native'){
    throw new TypeError('native_library must match an exact native entry in runtime closure');
  }
  for(const path of REQUIRED_BINDINGS){
    const claimed=requiredBindings.find((entry)=>entry.path===path);
    const actual=byPath.get(path);
    if(!claimed||!actual||claimed.sha256!==actual.sha256){
      throw new TypeError(`required runtime binding is not closure-bound: ${path}`);
    }
  }
  for(const plugin of plugins){
    const actual=byPath.get(plugin.path);
    if(!actual||actual.sha256!==plugin.sha256||actual.kind!=='plugin'){
      throw new TypeError(`plugin library is not closure-bound: ${plugin.path}`);
    }
  }

  exactKeys(value.startup,[
    'isolated_flag','no_site_flag','dont_write_bytecode','ambient_environment_empty',
    'pth_processing_disabled','runtime_import_root_explicit',
  ],'runtime inventory startup');
  for(const [key,wanted] of [
    ['isolated_flag',true],
    ['no_site_flag',true],
    ['dont_write_bytecode',true],
    ['ambient_environment_empty',true],
    ['pth_processing_disabled',true],
    ['runtime_import_root_explicit',true],
  ]){
    if(value.startup[key]!==wanted) throw new TypeError(`runtime inventory startup.${key} must be true`);
  }

  const roleShas=[launcher.sha256,helper.sha256,wrapper.sha256,closureSha,nativeLibrary.sha256];
  if(new Set(roleShas).size!==roleShas.length){
    throw new TypeError('launcher/helper/wrapper/runtime-closure/native roles must use distinct digests');
  }

  return Object.freeze({
    schema:MUJOCO_RUNTIME_INVENTORY_SCHEMA,
    target:'SIM-mujoco',
    platform:bounded(value.platform,'platform'),
    python_version:bounded(value.python_version,'python_version'),
    mujoco_version:VERSION,
    launcher:Object.freeze(launcher),
    helper:Object.freeze(helper),
    wrapper:Object.freeze(wrapper),
    runtime_closure:Object.freeze({
      closure_sha256:closureSha,
      record_sha256:value.runtime_closure.record_sha256,
      record_entries_expected:expected,
      record_entries_verified:verified,
      unlisted_files:Object.freeze([]),
      symlinks:Object.freeze([]),
      files,
    }),
    native_library:Object.freeze(nativeLibrary),
    required_bindings:Object.freeze(requiredBindings),
    plugin_libraries:Object.freeze(plugins),
    startup:Object.freeze({...value.startup}),
  });
}

export function validateMujocoExecutionEnforcementEvidence(value){
  exactKeys(value,[
    'schema','target','runner_implementation_sha256','runtime_execution_policy_sha256',
    'permission_manifest_sha256','runtime_inventory_sha256','probes',
  ],'MuJoCo execution enforcement evidence');
  if(value.schema!==MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA) throw new TypeError('enforcement evidence schema is invalid');
  if(value.target!=='SIM-mujoco') throw new TypeError('enforcement evidence target must be SIM-mujoco');
  const probes=plain(value.probes,'enforcement probes');
  const required=[
    'source_mount_read_only',
    'runtime_mount_read_only',
    'source_symlink_denied',
    'source_hardlink_denied',
    'source_write_denied',
    'runtime_write_denied',
    'network_connect_denied',
    'network_listen_denied',
    'unexpected_process_denied',
    'ambient_environment_empty',
    'pre_post_source_hash_equal',
    'runtime_closure_reverified',
    'native_library_reverified',
    'plugin_closure_reverified',
  ];
  exactKeys(probes,required,'enforcement probes');
  for(const key of required){
    if(probes[key]!==true) throw new TypeError(`enforcement probe ${key} must be true`);
  }
  return Object.freeze({
    schema:MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA,
    target:'SIM-mujoco',
    runner_implementation_sha256:digest(value.runner_implementation_sha256,'runner_implementation_sha256'),
    runtime_execution_policy_sha256:digest(value.runtime_execution_policy_sha256,'runtime_execution_policy_sha256'),
    permission_manifest_sha256:digest(value.permission_manifest_sha256,'permission_manifest_sha256'),
    runtime_inventory_sha256:digest(value.runtime_inventory_sha256,'runtime_inventory_sha256'),
    probes:Object.freeze({...probes}),
  });
}

export function mujocoRuntimeInventoryDigest(inventory){
  return hashJson(validateMujocoRuntimeInventory(inventory));
}

export function buildMujocoExecutionAdmissionCandidate({
  inventory,
  artifactTrustPolicy,
  readRoots=['inputs/mujoco'],
  limits={},
  enforcementEvidence=null,
}={}){
  const runtime=validateMujocoRuntimeInventory(inventory);
  const trustPolicy=plain(artifactTrustPolicy,'artifactTrustPolicy');
  const helperPlan=buildMujocoEffectiveModelHelperPlan({
    launcher:runtime.launcher,
    assets:[
      {id:'effective-model-helper',sha256:runtime.helper.sha256},
      {id:'mujoco-runtime-closure',sha256:runtime.runtime_closure.closure_sha256},
      {id:'mujoco-native-library',sha256:runtime.native_library.sha256},
      {id:'mujoco-runtime-wrapper',sha256:runtime.wrapper.sha256},
      ...runtime.plugin_libraries.map((plugin,index)=>({
        id:`mujoco-bundled-plugin-${String(index).padStart(3,'0')}`,
        sha256:plugin.sha256,
      })),
    ],
    artifactTrustPolicy:trustPolicy,
    readRoots,
    limits,
  });
  const permission=helperPlan.helper_requirements.runtime.permission_manifest;
  const permissionSha=permissionManifestDigest(permission);
  const inventorySha=mujocoRuntimeInventoryDigest(runtime);
  const trustSha=artifactTrustPolicyDigest(artifactTrustPolicy);

  const blockers=[];
  let enforcement=null;
  if(enforcementEvidence===null){
    blockers.push('ENFORCEMENT_EVIDENCE_MISSING');
  }else{
    enforcement=validateMujocoExecutionEnforcementEvidence(enforcementEvidence);
    if(enforcement.permission_manifest_sha256!==permissionSha) blockers.push('PERMISSION_MANIFEST_DIGEST_MISMATCH');
    if(enforcement.runtime_inventory_sha256!==inventorySha) blockers.push('RUNTIME_INVENTORY_DIGEST_MISMATCH');
  }

  return Object.freeze({
    schema:MUJOCO_ADMISSION_CANDIDATE_SCHEMA,
    target:'SIM-mujoco',
    state:blockers.length===0?'READY_FOR_INDEPENDENT_REVIEW':'BLOCKED',
    admitted:false,
    independent_review_required:true,
    blockers:Object.freeze(blockers),
    runtime_inventory_sha256:inventorySha,
    artifact_trust_policy_sha256:trustSha,
    permission_manifest_sha256:permissionSha,
    helper_plan:helperPlan,
    enforcement_evidence:enforcement,
    t16_runtime_binding_allowed:false,
    note:'A1 may prepare this evidence package but cannot self-issue execution admission. T16 RuntimeBinding/attempt creation remains blocked until a separate reviewer approves this exact package.',
  });
}
