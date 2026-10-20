import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { focusOperationContext } from '../lib/context-focus.mjs';

const contractPath='specs/ecc/contract.json';
const handler=[
  '@router.get("/ping")',
  'async def readPing():',
  '    return {"marker":"DUMMY_TEST_VALUE"}',''
].join('\n');
function git(repo,...args){
  return execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function fixture(t,filepath,contents){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ecc-focus-policy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');
  const contract={
    sbf_contract:'9',feature_id:'001-demo',feature_uid:'11111111-1111-4111-8111-111111111111',
    source:{adapter:'python-fastapi',module:'fixture',provenance:'source'},
    operations:{readPing:{verb:'GET',path:'/ping',pathParams:{},body:false}},
    warnings:[],completeness:{status:'partial',operation_count:1,endpoint_count:1}
  };
  for(const [filename,body] of Object.entries({
    [contractPath]:JSON.stringify(contract)+'\n',
    'app/routes/other.py':'def unrelated(): return False\n',
    [filepath]:contents
  })){
    const target=path.join(root,filename);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);
  }
  git(root,'add','--all');git(root,'commit','-qm','pinned Git fixture');
  return {repoRoot:root,contractPath,operationId:'readPing',revision:git(root,'rev-parse','HEAD')};
}
test('tracked handler under keys/ cannot be emitted as focused source',t=>{
  const f=fixture(t,'app/keys/handler.py',handler);
  const d=focusOperationContext(f);
  assert.equal(d.status,'abstained');
  assert.equal(d.focus.selected,null);
  assert.ok(d.discovery.incomplete_reasons.includes('restricted_source_files_excluded'));
  assert.ok(!JSON.stringify(d).includes('DUMMY_TEST_VALUE'));
  assert.ok(!JSON.stringify(d).includes('app/keys/handler.py'));
});
test('keys.py, key_store and keystore paths are denied',t=>{
  for(const filename of ['app/keys.py','app/key_store/handler.py','app/keystore/handler.py']){
    const f=fixture(t,filename,handler);
    const d=focusOperationContext(f);
    assert.equal(d.status,'abstained',filename);
    assert.equal(d.focus.selected,null);
    assert.ok(!JSON.stringify(d).includes(filename));
  }
});
test('a fake GET decorator in a Python docstring is not a callable route',t=>{
  const body=[
    '"""', '@router.get("/ping")', 'DUMMY_DOCSTRING_MARKER',
    '"""', 'async def readPing():', '    return {"ping":"pong"}', ''
  ].join('\n');
  const d=focusOperationContext(fixture(t,'app/routes/api.py',body));
  assert.equal(d.status,'abstained');
  assert.equal(d.focus.selected,null);
  assert.ok(!JSON.stringify(d).includes('DUMMY_DOCSTRING_MARKER'));
});
test('genuine decorated handler after a docstring is still found',t=>{
  const body=[
    '"""','@router.get("/ping")','DUMMY_DOCSTRING_MARKER','"""',
    '@router.get("/ping")','async def readPing():',
    '    return {"ping":"pong"}',''
  ].join('\n');
  const d=focusOperationContext(fixture(t,'app/routes/api.py',body));
  assert.equal(d.status,'advisory_complete');
  assert.equal(d.focus.selected.path,'app/routes/api.py');
  assert.ok(d.focus.selected.excerpt.startsWith('@router.get('));
  assert.ok(!d.focus.selected.excerpt.includes('DUMMY_DOCSTRING_MARKER'));
});
