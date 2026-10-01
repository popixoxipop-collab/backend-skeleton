import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MUJOCO_EXECUTION_ADMISSION_CANDIDATE,
  MUJOCO_RUNTIME_INVENTORY_SCHEMA,
  buildMujocoExecutionAdmissionCandidate,
  mujocoRuntimeInventoryDigest,
  validateMujocoRuntimeInventory,
} from '../../../adapters/sim-next/mujoco/execution-admission.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR=path.resolve(
  HERE,
  '../../../adapters/sim-next/mujoco/runtime_inventory_collector.py',
);

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function recordDigest(bytes) {
  return 'sha256='+crypto.createHash('sha256').update(bytes).digest('base64url');
}

function write(root, relative, bytes) {
  const target=path.join(root,...relative.split('/'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
  return target;
}

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4-runtime-'));
  const venv=path.join(root,'venv');
  const site=path.join(venv,'lib','python3.12','site-packages');
  const helper=path.join(root,'effective_model_helper.py');
  const launcher=write(venv,'bin/python',Buffer.from('fake-python-launcher\n'));
  fs.chmodSync(launcher,0o755);
  fs.writeFileSync(helper,'# reviewed helper fixture\n');

  const files=new Map([
    ['mujoco/__init__.py',Buffer.from('__version__ = "3.12.0"\n')],
    ['mujoco/_structs.cpython-312-x86_64-linux-gnu.so',Buffer.from('fake-structs-so')],
    ['mujoco/_functions.cpython-312-x86_64-linux-gnu.so',Buffer.from('fake-functions-so')],
    ['mujoco/libmujoco.so.3.12.0',Buffer.from('fake-native-lib')],
    ['mujoco-3.12.0.dist-info/METADATA',Buffer.from(
      'Metadata-Version: 2.1\nName: mujoco\nVersion: 3.12.0\n',
    )],
  ]);
  for (const [relative,bytes] of files) write(site,relative,bytes);

  const lines=[];
  for (const [relative,bytes] of files) {
    lines.push([relative,recordDigest(bytes),String(bytes.length)].join(','));
  }
  lines.push('mujoco-3.12.0.dist-info/RECORD,,');
  write(site,'mujoco-3.12.0.dist-info/RECORD',Buffer.from(lines.join('\n')+'\n'));

  return {root,venv,site,helper,files};
}

function collect(fx) {
  const child=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
    input:JSON.stringify({
      protocol:'sbf.sim-mujoco-runtime-inventory-request/draft-1',
      venv_root:fx.venv,
      helper_path:fx.helper,
      expected_mujoco_version:'3.12.0',
    }),
    encoding:'utf8',
    env:{},
    timeout:10_000,
    maxBuffer:8*1024*1024,
  });
  assert.equal(child.signal,null);
  assert.equal(child.stderr,'');
  const parsed=JSON.parse(child.stdout);
  return {child,parsed};
}

function emptyPolicy() {
  return {
    schema:'bskel.trust-artifact-policy/1',
    generation:1,
    allow:[],
    revoked:[],
  };
}

function limits() {
  return {
    wall_ms:60_000,
    cpu_ms:60_000,
    memory_bytes:1_073_741_824,
    pids:4,
    stdout_bytes:8_388_608,
    stderr_bytes:262_144,
    scratch_bytes:67_108_864,
  };
}

