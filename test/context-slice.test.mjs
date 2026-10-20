import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sliceOperationContext } from '../lib/context-slice.mjs';

const cli=fileURLToPath(new URL('../bin/bskel.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const contract='specs/ecc/contract.json';
const handler=[
 'from fastapi import APIRouter',
 'from app.services import reply_payload',
 'router=APIRouter()',
 '@router.get("/ping")',
 'async def readPing():',
 '    value = reply_payload()',
 '    return value',
 '',
 '@router.post("/ping")',
 'async def writePing():',
 '    return {"bad": "excluded"}',
 ''].join('\n');
const dep=[
 'def reply_payload():',
 '    return {"ping": "pong!", "status": "ok"}',
 '',
 'def secret_like():',
 '    return "EXCLUDED_PRIVATE"',
 ''].join('\n');
function git(dir,...args){
 return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function fixture(t,extras={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-slice-'));
 t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
 git(root,'init','-q');git(root,'config','user.name','Test');git(root,'config','user.email','test@example.invalid');
 const doc={sbf_contract:'9',feature_id:'001-slice',feature_uid:'11111111-1111-4111-8111-111111111111',
   source:{adapter:'python-fastapi',module:'app',provenance:'snapshot'},
   operations:{readPing:{verb:'GET',path:'/ping',pathParams:{},body:false,provenance:'source-annotation'}},
   warnings:[],completeness:{status:'partial',operation_count:1,endpoint_count:1}};
 const files={[contract]:JSON.stringify(doc,null,2)+'\n',
   'app/routes/ping.py':handler,'app/services.py':dep,
   'app/routes/other.py':'@router.get("/other")\ndef other(): return 1\n',
   ...extras};
 for(const [name,value] of Object.entries(files)){
   const full=path.join(root,name);
   fs.mkdirSync(path.dirname(full),{recursive:true});
   fs.writeFileSync(full,value);
 }
 fs.writeFileSync(path.join(root,'.env'),'PASS=TOP_SECRET_SOURCE_NEVER_INCLUDED');
 git(root,'add','--all');git(root,'commit','-qm','Fixture');
 return {root,commit:git(root,'rev-parse','HEAD')};
}
function slice(f,override={}){
 return sliceOperationContext({repoRoot:f.root,contractPath:contract,operationId:'readPing',
   revision:f.commit,...override});
}
function cmd(f,...args){
 return spawnSync(process.execPath,[cli,'context','slice',...args],
  {cwd:f.root,encoding:'utf8',timeout:15000});
}
test('one-level Python local import closure contains only relevant symbol',t=>{
 const f=fixture(t),a=slice(f),b=slice(f);
 assert.deepEqual(a,b);
 assert.equal(a.schema,'bskel.context-slice/1');
 assert.equal(a.status,'advisory_complete');
 assert.equal(a.repository.commit,f.commit);
 assert.equal(a.handler.path,'app/routes/ping.py');
 assert.ok(a.handler.excerpt.includes('return value'));
 assert.ok(!a.handler.excerpt.includes('writePing'));
 assert.equal(a.dependencies.length,1);
 assert.equal(a.dependencies[0].path,'app/services.py');
 assert.equal(a.dependencies[0].symbol,'reply_payload');
 assert.ok(a.dependencies[0].excerpt.includes('pong!'));
 assert.ok(!a.dependencies[0].excerpt.includes('secret_like'));
 assert.ok(!JSON.stringify(a).includes('TOP_SECRET_SOURCE'));
 assert.ok(!JSON.stringify(a).includes('EXCLUDED_PRIVATE'));
 assert.equal(a.budget.used_bytes,a.handler.bytes+a.dependencies[0].bytes);
 assert.equal(a.handler.excerpt_sha256,sha(Buffer.from(a.handler.excerpt)));
 assert.equal(a.dependencies[0].excerpt_sha256,sha(Buffer.from(a.dependencies[0].excerpt)));
 assert.equal(a.dependencies[0].source_sha256,sha(Buffer.from(dep)));
});
test('all bytes pinned to immutable commit, never mutable uncommitted worktree',t=>{
 const f=fixture(t),a=slice(f);
 fs.writeFileSync(path.join(f.root,'app/services.py'),'def reply_payload():return {"bad":"injection"}\n');
 fs.writeFileSync(path.join(f.root,'.env'),'SECRET=CHANGED');
 const b=slice(f);
 assert.deepEqual(a,b);
});
test('budget deficit never silently truncates a local dependency',t=>{
 const f=fixture(t);
 const adequate=slice(f),required=adequate.handler.bytes;
 const limited=slice(f,{maxBytes:Math.max(128,required+2)});
 assert.equal(limited.handler.bytes,required);
 assert.equal(limited.dependencies.length,0);
 assert.equal(limited.status,'advisory_incomplete');
 assert.ok(limited.unresolved.some(x=>x.reason==='dependency_byte_budget'));
 assert.equal(limited.budget.used_bytes,required);
});
test('maxDependencies zero is a reported incomplete closure, not zero cost success',t=>{
 const f=fixture(t),a=slice(f,{maxDependencies:0});
 assert.equal(a.dependencies.length,0);
 assert.equal(a.status,'advisory_incomplete');
 assert.ok(a.unresolved.some(x=>x.reason==='dependency_count_budget'));
});
test('an explicit external Python import is not read as a local source dependency',t=>{
 const f=fixture(t,{'app/routes/ping.py':handler.replace('from app.services import reply_payload','from externalprovider.unsafe import reply_payload')});
 const a=slice(f);
 assert.equal(a.dependencies.length,0);
 assert.ok(!JSON.stringify(a).includes('externalprovider/unsafe.py'));
});
test('an imported name mentioned only inside a Python string is not treated as a call',t=>{
 const changed=handler.replace('value = reply_payload()', 'value = "reply_payload()"');
 const f=fixture(t,{'app/routes/ping.py':changed});
 const r=slice(f);
 assert.equal(r.dependencies.length,0);
 assert.equal(JSON.stringify(r).includes('EXCLUDED_PRIVATE'),false);
});
test('a referenced credential-looking Python module is never copied into source context',t=>{
 const source=handler.replace('from app.services import reply_payload','from app.secrets import reply_payload');
 const f=fixture(t,{'app/routes/ping.py':source,'app/secrets.py':'def reply_payload(): return "VERY_SECRET_VALUE"\\n'});
 const r=slice(f);
 assert.equal(r.dependencies.length,0);
 assert.equal(r.status,'advisory_incomplete');
 assert.ok(r.warnings.some(x=>x.reason==='ambiguous_or_invalid_import'));
 assert.equal(JSON.stringify(r).includes('VERY_SECRET_VALUE'),false);
});
test('an unresolved local relative import is incomplete rather than falsely complete',t=>{
 const f=fixture(t,{'app/routes/ping.py':handler.replace('from app.services import reply_payload','from .not_there import reply_payload')});
 const a=slice(f);
 assert.equal(a.dependencies.length,0);
 assert.equal(a.status,'advisory_incomplete');
 assert.ok(a.unresolved.some(x=>x.reason==='unresolved_relative_import'));
});
test('overly large handler abstains before violating source byte budget',t=>{
 const f=fixture(t,{'app/routes/ping.py':handler.replace('    return value','    msg = "'+'x'.repeat(1200)+'"\n    return value')});
 const a=slice(f,{maxBytes:128});
 assert.equal(a.status,'abstained');
 assert.equal(a.handler,null);
 assert.equal(a.budget.used_bytes,0);
});
test('CLI returns slice receipt without changing existing repo or original contract',t=>{
 const f=fixture(t);
 const before=git(f.root,'status','--porcelain');
 const result=cmd(f,'--contract',contract,'--operation','readPing','--revision',f.commit,'--json');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.equal(data.dependencies.length,1);
 assert.equal(data.handler.path,'app/routes/ping.py');
 assert.equal(git(f.root,'status','--porcelain'),before);
 const help=cmd(f,'--help');assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--max-dependencies/);
});
test('invalid flags produce structured diagnostic and never leak source',t=>{
 const f=fixture(t);
 const result=cmd(f,'--contract',contract,'--operation','readPing','--max-dependencies','99','--json');
 assert.notEqual(result.status,0);
 const data=JSON.parse(result.stdout);
 assert.equal(data.schema,'sbf.cli-diagnostic/1');
 assert.equal(data.ok,false);
 assert.equal(result.stdout.includes('pong!'),false);
});
test('legacy context pack and deterministic plan remain distinct from advisory slice',t=>{
 const f=fixture(t);
 const packed=spawnSync(process.execPath,[cli,'context','pack','--contract',contract,
   '--revision',f.commit,'--files','app/routes/ping.py,app/services.py','--json'],
   {cwd:f.root,encoding:'utf8',timeout:15000});
 assert.equal(packed.status,0,packed.stderr);
 const packet=JSON.parse(packed.stdout);
 assert.equal(packet.schema,'sbf.context-packet/1');
 assert.equal(packet.selection.complete,true);
 assert.equal(packet.sources.length,2);
 assert.equal(slice(f).authority,'ADVISORY_NO_RELEASE_NO_CODE_EXECUTION');
});
