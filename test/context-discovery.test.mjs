import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverOperationContext } from '../lib/context-discovery.mjs';
import { validateAgainstSchema } from '../lib/schema-validate.mjs';
const CLI=fileURLToPath(new URL('../bin/bskel.mjs',import.meta.url));
const CONTRACT='specs/001-demo/contracts/001-demo.schema.json';
const src="from fastapi import APIRouter\nrouter=APIRouter()\n@router.get('/ping')\nasync def readPing(): return {'ping':'pong!'}\n";
const doc={
  sbf_contract:'9',feature_id:'001-demo',feature_uid:'6576a254-4a9f-4af4-8f24-7a707e6066ce',
  source:{adapter:'python-fastapi',module:'demo',provenance:'fixture'},
  operations:{readPing:{verb:'GET',path:'/ping',pathParams:{},body:false,provenance:'source-annotation'}},
  warnings:[],completeness:{status:'complete',operation_count:1,endpoint_count:1}
};
function git(root,...args) {
  return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function add(root,file,content){const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);}
function fixture(t,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-auto-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  git(root,'init','-q');
  git(root,'config','user.name','Fixture');
  git(root,'config','user.email','fixture@example.invalid');
  for(const [name,content] of Object.entries({
    [CONTRACT]:JSON.stringify(doc,null,2)+'\n',
    'app/routes/ping.py':src,
    'app/routes/unused.py':"from fastapi import APIRouter\nrouter=APIRouter()\n@router.get('/extra')\nasync def other():return {'other':'ok'}\n",
    'README.md':'# App\n',
    'app/secret.key':'Do not include me\n',
    'app/.env':'SECRET=DO_NOT_INCLUDE\n',
    'tests/test_ping.py':"@router.get('/ping')\nasync def readPing(): raise RuntimeError('test decoy')\n",
    ...extra
  }))add(root,name,content);
  fs.symlinkSync('ping.py',path.join(root,'app/routes/linked.py'));
  git(root,'add','--all');git(root,'commit','-qm','Snapshot');
  return {root,commit:git(root,'rev-parse','HEAD')};
}
const discover=(f,opts={})=>discoverOperationContext({
  repoRoot:f.root,contractPath:CONTRACT,operationId:'readPing',revision:f.commit,...opts
});
function cli(root,...args) {
  return spawnSync(process.execPath,[CLI,'context',...args],{cwd:root,encoding:'utf8',timeout:20000,maxBuffer:5e6});
}
test('ranks the exact endpoint from immutable Git ahead of unrelated code',t=>{
  const f=fixture(t),first=discover(f),again=discover(f);
  assert.deepEqual(first,again);
  assert.equal(first.schema,'bskel.context-discovery/1');
  assert.equal(first.repository.commit,f.commit);
  assert.equal(first.selection.selected[0].path,'app/routes/ping.py');
  assert.equal(first.selection.confidence,'high');
  assert.equal(first.selection.selected[0].sha256,createHash('sha256').update(src).digest('hex'));
  assert.ok(first.selection.selected[0].signals.includes('handler_declaration'));
  assert.ok(first.selection.selected.every(x=>!x.path.includes('secret')&&!x.path.includes('test')&&!x.path.includes('linked')&&!x.path.includes('.env')));
  assert.equal(JSON.stringify(first).includes('DO_NOT_INCLUDE'),false);
});
test('ignores worktree mutation and Git replacement objects for explicit commit',t=>{
  const f=fixture(t),before=discover(f);
  add(f.root,'app/routes/ping.py',"@router.get('/WRONG')\n");
  git(f.root,'add','app/routes/ping.py');git(f.root,'commit','-qm','New');
  git(f.root,'replace',f.commit,git(f.root,'rev-parse','HEAD'));
  assert.deepEqual(discover(f),before);
});
test('bound scan marks budgets explicitly rather than lying about coverage',t=>{
  const f=fixture(t);
  const one=discover(f,{maxScanFiles:1});
  assert.equal(one.inventory.budget_limited,true);
  assert.equal(one.selection.complete,false);
  assert.ok(one.inventory.scanned_files<=1);
  assert.throws(()=>discover(f,{maxScanFiles:0}),/maxScanFiles/);
  assert.throws(()=>discover(f,{maxScanBytes:128}),/maxScanBytes/);
  assert.throws(()=>discover(f,{maxSelectedFiles:0}),/maxSelectedFiles/);
});
test('no matching source returns empty selection with zero confidence',t=>{
  const f=fixture(t);
  const yes=discoverOperationContext({repoRoot:f.root,contractPath:CONTRACT,operationId:'readPing'});
  assert.ok(yes.selection.selected.length);
  const contract=JSON.parse(fs.readFileSync(path.join(f.root,CONTRACT),'utf8'));
  contract.operations={unknownOperation:{verb:'GET',path:'/no-such-route',pathParams:{},body:false}};
  add(f.root,CONTRACT,JSON.stringify(contract));git(f.root,'add',CONTRACT);git(f.root,'commit','-qm','Change contract');
  const no=discoverOperationContext({repoRoot:f.root,contractPath:CONTRACT,operationId:'unknownOperation'});
  assert.equal(no.selection.selected.length,0);
  assert.equal(no.selection.confidence,'none');
  assert.equal(no.selection.complete,false);
});
test('unknown operation and malicious path references fail closed',t=>{
  const f=fixture(t);
  assert.throws(()=>discoverOperationContext({repoRoot:f.root,contractPath:CONTRACT,operationId:'not-there'}),/operation absent/);
  assert.throws(()=>discoverOperationContext({repoRoot:f.root,contractPath:'../.env',operationId:'readPing'}),/contract path/);
  assert.throws(()=>discoverOperationContext({repoRoot:f.root,contractPath:CONTRACT,operationId:'readPing;rm -rf /'}),/operation ID/);
});
test('CLI discover and auto-pack verify original packet schema, no instruction execution',t=>{
  const f=fixture(t);
  const d=cli(f.root,'discover','--contract',CONTRACT,'--operation','readPing','--revision',f.commit,'--json');
  assert.equal(d.status,0,d.stderr);
  const discovered=JSON.parse(d.stdout);
  assert.equal(discovered.selection.selected[0].path,'app/routes/ping.py');
  const a=cli(f.root,'pack','--contract',CONTRACT,'--revision',f.commit,'--auto-select','--operation','readPing','--max-files','4','--json');
  assert.equal(a.status,0,a.stderr);
  const packet=JSON.parse(a.stdout);
  assert.equal(packet.schema,'sbf.context-packet/1');
  assert.equal(packet.sources[0].path,'app/routes/ping.py');
  assert.equal(validateAgainstSchema('context-packet.schema.json',packet).ok,true);
  assert.equal(packet.contract.content,fs.readFileSync(path.join(f.root,CONTRACT),'utf8'));
  assert.equal(a.stdout.includes('DO_NOT_INCLUDE'),false);
});
test('legacy pack path remains identical byte for byte and conflicting flags rejected',t=>{
  const f=fixture(t);
  const args=['pack','--contract',CONTRACT,'--revision',f.commit,'--files','app/routes/ping.py','--json'];
  const one=cli(f.root,...args);
  assert.equal(one.status,0,one.stderr);
  const second=cli(f.root,...args);assert.equal(one.stdout,second.stdout);
  const conflict=cli(f.root,...args,'--auto-select','--operation','readPing');
  assert.notEqual(conflict.status,0);
  const missing=cli(f.root,'pack','--contract',CONTRACT,'--auto-select','--json');
  assert.notEqual(missing.status,0);
});
test('auto-pack refuses omitted source even after complete discovery; explicit pack reports incompleteness',t=>{
  const f=fixture(t);
  const destination=path.join(f.root,'should-not-be-created.json');
  const r=cli(f.root,'pack','--contract',CONTRACT,'--auto-select','--operation','readPing',
    '--max-files','1','--out','should-not-be-created.json','--json');
  assert.notEqual(r.status,0,'incomplete automatic packing must fail closed');
  assert.match(r.stderr,/automatic pack refuses incomplete packet/);
  const diagnostic=JSON.parse(r.stdout);
  assert.equal(diagnostic.schema,'sbf.cli-diagnostic/1');
  assert.equal(diagnostic.ok,false);
  assert.equal(diagnostic.command,'context pack');
  assert.equal(fs.existsSync(destination),false,'incomplete auto-packet must not be written');
  // The contract itself fits; the source does not. The byte budget must
  // be checked after discovery as a distinct fail-closed stage.
  const budget=Buffer.byteLength(fs.readFileSync(path.join(f.root,CONTRACT)))+1;
  const bytes=cli(f.root,'pack','--contract',CONTRACT,'--auto-select','--operation','readPing',
    '--max-bytes',String(budget),'--out','should-not-be-created.json','--json');
  assert.notEqual(bytes.status,0,'auto-pack may not emit a source omitted by byte budget');
  assert.equal(fs.existsSync(destination),false);
  const chosen=cli(f.root,'pack','--contract',CONTRACT,'--files','app/routes/ping.py','--max-files','1','--json');
  assert.equal(chosen.status,0,chosen.stderr);
  const packet=JSON.parse(chosen.stdout);
  assert.equal(packet.selection.complete,false);
  assert.equal(packet.sources.length,0);
  assert.ok(packet.selection.omitted.some(o=>o.reason==='file_budget'));
});
