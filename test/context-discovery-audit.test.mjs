import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { discoverOperationContext } from '../lib/context-discovery.mjs';

const requireSpawn=(argv,cwd)=>spawnSync(argv[0],argv.slice(1),{
  cwd,encoding:'utf8',timeout:20000,maxBuffer:4194304
});
const CONTRACT='specs/001-demo/contracts/001-demo.schema.json';
const BODY={
  sbf_contract:'9',feature_id:'001-demo',feature_uid:'6576a254-4a9f-4af4-8f24-7a707e6066ce',
  source:{adapter:'python-fastapi',module:'demo',provenance:'fixed security test'},
  operations:{readPing:{verb:'GET',path:'/ping',pathParams:{},body:false,provenance:'fixed security test'}},
  warnings:[],completeness:{status:'complete',operation_count:1,endpoint_count:1}
};
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function write(root,file,content) {
  const loc=path.join(root,file);
  fs.mkdirSync(path.dirname(loc),{recursive:true});
  fs.writeFileSync(loc,content);
}
function fixture(t,files,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-security-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  git(root,'init','-q');
  git(root,'config','user.name','Test');
  git(root,'config','user.email','test@example.invalid');
  const contract=JSON.stringify(BODY,null,2)+'\n';
  if(options.symlinkContract){
    fs.mkdirSync(path.dirname(path.join(root,CONTRACT)),{recursive:true});
    fs.symlinkSync(contract,path.join(root,CONTRACT));
  } else {
    write(root,CONTRACT,contract);
  }
  for(const [file,content] of Object.entries(files))write(root,file,content);
  if(options.invalidUtf8Name){
    const raw=Buffer.concat([Buffer.from(root+'/src/'),Buffer.from([0xff]),Buffer.from('ping.py')]);
    fs.mkdirSync(path.join(root,'src'),{recursive:true});
    fs.writeFileSync(raw,'def readPing(): return {}\n');
  }
  git(root,'add','--all');git(root,'commit','-qm','Security negative case');
  return {root,commit:git(root,'rev-parse','HEAD')};
}
const discover=(f,extra={})=>discoverOperationContext({
  repoRoot:f.root,contractPath:CONTRACT,operationId:'readPing',revision:f.commit,...extra
});

