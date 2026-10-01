import test from 'node:test';
import assert from 'node:assert/strict';

import { artifactRefForBytes } from '../adapters/sim-next/identity.mjs';
import {
  MUJOCO_EFFECTIVE_HELPER_REQUEST,
  MUJOCO_EFFECTIVE_HELPER_RESPONSE,
  MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION,
  validateMujocoEffectiveHelperRequest,
  validateMujocoEffectiveHelperResponse,
} from '../adapters/sim-next/mujoco/helper-protocol.mjs';

function artifact(bytes, family, mediaType='application/octet-stream') {
  return artifactRefForBytes(Buffer.from(bytes), {
    family,
    version:'draft-1',
    mediaType,
  });
}

function request() {
  return {
    protocol:MUJOCO_EFFECTIVE_HELPER_REQUEST,
    target:'SIM-mujoco',
    source_bundle:{
      root:{
        path:'models/main.xml',
        artifact:artifact('<mujoco/>','simulation-source','application/xml'),
      },
      dependencies:[],
    },
    helper_artifact:artifact('helper-bytes','simulation-helper','text/x-python'),
  };
}

function response(req=request()) {
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
          nbody:1,njnt:0,ngeom:0,nsite:0,ntendon:0,
          nq:0,nv:0,na:0,nu:0,nactuator:0,nout:0,
          nsensor:0,nsensordata:0,
        },
        options:{timestep:0.002,gravity:[0,0,-9.81],integrator:'Euler'},
        bodies:[{id:0,name:'world',parent_id:0}],
        joints:[],geoms:[],sites:[],actuators:[],sensors:[],
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

test('Q-M3 protocol: success response requires exact request binding authority', () => {
  const res=response();
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(res),
    /request|binding|required|exact/i,
  );
});

test('Q-M3 protocol: exact request binding accepts key-order independent ArtifactRefs', () => {
  const req=request();
  const helper=req.helper_artifact;
  req.helper_artifact={
    size_bytes:helper.size_bytes,
    byte_sha256:helper.byte_sha256,
    media_type:helper.media_type,
    version:helper.version,
    family:helper.family,
    artifact_ref:helper.artifact_ref,
  };
  assert.equal(validateMujocoEffectiveHelperRequest(req).target,'SIM-mujoco');
  assert.equal(validateMujocoEffectiveHelperResponse(response(request()),{request:req}).ok,true);
});

test('Q-M3 protocol: response cannot smuggle request mismatch through dependency order or helper identity', () => {
  const req=request();
  req.source_bundle.dependencies=[
    {path:'models/a.xml',role:'include',artifact:artifact('a','simulation-source','application/xml')},
    {path:'models/b.obj',role:'asset',artifact:artifact('b','simulation-source','model/obj')},
  ];
  const out=response(req);
  const reordered=structuredClone(out);
  reordered.effective_model.source_bundle.dependencies.reverse();
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(reordered,{request:req}),
    /source_bundle does not match the exact request/,
  );

  const other=structuredClone(out);
  other.effective_model.compiler.helper_artifact=artifact('different','simulation-helper','text/x-python');
  assert.throws(
    () => validateMujocoEffectiveHelperResponse(other,{request:req}),
    /helper_artifact does not match the exact request/,
  );
});
