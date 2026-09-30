import test from 'node:test';
import assert from 'node:assert/strict';

import { artifactRefForBytes } from '../../../adapters/sim-next/identity.mjs';
import {
  MUJOCO_EFFECTIVE_MODEL_SCHEMA,
  validateMujocoEffectiveModelExport,
} from '../../../adapters/sim-next/mujoco/effective-model.mjs';

function artifact(bytes, family, mediaType='application/octet-stream') {
  return artifactRefForBytes(Buffer.from(bytes), {
    family,
    version:'draft-1',
    mediaType,
  });
}

function golden() {
  return {
    schema:MUJOCO_EFFECTIVE_MODEL_SCHEMA,
    target:'SIM-mujoco',
    source_bundle:{
      root:{
        path:'models/main.xml',
        artifact:artifact('<mujoco/>','simulation-source','application/xml'),
      },
      dependencies:[],
    },
    compiler:{
      engine:'mujoco',
      version:'fixture-3.x',
      build:null,
      helper_artifact:artifact('helper','simulation-helper','text/x-python'),
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
        nu:1,
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
        { id:0, name:'world', parent_id:0 },
        { id:1, name:'link', parent_id:0 },
      ],
      joints:[
        {
          id:0,
          name:'hinge',
          body_id:1,
          type:'hinge',
          qpos_adr:0,
          dof_adr:0,
          qpos_width:1,
          dof_width:1,
          limited:true,
          range:[-1,1],
        },
      ],
      geoms:[
        { id:0, name:'g', body_id:1, type:'capsule', contype:1, conaffinity:1 },
      ],
      sites:[
        { id:0, name:'tip', body_id:1 },
      ],
      actuators:[
        {
          id:0,
          name:'m',
          transmission_type:'joint',
          target_ids:[0,-1],
          control_adr:0,
          control_count:1,
          controls:[{ limited:true, range:[-1,1] }],
          output_adr:0,
          output_count:1,
          activation_adr:-1,
          activation_count:0,
        },
      ],
      sensors:[
        { id:0, name:'jp', type:'jointpos', object_type:'joint', object_id:0, adr:0, dim:1 },
      ],
    },
    claims:{
      compiled_model_facts:true,
      source_bundle_bound:true,
      runtime_behavior_verified:false,
      dynamic_state_observed:false,
    },
  };
}

test('accepts a bounded compiled-model facts envelope without promoting runtime behavior', () => {
  const result=validateMujocoEffectiveModelExport(golden());
  assert.equal(result.target,'SIM-mujoco');
  assert.equal(result.model.counts.nq,1);
  assert.equal(result.model.joints[0].qpos_adr,0);
  assert.equal(result.claims.runtime_behavior_verified,false);
  assert.equal(result.claims.dynamic_state_observed,false);
});

test('joint type fixes qpos/dof widths and invalid widths fail closed', () => {
  const value=golden();
  value.model.joints[0].type='free';
  value.model.joints[0].qpos_width=1;
  value.model.joints[0].dof_width=1;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /widths do not match joint type free/);
});

test('qpos/qvel address ranges must exactly cover nq/nv without gaps or overlaps', () => {
  const value=golden();
  value.model.counts.nq=2;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /qpos coverage is incomplete/);

  const two=golden();
  two.model.counts.njnt=2;
  two.model.counts.nq=2;
  two.model.counts.nv=2;
  two.model.joints.push({
    id:1,name:'j2',body_id:1,type:'hinge',qpos_adr:0,dof_adr:1,qpos_width:1,dof_width:1,limited:false,range:null,
  });
  assert.throws(() => validateMujocoEffectiveModelExport(two), /qpos ranges overlap/);
});

test('sensor addresses must exactly cover sensordata', () => {
  const value=golden();
  value.model.sensors[0].adr=1;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /sensordata range exceeds total/);

  const gap=golden();
  gap.model.counts.nsensordata=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /sensordata coverage is incomplete/);
});

