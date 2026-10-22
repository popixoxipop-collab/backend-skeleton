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
const CATALOG='test/conformance-next/product-mutations-wave7.json';
const ONE_CASE=new Set(['01','04','05','06','07','08'].map(x=>'wave7-schema-'+x+'.test.mjs'));

function counts(tap){
 const text=stripVTControlCharacters(tap);
 const out={};
 for(const field of ['tests','pass','fail','cancelled','skipped','todo']){
  const found=[...text.matchAll(new RegExp('^(?:#|ℹ) '+field+' (\\d+)\\r?$','gm'))];
  assert.equal(found.length,1,field+' outcome missing/duplicate');
  const value=Number(found[0][1]);
  assert.ok(Number.isSafeInteger(value) && value>=0);
  out[field]=value;
 }
 assert.equal(out.tests,out.pass+out.fail+out.cancelled+out.skipped+out.todo);
 return out;
}
test('wave7 evidence counters distinguish complete TAP and reject truncation',()=>{
 const example={tests:1,pass:0,fail:1,cancelled:0,skipped:0,todo:0};
 const line=Object.entries(example).map(([k,v])=>'# '+k+' '+v+'\n').join('');
 assert.deepEqual(counts(line),example);
 assert.deepEqual(counts('\x1b[31m'+line+'\x1b[0m'),example);
 for(const damaged of [line.replace('# tests 1\n',''),line+'# fail 1\n',
  line.replace('# fail 1','# fail NaN')])assert.throws(()=>counts(damaged));
});
test('wave7 8 exact-source mutants fail a real single-case assertion with green original fixtures',{
 timeout:500000,
},()=>{
 const git=(args,cwd=ROOT)=>execFileSync('git',args,{
  cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
 }).trim();
 const head=git(['rev-parse','HEAD^{commit}']);
 assert.match(head,/^[0-9a-f]{40}$/);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave7-pinned-'));
 const repo=path.join(scratch,'repo');
 try{
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',ROOT,repo],scratch);
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
  assert.equal(result.mutants.length,8);
  for(let i=0;i<result.mutants.length;i++){
   const m=result.mutants[i],source=cat.mutants[i];
   assert.equal(m.id,source.id);
   assert.ok(ONE_CASE.has(path.basename(source.test_files[0])),source.id);
   assert.deepEqual(m.baseline.signal,null);
   assert.equal(m.baseline.timed_out,false);
   assert.equal(m.baseline.exit_code,0);
   assert.equal(m.status,'killed',JSON.stringify({id:m.id,class:m.classification}));
   assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1);
   assert.equal(m.signal,null);
   assert.equal(m.timed_out,false);
   assert.equal(m.error_code,null);
   const original=counts(m.baseline.stdout_tail);
   const changed=counts(m.stdout_tail);
   assert.equal(original.tests,original.pass);
   assert.equal(original.tests,1);
   assert.equal(changed.tests,original.tests);
   assert.equal(changed.fail,1);
   assert.equal(changed.pass,0);
   assert.equal(changed.cancelled,0);
   assert.equal(changed.skipped,0);
   assert.equal(changed.todo,0);
   assert.match(m.stdout_tail,/ERR_ASSERTION|AssertionError/,
    'only actual assertion failures qualify, never parse/import/timeout failures');
  }
  assert.equal(result.pass,true,JSON.stringify(result.gate));
  assert.equal(result.gate.critical_total,7);
  assert.deepEqual(result.gate.critical_failures,[]);
  assert.equal(result.gate.noncritical_executable,1);
  assert.equal(result.gate.noncritical_killed,1);
  assert.equal(result.gate.noncritical_score,1);
 }finally{
  fs.rmSync(scratch,{recursive:true,force:true});
 }
});