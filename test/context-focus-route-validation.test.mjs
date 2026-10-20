import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { focusOperationContext } from '../lib/context-focus.mjs';

const CONTRACT='specs/ecc/contract.json';
function git(cwd,...args){
 return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function fixture(t,source,expectedPath='/ping'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ecc-route-validate-'));
 t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
 git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');
 const contract={
  sbf_contract:'9',feature_id:'001-route',feature_uid:'11111111-1111-4111-8111-111111111111',
  source:{adapter:'python-fastapi',module:'fixture',provenance:'source'},
  operations:{readPing:{verb:'GET',path:expectedPath,pathParams:{},body:false}},
  warnings:[],completeness:{status:'partial',operation_count:1,endpoint_count:1}
 };
 for(const [rel,content] of Object.entries({
   [CONTRACT]:JSON.stringify(contract)+'\n',
   'app/routes/api.py':source
 })){
  const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);
 }
 git(root,'add','--all');git(root,'commit','-qm','immutable GET route fixture');
 return {repoRoot:root,contractPath:CONTRACT,operationId:'readPing',revision:git(root,'rev-parse','HEAD')};
}
test('wrong decorated GET path must not certify a different contract route',t=>{
 const f=fixture(t,[
  '@router.get("/other")',
  'async def readPing():',
  '    return {"source":"unmatched-route"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.focus.selected,null);
 assert.notEqual(r.status,'advisory_complete');
 assert.ok(!JSON.stringify(r).includes('unmatched-route'));
});
test('GET decorator applied to an intervening class cannot be attached to later function',t=>{
 const f=fixture(t,[
  '@router.get("/ping")',
  'class Decoy:',
  '    pass',
  'async def readPing():',
  '    return {"marker":"CLASS_ATTRIBUTION_DECOY"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.focus.selected,null);
 assert.ok(!JSON.stringify(r).includes('CLASS_ATTRIBUTION_DECOY'));
});
test('same-indentation assignment between decorator and function also breaks ownership',t=>{
 const f=fixture(t,[
  '@router.get("/ping")',
  'not_a_decorator = 42',
  'async def readPing():',
  '    return {"marker":"ASSIGNMENT_DECOY"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.focus.selected,null);
});
test('true multiline GET decorator with matching route remains focusable',t=>{
 const f=fixture(t,[
  '@router.get(',
  '    "/ping",',
  '    response_model=dict,',
  '    responses={404: {"description":"missing"}},',
  ')',
  'async def readPing(',
  '):',
  '    return {"ping":"pong"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'advisory_complete');
 assert.equal(r.focus.selected.path,'app/routes/api.py');
 assert.ok(r.focus.selected.excerpt.startsWith('@router.get('));
 assert.ok(r.focus.selected.excerpt.includes('async def readPing('));
});
test('unknown composite router prefix is incomplete, not proven matching a full route',t=>{
 const f=fixture(t,[
  'router=APIRouter(prefix="/ping")',
  '@router.get("/")',
  'async def readPing():',
  '    return {"ping":"pong"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.notEqual(r.status,'advisory_complete');
});

test('an inline comment cannot forge the expected route literal',t=>{
 const f=fixture(t,[
  '@router.get( # @router.get("/ping")',
  '    "/other"',
  ')',
  'async def readPing():',
  '    return {"marker":"INLINE_COMMENT_ROUTE_DECOY"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'abstained');
 assert.equal(r.focus.selected,null);
 assert.ok(!JSON.stringify(r).includes('INLINE_COMMENT_ROUTE_DECOY'));
});
test('the actual route remains recognized despite a misleading inline comment',t=>{
 const f=fixture(t,[
  '@router.get( # @router.get("/other")',
  '    "/ping"',
  ')',
  'async def readPing():',
  '    return {"ping":"pong"}',''
 ].join('\n'));
 const r=focusOperationContext(f);
 assert.equal(r.status,'advisory_complete');
 assert.equal(r.focus.selected.path,'app/routes/api.py');
 assert.equal(r.focus.selected.route_verification,'exact');
});
