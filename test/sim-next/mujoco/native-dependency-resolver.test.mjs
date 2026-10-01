import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const RESOLVER=path.resolve(
  HERE,
  '../../../adapters/sim-next/mujoco/native_dependency_resolver.py',
);

const REQUIRED=[
  'mujoco/libmujoco.so.3.12.0',
  'mujoco/_callbacks.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_constants.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_enums.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_errors.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_functions.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_render.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_specs.cpython-312-x86_64-linux-gnu.so',
  'mujoco/_structs.cpython-312-x86_64-linux-gnu.so',
];

function mkdirp(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});
}

function writeU64(buf,offset,value){
  buf.writeBigUInt64LE(BigInt(value),offset);
}

function elf64Interp(interpBytes){
  const phoff=64;
  const phentsize=56;
  const phnum=2;
  const interpOffset=256;
  const total=Math.max(1024,interpOffset+interpBytes.length);
  const base=0x400000;
  const buf=Buffer.alloc(total);

  buf.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0,0,0,0,0,0,0,0],0);
  buf.writeUInt16LE(3,16);
  buf.writeUInt16LE(62,18);
  buf.writeUInt32LE(1,20);
  writeU64(buf,24,0);
  writeU64(buf,32,phoff);
  writeU64(buf,40,0);
  buf.writeUInt32LE(0,48);
  buf.writeUInt16LE(64,52);
  buf.writeUInt16LE(phentsize,54);
  buf.writeUInt16LE(phnum,56);

  let p=phoff;
  buf.writeUInt32LE(1,p);
  buf.writeUInt32LE(5,p+4);
  writeU64(buf,p+8,0);
  writeU64(buf,p+16,base);
  writeU64(buf,p+24,base);
  writeU64(buf,p+32,total);
  writeU64(buf,p+40,total);
  writeU64(buf,p+48,4096);

  p+=phentsize;
  buf.writeUInt32LE(3,p);
  buf.writeUInt32LE(4,p+4);
  writeU64(buf,p+8,interpOffset);
  writeU64(buf,p+16,base+interpOffset);
  writeU64(buf,p+24,base+interpOffset);
  writeU64(buf,p+32,interpBytes.length);
  writeU64(buf,p+40,interpBytes.length);
  writeU64(buf,p+48,1);

  interpBytes.copy(buf,interpOffset);
  return buf;
}

function parseElfDirect(target){
  const script=String.raw`
import importlib.util
import sys
spec=importlib.util.spec_from_file_location("m4a_resolver",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    module.parse_elf_dynamic(module.Path(sys.argv[2]))
except module.ResolveError as exc:
    print(str(exc))
    raise SystemExit(2)
print("PASS")
`;
  return spawnSync('python3',['-I','-S','-B','-c',script,RESOLVER,target],{
    encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
  });
}

