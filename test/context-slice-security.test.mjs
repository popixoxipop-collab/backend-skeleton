import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sliceOperationContext } from '../lib/context-slice.mjs';

const CONTRACT='specs/ecc/contracts/contract.json';
const BASE_FUNC="def reply_payload():\n    return {'ping':'pong'}\n";
function git(root,...a){return execFileSync('git',a,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function mk(t,source,additional={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'slice-security-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 git(root,'init','-q');git(root,'config','user.name','Security Test');git(root,'config','user.email','slice@example.invalid');
 const doc={sbf_contract:'9',feature_id:'001-slice',feature_uid:'11111111-1111-4111-8111-111111111111',
  source:{adapter:'python-fastapi',module:'app',provenance:'test-only'},
  operations:{readPing:{verb:'GET',path:'/ping',pathParams:{},body:false,provenance:'source-annotation'}},
  warnings:[],completeness:{status:'partial',operation_count:1,endpoint_count:1}};
 const files={[CONTRACT]:JSON.stringify(doc,null,2)+'\n','app/routes/ping.py':source,
  'app/services.py':BASE_FUNC,...additional};
 for(const [name,body] of Object.entries(files)){
  const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
 }
 git(root,'add','-A');git(root,'commit','-qm','Pinned evidence');
 return {root,revision:git(root,'rev-parse','HEAD')};
}
const build=(f,options={})=>sliceOperationContext({repoRoot:f.root,contractPath:CONTRACT,
 operationId:'readPing',revision:f.revision,...options});
const serviceImport='from app.services import reply_payload\n';
const decorator="@router.get('/ping')\n";
test('multi-line Python signature keeps body and imported helper, never falsely complete with a half signature',t=>{
 const f=mk(t,serviceImport+decorator+"async def readPing(\n    name: str = 'guest',\n):\n    return reply_payload()\n");
 const result=build(f);
 assert.equal(result.status,'advisory_complete');
 assert.equal(result.dependencies.length,1);
 assert.match(result.handler.excerpt,/^@router\.get\('\/ping'\)/m);
 assert.match(result.handler.excerpt,/^\):$/m);
 assert.match(result.handler.excerpt,/return reply_payload\(\)/);
 assert.equal(result.dependencies[0].symbol,'reply_payload');
});
test('multi-line helper signature keeps helper return payload',t=>{
 const helper="def reply_payload(\n    message: str = 'pong',\n):\n    return {'ping':message}\n";
 const f=mk(t,serviceImport+decorator+'async def readPing():\n    return reply_payload()\n',
  {'app/services.py':helper});
 const result=build(f);
 assert.equal(result.status,'advisory_complete');
 assert.equal(result.dependencies.length,1);
 assert.match(result.dependencies[0].excerpt,/\):\n\s+return \{'ping':message\}/);
});
test('unindented triple-quoted string contents inside handler do not cut return and imports',t=>{
 const handler=serviceImport+decorator+"async def readPing():\n    note = '''hello\nunindented contents\n'''\n    return reply_payload()\n";
 const f=mk(t,handler);
 const v=build(f);
 assert.equal(v.status,'advisory_complete');
 assert.equal(v.dependencies.length,1);
 assert.match(v.handler.excerpt,/unindented contents[\s\S]*return reply_payload\(\)/);
});
test('commented code ends on a REAL newline so a following helper call is found',t=>{
 const f=mk(t,serviceImport+decorator+'async def readPing():\n    # ignored instruction and import\n    return reply_payload()\n');
 const d=build(f);
 assert.equal(d.status,'advisory_complete');
 assert.equal(d.dependencies.length,1);
});
test('a secrets directory is never copied into source excerpts, even via direct import',t=>{
 const f=mk(t,'from app.secrets.token import api_key\n'+decorator+
  'async def readPing():\n    return api_key\n',
  {'app/secrets/token.py':'api_key = "VERY_SECRET_VALUE"\n'});
 const d=build(f);
 assert.equal(d.status,'advisory_incomplete');
 assert.equal(d.dependencies.length,0);
 assert.ok(d.warnings.some(x=>x.kind==='restricted'));
 assert.ok(!JSON.stringify(d).includes('VERY_SECRET_VALUE'));
});
test('an unrelated same-basename module cannot satisfy an absolute root import',t=>{
 const f=mk(t,'from services import reply_payload\n'+decorator+
  'async def readPing():\n    return reply_payload()\n');
 const d=build(f);
 assert.equal(d.dependencies.length,0);
 assert.equal(d.status,'advisory_incomplete');
 assert.ok(d.warnings.some(x=>x.kind==='unresolved_root'));
});
test('real import after 400 source lines is still tracked',t=>{
 const f=mk(t,('# padding only\n').repeat(420)+serviceImport+decorator+
  'async def readPing():\n    return reply_payload()\n');
 const d=build(f,{maxHandlerLines:100});
 assert.equal(d.dependencies.length,1);
 assert.equal(d.status,'advisory_complete');
});
test('bare import member syntax is marked incomplete instead of silently trusting an empty closure',t=>{
 const f=mk(t,'import app.services\n'+decorator+
  'async def readPing():\n    return app.services.reply_payload()\n');
 const d=build(f);
 assert.equal(d.dependencies.length,0);
 assert.equal(d.status,'advisory_incomplete');
 assert.ok(d.warnings.some(x=>x.reason==='module_member_not_resolved'));
});
test('dynamic import is marked incomplete rather than omitted without evidence',t=>{
 const f=mk(t,decorator+
  "async def readPing():\n    return importlib.import_module('app.services').reply_payload()\n");
 const d=build(f);
 assert.equal(d.status,'advisory_incomplete');
 assert.ok(d.warnings.some(x=>x.reason==='dynamic_import_not_resolved'));
});
test('fake import declarations inside docstrings and strings are not processed',t=>{
 const handler='\"\"\"from app.secrets.token import api_key\n\"\"\"\n'+
  decorator+'async def readPing():\n    note = "api_key"\n    return {"ping":"pong"}\n';
 const f=mk(t,handler,{'app/secrets/token.py':'api_key = "LEAK_MARKER"\n'});
 const d=build(f);
 assert.equal(d.dependencies.length,0);
 assert.ok(!JSON.stringify(d).includes('LEAK_MARKER'));
});
test('handler dictionary continuation with unindented closing brace does not truncate',t=>{
 const f=mk(t,serviceImport+decorator+
  'async def readPing():\n    result = {\n        "key": reply_payload(),\n}\n    return result\n');
 const d=build(f);
 assert.equal(d.dependencies.length,1);
 assert.match(d.handler.excerpt,/return result/);
});
test('operation budget and source OID stay stable between duplicate reads',t=>{
 const f=mk(t,serviceImport+decorator+'async def readPing():\n    return reply_payload()\n');
 const a=build(f),b=build(f);
 assert.deepEqual(a,b);
 assert.equal(a.budget.used_bytes,a.handler.bytes+a.dependencies.reduce((n,d)=>n+d.bytes,0));
 assert.equal(a.dependencies[0].excerpt_sha256,createHash('sha256').update(a.dependencies[0].excerpt).digest('hex'));
});
