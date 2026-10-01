import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { artifactRefForBytes } from '../../../adapters/sim-next/identity.mjs';
import { validateMujocoEffectiveModelExport } from '../../../adapters/sim-next/mujoco/effective-model.mjs';
import {
  MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION,
  MUJOCO_EFFECTIVE_HELPER_REQUEST,
  MUJOCO_EFFECTIVE_HELPER_RESPONSE,
  validateMujocoEffectiveHelperRequest,
  validateMujocoEffectiveHelperResponse,
} from '../../../adapters/sim-next/mujoco/helper-protocol.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const HELPER=path.resolve(HERE,'../../../adapters/sim-next/mujoco/effective_model_helper.py');
const HELPER_BYTES=fs.readFileSync(HELPER);

function artifact(bytes, family, mediaType='application/octet-stream') {
  return artifactRefForBytes(Buffer.from(bytes), {
    family,
    version:'draft-1',
    mediaType,
  });
}

function request(sourceBytes='<mujoco/>') {
  return {
    protocol:MUJOCO_EFFECTIVE_HELPER_REQUEST,
    target:'SIM-mujoco',
    source_bundle:{
      root:{
        path:'models/main.xml',
        artifact:artifact(sourceBytes,'simulation-source','application/xml'),
      },
      dependencies:[],
    },
    helper_artifact:artifact(HELPER_BYTES,'simulation-helper','text/x-python'),
  };
}

function goldenResponse(req=request()) {
  return {
    protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
    ok:true,
    effective_model:{
      schema:'sbf.sim-mujoco-effective-model/draft-1',
      target:'SIM-mujoco',
      source_bundle:req.source_bundle,
      compiler:{
        engine:'mujoco',
        version:MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION,
        build:null,
        helper_artifact:req.helper_artifact,
      },
      model:{
        counts:{
          nbody:2,
          njnt:1,
          ngeom:1,
          nsite:1,
          ntendon:0,
          nq:1,
          nv:1,
          na:0,
          nu:2,
          nactuator:1,
          nout:1,
          nsensor:1,
          nsensordata:1,
        },
        options:{
          timestep:0.002,
          gravity:[0,0,-9.81],
          integrator:'Euler',
        },
        bodies:[
          { id:0,name:'world',parent_id:0 },
          { id:1,name:'link',parent_id:0 },
        ],
        joints:[
          {
            id:0,name:'hinge',body_id:1,type:'hinge',
            qpos_adr:0,dof_adr:0,qpos_width:1,dof_width:1,
            limited:true,range:[-1,1],
          },
        ],
        geoms:[
          { id:0,name:'g',body_id:1,type:'capsule',contype:1,conaffinity:1 },
        ],
        sites:[
          { id:0,name:'tip',body_id:1 },
        ],
        actuators:[
          {
            id:0,name:'m',transmission_type:'joint',target_ids:[0,-1],
            control_adr:0,control_count:2,
            controls:[
              { limited:true,range:[-1,1] },
              { limited:false,range:null },
            ],
            output_adr:0,output_count:1,
            activation_adr:-1,activation_count:0,
          },
        ],
        sensors:[
          { id:0,name:'jp',type:'jointpos',object_type:'joint',object_id:0,adr:0,dim:1 },
        ],
      },
      claims:{
        compiled_model_facts:true,
        source_bundle_bound:true,
        runtime_behavior_verified:false,
        dynamic_state_observed:false,
      },
    },
  };
}