function elf64({needed=[],runpath=null,rpath=null}={}){
  const base=0x400000;
  const phoff=64;
  const phentsize=56;
  const phnum=(needed.length||runpath||rpath)?2:1;
  const dynOffset=256;
  const strOffset=768;

  const strings=[Buffer.from([0])];
  let cursor=1;
  const offsets=new Map();
  function addString(value){
    if(offsets.has(value))return offsets.get(value);
    const off=cursor;
    const b=Buffer.from(value+'\0','utf8');
    strings.push(b);cursor+=b.length;offsets.set(value,off);return off;
  }
  for(const name of needed)addString(name);
  if(runpath!==null)addString(runpath);
  if(rpath!==null)addString(rpath);
  const strtab=Buffer.concat(strings);

  const dyn=[];
  for(const name of needed)dyn.push([1,addString(name)]);
  if(runpath!==null)dyn.push([29,addString(runpath)]);
  if(rpath!==null)dyn.push([15,addString(rpath)]);
  if(dyn.length){
    dyn.push([5,base+strOffset]);
    dyn.push([10,strtab.length]);
  }
  dyn.push([0,0]);
  const dynSize=dyn.length*16;

  const total=Math.max(strOffset+strtab.length, dynOffset+dynSize, phoff+phentsize*phnum, 1024);
  const buf=Buffer.alloc(total);

  // ELF64 little-endian x86_64 header.
  buf.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0,0,0,0,0,0,0,0],0);
  buf.writeUInt16LE(3,16);       // ET_DYN
  buf.writeUInt16LE(62,18);      // EM_X86_64
  buf.writeUInt32LE(1,20);
  writeU64(buf,24,0);
  writeU64(buf,32,phoff);
  writeU64(buf,40,0);
  buf.writeUInt32LE(0,48);
  buf.writeUInt16LE(64,52);
  buf.writeUInt16LE(phentsize,54);
  buf.writeUInt16LE(phnum,56);
  buf.writeUInt16LE(0,58);
  buf.writeUInt16LE(0,60);
  buf.writeUInt16LE(0,62);

  // PT_LOAD covering the whole file.
  let p=phoff;
  buf.writeUInt32LE(1,p);
  buf.writeUInt32LE(5,p+4);
  writeU64(buf,p+8,0);
  writeU64(buf,p+16,base);
  writeU64(buf,p+24,base);
  writeU64(buf,p+32,total);
  writeU64(buf,p+40,total);
  writeU64(buf,p+48,4096);

  if(phnum===2){
    p+=phentsize;
    buf.writeUInt32LE(2,p);
    buf.writeUInt32LE(4,p+4);
    writeU64(buf,p+8,dynOffset);
    writeU64(buf,p+16,base+dynOffset);
    writeU64(buf,p+24,base+dynOffset);
    writeU64(buf,p+32,dynSize);
    writeU64(buf,p+40,dynSize);
    writeU64(buf,p+48,8);
    dyn.forEach(([tag,value],index)=>{
      writeU64(buf,dynOffset+index*16,tag);
      writeU64(buf,dynOffset+index*16+8,value);
    });
    strtab.copy(buf,strOffset);
  }
  return buf;
}

function write(root,relative,bytes){
  const target=path.join(root,...relative.split('/'));
  mkdirp(target);
  fs.writeFileSync(target,bytes);
  return target;
}

function fixture({
  seedNeeded=['libfoo.so'],
  pluginNeeded=['libbar.so'],
  pluginRunpath=null,
  seedRunpath=null,
  duplicateRoot=false,
  fooNeeded=[],
  barNeeded=[],
}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4a-'));
  const runtime=path.join(root,'runtime');
  const lib1=path.join(root,'lib1');
  const lib2=path.join(root,'lib2');
  fs.mkdirSync(lib1,{recursive:true});
  fs.mkdirSync(lib2,{recursive:true});

  for(const rel of REQUIRED){
    write(runtime,rel,elf64({needed:seedNeeded,runpath:seedRunpath}));
  }
  write(runtime,'mujoco/plugin/libplugin-fixture.so',elf64({needed:pluginNeeded,runpath:pluginRunpath}));
  write(lib1,'libfoo.so',elf64({needed:fooNeeded}));
  write(lib1,'libbar.so',elf64({needed:barNeeded}));
  if(duplicateRoot){
    write(lib2,'libfoo.so',elf64());
  }

  return {root,runtime,lib1,lib2};
}

function hostNativeRoots(){
  const candidates=[
    '/usr/lib/x86_64-linux-gnu',
    '/usr/local/lib',
  ];
  const roots=[];
  for(const candidate of candidates){
    if(!fs.existsSync(candidate))continue;
    const real=fs.realpathSync(candidate);
    if(!roots.includes(real))roots.push(real);
  }
  assert.ok(
    roots.some(root=>root.endsWith('/usr/lib/x86_64-linux-gnu')),
    'CI host must expose the pinned Linux x86_64 native root',
  );
  return roots;
}

function run(fx,searchRoots=[fx.lib1],raw=null){
  const allRoots=[...searchRoots];
  for(const root of hostNativeRoots()){
    if(!allRoots.includes(root))allRoots.push(root);
  }
  const input=raw??JSON.stringify({
    protocol:'sbf.sim-mujoco-native-dependency-resolve/draft-1',
    target:'SIM-mujoco',
    admission_candidate_sha:'a42d944ad9033bc2305ce3ad9c72aaaee63a7a3f',
    runtime_import_root:fx.runtime,
    search_roots:allRoots,
  });
  const child=spawnSync('python3',['-I','-S','-B',RESOLVER],{
    input,
    encoding:'utf8',
    env:{},
    timeout:10_000,
    maxBuffer:8*1024*1024,
  });
  return {
    child,
    parsed:child.stdout.trim()?JSON.parse(child.stdout):null,
  };
}

