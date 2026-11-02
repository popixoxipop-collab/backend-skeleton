import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runProductMutationCampaign} from './product-mutation-runner.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const CATALOG='test/conformance-next/product-mutations-wave8.json';
const fixed=new Set(['wave8-auth-02.test.mjs','wave8-auth-04.test.mjs','wave8-auth-05.test.mjs','wave8-project-05.test.mjs']);
function counts(t){
 const text=stripVTControlCharacters(t),result={};
 for(const k of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...text.matchAll(new RegExp('^(?:#|ℹ) '+k+' (\\d+)\\r?$','gm'))];
  assert.equal(matches.length,1,'missing/duplicate '+k);
  result[k]=Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(result[k]));
 }
 assert.equal(result.tests,result.pass+result.fail+result.skipped+result.cancelled+result.todo);
 return result;
}
test('Wave8 evidence parsing rejects missing/duplicated case-count summary',()=>{
 const s='# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 assert.deepEqual(counts(s),{tests:1,pass:0,fail:1,cancelled:0,skipped:0,todo:0});
 assert.deepEqual(counts('\x1b[31m'+s+'\x1b[0m'),counts(s));
 assert.throws(()=>counts(s.replace('# fail 1\n','')));
 assert.throws(()=>counts(s+'# fail 1\n'));
});
test('Wave8 detects four source-security and one shared-project-facet mutations, never setup/syntax failures',{
 timeout:480000,
},()=>{
 const git=(args,cwd=ROOT)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 const head=git(['rev-parse','HEAD^{commit}']);
 assert.match(head,/^[a-f0-9]{40}$/);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave8-pinned-'));
 const repo=path.join(temp,'repo');
 try {
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',ROOT,repo],temp);
  git(['checkout','--quiet','--detach',head],repo);
  assert.equal(git(['rev-parse','HEAD'],repo),head);
  assert.equal(git(['status','--porcelain','--untracked-files=all'],repo),'');
  const cat=JSON.parse(fs.readFileSync(path.join(repo,CATALOG),'utf8'));
  const old=process.env.NODE_OPTIONS;
  let result;
  try {
   process.env.NODE_OPTIONS='--test-reporter=tap';
   result=runProductMutationCampaign({repoRoot:repo,catalog:cat,sourceCommit:head});
  } finally {
   if(old===undefined)delete process.env.NODE_OPTIONS;
   else process.env.NODE_OPTIONS=old;
  }
  assert.deepEqual(result.catalog_errors,[]);
  assert.equal(result.source_commit,head);
  assert.equal(result.mutants.length,5);
  for(let i=0;i<result.mutants.length;i++){
   const m=result.mutants[i],source=cat.mutants[i];
   assert.equal(m.id,source.id);
   assert.ok(fixed.has(path.basename(source.test_files[0])));
   assert.equal(m.baseline.exit_code,0);
   assert.equal(m.baseline.signal,null);
   assert.equal(m.baseline.timed_out,false);
   assert.equal(m.status,'killed');
   assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1);
   assert.equal(m.signal,null);
   assert.equal(m.timed_out,false);
   assert.equal(m.error_code,null);
   const a=counts(m.baseline.stdout_tail),b=counts(m.stdout_tail);
   assert.equal(a.tests,a.pass);
   assert.equal(a.tests,1);
   assert.equal(b.tests,b.fail);
   assert.equal(b.tests,1);
   assert.equal(b.pass,0);
   assert.equal(b.skipped,0);
   assert.equal(b.cancelled,0);
   assert.equal(b.todo,0);
   assert.match(m.stdout_tail,/ERR_ASSERTION|AssertionError/,
     'this is genuine behavior assertion loss, not parse/import failure');
  }
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_total,4);
  assert.deepEqual(result.gate.critical_failures,[]);
  assert.equal(result.gate.noncritical_executable,1);
  assert.equal(result.gate.noncritical_killed,1);
  assert.equal(result.gate.noncritical_score,1);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});