function runHelper(req, files={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m3-helper-'));
  try {
    for (const [relative,bytes] of Object.entries(files)) {
      const target=path.join(dir,...relative.split('/'));
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,bytes);
    }
    const child=spawnSync('python3',['-I','-S','-B',HELPER],{
      cwd:dir,
      input:JSON.stringify(req),
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:4*1024*1024,
      env:{},
    });
    assert.equal(child.signal,null);
    assert.equal(child.stderr,'');
    const parsed=JSON.parse(child.stdout);
    return { child, parsed };
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('M3 Python wire rejects duplicate JSON keys and non-standard numeric constants', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m3-wire-'));
  try {
    for (const raw of [
      '{"protocol":"a","protocol":"b"}',
      '{"protocol":NaN}',
      '{"protocol":Infinity}',
    ]) {
      const child=spawnSync('python3',['-I','-S','-B',HELPER],{
        cwd:dir,input:raw,encoding:'utf8',
        timeout:10_000,maxBuffer:4*1024*1024,env:{},
      });
      assert.notEqual(child.status,0);
      assert.equal(child.stderr,'');
      const parsed=JSON.parse(child.stdout);
      assert.equal(parsed.protocol,MUJOCO_EFFECTIVE_HELPER_RESPONSE);
      assert.equal(parsed.ok,false);
      assert.equal(parsed.error.code,'REQUEST_INVALID');
    }
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('M3 helper request is exact-key bounded and preserves exact source/helper ArtifactRefs', () => {
  const req=request();
  const validated=validateMujocoEffectiveHelperRequest(req);
  assert.equal(validated.protocol,MUJOCO_EFFECTIVE_HELPER_REQUEST);
  assert.equal(validated.source_bundle.root.path,'models/main.xml');
  assert.equal(validated.helper_artifact.byte_sha256,req.helper_artifact.byte_sha256);

  for (const [field,value] of [
    ['repoRoot','/tmp/repo'],
    ['pythonCommand','python3'],
    ['networkAllow',['example.com']],
    ['writeRoots',['scratch']],
    ['targetCodeExecution',true],
  ]) {
    assert.throws(
      () => validateMujocoEffectiveHelperRequest({ ...req,[field]:value }),
      new RegExp(`unsupported fields: ${field}`),
    );
  }
});

test('M3 helper request rejects source traversal duplicate paths roles and wrong ArtifactRef families', () => {
  const traversal=request();
  traversal.source_bundle.root.path='../main.xml';
  assert.throws(() => validateMujocoEffectiveHelperRequest(traversal),/repo-relative POSIX path/);

  const duplicate=request();
  duplicate.source_bundle.dependencies=[{
    path:'models/main.xml',
    role:'include',
    artifact:artifact('copy','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveHelperRequest(duplicate),/duplicate logical path/);

  const role=request();
  role.source_bundle.dependencies=[{
    path:'models/dep.xml',
    role:'generated',
    artifact:artifact('dep','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveHelperRequest(role),/role must be include or asset/);

  const family=request();
  family.helper_artifact={...family.helper_artifact,family:'simulation-source'};
  assert.throws(() => validateMujocoEffectiveHelperRequest(family),/ArtifactRef.family must be simulation-helper/);
});

test('M3 success response is M2-validated and bound to exact request source/helper identities', () => {
  const req=request();
  const response=goldenResponse(req);
  const result=validateMujocoEffectiveHelperResponse(response,{request:req});
  assert.equal(result.ok,true);
  assert.equal(result.effective_model.model.counts.nactuator,1);
  assert.equal(result.effective_model.model.counts.nu,2);

  const reordered=request();
  const helperRef=reordered.helper_artifact;
  reordered.helper_artifact={
    size_bytes:helperRef.size_bytes,
    byte_sha256:helperRef.byte_sha256,
    media_type:helperRef.media_type,
    version:helperRef.version,
    family:helperRef.family,
    artifact_ref:helperRef.artifact_ref,
  };
  const sourceRef=reordered.source_bundle.root.artifact;
  reordered.source_bundle.root.artifact={
    size_bytes:sourceRef.size_bytes,
    byte_sha256:sourceRef.byte_sha256,
    media_type:sourceRef.media_type,
    version:sourceRef.version,
    family:sourceRef.family,
    artifact_ref:sourceRef.artifact_ref,
  };
  assert.equal(
    validateMujocoEffectiveHelperResponse(goldenResponse(request()),{request:reordered}).ok,
    true,
  );

  const wrongSource=goldenResponse(req);
  wrongSource.effective_model.source_bundle={
    ...wrongSource.effective_model.source_bundle,
    root:{
      ...wrongSource.effective_model.source_bundle.root,
      path:'models/other.xml',
    },
  };
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(wrongSource,{request:req}),
    /source_bundle does not match the exact request/,
  );

  const wrongHelper=goldenResponse(req);
  wrongHelper.effective_model.compiler.helper_artifact=artifact(
    'other-helper',
    'simulation-helper',
    'text/x-python',
  );
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(wrongHelper,{request:req}),
    /helper_artifact does not match the exact request/,
  );
});

test('M3 authoritative success response requires the exact invocation request', () => {
  const response=goldenResponse();
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(response),
    /requires exact request binding authority/,
  );

  assert.equal(
    validateMujocoEffectiveHelperResponse({
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:false,
      error:{code:'MODEL_COMPILE_FAILED',message:'fixture failed'},
    }).ok,
    false,
  );
});

test('M3 response refuses runtime claims version drift and loose error envelopes', () => {
  const req=request();

  const runtime=goldenResponse(req);
  runtime.effective_model.claims.runtime_behavior_verified=true;
  assert.throws(() => validateMujocoEffectiveHelperResponse(runtime,{request:req}),/cannot claim runtime behavior/);

  const version=goldenResponse(req);
  version.effective_model.compiler.version='3.13.0';
  assert.throws(() => validateMujocoEffectiveHelperResponse(version,{request:req}),/compiler.version must be 3.12.0/);

  assert.deepEqual(
    validateMujocoEffectiveHelperResponse({
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:false,
      error:{code:'MODEL_COMPILE_FAILED',message:'fixture failed'},
    }),
    {
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:false,
      error:{code:'MODEL_COMPILE_FAILED',message:'fixture failed'},
    },
  );

  assert.throws(
    () => validateMujocoEffectiveHelperResponse({
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:false,
      error:{code:'bad-code',message:'fixture failed'},
    }),
    /error.code is invalid/,
  );
});

test('M3 Python helper fails malformed request before any MuJoCo import', () => {
  const bad={...request(),unexpected:true};
  const {child,parsed}=runHelper(bad,{});
  assert.notEqual(child.status,0);
  assert.equal(parsed.protocol,MUJOCO_EFFECTIVE_HELPER_RESPONSE);
  assert.equal(parsed.ok,false);
  assert.equal(parsed.error.code,'REQUEST_INVALID');
});

test('M3 Python helper binds its own exact bytes before source compilation', () => {
  const req=request();
  req.helper_artifact=artifact('not-the-helper','simulation-helper','text/x-python');
  const {child,parsed}=runHelper(req,{});
  assert.notEqual(child.status,0);
  assert.equal(parsed.ok,false);
  assert.equal(parsed.error.code,'HELPER_ARTIFACT_MISMATCH');
});

test('M3 Python helper rejects source-byte mismatch and unlisted staging files before MuJoCo import', () => {
  const bytes='<mujoco/>';

  const mismatch=request('different bytes');
  const first=runHelper(mismatch,{'models/main.xml':bytes});
  assert.notEqual(first.child.status,0);
  assert.equal(first.parsed.error.code,'SOURCE_CLOSURE_INVALID');

  const extra=request(bytes);
  const second=runHelper(extra,{
    'models/main.xml':bytes,
    'models/unlisted.xml':'<mujoco/>',
  });
  assert.notEqual(second.child.status,0);
  assert.equal(second.parsed.error.code,'SOURCE_CLOSURE_INVALID');
  assert.match(second.parsed.error.message,/file set does not equal source_bundle/);
});

test('M3 compiler read-closure preflight rejects absolute and undeclared asset reads before MuJoCo import', () => {
  const absolute='<mujoco><compiler meshdir="/tmp"/><asset><mesh name="m" file="outside.obj"/></asset></mujoco>';
  const first=runHelper(request(absolute),{'models/main.xml':absolute});
  assert.notEqual(first.child.status,0);
  assert.equal(first.parsed.error.code,'SOURCE_CLOSURE_INVALID');
  assert.match(first.parsed.error.message,/compiler\.meshdir|relative POSIX path/);

  const undeclared='<mujoco><asset><mesh name="m" file="outside.obj"/></asset></mujoco>';
  const second=runHelper(request(undeclared),{'models/main.xml':undeclared});
  assert.notEqual(second.child.status,0);
  assert.equal(second.parsed.error.code,'SOURCE_CLOSURE_INVALID');
  assert.match(second.parsed.error.message,/undeclared compiler input/);
});

test('M3 compiler read-closure preflight accepts an exactly declared relative asset dependency', () => {
  const xml='<mujoco><asset><mesh name="m" file="mesh.obj"/></asset></mujoco>';
  const req=request(xml);
  const assetBytes='v 0 0 0\n';
  req.source_bundle.dependencies=[{
    path:'models/mesh.obj',
    role:'asset',
    artifact:artifact(assetBytes,'simulation-source','model/obj'),
  }];

  const script=String.raw`
import hashlib
import importlib.util
import json
import pathlib
import sys

helper_path=sys.argv[1]
request_json=sys.argv[2]
spec=importlib.util.spec_from_file_location("m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
req=json.loads(request_json)
module.verify_staged_source_closure(req["source_bundle"],pathlib.Path.cwd())
print("OK")
`;

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m3-closure-positive-'));
  try {
    fs.mkdirSync(path.join(dir,'models'),{recursive:true});
    fs.writeFileSync(path.join(dir,'models','main.xml'),xml);
    fs.writeFileSync(path.join(dir,'models','mesh.obj'),assetBytes);
    const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER,JSON.stringify(req)],{
      cwd:dir,encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,env:{},
    });
    assert.equal(child.status,0,child.stderr || child.stdout);
    assert.equal(child.stdout.trim(),'OK');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('M3 Python helper rejects symlinks in approved staging closure', {
  skip:process.platform === 'win32',
}, () => {
  const bytes='<mujoco/>';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m3-symlink-'));
  try {
    fs.mkdirSync(path.join(dir,'models'),{recursive:true});
    fs.writeFileSync(path.join(dir,'outside.xml'),bytes);
    fs.symlinkSync('../outside.xml',path.join(dir,'models','main.xml'));

    const req=request(bytes);
    req.source_bundle.root.path='models/main.xml';
    // Include outside.xml so the only closure violation under attack is the symlink itself.
    req.source_bundle.dependencies=[{
      path:'outside.xml',
      role:'include',
      artifact:artifact(bytes,'simulation-source','application/xml'),
    }];

    const child=spawnSync('python3',['-I','-S','-B',HELPER],{
      cwd:dir,input:JSON.stringify(req),encoding:'utf8',
      timeout:10_000,maxBuffer:4*1024*1024,env:{},
    });
    const parsed=JSON.parse(child.stdout);
    assert.notEqual(child.status,0);
    assert.equal(parsed.error.code,'SOURCE_CLOSURE_INVALID');
    assert.match(parsed.error.message,/symlink/);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('M3 pure extractor preserves nactuator != nu != nout and produces an M2-valid envelope', () => {
  const script=String.raw`
import importlib.util
import json
import sys
from types import SimpleNamespace

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class mjtIntegrator:
    mjINT_EULER=0
class mjtJoint:
    mjJNT_FREE=0
    mjJNT_BALL=1
    mjJNT_SLIDE=2
    mjJNT_HINGE=3
class mjtGeom:
    mjGEOM_CAPSULE=5
class mjtTrn:
    mjTRN_JOINT=0
    mjTRN_JOINTINPARENT=1
    mjTRN_SLIDERCRANK=2
    mjTRN_TENDON=3
    mjTRN_SITE=4
    mjTRN_BODY=5
class mjtSensor:
    mjSENS_JOINTPOS=9
class mjtObj:
    mjOBJ_BODY=1
    mjOBJ_JOINT=3
    mjOBJ_GEOM=5
    mjOBJ_SITE=6
    mjOBJ_ACTUATOR=19
    mjOBJ_SENSOR=20

names={
    (1,0):"world",(1,1):"link",(3,0):"hinge",(5,0):"g",
    (6,0):"tip",(19,0):"m",(20,0):"jp",
}
def mj_id2name(model,obj,index):
    return names.get((int(obj),index))

mj=SimpleNamespace(
    mjtIntegrator=mjtIntegrator,mjtJoint=mjtJoint,mjtGeom=mjtGeom,
    mjtTrn=mjtTrn,mjtSensor=mjtSensor,mjtObj=mjtObj,mj_id2name=mj_id2name,
)
model=SimpleNamespace(
    nbody=2,njnt=1,ngeom=1,nsite=1,ntendon=0,
    nq=1,nv=1,na=0,nu=2,nactuator=1,nout=1,nsensor=1,nsensordata=1,
    opt=SimpleNamespace(timestep=0.002,gravity=[0.0,0.0,-9.81],integrator=0),
    body_parentid=[0,0],
    jnt_type=[3],jnt_qposadr=[0],jnt_dofadr=[0],jnt_bodyid=[1],
    jnt_limited=[True],jnt_range=[[-1.0,1.0]],
    geom_type=[5],geom_bodyid=[1],geom_contype=[1],geom_conaffinity=[1],
    site_bodyid=[1],
    actuator_trntype=[0],actuator_ctrladr=[0],actuator_ctrlnum=[2],
    actuator_outadr=[0],actuator_outnum=[1],actuator_actadr=[-1],
    actuator_actnum=[0],actuator_trnid=[[0,-1]],
    actuator_ctrllimited=[True,False],
    actuator_ctrlrange=[[-1.0,1.0],[0.0,0.0]],
    sensor_type=[9],sensor_objtype=[3],sensor_objid=[0],sensor_adr=[0],sensor_dim=[1],
)
source={
    "root":{"path":"models/main.xml","artifact":{
        "artifact_ref":"sbf.artifact-ref/1","family":"simulation-source",
        "version":"draft-1","media_type":"application/xml",
        "byte_sha256":"a"*64,"size_bytes":1,
    }},
    "dependencies":[],
}
helper_artifact={
    "artifact_ref":"sbf.artifact-ref/1","family":"simulation-helper",
    "version":"draft-1","media_type":"text/x-python",
    "byte_sha256":"b"*64,"size_bytes":1,
}
result=module.extract_effective_model(
    model,mj,source_bundle=source,helper_artifact=helper_artifact,version="3.12.0"
)
print(json.dumps(result,separators=(",",":"),allow_nan=False))
`;

  const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
    encoding:'utf8',
    timeout:10_000,
    maxBuffer:4*1024*1024,
    env:{},
  });
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stderr,'');
  const result=JSON.parse(child.stdout);
  const validated=validateMujocoEffectiveModelExport(result);
  assert.equal(validated.model.counts.nactuator,1);
  assert.equal(validated.model.counts.nu,2);
  assert.equal(validated.model.counts.nout,1);
  assert.equal(validated.model.counts.na,0);
  assert.equal(validated.model.actuators.length,1);
  assert.equal(validated.model.actuators[0].controls.length,2);
});

test('M3 pure extractor fails closed on an unreviewed transmission enum', () => {
  const source=fs.readFileSync(HELPER,'utf8');
  assert.match(source,/unreviewed actuator transmission type/);
  assert.match(source,/TRANSMISSION_ENUMS/);
  assert.doesNotMatch(source,/SO3.*"so3"/);
});

test('M3 helper source is compiler-only and contains no physics-step/render/network/process escape', () => {
  const source=fs.readFileSync(HELPER,'utf8');
  assert.match(source,/MjModel\.from_xml_path/);
  assert.equal(
    [...source.matchAll(/verify_staged_source_closure\(request\["source_bundle"\], staging_root\)/g)].length,
    2,
  );
  for (const forbidden of [
    /MjData\s*\(/,
    /mj_step\s*\(/,
    /mj_forward\s*\(/,
    /Renderer\s*\(/,
    /import\s+socket/,
    /import\s+subprocess/,
    /import\s+urllib/,
    /import\s+requests/,
    /os\.environ/,
    /Popen\s*\(/,
  ]) {
    assert.doesNotMatch(source,forbidden);
  }
});