test('M4A resolves a synthetic MuJoCo ELF closure without subprocess or MuJoCo import',()=>{
  const fx=fixture();
  try{
    const {child,parsed}=run(fx);
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stderr,'');
    assert.equal(parsed.schema,'sbf.sim-mujoco-native-dependency-closure/draft-1');
    assert.equal(parsed.target,'SIM-mujoco');
    assert.equal(parsed.platform,'Linux-x86_64');
    assert.match(parsed.python_version,/^3\.12\.\d+$/);
    assert.equal(parsed.mujoco_version,'3.12.0');
    assert.equal(parsed.admission_candidate_sha,'a42d944ad9033bc2305ce3ad9c72aaaee63a7a3f');
    assert.match(parsed.resolver.sha256,/^[a-f0-9]{64}$/);
    assert.ok(parsed.resolver.size_bytes>0);
    assert.equal(parsed.claims.elf_metadata_parsed,true);
    assert.equal(parsed.claims.launcher_native_closure_included,true);
    assert.match(parsed.launcher.path,/^\//);
    assert.match(parsed.launcher.sha256,/^[a-f0-9]{64}$/);
    assert.ok(parsed.launcher.size_bytes>0);
    assert.equal(parsed.claims.subprocess_executed,false);
    assert.equal(parsed.claims.mujoco_imported,false);
    assert.equal(parsed.claims.helper_executed,false);
    assert.equal(parsed.claims.mjcf_compiled,false);
    assert.equal(parsed.claims.execution_admitted,false);
    assert.ok(parsed.stdlib_roots.length>=1);
    assert.match(parsed.closure_sha256,/^[a-f0-9]{64}$/);

    const deps=parsed.native_dependency_files.map(x=>path.basename(x.path));
    assert.equal(deps.includes('libfoo.so'),true);
    assert.equal(deps.includes('libbar.so'),true);
    assert.equal(
      parsed.native_dependency_files.some(x=>x.path===parsed.launcher.path),
      false,
    );
    assert.equal(parsed.native_dependency_files.every(x=>x.logical_path.startsWith('system-native/')),true);
    assert.equal(
      parsed.nodes.some(x=>x.path===parsed.launcher.path&&x.seed===true),
      true,
    );
    const launcherNode=parsed.nodes.find(x=>x.path===parsed.launcher.path);
    assert.ok(launcherNode);
    if(launcherNode.interp!==null){
      assert.equal(
        parsed.nodes.some(x=>x.path===launcherNode.interp),
        true,
      );
    }

    const source=fs.readFileSync(RESOLVER,'utf8');
    assert.doesNotMatch(source,/^\s*import\s+mujoco\b/m);
    assert.doesNotMatch(source,/^\s*from\s+mujoco\b/m);
    assert.doesNotMatch(source,/^\s*(?:import|from)\s+subprocess\b/m);
    assert.doesNotMatch(source,/\bos\.system\s*\(/);
    assert.doesNotMatch(source,/\bPopen\s*\(/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A bounds and sanitizes PT_INTERP before reading loader metadata',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4a-interp-'));
  try{
    const oversized=path.join(root,'oversized.elf');
    fs.writeFileSync(
      oversized,
      elf64Interp(Buffer.concat([Buffer.alloc(4097,0x61),Buffer.from([0])])),
    );
    let child=parseElfDirect(oversized);
    assert.notEqual(child.status,0);
    assert.match(child.stdout,/PT_INTERP size is invalid/);

    const control=path.join(root,'control.elf');
    fs.writeFileSync(control,elf64Interp(Buffer.from('/lib/loader\nname\0','utf8')));
    child=parseElfDirect(control);
    assert.notEqual(child.status,0);
    assert.match(child.stdout,/PT_INTERP contains control characters/);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4A fails closed when a DT_NEEDED library resolves ambiguously',()=>{
  const fx=fixture({duplicateRoot:true});
  try{
    const {child}=run(fx,[fx.lib1,fx.lib2]);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/ambiguous DT_NEEDED libfoo\.so/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A rejects soname symlinks that escape an approved search root',{
  skip:process.platform==='win32',
},()=>{
  const fx=fixture();
  try{
    const outside=path.join(fx.root,'outside');
    fs.mkdirSync(outside,{recursive:true});
    const outsideLib=path.join(outside,'libfoo-real.so');
    fs.writeFileSync(outsideLib,elf64());

    const admitted=path.join(fx.lib1,'libfoo.so');
    fs.rmSync(admitted);
    fs.symlinkSync(path.relative(fx.lib1,outsideLib),admitted);

    const {child}=run(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/escapes approved search root/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A rejects slash-bearing DT_NEEDED names',()=>{
  const fx=fixture({seedNeeded:['../libfoo.so']});
  try{
    const {child}=run(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/slash-bearing DT_NEEDED is unsupported/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A allows canonical $ORIGIN/.. RUNPATH inside the MuJoCo runtime root',()=>{
  const fx=fixture({
    pluginNeeded:['libmujoco.so.3.12.0'],
    pluginRunpath:'$ORIGIN/..',
  });
  try{
    const {child,parsed}=run(fx);
    assert.equal(child.status,0,child.stderr);
    assert.equal(
      parsed.edges.some(
        e=>e.from.endsWith('/mujoco/plugin/libplugin-fixture.so')
          && e.needed==='libmujoco.so.3.12.0'
          && e.to.endsWith('/mujoco/libmujoco.so.3.12.0'),
      ),
      true,
    );
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A rejects unsupported dynamic-loader tokens and relative runpaths',()=>{
  for(const runpath of ['$LIB','relative/lib']){
    const fx=fixture({seedRunpath:runpath});
    try{
      const {child}=run(fx);
      assert.notEqual(child.status,0);
      assert.match(
        child.stderr,
        /unsupported dynamic-loader token|relative RPATH\/RUNPATH is unsupported/,
      );
    }finally{
      fs.rmSync(fx.root,{recursive:true,force:true});
    }
  }
});

test('M4A handles dependency cycles deterministically without recursion escape',()=>{
  const fx=fixture({
    seedNeeded:['libfoo.so'],
    pluginNeeded:[],
    fooNeeded:['libbar.so'],
    barNeeded:['libfoo.so'],
  });
  try{
    const {child,parsed}=run(fx);
    assert.equal(child.status,0,child.stderr);
    const external=parsed.nodes.filter(x=>x.path.startsWith(fx.lib1));
    assert.equal(external.length,2);
    assert.equal(parsed.edges.some(e=>e.needed==='libbar.so'),true);
    assert.equal(parsed.edges.some(e=>e.needed==='libfoo.so'&&e.from.endsWith('libbar.so')),true);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A rejects symlinked runtime seed components', {
  skip:process.platform==='win32',
},()=>{
  const fx=fixture();
  try{
    const seed=path.join(fx.runtime,'mujoco','_callbacks.cpython-312-x86_64-linux-gnu.so');
    const real=seed+'.real';
    fs.renameSync(seed,real);
    fs.symlinkSync(path.basename(real),seed);
    const {child}=run(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/contains symlink component/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A wire rejects duplicate keys NaN and unsupported fields',()=>{
  const fx=fixture();
  try{
    for(const raw of [
      '{"protocol":"a","protocol":"b"}',
      '{"protocol":NaN}',
      JSON.stringify({
        protocol:'sbf.sim-mujoco-native-dependency-resolve/draft-1',
        target:'SIM-mujoco',
        admission_candidate_sha:'a42d944ad9033bc2305ce3ad9c72aaaee63a7a3f',
        runtime_import_root:fx.runtime,
        search_roots:[fx.lib1],
        approved:true,
      }),
    ]){
      const {child}=run(fx,[fx.lib1],raw);
      assert.notEqual(child.status,0);
      assert.match(child.stderr,/M4_NATIVE_DEPENDENCY_DENIED/);
    }
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A rejects request binding to any non-canonical admission candidate',()=>{
  const fx=fixture();
  try{
    const raw=JSON.stringify({
      protocol:'sbf.sim-mujoco-native-dependency-resolve/draft-1',
      target:'SIM-mujoco',
      admission_candidate_sha:'0'.repeat(40),
      runtime_import_root:fx.runtime,
      search_roots:[fx.lib1],
    });
    const {child}=run(fx,[fx.lib1],raw);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/not bound to the canonical M4 admission candidate/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});

test('M4A fails closed when an exact reviewed seed is missing',()=>{
  const fx=fixture();
  try{
    fs.rmSync(path.join(fx.runtime,'mujoco','_render.cpython-312-x86_64-linux-gnu.so'));
    const {child}=run(fx);
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/seed\[[0-9]+\] does not exist/);
  }finally{
    fs.rmSync(fx.root,{recursive:true,force:true});
  }
});
