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
  MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA,
  MUJOCO_RUNTIME_INVENTORY_SCHEMA,
  buildMujocoExecutionAdmissionCandidate,
  mujocoRuntimeInventoryDigest,
  runtimeClosureDigest,
  validateMujocoRuntimeInventory,
} from '../../../adapters/sim-next/mujoco/execution-admission.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR=path.resolve(HERE,'../../../adapters/sim-next/mujoco/runtime_inventory_collector.py');
const WRAPPER=path.resolve(HERE,'../../../adapters/sim-next/mujoco/runtime_wrapper.py');

const REQUIRED_BINDINGS=[
  'mujoco/__init__.py',
  'mujoco/_callbacks.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_constants.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_enums.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_errors.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_functions.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_render.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_specs.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_structs.cpython-312-x86_64-linux-gnu.so',
];
const NATIVE='mujoco/libmujoco.so.3.12.0';
const EXPECTED_RECORD_HASHED=REQUIRED_BINDINGS.length+3; // native + plugin + METADATA

function sha(bytes){
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function recordHash(bytes){
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

function write(root,rel,bytes){
  const target=path.join(root,...rel.split('/'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
  return target;
}

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4-admission-'));
  const runtime=path.join(root,'runtime');
  const stdlib=path.join(root,'stdlib');
  const helper=path.join(root,'effective_model_helper.py');
  const wrapper=path.join(root,'runtime_wrapper.py');
  fs.mkdirSync(runtime,{recursive:true});
  fs.mkdirSync(stdlib,{recursive:true});
  fs.copyFileSync(WRAPPER,wrapper);
  fs.writeFileSync(helper,'print("helper-fixture")\n');
  fs.writeFileSync(path.join(stdlib,'os.py'),'# stdlib fixture\n');

  const entries=new Map([
    ['mujoco/__init__.py','VERSION="fixture"\n'],
    ['mujoco/_callbacks.cpython-312-x86_64-linux-gnu.so','callbacks-bytes'],
    ['mujoco/_constants.cpython-312-x86_64-linux-gnu.so','constants-bytes'],
    ['mujoco/_enums.cpython-312-x86_64-linux-gnu.so','enum-bytes'],
    ['mujoco/_errors.cpython-312-x86_64-linux-gnu.so','errors-bytes'],
    ['mujoco/_functions.cpython-312-x86_64-linux-gnu.so','function-bytes'],
    ['mujoco/_render.cpython-312-x86_64-linux-gnu.so','render-bytes'],
    ['mujoco/_specs.cpython-312-x86_64-linux-gnu.so','specs-bytes'],
    ['mujoco/_structs.cpython-312-x86_64-linux-gnu.so','structs-bytes'],
    [NATIVE,'native-bytes'],
    ['mujoco/plugin/libfixture.so','plugin-bytes'],
    ['mujoco-3.12.0.dist-info/METADATA','Metadata-Version: 2.4\nName: mujoco\nVersion: 3.12.0\n'],
  ]);
  for(const [rel,bytes] of entries) write(runtime,rel,bytes);

  const generatedPycPath='mujoco/__pycache__/__init__.cpython-312.pyc';
  const generatedPycBytes=Buffer.from('generated-cpython312-pyc-fixture');
  write(runtime,generatedPycPath,generatedPycBytes);

  const rows=[];
  for(const [rel,bytes] of entries){
    const raw=Buffer.from(bytes);
    rows.push([rel,`sha256=${recordHash(raw)}`,String(raw.length)]);
  }
  rows.push([generatedPycPath,'','']);
  rows.push(['mujoco-3.12.0.dist-info/RECORD','','']);
  write(runtime,'mujoco-3.12.0.dist-info/RECORD',rows.map((row)=>row.join(',')).join('\n')+'\n');

  const nativeDep=write(root,'lib/libsystem-fixture.so','system-native');
  return {root,runtime,stdlib,helper,wrapper,nativeDep};
}

function collect(fx){
  const request={
    protocol:'sbf.sim-mujoco-runtime-admission-collect/draft-1',
    target:'SIM-mujoco',
    runtime_import_root:fx.runtime,
    helper_path:fx.helper,
    wrapper_path:fx.wrapper,
    stdlib_roots:[fx.stdlib],
    native_dependency_files:[{
      logical_path:'system-native/libsystem-fixture.so',
      path:fx.nativeDep,
    }],
  };
  const child=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
    input:JSON.stringify(request),
    encoding:'utf8',
    env:{},
    timeout:20_000,
    maxBuffer:16*1024*1024,
  });
  const parsed=child.status===0?JSON.parse(child.stdout):null;
  return {child,parsed};
}

function emptyPolicy(){
  return {
    schema:'bskel.trust-artifact-policy/1',
    generation:1,
    allow:[],
    revoked:[],
  };
}

function limits(){
  return {
    wall_ms:60_000,
    cpu_ms:60_000,
    memory_bytes:1_073_741_824,
    pids:2,
    stdout_bytes:8_388_608,
    stderr_bytes:262_144,
    scratch_bytes:1,
  };
}

function baseCandidate(parsed,enforcementEvidence=null){
  return buildMujocoExecutionAdmissionCandidate({
    m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
    runtimeInventory:parsed,
    currentArtifactTrustPolicy:emptyPolicy(),
    readRoots:['inputs/mujoco'],
    limits:limits(),
    enforcementEvidence,
  });
}

test('M4 collector and validator keep full-runtime file ceiling bounded above observed Alienware closure',()=>{
  const src=fs.readFileSync(COLLECTOR,'utf8');
  assert.match(src,/MAX_FILES = 50_000/);
  assert.doesNotMatch(src,/MAX_FILES = 20_000/);
  assert.match(src,/MAX_TOTAL_BYTES = 16 \* 1024 \* 1024 \* 1024/);
  const admission=fs.readFileSync(new URL('../../../adapters/sim-next/mujoco/execution-admission.mjs',import.meta.url),'utf8');
  assert.match(admission,/runtime_closure\.files must contain 1\.\.50000 entries/);
  assert.doesNotMatch(admission,/runtime_closure\.files must contain 1\.\.20000 entries/);
});

test('M4 collector inventories exact runtime bytes without importing or compiling MuJoCo',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stderr,'');
    assert.equal(parsed.schema,MUJOCO_RUNTIME_INVENTORY_SCHEMA);
    assert.equal(parsed.mujoco_version,'3.12.0');
    assert.equal(parsed.collector.sha256,sha(fs.readFileSync(COLLECTOR)));
    assert.equal(parsed.runtime_closure.record_entries_expected,EXPECTED_RECORD_HASHED);
    assert.equal(parsed.runtime_closure.record_entries_verified,EXPECTED_RECORD_HASHED);
    assert.equal(parsed.runtime_closure.record_unhashed_entries.length,2);
    assert.equal(
      parsed.runtime_closure.record_unhashed_entries.some(
        (entry)=>entry.path==='mujoco/__pycache__/__init__.cpython-312.pyc'
          && entry.reason==='generated-cpython312-pyc',
      ),
      true,
    );
    assert.equal(
      parsed.runtime_closure.record_unhashed_entries.some(
        (entry)=>entry.path==='mujoco-3.12.0.dist-info/RECORD'
          && entry.reason==='record-self',
      ),
      true,
    );
    assert.deepEqual(parsed.runtime_closure.unlisted_files,[]);
    assert.deepEqual(parsed.runtime_closure.symlinks,[]);
    assert.equal(parsed.required_bindings.length,REQUIRED_BINDINGS.length);
    assert.equal(parsed.plugin_libraries.length,1);
    assert.equal(parsed.native_library.path,NATIVE);
    assert.equal(parsed.startup.isolated_flag,true);
    assert.equal(parsed.startup.no_site_flag,true);
    assert.equal(parsed.startup.pth_processing_disabled,true);
    assert.equal(
      validateMujocoRuntimeInventory(parsed).runtime_closure.closure_sha256,
      parsed.runtime_closure.closure_sha256,
    );

    const source=fs.readFileSync(COLLECTOR,'utf8');
    assert.doesNotMatch(source,/^\s*import\s+mujoco\b/m);
    assert.doesNotMatch(source,/MjModel|from_xml_path|mj_step|mj_forward/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 inventory identity changes if collector identity is changed and candidate preserves collector SHA',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const original=mujocoRuntimeInventoryDigest(parsed);
    const changed=structuredClone(parsed);
    changed.collector.sha256='f'.repeat(64);
    assert.notEqual(original,mujocoRuntimeInventoryDigest(changed));

    const candidate=baseCandidate(parsed,null);
    assert.equal(
      candidate.required_runtime_identities.collector_sha256,
      parsed.collector.sha256,
    );
    assert.equal(
      candidate.proposed_artifact_trust_policy.allow.some(
        (entry)=>entry.usage==='helper'&&entry.sha256===parsed.collector.sha256,
      ),
      true,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 runtime closure digest changes when any file identity changes',()=>{
  const files=[
    {path:'mujoco/a.py',sha256:'a'.repeat(64),size_bytes:1,kind:'python'},
    {path:NATIVE,sha256:'b'.repeat(64),size_bytes:2,kind:'native'},
  ];
  const original=runtimeClosureDigest(files);
  assert.notEqual(original,runtimeClosureDigest([{...files[0],sha256:'c'.repeat(64)},files[1]]));
  assert.notEqual(original,runtimeClosureDigest([{...files[0],size_bytes:2},files[1]]));
});

test('M4 inventory rejects unlisted files symlinks stale closure hashes and missing bindings',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);

    assert.throws(
      ()=>validateMujocoRuntimeInventory({
        ...parsed,
        runtime_closure:{...parsed.runtime_closure,unlisted_files:['mujoco/rogue.py']},
      }),
      /no unlisted MuJoCo package files/,
    );
    assert.throws(
      ()=>validateMujocoRuntimeInventory({
        ...parsed,
        runtime_closure:{...parsed.runtime_closure,symlinks:['mujoco/link.so']},
      }),
      /no symlink entries/,
    );
    assert.throws(
      ()=>validateMujocoRuntimeInventory({
        ...parsed,
        runtime_closure:{...parsed.runtime_closure,closure_sha256:'f'.repeat(64)},
      }),
      /does not bind/,
    );
    assert.throws(
      ()=>validateMujocoRuntimeInventory({
        ...parsed,
        required_bindings:parsed.required_bindings.filter((x)=>x.path!==REQUIRED_BINDINGS[0]),
      }),
      /required_bindings must contain exactly the reviewed MuJoCo 3.12.0 binding set/,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 runtime inventory digest is canonical across required-binding input order',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const reordered=structuredClone(parsed);
    reordered.required_bindings=[...reordered.required_bindings].reverse();
    assert.equal(
      mujocoRuntimeInventoryDigest(parsed),
      mujocoRuntimeInventoryDigest(reordered),
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 inventory pins Linux x86_64 Python 3.12 and the exact reviewed binding set',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    assert.match(parsed.python_version,/^3\.12\.\d+$/);
    assert.equal(parsed.platform,'Linux-x86_64');

    assert.throws(
      ()=>validateMujocoRuntimeInventory({...parsed,platform:'Linux-aarch64'}),
      /platform must be Linux-x86_64/,
    );
    assert.throws(
      ()=>validateMujocoRuntimeInventory({...parsed,python_version:'3.13.0'}),
      /Python 3.12.x/,
    );
    assert.throws(
      ()=>validateMujocoRuntimeInventory({
        ...parsed,
        required_bindings:[...parsed.required_bindings,{path:'mujoco/extra.so',sha256:'a'.repeat(64)}],
      }),
      /must contain exactly the reviewed MuJoCo 3.12.0 binding set/,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector allows only closure-bound CPython 3.12 pyc/RECORD unhashed rows and requires sizes for hashed rows',()=>{
  const fx=fixture();
  try{
    const first=collect(fx);
    assert.equal(first.child.status,0,first.child.stderr);
    assert.equal(first.parsed.runtime_closure.record_unhashed_entries.length,2);

    const record=path.join(fx.runtime,'mujoco-3.12.0.dist-info','RECORD');
    const original=fs.readFileSync(record,'utf8');

    fs.writeFileSync(record,original.replace(
      /mujoco\/__init__\.py,sha256=[^,]+,[0-9]+/,
      'mujoco/__init__.py,,',
    ));
    let result=collect(fx);
    assert.notEqual(result.child.status,0);
    assert.match(result.child.stderr,/unhashed RECORD entry is not admissible/);

    fs.writeFileSync(record,original.replace(
      /(mujoco\/__init__\.py,sha256=[^,]+),[0-9]+/,
      '$1,',
    ));
    result=collect(fx);
    assert.notEqual(result.child.status,0);
    assert.match(result.child.stderr,/hashed RECORD entry is missing size/);

    const tampered=structuredClone(first.parsed);
    tampered.runtime_closure.record_unhashed_entries=[
      {path:'mujoco/not-cache.cpython-312.pyc',reason:'generated-cpython312-pyc'},
      {path:'mujoco-3.12.0.dist-info/RECORD',reason:'record-self'},
    ];
    assert.throws(
      ()=>validateMujocoRuntimeInventory(tampered),
      /generated-cpython312-pyc must be a MuJoCo __pycache__/,
    );

    write(fx.runtime,'mujoco/cache.pyc',Buffer.from('unsupported-unhashed-pyc-fixture'));
    const unsupported=original.trimEnd()
      +'\n'+'mujoco/cache.pyc,,\n';
    fs.writeFileSync(record,unsupported);
    result=collect(fx);
    assert.notEqual(result.child.status,0);
    assert.match(result.child.stderr,/unhashed RECORD entry is not admissible/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector bounds stdlib roots and native dependency list sizes before inventory',()=>{
  const fx=fixture();
  try{
    const base={
      protocol:'sbf.sim-mujoco-runtime-admission-collect/draft-1',
      target:'SIM-mujoco',
      runtime_import_root:fx.runtime,
      helper_path:fx.helper,
      wrapper_path:fx.wrapper,
      stdlib_roots:[fx.stdlib],
      native_dependency_files:[{
        logical_path:'system-native/libsystem-fixture.so',
        path:fx.nativeDep,
      }],
    };

    const tooManyStdlib=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
      input:JSON.stringify({...base,stdlib_roots:Array(9).fill(fx.stdlib)}),
      encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
    });
    assert.notEqual(tooManyStdlib.status,0);
    assert.match(tooManyStdlib.stderr,/stdlib_roots exceeds limit 8/);

    const tooManyNative=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
      input:JSON.stringify({
        ...base,
        native_dependency_files:Array.from({length:513},(_,index)=>({
          logical_path:`system-native/dep-${index}.so`,
          path:fx.nativeDep,
        })),
      }),
      encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
    });
    assert.notEqual(tooManyNative.status,0);
    assert.match(tooManyNative.stderr,/native_dependency_files exceeds limit 512/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector rejects duplicate-key/NaN wire input before filesystem inventory',()=>{
  const fx=fixture();
  try{
    for(const raw of [
      '{"protocol":"a","protocol":"b"}',
      '{"protocol":NaN}',
    ]){
      const child=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
        input:raw,encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
      });
      assert.notEqual(child.status,0);
      assert.match(child.stderr,/M4_RUNTIME_INVENTORY_DENIED/);
    }
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector and wrapper reject helper symlink laundering before resolution',{
  skip:process.platform==='win32',
},()=>{
  const fx=fixture();
  try{
    const real=fx.helper+'.real';
    fs.renameSync(fx.helper,real);
    fs.symlinkSync(path.basename(real),fx.helper);
    const {child}=collect(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/contains symlink component/);

    const wrapper=spawnSync('python3',['-I','-S','-B',WRAPPER,fx.runtime,fx.helper,sha(fs.readFileSync(real))],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.notEqual(wrapper.status,0);
    assert.match(wrapper.stderr,/helper contains symlink component/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector and wrapper reject symlinked parent components in fixed absolute inputs',{
  skip:process.platform==='win32',
},()=>{
  const fx=fixture();
  try{
    const aliasParent=path.join(fx.root,'alias-parent');
    fs.symlinkSync(fx.root,aliasParent);

    const collectorRequest={
      protocol:'sbf.sim-mujoco-runtime-admission-collect/draft-1',
      target:'SIM-mujoco',
      runtime_import_root:fx.runtime,
      helper_path:path.join(aliasParent,path.basename(fx.helper)),
      wrapper_path:fx.wrapper,
      stdlib_roots:[fx.stdlib],
      native_dependency_files:[{
        logical_path:'system-native/libsystem-fixture.so',
        path:fx.nativeDep,
      }],
    };
    const collected=spawnSync('python3',['-I','-S','-B',COLLECTOR],{
      input:JSON.stringify(collectorRequest),
      encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
    });
    assert.notEqual(collected.status,0);
    assert.match(collected.stderr,/helper_path contains symlink component/);

    const helperSha=sha(fs.readFileSync(fx.helper));
    const wrapped=spawnSync(
      'python3',
      ['-I','-S','-B',WRAPPER,fx.runtime,path.join(aliasParent,path.basename(fx.helper)),helperSha],
      {encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024},
    );
    assert.notEqual(wrapped.status,0);
    assert.match(wrapped.stderr,/helper contains symlink component/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 collector rejects symlinked parent components before reading RECORD targets',{
  skip:process.platform==='win32',
},()=>{
  const fx=fixture();
  try{
    const outside=path.join(fx.root,'outside');
    fs.mkdirSync(outside,{recursive:true});
    const external=Buffer.from('external-runtime-bytes');
    fs.writeFileSync(path.join(outside,'external.bin'),external);
    fs.symlinkSync(outside,path.join(fx.runtime,'mujoco','linkdir'));

    const record=path.join(fx.runtime,'mujoco-3.12.0.dist-info','RECORD');
    const original=fs.readFileSync(record,'utf8');
    const extra=[
      'mujoco/linkdir/external.bin',
      `sha256=${recordHash(external)}`,
      String(external.length),
    ].join(',');
    fs.writeFileSync(record,original.trimEnd()+'\n'+extra+'\n');

    const {child}=collect(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/contains symlink component/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 plugin list must enumerate the exact plugin closure',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    assert.throws(
      ()=>validateMujocoRuntimeInventory({...parsed,plugin_libraries:[]}),
      /enumerate every plugin entry/,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 A1 evidence remains NOT_ADMITTED and BLOCKED without external enforcement',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const candidate=baseCandidate(parsed,null);
    assert.equal(candidate.schema,MUJOCO_EXECUTION_ADMISSION_CANDIDATE);
    assert.equal(candidate.state,'NOT_ADMITTED');
    assert.equal(candidate.review_readiness,'BLOCKED');
    assert.equal(candidate.execution_authorized,false);
    assert.equal(candidate.t16_runtime_binding_allowed,false);
    assert.equal(candidate.unresolved.includes('enforcement-evidence-missing'),true);
    assert.equal(candidate.unresolved.includes('independent-t20-t16-admission-verdict-required'),true);

    const permission=candidate.helper_plan.helper_requirements.runtime.permission_manifest;
    assert.deepEqual(permission.read_roots,['inputs/mujoco']);
    assert.deepEqual(permission.write_roots,[]);
    assert.deepEqual(permission.network,{mode:'deny',allow:[]});
    assert.deepEqual(permission.listen,{mode:'deny',allow:[]});
    assert.deepEqual(permission.environment,{allow:[]});
    assert.deepEqual(permission.secret_refs,[]);
    assert.deepEqual(permission.devices,{mode:'deny',allow:[]});
    assert.deepEqual(permission.process,{
      mode:'argv-allowlist',
      executables:[parsed.launcher.basename],
      max_children:1,
    });
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 complete structural evidence becomes review-ready only and still cannot self-admit',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const preliminary=baseCandidate(parsed,null);
    const enforcement={
      schema:MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA,
      target:'SIM-mujoco',
      runner_implementation_sha256:'1'.repeat(64),
      runtime_execution_policy_sha256:'2'.repeat(64),
      permission_manifest_sha256:preliminary.permission_manifest_digest,
      runtime_inventory_sha256:mujocoRuntimeInventoryDigest(parsed),
      probe_receipt_bundle_sha256:'3'.repeat(64),
      probes:{
        source_mount_read_only:true,
        runtime_mount_read_only:true,
        source_symlink_denied:true,
        source_hardlink_denied:true,
        source_write_denied:true,
        runtime_write_denied:true,
        network_connect_denied:true,
        network_listen_denied:true,
        unexpected_process_denied:true,
        ambient_environment_empty:true,
        pre_post_source_hash_equal:true,
        runtime_closure_reverified:true,
        stdlib_closure_reverified:true,
        native_library_reverified:true,
        native_dependency_closure_reverified:true,
        plugin_closure_reverified:true,
        decoder_closure_reverified:true,
        resource_provider_closure_reverified:true,
      },
    };
    const candidate=baseCandidate(parsed,enforcement);
    assert.equal(candidate.state,'NOT_ADMITTED');
    assert.equal(candidate.review_readiness,'READY_FOR_INDEPENDENT_REVIEW');
    assert.equal(candidate.execution_authorized,false);
    assert.equal(candidate.t16_runtime_binding_allowed,false);
    assert.equal(candidate.unresolved.includes('independent-t20-t16-admission-verdict-required'),true);
    assert.equal(candidate.unresolved.includes('t16-runtime-binding-not-created'),true);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 enforcement evidence must bind exact permission and runtime inventory digests',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const bad={
      schema:MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA,
      target:'SIM-mujoco',
      runner_implementation_sha256:'1'.repeat(64),
      runtime_execution_policy_sha256:'2'.repeat(64),
      permission_manifest_sha256:'f'.repeat(64),
      runtime_inventory_sha256:'e'.repeat(64),
      probe_receipt_bundle_sha256:'3'.repeat(64),
      probes:{
        source_mount_read_only:true,
        runtime_mount_read_only:true,
        source_symlink_denied:true,
        source_hardlink_denied:true,
        source_write_denied:true,
        runtime_write_denied:true,
        network_connect_denied:true,
        network_listen_denied:true,
        unexpected_process_denied:true,
        ambient_environment_empty:true,
        pre_post_source_hash_equal:true,
        runtime_closure_reverified:true,
        stdlib_closure_reverified:true,
        native_library_reverified:true,
        native_dependency_closure_reverified:true,
        plugin_closure_reverified:true,
        decoder_closure_reverified:true,
        resource_provider_closure_reverified:true,
      },
    };
    const candidate=baseCandidate(parsed,bad);
    assert.equal(candidate.review_readiness,'BLOCKED');
    assert.equal(candidate.unresolved.includes('permission-manifest-digest-mismatch'),true);
    assert.equal(candidate.unresolved.includes('runtime-inventory-digest-mismatch'),true);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 enforcement evidence requires an exact negative-probe receipt bundle digest',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    const preliminary=baseCandidate(parsed,null);
    const enforcement={
      schema:MUJOCO_EXECUTION_ENFORCEMENT_SCHEMA,
      target:'SIM-mujoco',
      runner_implementation_sha256:'1'.repeat(64),
      runtime_execution_policy_sha256:'2'.repeat(64),
      permission_manifest_sha256:preliminary.permission_manifest_digest,
      runtime_inventory_sha256:mujocoRuntimeInventoryDigest(parsed),
      probe_receipt_bundle_sha256:'3'.repeat(64),
      probes:{
        source_mount_read_only:true,
        runtime_mount_read_only:true,
        source_symlink_denied:true,
        source_hardlink_denied:true,
        source_write_denied:true,
        runtime_write_denied:true,
        network_connect_denied:true,
        network_listen_denied:true,
        unexpected_process_denied:true,
        ambient_environment_empty:true,
        pre_post_source_hash_equal:true,
        runtime_closure_reverified:true,
        stdlib_closure_reverified:true,
        native_library_reverified:true,
        native_dependency_closure_reverified:true,
        plugin_closure_reverified:true,
        decoder_closure_reverified:true,
        resource_provider_closure_reverified:true,
      },
    };
    const ok=baseCandidate(parsed,enforcement);
    assert.equal(ok.enforcement_evidence.probe_receipt_bundle_sha256,'3'.repeat(64));

    const missing=structuredClone(enforcement);
    delete missing.probe_receipt_bundle_sha256;
    assert.throws(
      ()=>baseCandidate(parsed,missing),
      /must contain exactly/,
    );

    const invalid={...enforcement,probe_receipt_bundle_sha256:'not-a-hash'};
    assert.throws(
      ()=>baseCandidate(parsed,invalid),
      /probe_receipt_bundle_sha256 must be a lowercase SHA-256/,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 wrapper requires -I -S -B, exact helper bytes, and ignores source-tree pycache',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4-wrapper-'));
  try{
    const runtime=path.join(root,'runtime');
    const mujocoDir=path.join(runtime,'mujoco');
    const source=path.join(mujocoDir,'__init__.py');
    const sourcePycache=path.join(mujocoDir,'__pycache__');
    fs.mkdirSync(sourcePycache,{recursive:true});
    fs.writeFileSync(source,'VALUE="BYTECODE"\n');

    const cacheTag=spawnSync('python3',['-c','import sys; print(sys.implementation.cache_tag)'],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.equal(cacheTag.status,0,cacheTag.stderr);
    const pyc=path.join(sourcePycache,`__init__.${cacheTag.stdout.trim()}.pyc`);
    const compiled=spawnSync('python3',[
      '-c',
      [
        'import py_compile,sys',
        'py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True,',
        '  invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)',
      ].join('\n'),
      source,
      pyc,
    ],{encoding:'utf8',env:{},timeout:10_000});
    assert.equal(compiled.status,0,compiled.stderr);

    // An unchecked-hash pyc would normally remain executable even after the
    // source changes. The wrapper must force Python to ignore source-tree
    // __pycache__ and execute these reviewed source bytes instead.
    fs.writeFileSync(source,'VALUE="SOURCE"\n');

    const helper=path.join(root,'probe.py');
    fs.writeFileSync(helper,[
      'import sys',
      'from pathlib import Path',
      'assert sys.flags.isolated == 1',
      'assert sys.flags.no_site == 1',
      'assert sys.flags.dont_write_bytecode == 1',
      'runtime_root = Path(sys.path[-1])',
      'expected = runtime_root / "mujoco" / ".bskel-no-pyc-cache"',
      'assert sys.pycache_prefix == str(expected)',
      'import mujoco',
      'assert mujoco.VALUE == "SOURCE"',
      'print("WRAPPER_PROBE_PASS")',
      '',
    ].join('\n'));
    const helperSha=sha(fs.readFileSync(helper));

    const ok=spawnSync('python3',['-I','-S','-B',WRAPPER,runtime,helper,helperSha],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/WRAPPER_PROBE_PASS/);

    const isolationPrefix=path.join(mujocoDir,'.bskel-no-pyc-cache');
    assert.equal(fs.existsSync(isolationPrefix),false);

    fs.mkdirSync(isolationPrefix);
    const occupied=spawnSync('python3',['-I','-S','-B',WRAPPER,runtime,helper,helperSha],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.notEqual(occupied.status,0);
    assert.match(occupied.stderr,/pycache isolation prefix must not exist/);
    fs.rmSync(isolationPrefix,{recursive:true,force:true});

    const wrong=spawnSync('python3',['-I','-S','-B',WRAPPER,runtime,helper,'f'.repeat(64)],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.notEqual(wrong.status,0);
    assert.match(wrong.stderr,/helper bytes do not match/);

    const flags=spawnSync('python3',[WRAPPER,runtime,helper,helperSha],{
      encoding:'utf8',env:{},timeout:10_000,
    });
    assert.notEqual(flags.status,0);
    assert.match(flags.stderr,/isolated mode/);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4 collector exposes generated or unlisted MuJoCo files and verifier blocks them',()=>{
  const fx=fixture();
  try{
    write(fx.runtime,'mujoco/__pycache__/rogue.pyc','generated');
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    assert.equal(parsed.runtime_closure.unlisted_files.includes('mujoco/__pycache__/rogue.pyc'),true);
    assert.throws(()=>validateMujocoRuntimeInventory(parsed),/no unlisted MuJoCo package files/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4 admission input rejects approval knobs and revoked required runtime bytes',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=collect(fx);
    assert.equal(child.status,0,child.stderr);
    assert.throws(
      ()=>buildMujocoExecutionAdmissionCandidate({
        m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
        runtimeInventory:parsed,
        currentArtifactTrustPolicy:emptyPolicy(),
        readRoots:['inputs/mujoco'],
        limits:limits(),
        enforcementEvidence:null,
        approved:true,
      }),
      /must contain exactly/,
    );

    const revoked=emptyPolicy();
    revoked.generation=4;
    revoked.revoked=[{
      sha256:parsed.native_library.sha256,
      reason:'runtime native library revoked by independent security review',
    }];
    assert.throws(
      ()=>buildMujocoExecutionAdmissionCandidate({
        m3CandidateSha:'78dcf2d720215e4c9cd54b0402eb83083b1a5ddd',
        runtimeInventory:parsed,
        currentArtifactTrustPolicy:revoked,
        readRoots:['inputs/mujoco'],
        limits:limits(),
        enforcementEvidence:null,
      }),
      /required runtime digest is revoked/,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});


test('M4 collector rejects duplicate RECORD paths',()=>{
  const fx=fixture();
  try{
    const record=path.join(fx.runtime,'mujoco-3.12.0.dist-info','RECORD');
    const rows=fs.readFileSync(record,'utf8').trimEnd().split('\n');
    fs.writeFileSync(record,[...rows,rows[0],''].join('\n'));
    const result=collect(fx);
    assert.notEqual(result.child.status,0);
    assert.match(result.child.stderr,/duplicate path/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});
