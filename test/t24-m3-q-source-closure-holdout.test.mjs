import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const HELPER=path.resolve(HERE,'../adapters/sim-next/mujoco/effective_model_helper.py');

function runRaw(raw) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-wire-'));
  try {
    return spawnSync('python3',['-I','-S','-B',HELPER],{
      cwd:dir,
      input:raw,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:4*1024*1024,
      env:{},
    });
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('Q-M3 wire: nested duplicate keys and malformed UTF-8 fail before MuJoCo import', () => {
  const duplicate=runRaw('{"outer":{"x":1,"x":2}}');
  assert.notEqual(duplicate.status,0);
  assert.equal(duplicate.stderr,'');
  assert.equal(JSON.parse(duplicate.stdout).error.code,'REQUEST_INVALID');

  const invalid=runRaw(Buffer.from([0xff,0xfe,0xfd]));
  assert.notEqual(invalid.status,0);
  assert.equal(invalid.stderr,'');
  assert.equal(JSON.parse(invalid.stdout).error.code,'REQUEST_INVALID');
});

test('Q-M3 source closure: helper-only checks reject undeclared absolute MuJoCo asset reads', {
  skip:process.platform === 'win32',
}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-closure-'));
  try {
    fs.mkdirSync(path.join(dir,'models'),{recursive:true});
    fs.writeFileSync(
      path.join(dir,'models','main.xml'),
      '<mujoco><compiler meshdir="/tmp"/><asset><mesh name="m" file="outside.obj"/></asset></mujoco>',
    );

    const script=String.raw`
import hashlib
import importlib.util
import pathlib
import sys

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("q_m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root=pathlib.Path.cwd()
p=root/"models"/"main.xml"
data=p.read_bytes()
bundle={
  "root":{
    "path":"models/main.xml",
    "artifact":{
      "artifact_ref":"sbf.artifact-ref/1",
      "family":"simulation-source",
      "version":"draft-1",
      "media_type":"application/xml",
      "byte_sha256":hashlib.sha256(data).hexdigest(),
      "size_bytes":len(data),
    },
  },
  "dependencies":[],
}
module.verify_staged_source_closure(bundle,root)
`;
    const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
      cwd:dir,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:4*1024*1024,
      env:{},
    });
    assert.notEqual(
      child.status,
      0,
      'source closure accepted MJCF that can direct MuJoCo to an undeclared absolute asset path',
    );
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('Q-M3 source closure: safe dot-segment asset refs normalize to declared closure paths', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-dot-ref-'));
  try {
    fs.mkdirSync(path.join(dir,'models'),{recursive:true});
    const xml='<mujoco><asset><mesh name="m" file="./mesh.obj"/></asset></mujoco>';
    const asset='v 0 0 0\n';
    fs.writeFileSync(path.join(dir,'models','main.xml'),xml);
    fs.writeFileSync(path.join(dir,'models','mesh.obj'),asset);

    const script=String.raw`
import hashlib
import importlib.util
import pathlib
import sys

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("q_m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root=pathlib.Path.cwd()
def ref(rel):
    data=(root/rel).read_bytes()
    return {
      "artifact_ref":"sbf.artifact-ref/1",
      "family":"simulation-source",
      "version":"draft-1",
      "media_type":"application/octet-stream",
      "byte_sha256":hashlib.sha256(data).hexdigest(),
      "size_bytes":len(data),
    }

bundle={
  "root":{"path":"models/main.xml","artifact":ref("models/main.xml")},
  "dependencies":[{
    "path":"models/mesh.obj",
    "role":"asset",
    "artifact":ref("models/mesh.obj"),
  }],
}
module.verify_staged_source_closure(bundle,root)
print("OK")
`;
    const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
      cwd:dir,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:4*1024*1024,
      env:{},
    });
    assert.equal(child.status,0,child.stderr || child.stdout);
    assert.equal(child.stdout.trim(),'OK');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('Q-M3 source closure: plugin/extension and unreviewed file-bearing model assets fail closed', () => {
  const cases=[
    '<mujoco><extension><plugin plugin="vendor.example"/></extension></mujoco>',
    '<mujoco><asset><model name="sub" file="submodel.xml"/></asset></mujoco>',
  ];
  for (const xml of cases) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-unreviewed-'));
    try {
      fs.mkdirSync(path.join(dir,'models'),{recursive:true});
      fs.writeFileSync(path.join(dir,'models','main.xml'),xml);

      const script=String.raw`
import hashlib
import importlib.util
import pathlib
import sys

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("q_m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root=pathlib.Path.cwd()
data=(root/"models"/"main.xml").read_bytes()
bundle={
  "root":{"path":"models/main.xml","artifact":{
    "artifact_ref":"sbf.artifact-ref/1","family":"simulation-source","version":"draft-1",
    "media_type":"application/xml","byte_sha256":hashlib.sha256(data).hexdigest(),"size_bytes":len(data),
  }},
  "dependencies":[],
}
module.verify_staged_source_closure(bundle,root)
`;
      const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
        cwd:dir,encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,env:{},
      });
      assert.notEqual(child.status,0,xml);
    } finally {
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }
});

