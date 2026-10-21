import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProductMutationCampaign } from './product-mutation-runner.mjs';

function makeFixture(t, {todo = false, extraRawCheck = false} = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-false-kill-correction-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'test'),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
    name:'t19-false-kill-control',version:'1.0.0',private:true,type:'module',
  })+'\n');
  fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({
    name:'t19-false-kill-control',version:'1.0.0',lockfileVersion:3,requires:true,
    packages:{'':{name:'t19-false-kill-control',version:'1.0.0'}},
  },null,2)+'\n');
  fs.writeFileSync(path.join(root,'subject.mjs'),'export const value = 1;\n');
  fs.writeFileSync(path.join(root,'test/subject.test.mjs'),[
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import {value} from '../subject.mjs';",
    "test('actual contract',()=>assert.equal(value,1));",
    ...(todo?["test.todo('unimplemented required behavior');"]:[]),
  ].join('\n')+'\n');
  if(extraRawCheck) {
    fs.writeFileSync(path.join(root,'test/raw-source.test.mjs'),[
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "test('raw tracked source bytes',()=>assert.match(fs.readFileSync(new URL('../subject.mjs',import.meta.url),'utf8'),/value = 1/));",
    ].join('\n')+'\n');
  }
  const git=(args)=>{
    const child=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,
      env:{...process.env,GIT_AUTHOR_NAME:'T19 QA fixture',
        GIT_AUTHOR_EMAIL:'t19-qa@example.invalid',
        GIT_COMMITTER_NAME:'T19 QA fixture',
        GIT_COMMITTER_EMAIL:'t19-qa@example.invalid',
        GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',
        GIT_CONFIG_NOSYSTEM:'1'}});
    assert.equal(child.status,0,child.stderr);return child.stdout.trim();
  };
  git(['init','-q']);git(['add','-A']);git(['commit','-qm','fixed original oracle']);
  return {root,head:git(['rev-parse','HEAD'])};
}
const mutant=(id,critical,replace)=>({
  id,vector_id:'NEG-RUN-06',critical,
  file:'subject.mjs',find:'export const value = 1;',replace,
  test_files:['test/subject.test.mjs'],timeout_ms:15000,
  invariant:'A mutation must actually be detected by a completed assertion, not a broken test runner.',
});
test('T19 false positive RED: syntax-only child crash is not a critical/noncritical semantic kill',{
  timeout:120000,
},t=>{
  const {root,head}=makeFixture(t);
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[
    mutant('critical-syntax-not-killed',true,'export const value = ;'),
    mutant('noncritical-syntax-not-killed',false,'export const value = ;'),
  ]};
  const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit:head});
  assert.deepEqual(result.catalog_errors,[]);
  assert.equal(result.mutants.length,2);
  assert.equal(result.pass,false,'syntax-only failures must not satisfy full mutation gate');
  assert.equal(result.gate.pass,false);
  for(const row of result.mutants){
    assert.equal(row.baseline.exit_code,0);
    assert.equal(row.exit_code,1);
    assert.equal(row.status,'survived',row.id);
    assert.notEqual(row.classification,'mutant-detected',row.id);
    assert.equal(row.semantic_assertion_failures,0);
  }
});
test('T19 proper behavioral assertion failures still count as critical and noncritical kills',{
  timeout:120000,
},t=>{
  const {root,head}=makeFixture(t);
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[
    mutant('critical-real-assertion',true,'export const value = 2;'),
    mutant('noncritical-real-assertion',false,'export const value = 2;'),
  ]};
  const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit:head});
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_failures.length,0);
  assert.equal(result.gate.noncritical_score,1);
  for(const row of result.mutants){
    assert.equal(row.baseline.exit_code,0);
    assert.equal(row.status,'killed',row.id);
    assert.equal(row.classification,'mutant-detected');
    assert.equal(row.exit_code,1);
    assert.equal(row.signal,null);
    assert.equal(row.timed_out,false);
    assert.equal(row.error_code,null);
    assert.ok(row.semantic_assertion_failures>=1);
    assert.equal(row.tap.tests,1);
    assert.equal(row.tap.fail,1);
    assert.equal(row.tap.skipped,0);
    assert.equal(row.tap.todo,0);
  }
});
test('T19 incomplete TODO original test cannot certify a mutant kill',{
  timeout:120000,
},t=>{
  const {root,head}=makeFixture(t,{todo:true});
  const result=runProductMutationCampaign({repoRoot:root,sourceCommit:head,
    catalog:{contract:'sbf.qa-product-mutation-catalog/1',mutants:[
      mutant('incomplete-original',true,'export const value = 2;'),
    ]}});
  assert.equal(result.pass,false);
  assert.equal(result.mutants[0].status,'survived');
  assert.equal(result.mutants[0].classification,'baseline-incomplete');
  assert.equal(result.mutants[0].baseline.tap.todo,1);
});

test('T19 mixed parser failure plus another real assertion cannot forge a killed mutation',{
  timeout:120000,
},t=>{
  const {root,head}=makeFixture(t,{extraRawCheck:true});
  const result=runProductMutationCampaign({repoRoot:root,sourceCommit:head,
    catalog:{contract:'sbf.qa-product-mutation-catalog/1',mutants:[
      {...mutant('mixed-parser-and-assertion',true,'export const value = ;'),
        test_files:['test/subject.test.mjs','test/raw-source.test.mjs']},
    ]}});
  assert.equal(result.mutants.length,1);
  const m=result.mutants[0];
  assert.equal(m.baseline.exit_code,0);
  assert.equal(m.baseline.tap.tests,2);
  assert.equal(m.exit_code,1);
  assert.equal(m.tap.tests,2,'a parser error can keep the total test count unchanged');
  assert.ok(m.semantic_assertion_failures>=1,
    'the other test actually fails an assertion, so marker-only logic is insufficient');
  assert.notDeepEqual(m.test_names,m.baseline.test_names,
    'the imported test was replaced with synthetic file-level error identity');
  assert.equal(m.status,'survived','the import/parse failure is not a semantic kill');
  assert.equal(m.classification,'mutant-test-identity-mismatch');
  assert.equal(result.pass,false);
});
