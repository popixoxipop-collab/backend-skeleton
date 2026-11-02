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
const CATALOG='test/conformance-next/product-mutations-wave6.json';
const FIXED_COUNTS={'wave6-project.test.mjs':1, 'wave6-game-01.test.mjs':1, 'wave6-game-02.test.mjs':1, 'wave6-game-03.test.mjs':1, 'wave6-game-06.test.mjs':1, 'wave6-game-07.test.mjs':1};
function counters(text){
 const normalized=stripVTControlCharacters(text),result={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...normalized.matchAll(new RegExp('^(?:#|ℹ) '+key+' (\\d+)\\r?$','gm'))];
  assert.equal(matches.length,1,'missing or duplicate '+key+' test outcome counter');
  result[key]=Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(result[key]));
 }
 return result;
}
test('wave6 test-count validator rejects missing, repeated or unparseable outcome summaries',()=>{
 const counts={tests:3,pass:2,fail:1,cancelled:0,skipped:0,todo:0};
 for(const marker of ['#','ℹ']){
  const text=Object.entries(counts).map(([k,v])=>marker+' '+k+' '+v+'\n').join('');
  assert.deepEqual(counters(text),counts);
  assert.deepEqual(counters('\x1b[32m'+text+'\x1b[0m'),counts);
 }
 const example='# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 for(const bad of [example.replace('# pass 0\n',''),example+'# fail 1\n',
   example.replace('# fail 1','# fail invalid')])assert.throws(()=>counters(bad));
});
test('wave6 six vectors/seven source mutations fail real semantic assertions with green original suites',{timeout:480000},()=>{
 const git=(args,cwd=ROOT)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 const HEAD=git(['rev-parse','HEAD^{commit}']);
 assert.match(HEAD,/^[0-9a-f]{40}$/);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave6-pinned-'));
 const repo=path.join(temp,'repo');
 try{
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',ROOT,repo],temp);
  git(['checkout','--quiet','--detach',HEAD],repo);
  assert.equal(git(['rev-parse','HEAD'],repo),HEAD);
  assert.equal(git(['status','--porcelain','--untracked-files=all'],repo),'');
  const cat=JSON.parse(fs.readFileSync(path.join(repo,CATALOG),'utf8'));
  const prior=process.env.NODE_OPTIONS;
  let result;
  try{
   process.env.NODE_OPTIONS='--test-reporter=tap';
   result=runProductMutationCampaign({repoRoot:repo,catalog:cat,sourceCommit:HEAD});
  }finally{
   if(prior===undefined)delete process.env.NODE_OPTIONS;
   else process.env.NODE_OPTIONS=prior;
  }
  assert.deepEqual(result.catalog_errors,[]);
  assert.equal(result.source_commit,HEAD);
  assert.equal(result.mutants.length,7);
  assert.deepEqual(result.mutants.map(x=>x.id),cat.mutants.map(x=>x.id));
  for(let i=0;i<result.mutants.length;i++){
   const m=result.mutants[i];
   const n=FIXED_COUNTS[path.basename(cat.mutants[i].test_files[0])];
   assert.ok(n,'expected file-specific case count required');
   assert.equal(m.baseline.exit_code,0,JSON.stringify(m));
   assert.equal(m.baseline.signal,null);assert.equal(m.baseline.timed_out,false);
   assert.equal(m.status,'killed',JSON.stringify(m));
   assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1,JSON.stringify(m));
   assert.equal(m.signal,null);assert.equal(m.timed_out,false);assert.equal(m.error_code,null);
   const before=counters(m.baseline.stdout_tail),after=counters(m.stdout_tail);
   assert.equal(before.tests,n);assert.equal(before.pass,n);assert.equal(before.fail,0);
   assert.equal(before.cancelled,0);assert.equal(before.skipped,0);assert.equal(before.todo,0);
   assert.equal(after.tests,n);assert.ok(after.fail>0);
   assert.equal(after.pass+after.fail,n);assert.equal(after.cancelled,0);assert.equal(after.skipped,0);assert.equal(after.todo,0);
   assert.match(m.stdout_tail,/ERR_ASSERTION|AssertionError/,
    'actual failed assertion required; parser/import/setup failures never earn mutant-killed credit');
  }
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_total,6);
  assert.deepEqual(result.gate.critical_failures,[]);
  assert.equal(result.gate.noncritical_executable,1);
  assert.equal(result.gate.noncritical_killed,1);
  assert.equal(result.gate.noncritical_score,1);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});