test('M4 filesystem-only collector re-verifies installed RECORD bytes without importing MuJoCo', () => {
  const fx=fixture();
  try {
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stdout);
    assert.equal(parsed.schema,MUJOCO_RUNTIME_INVENTORY_SCHEMA);
    assert.equal(parsed.status,'INVENTORY_OBSERVED_NOT_ADMITTED');
    assert.equal(parsed.mujoco_version,'3.12.0');
    assert.equal(parsed.claims.filesystem_inventory_verified,true);
    assert.equal(parsed.claims.wheel_record_reverified_against_installed_bytes,true);
    assert.equal(parsed.claims.mujoco_imported,false);
    assert.equal(parsed.claims.helper_executed,false);
    assert.equal(parsed.claims.mjcf_compiled,false);
    assert.equal(parsed.claims.execution_admitted,false);

    const validated=validateMujocoRuntimeInventory(parsed);
    assert.equal(validated.runtime_closure.entry_count,fx.files.size);
    assert.equal(validated.bindings.length,2);
    assert.equal(validated.native_library.path,'mujoco/libmujoco.so.3.12.0');
    assert.match(mujocoRuntimeInventoryDigest(parsed),/^[a-f0-9]{64}$/);

    const collectorSource=fs.readFileSync(COLLECTOR,'utf8');
    assert.doesNotMatch(collectorSource,/import\s+mujoco/);
    assert.doesNotMatch(collectorSource,/subprocess/);
    assert.doesNotMatch(collectorSource,/MjModel/);
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector fails closed when an installed file no longer matches wheel RECORD', () => {
  const fx=fixture();
  try {
    fs.appendFileSync(
      path.join(fx.site,'mujoco','_structs.cpython-312-x86_64-linux-gnu.so'),
      'tamper',
    );
    const {child,parsed}=collect(fx);
    assert.notEqual(child.status,0);
    assert.equal(parsed.status,'INVENTORY_FAILED');
    assert.equal(parsed.error.code,'RUNTIME_INVENTORY_INVALID');
    assert.match(parsed.error.message,/installed bytes do not match RECORD/);
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector rejects unsafe RECORD paths before they can escape site-packages', () => {
  const fx=fixture();
  try {
    const record=path.join(fx.site,'mujoco-3.12.0.dist-info','RECORD');
    fs.writeFileSync(record,'../outside,sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,1\n');
    const {child,parsed}=collect(fx);
    assert.notEqual(child.status,0);
    assert.equal(parsed.status,'INVENTORY_FAILED');
    assert.equal(parsed.error.code,'RUNTIME_INVENTORY_INVALID');
    assert.match(parsed.error.message,/unsafe segments/);
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 runtime inventory validation recomputes closure identity and rejects self-certified execution claims', () => {
  const fx=fixture();
  try {
    const {parsed}=collect(fx);
    const changed=structuredClone(parsed);
    changed.runtime_closure.entries[0].size_bytes+=1;
    assert.throws(
      () => validateMujocoRuntimeInventory(changed),
      /total_size_bytes does not match entries|sha256 does not match/,
    );

    const claimed=structuredClone(parsed);
    claimed.claims.execution_admitted=true;
    assert.throws(
      () => validateMujocoRuntimeInventory(claimed),
      /cannot claim execution_admitted/,
    );

    const imported=structuredClone(parsed);
    imported.claims.mujoco_imported=true;
    assert.throws(
      () => validateMujocoRuntimeInventory(imported),
      /cannot claim mujoco_imported/,
    );
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 A1 admission candidate is structurally complete but always NOT_ADMITTED', () => {
  const fx=fixture();
  try {
    const {parsed}=collect(fx);
    const candidate=buildMujocoExecutionAdmissionCandidate({
      m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
      runtimeInventory:parsed,
      currentArtifactTrustPolicy:emptyPolicy(),
      readRoots:['inputs/mujoco'],
      limits:limits(),
    });

    assert.equal(candidate.schema,MUJOCO_EXECUTION_ADMISSION_CANDIDATE);
    assert.equal(candidate.state,'NOT_ADMITTED');
    assert.equal(candidate.execution_authorized,false);
    assert.equal(candidate.artifact_trust_delta.expanded,true);
    assert.equal(
      candidate.unresolved.includes('artifact-trust-expansion-requires-independent-approval'),
      true,
    );
    assert.equal(
      candidate.unresolved.includes('independent-t20-t16-admission-verdict-required'),
      true,
    );
    assert.equal(
      candidate.unresolved.includes('read-only-immutable-staging-enforcement-not-proven'),
      true,
    );

    const permission=candidate.helper_plan.helper_requirements.runtime.permission_manifest;
    assert.deepEqual(permission.read_roots,['inputs/mujoco']);
    assert.deepEqual(permission.write_roots,[]);
    assert.deepEqual(permission.network,{mode:'deny',allow:[]});
    assert.deepEqual(permission.environment,{allow:[]});
    assert.deepEqual(permission.secret_refs,[]);
    assert.deepEqual(permission.devices,{mode:'deny',allow:[]});
    assert.equal(permission.process.max_children,1);
    assert.equal(permission.process.executables.length,1);
    assert.equal(candidate.helper_plan.helper_requirements.executable_now,false);
    assert.equal(candidate.helper_plan.helper_requirements.runtime_binding_required,true);
    assert.match(candidate.permission_manifest_digest,/^[a-f0-9]{64}$/);
    assert.match(candidate.proposed_artifact_trust_policy_digest,/^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 admission builder rejects identity aliasing and caller attempts to smuggle approval', () => {
  const fx=fixture();
  try {
    const {parsed}=collect(fx);

    const aliased=structuredClone(parsed);
    aliased.helper.sha256=aliased.launcher.sha256;
    assert.throws(
      () => buildMujocoExecutionAdmissionCandidate({
        m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
        runtimeInventory:aliased,
        currentArtifactTrustPolicy:emptyPolicy(),
        readRoots:['inputs/mujoco'],
        limits:limits(),
      }),
      /identities must be distinct/,
    );

    assert.throws(
      () => buildMujocoExecutionAdmissionCandidate({
        m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
        runtimeInventory:parsed,
        currentArtifactTrustPolicy:emptyPolicy(),
        readRoots:['inputs/mujoco'],
        limits:limits(),
        approved:true,
      }),
      /must contain exactly/,
    );
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 proposed trust policy never removes revocations and refuses a revoked required runtime digest', () => {
  const fx=fixture();
  try {
    const {parsed}=collect(fx);
    const policy=emptyPolicy();
    policy.generation=4;
    policy.revoked=[{
      sha256:parsed.native_library.sha256,
      reason:'runtime native library revoked by independent security review',
    }];
    assert.throws(
      () => buildMujocoExecutionAdmissionCandidate({
        m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
        runtimeInventory:parsed,
        currentArtifactTrustPolicy:policy,
        readRoots:['inputs/mujoco'],
        limits:limits(),
      }),
      /required runtime digest is revoked/,
    );
  } finally {
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});
