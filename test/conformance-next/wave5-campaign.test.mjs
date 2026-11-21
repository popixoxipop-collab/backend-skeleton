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
const CATALOG='test/conformance-next/product-mutations-wave5.json';
const CASE_COUNTS={'wave5-persistence.test.mjs':4,'wave5-generation.test.mjs':1,'wave5-project.test.mjs':1};
function counters(data){
 const text=stripVTControlCharacters(data),counts={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...text.matchAll(new RegExp('^(?:#|ℹ) '+key+' (\\d+)\\r?$','gm'))];
  assert.equal(matches.length,1,'missing/duplicated '+key+' case count');
  counts[key]=Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(counts[key]));
 }
 return counts;
}
test('wave5 counts accept actual TAP/spec child results and reject altered or missing records',()=>{
 const obj={tests:3,pass:2,fail:1,cancelled:0,skipped:0,todo:0};
 for(const prefix of ['#','ℹ']){
  const body=Object.entries(obj).map(([k,v])=>prefix+' '+k+' '+v+'\n').join('');
  assert.deepEqual(counters(body),obj);
  assert.deepEqual(counters('\x1b[32m'+body+'\x1b[0m'),obj);
 }
 const text='# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 for(const broken of [text.replace('# fail 1\n',''),text+'# fail 1\n',
    text.replace('# pass 0','# pass NaN')])assert.throws(()=>counters(broken));
});
test('wave5 seven actual source mutations fail by proven assertions, not false baseline/setup/timeout kills',{timeout:480000},()=>{
 const git=(args,cwd=ROOT)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 const head=git(['rev-parse','HEAD^{commit}']);
 assert.match(head,/^[a-f0-9]{40}$/);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave5-pinned-'));
 const repo=path.join(temporary,'repo');
 try{
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',ROOT,repo],temporary);
  git(['checkout','--quiet','--detach',head],repo);
  assert.equal(git(['rev-parse','HEAD'],repo),head);
  assert.equal(git(['status','--porcelain','--untracked-files=all'],repo),'');
  const catalog=JSON.parse(fs.readFileSync(path.join(repo,CATALOG),'utf8'));
  const old=process.env.NODE_OPTIONS;
  let result;
  try{
   // The mutation subprocess keeps a bounded stdout tail: TAP puts exact
   // counters after the assertion stack, unlike Node's default spec output.
   process.env.NODE_OPTIONS='--test-reporter=tap';
   result=runProductMutationCampaign({repoRoot:repo,catalog,sourceCommit:head});
  }finally{
   if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;
  }
  assert.deepEqual(result.catalog_errors,[]);
  assert.equal(result.source_commit,head);
  assert.equal(result.mutants.length,7);
  assert.deepEqual(result.mutants.map(x=>x.id),catalog.mutants.map(x=>x.id));
  for(let i=0;i<result.mutants.length;i++){
   const m=result.mutants[i];
   const expected=CASE_COUNTS[path.basename(catalog.mutants[i].test_files[0])];
   assert.ok(expected,m.id+' needs a fixed discovered-case count');
   assert.equal(m.baseline.exit_code,0,JSON.stringify(m));
   assert.equal(m.baseline.signal,null);assert.equal(m.baseline.timed_out,false);
   assert.equal(m.status,'killed',JSON.stringify(m));
   assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1,JSON.stringify(m));
   assert.equal(m.signal,null);assert.equal(m.timed_out,false);assert.equal(m.error_code,null);
   const before=counters(m.baseline.stdout_tail),after=counters(m.stdout_tail);
   assert.equal(before.tests,expected);assert.equal(before.pass,expected);
   assert.equal(before.fail,0);assert.equal(before.cancelled,0);assert.equal(before.skipped,0);assert.equal(before.todo,0);
   assert.equal(after.tests,expected);assert.ok(after.fail>0);
   assert.equal(after.cancelled,0);assert.equal(after.skipped,0);assert.equal(after.todo,0);
   assert.equal(after.pass+after.fail,expected);
   assert.match(m.stdout_tail,/AssertionError|ERR_ASSERTION/,'must be actual assertion failure, not import/start failure');
  }
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_total,6);
  assert.deepEqual(result.gate.critical_failures,[]);
  assert.equal(result.gate.noncritical_executable,1);
  assert.equal(result.gate.noncritical_killed,1);
  assert.equal(result.gate.noncritical_score,1);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});