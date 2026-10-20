import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { focusOperationContext } from '../lib/context-focus.mjs';

const cli=fileURLToPath(new URL('../bin/bskel.mjs',import.meta.url));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const contractPath='specs/ecc/contracts/001-focustest.json';
const source=[
'from fastapi import APIRouter',
'router=APIRouter()',
'@router.get(',
'    "/people/{id}",',
'    response_model=dict,',
'    responses={',
'        404: {',
'            "description": "Person does not exist",',
'        },',
'    },',
')',
'async def readPerson(',
'    id: str,',
'):',
'    return {"id": id}',
'',
'@router.patch("/people/{id}")',
'async def patchPerson(id: str):',
'    return {"id": id}',''].join('\n');
function git(cwd,...args){return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function create(t,additional={}){
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-focus-'));
 t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
 git(repo,'init','-q');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
 const c={sbf_contract:'9',feature_id:'001-focustest',feature_uid:'fixture-uid',
  source:{adapter:'python-fastapi',module:'example',provenance:'source'},
  operations:{readPerson:{verb:'GET',path:'/people/{id}',pathParams:{},body:false}},
  warnings:[],completeness:{status:'partial',operation_count:1,endpoint_count:1}};
 const files={[contractPath]:JSON.stringify(c)+'\n',
  'app/routes/person.py':source,'app/routes/other.py':"@router.get('/places')\ndef place(): return {}\n",...additional};
 for(const [name,content] of Object.entries(files)){
  const file=path.join(repo,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);
 }
 fs.writeFileSync(path.join(repo,'.env'),'SECRET_TEST_DO_NOT_INCLUDE');
 git(repo,'add','--all');git(repo,'commit','-qm','fixture');
 return {repo,commit:git(repo,'rev-parse','HEAD')};
}
function get({repo,commit},options={}){
 return focusOperationContext({repoRoot:repo,contractPath,operationId:'readPerson',revision:commit,...options});
}
function runCli(f,...args){
 return spawnSync(process.execPath,[cli,'context',...args],{cwd:f.repo,encoding:'utf8',timeout:15000});
}
test('focus keeps entire multiline GET decorator and callable; stops before next PATCH',t=>{
 const f=create(t),a=get(f),b=get(f);
 assert.deepEqual(a,b);
 assert.equal(a.schema,'bskel.context-focus/1');
 assert.equal(a.repository.commit,f.commit);
 assert.equal(a.status,'advisory_complete');
 assert.equal(a.focus.selected.path,'app/routes/person.py');
 assert.match(a.focus.selected.excerpt,/@router\.get\(\n[\s\S]+?404:/);
 assert.match(a.focus.selected.excerpt,/async def readPerson\(/);
 assert.equal(a.focus.selected.excerpt.includes('@router.patch'),false);
 assert.equal(a.focus.selected.handler_symbol,'readPerson');
 assert.ok(a.focus.selected.bytes<8192);
 assert.equal(a.focus.selected.excerpt_sha256,sha(Buffer.from(a.focus.selected.excerpt)));
 assert.equal(JSON.stringify(a).includes('SECRET_TEST_DO_NOT_INCLUDE'),false);
 assert.equal(a.focus.selected.line_range.start,3);
 assert.ok(a.focus.selected.declaration_line>a.focus.selected.decorator_line);
});
test('focus consults pinned Git blob rather than dirty worktree',t=>{
 const f=create(t),a=get(f);
 fs.writeFileSync(path.join(f.repo,'app/routes/person.py'),'@router.get("/WRONG")\ndef readPerson(): return None\n');
 const b=get(f);assert.deepEqual(a,b);
 assert.match(b.focus.selected.excerpt,/people\/\{id\}/);
});
test('focus refuses truncation rather than emit partial decorator',t=>{
 const f=create(t),r=get(f,{maxBytes:128});
 assert.equal(r.status,'abstained');
 assert.equal(r.reason,'excerpt_exceeds_budget');
 assert.equal(r.focus.source_excerpt_bytes,0);
 assert.equal(r.focus.selected,null);
});
test('two declaring sources are ambiguous rather than a trusted guess',t=>{
 const f=create(t,{'app/routes/dupe.py':source});
 const r=get(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.reason,'multiple_decorated_sources');
 assert.equal(r.focus.selected,null);
});
test('source file without GET decorator cannot be focused',t=>{
 const f=create(t,{'app/routes/person.py':'def readPerson(): return None\n'});
 const r=get(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.focus.selected,null);
});
test('focused snippets preserve original CRLF and stable digest',t=>{
 const f=create(t,{'app/routes/person.py':source.replaceAll('\n','\r\n')});
 const r=get(f);
 assert.equal(r.status,'advisory_complete');
 assert.ok(r.focus.selected.excerpt.includes('\r\n'));
 assert.equal(sha(Buffer.from(r.focus.selected.excerpt)),r.focus.selected.excerpt_sha256);
});
test('CLI focus returns JSON without modifying source checkout',t=>{
 const f=create(t);
 const before=git(f.repo,'status','--porcelain');
 const r=runCli(f,'focus','--contract',contractPath,'--operation','readPerson','--revision',f.commit,'--max-bytes','2048','--json');
 assert.equal(r.status,0,r.stderr);
 const parsed=JSON.parse(r.stdout);
 assert.equal(parsed.focus.selected.path,'app/routes/person.py');
 assert.equal(git(f.repo,'status','--porcelain'),before);
 const h=runCli(f,'focus','--help');
 assert.equal(h.status,0,h.stderr);
 assert.match(h.stdout,/--max-bytes/);
});
test('CLI invalid budget returns diagnostic, not source content',t=>{
 const f=create(t);
 const r=runCli(f,'focus','--contract',contractPath,'--operation','readPerson','--max-bytes','20','--json');
 assert.notEqual(r.status,0);
 const result=JSON.parse(r.stdout);
 assert.equal(result.ok,false);
 assert.equal(result.schema,'sbf.cli-diagnostic/1');
 assert.equal(r.stdout.includes('async def readPerson'),false);
});
test('regular Git contract requirement rejects symlink',t=>{
 const f=create(t);
 fs.rmSync(path.join(f.repo,contractPath));
 fs.symlinkSync('person.py',path.join(f.repo,contractPath));
 git(f.repo,'add','-A');git(f.repo,'commit','-qm','symlink');
 assert.throws(()=>focusOperationContext({repoRoot:f.repo,contractPath,operationId:'readPerson'}),/regular committed contract/);
});

test('focused source refuses a GET handler inside a secret directory',t=>{
 const malicious=source.replace('return {"id": id}','return {"api_key": "NEVER_EXPOSE_SECRET_MARKER"}');
 const f=create(t,{
   'app/routes/person.py':'def unrelated(): return 0\n',
   'app/secrets/token.py':malicious,
 });
 const r=get(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.reason,'no_decorated_declaring_source');
 assert.ok(r.discovery.incomplete_reasons.includes('restricted_source_files_excluded'));
 assert.equal(r.focus.selected,null);
 assert.equal(r.focus.source_excerpt_bytes,0);
 assert.ok(!JSON.stringify(r).includes('NEVER_EXPOSE_SECRET_MARKER'));
 assert.ok(!JSON.stringify(r).includes('app/secrets/token.py'));
 const cli=runCli(f,'focus','--contract',contractPath,'--operation','readPerson','--revision',f.commit,'--json');
 assert.equal(cli.status,0,cli.stderr);
 assert.equal(JSON.parse(cli.stdout).focus.selected,null);
 assert.ok(!cli.stdout.includes('NEVER_EXPOSE_SECRET_MARKER'));
});

test('a lower-ranked restricted candidate downgrades safe focus completeness',t=>{
 const f=create(t,{'app/private/duplicate.py':source});
 const r=get(f);
 assert.equal(r.status,'advisory_incomplete');
 assert.equal(r.focus.selected.path,'app/routes/person.py');
 assert.ok(r.discovery.incomplete_reasons.includes('restricted_source_files_excluded'));
 assert.ok(!JSON.stringify(r).includes('app/private/duplicate.py'));
});
test('secret helper prefixes and CamelCase variants are excluded before source selection',t=>{
 const malicious=source.replace('return {"id": id}','return {"token":"DUMMY_MARKER_DO_NOT_EMIT"}');
 for(const secretFile of ['app/secret_helper.py','app/secretHelper.py','app/routes/token_helper.py']){
   const f=create(t,{[secretFile]:malicious});
   const result=get(f);
   assert.equal(result.status,'advisory_incomplete');
   assert.equal(result.focus.selected.path,'app/routes/person.py');
   assert.ok(result.discovery.incomplete_reasons.includes('restricted_source_files_excluded'));
   assert.ok(!JSON.stringify(result).includes('DUMMY_MARKER_DO_NOT_EMIT'));
   assert.ok(!JSON.stringify(result).includes(secretFile));
   const found=runCli(f,'discover','--contract',contractPath,'--operation','readPerson','--revision',f.commit,'--json');
   assert.equal(found.status,0,found.stderr);
   const discovery=JSON.parse(found.stdout);
   assert.ok(discovery.selection.selected.every(entry=>entry.path!==secretFile));
   const auto=runCli(f,'pack','--contract',contractPath,'--operation','readPerson',
     '--auto-select','--revision',f.commit,'--json');
   assert.notEqual(auto.status,0);
   assert.equal(JSON.parse(auto.stdout).ok,false);
 }
});
