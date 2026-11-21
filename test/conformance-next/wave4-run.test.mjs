import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runProductMutationCampaign} from './product-mutation-runner.mjs';

// A deliberately failing ORIGINAL oracle is essential: detecting that the
// candidate fails too must not turn the mutation gate green.
test('NEG-RUN-02 failed original oracle blocks the mutation verdict instead of creating a false pass',{timeout:90000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave4-original-fail-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'test'));
 fs.writeFileSync(path.join(root,'subject.mjs'),'export const value = 1;\n');
 fs.writeFileSync(path.join(root,'test/subject.test.mjs'),[
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import {value} from '../subject.mjs';",
  "test('oracle is red',()=>assert.equal(value,2));"
 ].join('\n')+'\n');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
  name:'t19-wave4-baseline-red',version:'1.0.0',private:true,type:'module'
 })+'\n');
 fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({
  name:'t19-wave4-baseline-red',version:'1.0.0',lockfileVersion:3,
  requires:true,packages:{'':{name:'t19-wave4-baseline-red',version:'1.0.0'}}
 },null,2)+'\n');
 const git=(args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:20000,
  env:{...process.env,GIT_AUTHOR_NAME:'T19 fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
   GIT_COMMITTER_NAME:'T19 fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(['init','-q']);git(['add','-A']);git(['commit','-qm','deliberately failing original oracle']);
 const head=git(['rev-parse','HEAD']);
 const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{
  id:'red-original-must-block',vector_id:'NEG-RUN-02',critical:true,
  file:'subject.mjs',find:'value = 1',replace:'value = 3',
  test_files:['test/subject.test.mjs'],timeout_ms:12000,
  invariant:'Original-oracle failure blocks comparison instead of producing pass.'
 }]};
 const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit:head});
 assert.deepEqual(result.catalog_errors,[]);
 assert.equal(result.mutants.length,1);
 const m=result.mutants[0];
 assert.equal(m.baseline.exit_code,1,'fixture must fail before any mutation');
 assert.equal(m.baseline.signal,null);
 assert.equal(m.baseline.timed_out,false);
 assert.equal(m.status,'survived','a red baseline cannot count a mutant as killed');
 assert.equal(m.classification,'baseline-failed');
 assert.equal(result.pass,false);
 assert.equal(result.gate.pass,false);
 assert.deepEqual(result.gate.critical_failures,['red-original-must-block']);
});