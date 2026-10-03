import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PRODUCER=path.resolve(
  HERE,
  '../../../adapters/sim-next/mujoco/stdlib_native_dependency_resolver.py',
);
const M4A=path.resolve(
  HERE,
  '../../../adapters/sim-next/mujoco/native_dependency_resolver.py',
);
const ADMISSION='8f7311b9e8680b03c7e0844ebce73751dc355fd7';
const M4A_CANDIDATE='9e23a0aa01c7fa0fc24f2edcbc3b6e9a1cbc0580';
const M4A_TREE='b4f77de0b8d3fdf38bc4ca9b374d3c1e7bb98c9b';
const M4A_SHA='359fd768c95869a7c0135cd8ebf489326d37e82f0afaa82174c324de0d25e837';

function writeU64(buf,offset,value){
  buf.writeBigUInt64LE(BigInt(value),offset);
}

function elf64({needed=[]}={}){
  const base=0x400000;
  const phoff=64;
  const phentsize=56;
  const phnum=needed.length?2:1;
  const dynOffset=256;
  const strOffset=768;

  const strings=[Buffer.from([0])];
  let cursor=1;
  const offsets=new Map();
  function addString(value){
    if(offsets.has(value))return offsets.get(value);
    const off=cursor;
    const b=Buffer.from(value+'\0','utf8');
    strings.push(b);
    cursor+=b.length;
    offsets.set(value,off);
    return off;
  }
  for(const name of needed)addString(name);
  const strtab=Buffer.concat(strings);
  const dyn=[];
  for(const name of needed)dyn.push([1,addString(name)]);
  if(dyn.length){
    dyn.push([5,base+strOffset]);
    dyn.push([10,strtab.length]);
  }
  dyn.push([0,0]);
  const dynSize=dyn.length*16;

  const total=Math.max(
    strOffset+strtab.length,
    dynOffset+dynSize,
    phoff+phentsize*phnum,
    1024,
  );
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
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
  return target;
}

function directScript(body,args=[]){
  const script=String.raw`
import importlib.util
import sys
producer_spec=importlib.util.spec_from_file_location("m4b",sys.argv[1])
producer=importlib.util.module_from_spec(producer_spec)
producer_spec.loader.exec_module(producer)
m4a,_,_,_=producer.load_approved_m4a()
`+body;
  return spawnSync(
    'python3',
    ['-I','-S','-B','-c',script,PRODUCER,...args],
    {encoding:'utf8',env:{},timeout:10_000,maxBuffer:8*1024*1024},
  );
}

