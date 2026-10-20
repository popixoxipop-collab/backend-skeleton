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

test('POST SBF contract is never considered a complete GET focus',t=>{
 const f=fixture(t,[
  '@router.get("/ping")',
  'async def readPing():',
  '    return {"ping":"pong"}',''
 ].join('\n'));
 const contract=JSON.parse(fs.readFileSync(path.join(f.repoRoot,CONTRACT),'utf8'));
 contract.operations.readPing.verb='POST';
 fs.writeFileSync(path.join(f.repoRoot,CONTRACT),JSON.stringify(contract)+'\n');
 git(f.repoRoot,'add',CONTRACT);
 git(f.repoRoot,'commit','-qm','Fixture: POST contract with source GET');
 f.revision=git(f.repoRoot,'rev-parse','HEAD');
 const d=focusOperationContext(f);
 assert.equal(d.status,'abstained');
 assert.equal(d.reason,'unsupported_contract_method');
 assert.equal(d.focus.selected,null);
});
test('Python APIRouter with static nonempty prefix cannot certify full route',t=>{
 const f=fixture(t,[
  'router = APIRouter(prefix="/v1")',
  '@router.get("/ping")',
  'async def readPing():',
  '    return {"ping":"pong"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected)assert.notEqual(d.focus.selected.route_verification,'exact');
});
test('Python ternary conditional GET route is never certified using the first literal',t=>{
 const f=fixture(t,[
  '@router.get("/ping" if False else "/other")',
  'async def readPing():',
  '    return {"ping":"not actually at ping"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
});
test('nested expression containing a fake GET literal cannot certify route',t=>{
 const f=fixture(t,[
  "@router.get((\"/other\", \"@router.get('/ping')\")[0])",
  'async def readPing():',
  '    return {"ping":"not actually at ping"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
});

function javaFixture(t,withPrefix=false){
 const f=fixture(t,'def unrelated(): return 0\n');
 const file=path.join(f.repoRoot,'src/main/java/demo/DemoController.java');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const content=[
  'package demo;',
  '@RestController',
  ...(withPrefix?['@RequestMapping("/v1")']:[]),
  'public class DemoController {',
  '    @GetMapping("/ping")',
  '    public String readPing() { return "pong"; }',
  '}',''
 ].join('\n');
 fs.writeFileSync(file,content);
 git(f.repoRoot,'add','--','src/main/java/demo/DemoController.java');
 git(f.repoRoot,'commit','-qm','Java GET route test');
 f.revision=git(f.repoRoot,'rev-parse','HEAD');
 return f;
}
test('Spring Java @GetMapping direct literal path is handled as a JVM source',t=>{
 const f=javaFixture(t,false);
 const d=focusOperationContext(f);
 assert.equal(d.status,'advisory_complete');
 assert.equal(d.focus.selected.path,'src/main/java/demo/DemoController.java');
 assert.equal(d.focus.selected.language,'jvm');
 assert.equal(d.focus.selected.route_verification,'exact');
});
test('Spring class-level RequestMapping prefix prevents exact full-route certification',t=>{
 const f=javaFixture(t,true);
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected){
  assert.equal(d.focus.selected.language,'jvm');
  assert.notEqual(d.focus.selected.route_verification,'exact');
 }
});

test('Python conditional GET handler is not statically guaranteed to register',t=>{
 const f=fixture(t,[
  'if False:',
  '    @router.get("/ping")',
  '    async def readPing():',
  '        return {"ping":"unregistered"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected)assert.notEqual(d.focus.selected.route_verification,'exact');
});
test('nested Python route factory cannot certify registration without caller evidence',t=>{
 const f=fixture(t,[
  'def create_app_routes():',
  '    @router.get("/ping")',
  '    async def readPing():',
  '        return {"ping":"requires factory call"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected)assert.notEqual(d.focus.selected.route_verification,'exact');
});

test('parenthesized APIRouter prefix cannot certify a full GET route',t=>{
 const f=fixture(t,[
  'router=APIRouter(prefix=("/v1"))',
  '@router.get("/ping")',
  'async def readPing():',
  '    return {"ping":"registered at /v1/ping"}',''
 ].join('\n'));
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected)assert.notEqual(d.focus.selected.route_verification,'exact');
});
test('Java array class-level RequestMapping cannot certify full GET route',t=>{
 const f=javaFixture(t,true);
 const filepath=path.join(f.repoRoot,'src/main/java/demo/DemoController.java');
 const java=fs.readFileSync(filepath,'utf8');
 assert.ok(java.includes('@RequestMapping("/v1")'));
 fs.writeFileSync(filepath,java.replace('@RequestMapping("/v1")','@RequestMapping(path = {"/v1"})'));
 git(f.repoRoot,'add','--','src/main/java/demo/DemoController.java');
 git(f.repoRoot,'commit','-qm','Java list route prefix fixture');
 f.revision=git(f.repoRoot,'rev-parse','HEAD');
 const d=focusOperationContext(f);
 assert.notEqual(d.status,'advisory_complete');
 if(d.focus.selected)assert.notEqual(d.focus.selected.route_verification,'exact');
});
