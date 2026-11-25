import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runProductMutationCampaign} from './product-mutation-runner.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const file='test/conformance-next/product-mutations-wave4.json';
const expected={'wave4-project.test.mjs':1,'wave4-route.test.mjs':3,
 'wave4-evidence.test.mjs':2,'wave4-run.test.mjs':1};
function counters(text){
 const normalized=stripVTControlCharacters(text);
 const out={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const rx=new RegExp('^(?:#|ℹ) '+key+' (\\d+)\\r?$','gm');
  const matches=[...normalized.matchAll(rx)];
  assert.equal(matches.length,1,'missing or duplicate '+key+' summary counter');
  const v=Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(v));out[key]=v;
 }
 return out;
}
test('wave4 summary accounting accepts genuine TAP/spec records but rejects absent counters',()=>{
 const values={tests:3,pass:2,fail:1,cancelled:0,skipped:0,todo:0};
 for(const marker of ['#','ℹ']){
  const text=Object.entries(values).map(([k,v])=>marker+' '+k+' '+v+'\n').join('');
  assert.deepEqual(counters(text),values);
  assert.deepEqual(counters('\x1b[32m'+text+'\x1b[0m'),values);
 }
 const text='# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 for(const invalid of [text.replace('# pass 0\n',''),text+'# pass 0\n',
   text.replace('# fail 1','# fail unknown')]) assert.throws(()=>counters(invalid));
});
test('wave4 real immutable-source mutations kill all six by assertions, never failed baselines/signals/timeouts',{timeout:480000},()=>{
 const git=(args,cwd=root)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 const head=git(['rev-parse','HEAD^{commit}']);
 assert.match(head,/^[a-f0-9]{40}$/);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave4-pinned-'));
 const checkout=path.join(temp,'repo');
 try{
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',root,checkout],temp);
  git(['checkout','--quiet','--detach',head],checkout);
  assert.equal(git(['rev-parse','HEAD'],checkout),head);
  assert.equal(git(['status','--porcelain','--untracked-files=all'],checkout),'');
  const catalog=JSON.parse(fs.readFileSync(path.join(checkout,file),'utf8'));
  // Node's default spec reporter emits the assertion stack after its counters.
  // The bounded source-runner keeps only a final stdout tail; the counters can
  // disappear from that tail. Pin TAP *for this live mutation campaign only*,
  // so counters follow the failure details and we can reject non-assertion kills.
  const priorNodeOptions=process.env.NODE_OPTIONS;
  let result;
  try{
   process.env.NODE_OPTIONS='--test-reporter=tap';
   result=runProductMutationCampaign({repoRoot:checkout,catalog,sourceCommit:head});
  }finally{
   if(priorNodeOptions===undefined)delete process.env.NODE_OPTIONS;
   else process.env.NODE_OPTIONS=priorNodeOptions;
  }
  assert.deepEqual(result.catalog_errors,[]);
  assert.equal(result.source_commit,head);
  assert.equal(result.mutants.length,6);
  assert.deepEqual(result.mutants.map(m=>m.id),catalog.mutants.map(m=>m.id));
  for(let i=0;i<result.mutants.length;i++){
   const m=result.mutants[i];
   const n=expected[path.basename(catalog.mutants[i].test_files[0])];
   assert.ok(n,'expected test-count pin required');
   assert.equal(m.baseline.exit_code,0,JSON.stringify(m));
   assert.equal(m.baseline.signal,null);assert.equal(m.baseline.timed_out,false);
   assert.equal(m.status,'killed',JSON.stringify(m));
   assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1,JSON.stringify(m));
   assert.equal(m.signal,null);assert.equal(m.timed_out,false);assert.equal(m.error_code,null);
   const before=counters(m.baseline.stdout_tail),after=counters(m.stdout_tail);
   assert.equal(before.tests,n);assert.equal(before.pass,n);assert.equal(before.fail,0);
   assert.equal(after.tests,n);assert.ok(after.fail>0);
   assert.equal(after.cancelled,0);assert.equal(after.skipped,0);
   assert.equal(after.pass+after.fail,n);
   assert.match(m.stdout_tail,/AssertionError|ERR_ASSERTION/,'must fail a semantic test, not an import/parse/setup error');
  }
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_total,3);
  assert.equal(result.gate.critical_failures.length,0);
  assert.equal(result.gate.noncritical_executable,3);
  assert.equal(result.gate.noncritical_killed,3);
  assert.equal(result.gate.noncritical_score,1);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});