test('Q-M3 source closure: relative meshdir and texturedir resolve from main MJCF directory', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-dirs-'));
  try {
    fs.mkdirSync(path.join(dir,'models','mesh-assets'),{recursive:true});
    fs.mkdirSync(path.join(dir,'models','textures'),{recursive:true});
    const xml='<mujoco><compiler meshdir="mesh-assets" texturedir="textures"/><asset><mesh name="m" file="m.obj"/><texture name="t" type="cube" fileup="up.png"/></asset></mujoco>';
    fs.writeFileSync(path.join(dir,'models','main.xml'),xml);
    fs.writeFileSync(path.join(dir,'models','mesh-assets','m.obj'),'v 0 0 0\n');
    fs.writeFileSync(path.join(dir,'models','textures','up.png'),'fixture-png');

    const script=String.raw`
import hashlib
import importlib.util
import pathlib
import sys

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("q_m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root=pathlib.Path.cwd()
def entry(rel,role=None):
    data=(root/rel).read_bytes()
    out={"path":rel,"artifact":{
      "artifact_ref":"sbf.artifact-ref/1","family":"simulation-source","version":"draft-1",
      "media_type":"application/octet-stream","byte_sha256":hashlib.sha256(data).hexdigest(),"size_bytes":len(data),
    }}
    if role is not None: out["role"]=role
    return out
bundle={
  "root":entry("models/main.xml"),
  "dependencies":[
    entry("models/mesh-assets/m.obj","asset"),
    entry("models/textures/up.png","asset"),
  ],
}
module.verify_staged_source_closure(bundle,root)
print("OK")
`;
    const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
      cwd:dir,encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,env:{},
    });
    assert.equal(child.status,0,child.stderr || child.stdout);
    assert.equal(child.stdout.trim(),'OK');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('Q-M3 source closure: compiler refs reject URI and parent traversal', () => {
  for (const xml of [
    '<mujoco><asset><mesh name="m" file="https://example.invalid/m.obj"/></asset></mujoco>',
    '<mujoco><compiler meshdir="../outside"/><asset><mesh name="m" file="m.obj"/></asset></mujoco>',
  ]) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-q-m3-path-'));
    try {
      fs.mkdirSync(path.join(dir,'models'),{recursive:true});
      fs.writeFileSync(path.join(dir,'models','main.xml'),xml);
      const script=String.raw`
import hashlib
import importlib.util
import pathlib
import sys

helper_path=sys.argv[1]
spec=importlib.util.spec_from_file_location("q_m3_helper",helper_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root=pathlib.Path.cwd()
data=(root/"models"/"main.xml").read_bytes()
bundle={"root":{"path":"models/main.xml","artifact":{
  "artifact_ref":"sbf.artifact-ref/1","family":"simulation-source","version":"draft-1",
  "media_type":"application/xml","byte_sha256":hashlib.sha256(data).hexdigest(),"size_bytes":len(data)
}},"dependencies":[]}
module.verify_staged_source_closure(bundle,root)
`;
      const child=spawnSync('python3',['-I','-S','-B','-c',script,HELPER],{
        cwd:dir,encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,env:{},
      });
      assert.notEqual(child.status,0,xml);
    } finally {
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }
});

test('Q-M3 source: compiler helper contains no direct simulation/runtime execution surface', () => {
  const source=fs.readFileSync(HELPER,'utf8');
  assert.match(source,/MjModel\.from_xml_path/);
  for (const forbidden of [
    /MjData\s*\(/,
    /mj_step\s*\(/,
    /mj_forward\s*\(/,
    /Renderer\s*\(/,
    /import\s+subprocess/,
    /import\s+socket/,
    /import\s+requests/,
    /import\s+urllib/,
    /os\.environ/,
  ]) assert.doesNotMatch(source,forbidden);
});