test('stateful actuator activation ranges are checked against na and stateless uses -1', () => {
  const stateful=golden();
  stateful.model.counts.na=1;
  stateful.model.actuators[0].activation_adr=0;
  stateful.model.actuators[0].activation_count=1;
  assert.equal(validateMujocoEffectiveModelExport(stateful).model.actuators[0].activation_adr,0);

  const bad=golden();
  bad.model.actuators[0].activation_adr=0;
  assert.throws(() => validateMujocoEffectiveModelExport(bad), /zero activation_count must use activation_adr=-1/);
});

test('effective-model count and source-closure limits fail before oversized allocations', () => {
  const huge=golden();
  huge.model.counts.nq=1_000_001;
  assert.throws(() => validateMujocoEffectiveModelExport(huge), /model.counts.nq must be an integer in/);

  const many=golden();
  many.source_bundle.dependencies=Array.from({ length:10_000 }, (_, index) => ({
    path:`models/d${index}.xml`,
    role:'include',
    artifact:artifact(`<mujoco model="${index}"/>`,'simulation-source','application/xml'),
  }));
  assert.throws(() => validateMujocoEffectiveModelExport(many), /file-count limit/);
});

test('body parent validation handles long acyclic chains without quadratic traversal', () => {
  const value=golden();
  const n=2000;
  value.model.counts.nbody=n;
  value.model.bodies=Array.from({ length:n }, (_, id) => ({
    id,
    name:id===0?'world':`b${id}`,
    parent_id:id===0?0:id-1,
  }));
  value.model.joints[0].body_id=n-1;
  value.model.geoms[0].body_id=n-1;
  value.model.sites[0].body_id=n-1;
  assert.equal(validateMujocoEffectiveModelExport(value).model.bodies.length,n);
});

test('compiled body parent graph must reach world without cycles', () => {
  const value=golden();
  value.model.counts.nbody=3;
  value.model.bodies=[
    { id:0,name:'world',parent_id:0 },
    { id:1,name:'a',parent_id:2 },
    { id:2,name:'b',parent_id:1 },
  ];
  value.model.joints[0].body_id=1;
  value.model.geoms[0].body_id=1;
  value.model.sites[0].body_id=1;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /parent graph contains a cycle/);
});

test('nactuator, nu and nout are distinct compiled counts', () => {
  const value=golden();
  value.model.counts.nu=2;
  value.model.counts.nactuator=1;
  value.model.counts.nout=1;
  value.model.actuators[0].control_count=2;
  value.model.actuators[0].controls=[
    { limited:true, range:[-1,1] },
    { limited:false, range:null },
  ];
  const result=validateMujocoEffectiveModelExport(value);
  assert.equal(result.model.actuators.length,1);
  assert.equal(result.model.counts.nu,2);
  assert.equal(result.model.counts.nactuator,1);
  assert.equal(result.model.counts.nout,1);
});

test('actuator control/output address ranges exactly cover nu/nout', () => {
  const controlGap=golden();
  controlGap.model.counts.nu=2;
  assert.throws(() => validateMujocoEffectiveModelExport(controlGap), /control coverage is incomplete/);

  const outputGap=golden();
  outputGap.model.counts.nout=2;
  assert.throws(() => validateMujocoEffectiveModelExport(outputGap), /output coverage is incomplete/);

  const mismatch=golden();
  mismatch.model.actuators[0].controls=[];
  assert.throws(() => validateMujocoEffectiveModelExport(mismatch), /controls length must equal control_count/);
});

test('actuator array length is nactuator, not nu', () => {
  const value=golden();
  value.model.counts.nactuator=2;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /model.actuators length must equal 2/);
});