test('oversize skipped source makes coverage explicitly incomplete',t=>{
  const large='def readPing():\n'+'x'.repeat(262145);
  const f=fixture(t,{'src/a.py':large,'src/z.py':"def readPing(): return {'ping':'pong'}\n"});
  const r=discover(f);
  assert.equal(r.inventory.rejected.oversize,1);
  assert.equal(r.selection.complete,false);
  assert.equal(r.selection.selected[0].path,'src/z.py');
});
test('truncating ranked candidates also marks selection incomplete',t=>{
  const f=fixture(t,{
    'src/a.py':"def readPing(): return 'a'\n",
    'src/b.py':"def readPing(): return 'b'\n",
    'src/c.py':"def readPing(): return 'c'\n"
  });
  const r=discover(f,{maxSelectedFiles:1});
  assert.equal(r.selection.selected.length,1);
  assert.ok(r.inventory.matched_files>1);
  assert.equal(r.selection.complete,false);
});
test('maxScanFiles bounds ALL inspected blobs including oversized',t=>{
  const f=fixture(t,{'src/a.py':'x'.repeat(262145),'src/z.py':"def readPing(): return {}\n"});
  const r=discover(f,{maxScanFiles:1});
  assert.equal(r.inventory.inspected_files,1);
  assert.equal(r.inventory.scanned_files,0);
  assert.equal(r.inventory.rejected.oversize,1);
  assert.equal(r.inventory.budget_limited,true);
  assert.equal(r.selection.complete,false);
  assert.equal(r.selection.selected.length,0);
});
test('a symlinked contract is rejected before its JSON link body is used',t=>{
  const f=fixture(t,{'src/ping.py':"def readPing(): return {}\n"},{symlinkContract:true});
  assert.throws(()=>discover(f),/regular committed contract/);
});
test('invalid UTF-8 Git filename fails closed without lossy U+FFFD selection',t=>{
  const f=fixture(t,{});
  // macOS refuses invalid Unicode filesystem names. Construct malformed raw
  // Git tree objects directly; do not rely on the host filesystem.
  const run=(argv,input)=>execFileSync('git',argv,{cwd:f.root,input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const blob=run(['hash-object','-w','--stdin'],Buffer.from('def readPing(): return {}\n'));
  const badName=Buffer.concat([Buffer.from('100644 blob '+blob+'\t'),Buffer.from([0xff]),Buffer.from('ping.py\0')]);
  const srcTree=run(['mktree','-z'],badName);
  const originalRoot=execFileSync('git',['ls-tree','-z',f.commit],{cwd:f.root});
  const rootTree=run(['mktree','-z'],Buffer.concat([originalRoot,Buffer.from('040000 tree '+srcTree+'\tsrc\0')]));
  const badCommit=run(['commit-tree',rootTree,'-p',f.commit,'-m','Raw invalid UTF8 path fixture']);
  assert.throws(()=>discover(f,{revision:badCommit}),/invalid UTF-8 Git path/);
});
test('comment-only source decoy cannot outrank real route registration',t=>{
  const f=fixture(t,{
    'src/readPing.js':"// readPing '/ping' -- comment only\n",
    'src/handler.js':"export function readPing(req,res) { return {}; }\nrouter.get('/ping', readPing);\n"
  });
  const r=discover(f);
  assert.equal(r.selection.selected[0].path,'src/handler.js');
  assert.equal(r.selection.confidence,'high');
});
test('a comment-only filename hint is low confidence, never complete',t=>{
  const f=fixture(t,{'src/readPing.js':"// readPing '/ping' -- nothing executable\n"});
  const r=discover(f);
  assert.equal(r.selection.confidence,'low');
  assert.equal(r.selection.complete,false);
});

test('auto-pack refuses incomplete source scans and emits no misleading packet',t=>{
  const large='def readPing():\n'+'x'.repeat(262145);
  const f=fixture(t,{
    'src/a.py':large,
    'src/z.py':"def readPing(): return {'ping':'pong'}\n",
  });
  const cli=new URL('../bin/bskel.mjs',import.meta.url).pathname;
  const output=path.join(f.root,'untrusted-packet.json');
  const r=requireSpawn([process.execPath,cli,'context','pack','--contract',CONTRACT,
      '--revision',f.commit,'--auto-select','--operation','readPing',
      '--out',output,'--json'],f.root);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/automatic discovery is incomplete/);
  assert.equal(fs.existsSync(output),false);
});
test('comment-only and truncated ranked inputs fail closed when auto-packed',t=>{
  const decoy=fixture(t,{'src/readPing.js':"// readPing '/ping'\n"});
  const cli=new URL('../bin/bskel.mjs',import.meta.url).pathname;
  const a=requireSpawn([process.execPath,cli,'context','pack','--contract',CONTRACT,
    '--auto-select','--operation','readPing','--json'],decoy.root);
  assert.notEqual(a.status,0);
  const f=fixture(t,{
    'src/a.py':"def readPing(): return 1\n",
    'src/b.py':"def readPing(): return 2\n"
  });
  const b=requireSpawn([process.execPath,cli,'context','pack','--contract',CONTRACT,
    '--max-files','2','--auto-select','--operation','readPing','--json'],f.root);
  assert.notEqual(b.status,0);
  assert.match(b.stderr,/ranked_candidates_truncated/);
});
test('block-comments, line-comments, and Python docstrings do not certify declarations',t=>{
  const f=fixture(t,{
    'src/readPing.js':"/* export function readPing(){} router.get('/ping', readPing); */\nconst other=1;\n",
    'src/decor.py':"\"\"\"def readPing(): pass\"\"\"\n# @router.get('/ping')\n",
    'src/real.py':"@router.get('/ping')\ndef readPing(): return {'ping':'pong'}\n"
  });
  const r=discover(f);
  assert.equal(r.selection.selected[0].path,'src/real.py');
  assert.ok(r.selection.selected[0].signals.includes('handler_declaration'));
});

test('string-only fake function signatures cannot certify a handler',t=>{
  const f=fixture(t,{
    'src/readPing.js':"const guidance = \"export function readPing(req,res){} router.get('/ping',readPing);\";\n",
    'src/actual.js':"export function readPing(req,res){ return true; }\nrouter.get('/ping',readPing);\n"
  });
  const r=discover(f);
  assert.equal(r.selection.selected[0].path,'src/actual.js');
  assert.ok(r.selection.selected[0].signals.includes('handler_declaration'));
});
test('a filename with only a string containing a signature is incomplete',t=>{
  const f=fixture(t,{'src/readPing.js':"const s = \"export function readPing(req,res){}\";\n"});
  const r=discover(f);
  assert.equal(r.selection.selected[0].signals.includes('handler_declaration'),false);
  assert.equal(r.selection.complete,false);
});

test('line comments reset at actual newlines before a real declaration',t=>{
  const f=fixture(t,{
    'src/real.py':"# docs: def readPing(): return false\n@router.get('/ping')\nasync def readPing(): return {'ping':'pong'}\n",
    'src/readPing.py':"# def readPing(): pass\n"
  });
  const r=discover(f);
  assert.equal(r.selection.selected[0].path,'src/real.py');
  assert.ok(r.selection.selected[0].signals.includes('handler_declaration'));
});
test('quoted comment delimiters do not swallow a later real handler',t=>{
  const f=fixture(t,{
    'src/real.js':"const url = 'http://host/test#fragment';\n// an ordinary comment\nexport function readPing(req,res){return true;}\nrouter.get('/ping',readPing);\n"
  });
  const r=discover(f);
  assert.equal(r.selection.selected[0].path,'src/real.js');
  assert.ok(r.selection.selected[0].signals.includes('handler_declaration'));
});