test('M4B reuses the exact Q4-approved M4A parser bytes and does not fork parser semantics',()=>{
  const child=directScript(String.raw`
print(producer.M4A_CANDIDATE_SHA)
print(producer.M4A_TREE_SHA)
print(producer.M4A_RESOLVER_SHA256)
`);
  assert.equal(child.status,0,child.stderr);
  assert.equal(
    child.stdout.trim(),
    [M4A_CANDIDATE,M4A_TREE,M4A_SHA].join('\n'),
  );

  const source=fs.readFileSync(PRODUCER,'utf8');
  assert.doesNotMatch(source,/^def parse_elf_dynamic\b/m);
  assert.doesNotMatch(source,/^def resolve_needed\b/m);
  assert.match(source,/m4a\.parse_elf_dynamic\(/);
  assert.match(source,/m4a\.resolve_needed\(/);
  assert.doesNotMatch(source,/^\s*import\s+mujoco\b/m);
  assert.doesNotMatch(source,/^\s*from\s+mujoco\b/m);
  assert.doesNotMatch(source,/^\s*(?:import|from)\s+subprocess\b/m);
});

test('M4B executes the exact hashed M4A source bytes even when a valid malicious pyc cache exists',()=>{
  const root=fs.mkdtempSync(path.join(os.homedir(),'bskel-m4b-pyc-bypass-'));
  try{
    const producerCopy=path.join(root,'stdlib_native_dependency_resolver.py');
    const m4aCopy=path.join(root,'native_dependency_resolver.py');
    const marker=path.join(root,'PYC_EXECUTED');
    fs.copyFileSync(PRODUCER,producerCopy);
    fs.copyFileSync(M4A,m4aCopy);
    const child=spawnSync('python3',['-I','-S','-B','-c',String.raw`
import importlib.util
import os
from pathlib import Path
import py_compile
import sys

producer_path=Path(sys.argv[1])
m4a_path=Path(sys.argv[2])
marker=Path(sys.argv[3])
approved=m4a_path.read_bytes()
target_size=len(approved)
prefix=(
    "from pathlib import Path\n"
    "ADMISSION_CANDIDATE_SHA = \"8f7311b9e8680b03c7e0844ebce73751dc355fd7\"\n"
    f"Path({str(marker)!r}).write_text('PYC_EXECUTED',encoding='utf-8')\n"
).encode("utf-8")
assert len(prefix)+2 <= target_size
malicious=(prefix+b"#").ljust(target_size-1,b"x")+b"\n"
assert len(malicious)==target_size
stamp=1760000000
m4a_path.write_bytes(malicious)
os.utime(m4a_path,(stamp,stamp))
py_compile.compile(str(m4a_path),doraise=True)
m4a_path.write_bytes(approved)
os.utime(m4a_path,(stamp,stamp))

spec=importlib.util.spec_from_file_location("m4b_under_test",str(producer_path))
producer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
m4a,_,sha256,size=producer.load_approved_m4a()
assert not marker.exists(), "cached bytecode executed instead of approved source bytes"
assert sha256==producer.M4A_RESOLVER_SHA256
assert size==producer.M4A_RESOLVER_SIZE
assert m4a.ADMISSION_CANDIDATE_SHA==producer.ADMISSION_CANDIDATE_SHA
assert callable(m4a.parse_elf_dynamic)
print("PYC_BYPASS_DENIED")
`,producerCopy,m4aCopy,marker],{
      encoding:'utf8',
      env:{},
      timeout:10_000,
      maxBuffer:8*1024*1024,
    });
    assert.equal(child.status,0,child.stderr);
    assert.match(child.stdout,/PYC_BYPASS_DENIED/);
    assert.equal(fs.existsSync(marker),false);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B translates Q4-approved parser denials into its own fail-closed protocol',()=>{
  const child=directScript(String.raw`
def denied():
    raise m4a.ResolveError("synthetic approved-parser denial")
m4a.stdlib_roots=denied
try:
    producer.configured_stdlib_roots(m4a)
except producer.M4BError as exc:
    print(str(exc))
    raise SystemExit(2)
print("PASS")
`);
  assert.notEqual(child.status,0);
  assert.match(child.stdout,/Q4-approved stdlib root resolver denied: synthetic approved-parser denial/);
});

test('M4B binds configured native-extension roots and exact launcher identity',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-config-'));
  try{
    const stdlib=path.join(root,'python3.12');
    const ext=path.join(stdlib,'lib-dynload');
    fs.mkdirSync(ext,{recursive:true});
    const child=directScript(String.raw`
stdlib=producer.Path(sys.argv[2])
ext=producer.Path(sys.argv[3])
m4a.stdlib_roots=lambda:[stdlib]
producer.sysconfig.get_config_var=lambda key: str(ext) if key=="DESTSHARED" else None
roots,native_roots=producer.configured_stdlib_roots(m4a)
launcher=producer.exact_launcher_identity(m4a)
print(roots[0])
print(native_roots[0])
print(launcher["path"])
print(launcher["sha256"])
print(launcher["size_bytes"])
`,[stdlib,ext]);
    assert.equal(child.status,0,child.stderr);
    const rows=child.stdout.trim().split('\n');
    assert.equal(rows[0],stdlib);
    assert.equal(rows[1],ext);
    assert.match(rows[2],/^\//);
    assert.match(rows[3],/^[a-f0-9]{64}$/);
    assert.ok(Number(rows[4])>0);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B recursively enumerates regular stdlib native extensions deterministically',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-seeds-'));
  try{
    const ext=path.join(root,'lib-dynload');
    const a=write(ext,'_ssl.cpython-312-x86_64-linux-gnu.so',elf64());
    const b=write(ext,'nested/_hashlib.cpython-312-x86_64-linux-gnu.so',elf64());
    write(ext,'README.txt','ignored');
    const child=directScript(String.raw`
roots=[producer.Path(sys.argv[2])]
seeds=producer.native_extension_seeds(m4a,roots)
for seed in seeds:
    print(seed)
`,[ext]);
    assert.equal(child.status,0,child.stderr);
    assert.deepEqual(
      child.stdout.trim().split('\n'),
      [a,b].sort(),
    );
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B fails closed on nested stdlib native-extension scandir failure',{
  skip:process.platform!=='linux',
},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-walk-'));
  try{
    const ext=path.join(root,'lib-dynload');
    const denied=path.join(ext,'nested-denied');
    fs.mkdirSync(denied,{recursive:true});
    fs.writeFileSync(path.join(denied,'libhidden.so'),elf64());
    const child=directScript(String.raw`
import errno
import os
root=producer.Path(sys.argv[2])
denied=os.path.realpath(sys.argv[3])
real_scandir=producer.os.scandir
def forced(path):
    current=os.path.realpath(os.fspath(path))
    if current==denied:
        raise PermissionError(errno.EACCES,"forced stdlib scandir denial",current)
    return real_scandir(path)
producer.os.scandir=forced
try:
    producer.native_extension_seeds(m4a,[root])
except producer.M4BError as exc:
    print(str(exc))
    raise SystemExit(2)
print("PASS")
`,[ext,denied]);
    assert.notEqual(child.status,0);
    assert.match(child.stdout,/stdlib native-extension traversal failed at nested-denied/);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B rejects symlinked stdlib native-extension entries',{
  skip:process.platform==='win32',
},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-symlink-'));
  try{
    const ext=path.join(root,'lib-dynload');
    fs.mkdirSync(ext,{recursive:true});
    const real=write(root,'real.so',elf64());
    fs.symlinkSync(real,path.join(ext,'linked.so'));
    const child=directScript(String.raw`
try:
    producer.native_extension_seeds(m4a,[producer.Path(sys.argv[2])])
except producer.M4BError as exc:
    print(str(exc))
    raise SystemExit(2)
print("PASS")
`,[ext]);
    assert.notEqual(child.status,0);
    assert.match(child.stdout,/must not be a symlink/);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B resolves transitive stdlib-native DT_NEEDED with Q4-approved loader semantics',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-closure-'));
  try{
    const stdlib=path.join(root,'python3.12');
    const ext=path.join(stdlib,'lib-dynload');
    const syslib=path.join(root,'syslib');
    fs.mkdirSync(ext,{recursive:true});
    fs.mkdirSync(syslib,{recursive:true});
    const seed=write(ext,'_ssl.cpython-312-x86_64-linux-gnu.so',elf64({needed:['libfoo.so']}));
    const dep=write(syslib,'libfoo.so',elf64({needed:['libbar.so']}));
    const transitive=write(syslib,'libbar.so',elf64());
    const child=directScript(String.raw`
closure=producer.resolve_stdlib_native_closure(
    m4a,
    [producer.Path(sys.argv[2])],
    [producer.Path(sys.argv[3])],
    [producer.Path(sys.argv[4])],
)
import json
print(json.dumps(closure,sort_keys=True,separators=(",",":")))
`,[stdlib,ext,syslib]);
    assert.equal(child.status,0,child.stderr);
    const parsed=JSON.parse(child.stdout);
    assert.deepEqual(parsed.seeds.map(x=>x.path),[seed]);
    const external=parsed.native_dependency_files.map(x=>x.path).sort();
    assert.deepEqual(external,[dep,transitive].sort());
    assert.deepEqual(
      parsed.external_native_files.map(x=>x.path).sort(),
      [dep,transitive].sort(),
    );
    assert.equal(
      parsed.external_native_files.every(
        x=>/^[a-f0-9]{64}$/.test(x.sha256)&&x.size_bytes>0,
      ),
      true,
    );
    assert.equal(parsed.edges.some(e=>e.needed==='libfoo.so'),true);
    assert.equal(parsed.edges.some(e=>e.needed==='libbar.so'),true);
    assert.equal(
      parsed.native_dependency_files.every(x=>x.logical_path.startsWith('system-native/')),
      true,
    );
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B fails closed when a .so seed is not valid ELF',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-m4b-nonelf-'));
  try{
    const stdlib=path.join(root,'python3.12');
    const ext=path.join(stdlib,'lib-dynload');
    const syslib=path.join(root,'syslib');
    fs.mkdirSync(syslib,{recursive:true});
    write(ext,'broken.so','not-elf');
    const child=directScript(String.raw`
try:
    producer.resolve_stdlib_native_closure(
        m4a,
        [producer.Path(sys.argv[2])],
        [producer.Path(sys.argv[3])],
        [producer.Path(sys.argv[4])],
    )
except producer.M4BError as exc:
    print(str(exc))
    raise SystemExit(2)
print("PASS")
`,[stdlib,ext,syslib]);
    assert.notEqual(child.status,0);
    assert.match(child.stdout,/Q4-approved ELF parser denied/);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('M4B request rejects stale upstream candidate/parser identities before closure work',()=>{
  const bad=JSON.stringify({
    protocol:'sbf.sim-python-stdlib-native-dependency-resolve/draft-1',
    target:'SIM-mujoco',
    admission_candidate_sha:ADMISSION,
    m4a_candidate_sha:'0'.repeat(40),
    m4a_tree_sha:M4A_TREE,
    m4a_resolver_sha256:M4A_SHA,
    search_roots:['/usr/lib/x86_64-linux-gnu'],
  });
  const child=spawnSync('python3',['-I','-S','-B',PRODUCER],{
    input:bad,
    encoding:'utf8',
    env:{},
    timeout:10_000,
    maxBuffer:1024*1024,
  });
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/M4_STDLIB_NATIVE_DEPENDENCY_DENIED/);
  assert.match(child.stderr,/not bound to the Q4-approved M4A candidate/);
});

test('M4B main resolves the real CI Python 3.12 lib-dynload closure without importing extensions',{
  skip:process.platform!=='linux',
},(t)=>{
  const version=spawnSync('python3',['-c','import platform; print(platform.python_version())'],{
    encoding:'utf8',env:{},timeout:10_000,maxBuffer:1024*1024,
  });
  assert.equal(version.status,0,version.stderr);
  if(!version.stdout.trim().startsWith('3.12.')){
    t.skip('requires the pinned Python 3.12 CI interpreter');
    return;
  }

  const canonicalSystemRoot='/usr/lib/x86_64-linux-gnu';
  assert.equal(fs.existsSync(canonicalSystemRoot),true);
  const roots=[fs.realpathSync(canonicalSystemRoot)];
  assert.equal(roots[0],canonicalSystemRoot);

  const input=JSON.stringify({
    protocol:'sbf.sim-python-stdlib-native-dependency-resolve/draft-1',
    target:'SIM-mujoco',
    admission_candidate_sha:ADMISSION,
    m4a_candidate_sha:M4A_CANDIDATE,
    m4a_tree_sha:M4A_TREE,
    m4a_resolver_sha256:M4A_SHA,
    search_roots:roots,
  });
  const child=spawnSync('python3',['-I','-S','-B',PRODUCER],{
    input,
    encoding:'utf8',
    env:{},
    timeout:30_000,
    maxBuffer:16*1024*1024,
  });
  assert.equal(child.status,0,child.stderr);
  const parsed=JSON.parse(child.stdout);
  assert.equal(parsed.schema,'sbf.sim-python-stdlib-native-dependency-closure/draft-1');
  assert.equal(parsed.admission_candidate_sha,ADMISSION);
  assert.equal(parsed.m4a_candidate_sha,M4A_CANDIDATE);
  assert.equal(parsed.m4a_tree_sha,M4A_TREE);
  assert.equal(parsed.m4a_resolver.sha256,M4A_SHA);
  assert.match(parsed.launcher.sha256,/^[a-f0-9]{64}$/);
  assert.ok(parsed.launcher.size_bytes>0);
  assert.ok(parsed.native_extension_roots.some(root=>root.endsWith('/lib-dynload')));
  assert.ok(parsed.seeds.length>0);
  assert.ok(parsed.nodes.length>=parsed.seeds.length);
  assert.match(parsed.closure_sha256,/^[a-f0-9]{64}$/);
  assert.equal(parsed.claims.q4_approved_parser_reused,true);
  assert.equal(parsed.claims.mujoco_imported,false);
  assert.equal(parsed.claims.helper_executed,false);
  assert.equal(parsed.claims.mjcf_compiled,false);
  assert.equal(parsed.claims.execution_admitted,false);
});

test('M4B strict union deduplicates only identical pairs and rejects both collision directions',()=>{
  const child=directScript(String.raw`
import json
same={"logical_path":"system-native/aaaa-libfoo.so","path":"/usr/lib/libfoo.so"}
m4a_rows=[same,{"logical_path":"system-native/bbbb-libbar.so","path":"/usr/lib/libbar.so"}]
m4b_rows=[same]
print(json.dumps(producer.strict_native_dependency_union(m4a_rows,m4b_rows),sort_keys=True,separators=(",",":")))
for left,right,needle in [
    (
        [{"logical_path":"system-native/collision.so","path":"/a.so"}],
        [{"logical_path":"system-native/collision.so","path":"/b.so"}],
        "logical_path collision",
    ),
    (
        [{"logical_path":"system-native/a.so","path":"/same.so"}],
        [{"logical_path":"system-native/b.so","path":"/same.so"}],
        "real-path collision",
    ),
]:
    try:
        producer.strict_native_dependency_union(left,right)
    except producer.M4BError as exc:
        assert needle in str(exc)
    else:
        raise AssertionError("collision was not rejected")
`);
  assert.equal(child.status,0,child.stderr);
  const rows=JSON.parse(child.stdout.trim());
  assert.deepEqual(rows,[
    {logical_path:'system-native/aaaa-libfoo.so',path:'/usr/lib/libfoo.so'},
    {logical_path:'system-native/bbbb-libbar.so',path:'/usr/lib/libbar.so'},
  ]);
});

test('M4B output contract keeps all execution and admission claims false',()=>{
  const source=fs.readFileSync(PRODUCER,'utf8');
  for(const claim of [
    '"subprocess_executed": False',
    '"mujoco_imported": False',
    '"helper_executed": False',
    '"mjcf_compiled": False',
    '"execution_admitted": False',
  ]){
    assert.equal(source.includes(claim),true,claim);
  }
  assert.equal(fs.existsSync(M4A),true);
  assert.match(source,/"launcher": launcher/);
  assert.match(source,/"m4a_resolver_sha256": m4a_sha256/);
  assert.match(source,/logical_path_collision_denied/);
  assert.match(source,/real_path_collision_denied/);
  assert.match(source,/"external_native_files": closure\["external_native_files"\]/);
});