test('actuator transmission target ids are range-checked by compiled transmission type', () => {
  const joint=golden();
  joint.model.actuators[0].target_ids=[4,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(joint), /joint transmission target_ids are invalid/);

  const site=golden();
  site.model.actuators[0].transmission_type='site';
  site.model.actuators[0].target_ids=[0,4];
  assert.throws(() => validateMujocoEffectiveModelExport(site), /site transmission target_ids are invalid/);

  const slider=golden();
  slider.model.actuators[0].transmission_type='slidercrank';
  slider.model.actuators[0].target_ids=[0,0];
  assert.equal(validateMujocoEffectiveModelExport(slider).model.actuators[0].transmission_type,'slidercrank');
});

test('counts and dense compiled IDs cannot disagree with arrays', () => {
  const value=golden();
  value.model.counts.nbody=3;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /model.bodies length must equal 3/);

  const id=golden();
  id.model.geoms[0].id=2;
  assert.throws(() => validateMujocoEffectiveModelExport(id), /ids must be dense and ordered/);
});

test('source/helper ArtifactRefs are family-scoped and logical paths, not byte equality, define closure identity', () => {
  const bad=golden();
  bad.source_bundle.root.artifact={...bad.source_bundle.root.artifact,family:'simulation-contract'};
  assert.throws(() => validateMujocoEffectiveModelExport(bad), /ArtifactRef.family must be simulation-source/);

  const sameBytesDifferentPath=golden();
  sameBytesDifferentPath.source_bundle.dependencies=[{
    path:'models/copy.xml',
    role:'include',
    artifact:sameBytesDifferentPath.source_bundle.root.artifact,
  }];
  assert.equal(
    validateMujocoEffectiveModelExport(sameBytesDifferentPath).source_bundle.dependencies[0].path,
    'models/copy.xml',
  );

  const duplicatePath=golden();
  duplicatePath.source_bundle.dependencies=[{
    path:'models/main.xml',
    role:'include',
    artifact:artifact('<mujoco/>','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(duplicatePath), /duplicate logical path/);
});

test('effective-model source closure rejects URI-shaped logical paths', () => {
  const value=golden();
  value.source_bundle.root.path='file:main.xml';
  assert.throws(() => validateMujocoEffectiveModelExport(value), /repo-relative POSIX path/);
});

test('effective-model source closure rejects traversal and unsupported dependency roles', () => {
  const traversal=golden();
  traversal.source_bundle.root.path='../main.xml';
  assert.throws(() => validateMujocoEffectiveModelExport(traversal), /repo-relative POSIX path/);

  const role=golden();
  role.source_bundle.dependencies=[{
    path:'models/dep.xml',
    role:'runtime-generated',
    artifact:artifact('<mujoco/>','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(role), /role must be include or asset/);
});

test('compiled-model producer may bind source refs but cannot claim independent source verification', () => {
  const value=golden();
  value.claims.source_bundle_verified=true;
  delete value.claims.source_bundle_bound;
  assert.throws(() => validateMujocoEffectiveModelExport(value), /unsupported fields|missing required fields/);
});

test('effective-model contract cannot self-certify runtime or dynamic observation', () => {
  const runtime=golden();
  runtime.claims.runtime_behavior_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(runtime), /cannot claim runtime behavior/);

  const dynamic=golden();
  dynamic.claims.dynamic_state_observed=true;
  assert.throws(() => validateMujocoEffectiveModelExport(dynamic), /cannot claim dynamic state observation/);
});

test('limited controls require explicit finite ranges', () => {
  const missing=golden();
  missing.model.actuators[0].controls[0].range=null;
  assert.throws(() => validateMujocoEffectiveModelExport(missing), /limited control requires range/);

  const nonfinite=golden();
  nonfinite.model.actuators[0].controls[0].range=[-1,Infinity];
  assert.throws(() => validateMujocoEffectiveModelExport(nonfinite), /must be finite/);
});

test('non-finite options and limited ranges fail closed', () => {
  const bad=golden();
  bad.model.options.timestep=Infinity;
  assert.throws(() => validateMujocoEffectiveModelExport(bad), /must be finite/);

  const limited=golden();
  limited.model.joints[0].range=null;
  assert.throws(() => validateMujocoEffectiveModelExport(limited), /limited joint requires range/);
});
