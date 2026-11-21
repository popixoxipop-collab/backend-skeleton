import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {runProductMutationCampaign} from './product-mutation-runner.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const FILE='test/conformance-next/product-mutations-wave3.json';
const EXPECTED_COUNTS={'wave3-identity.test.mjs':4,'wave3-policy.test.mjs':3,'wave3-routes.test.mjs':1,'wave3-package.test.mjs':1};
function counts(text) {
 const normalized=stripVTControlCharacters(text),result={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...normalized.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)\\r?$`,'gm'))];
  assert.equal(matches.length,1,`missing or duplicate ${key} counter`);
  const value=Number(matches[0][1]);assert.ok(Number.isSafeInteger(value));result[key]=value;
 }
 return result;
}
test('wave3 reads exact TAP and spec summary counters, including ANSI decoration',()=>{
 const expected={tests:4,pass:3,fail:1,cancelled:0,skipped:0,todo:0};
 for(const prefix of ['#','ℹ']){
  const text=Object.entries(expected).map(([key,value])=>`${prefix} ${key} ${value}\n`).join('');
  assert.deepEqual(counts(text),expected);
  assert.deepEqual(counts('\x1b[36m'+text+'\x1b[0m'),expected);
 }
});
test('wave3 refuses missing duplicate or malformed summary counters instead of guessing',()=>{
 const text='# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 for(const bad of [text.replace('# tests 1\n',''),text+'# tests 1\n',text.replace('# fail 1','# fail NaN')])
  assert.throws(()=>counts(bad),assert.AssertionError);
});

test('wave3 live campaign detects all ten defects without baseline, parser, signal or timeout false positives',{timeout:600000},()=>{
 const git=(args,cwd=ROOT)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 // Only committed bytes enter a campaign; sibling tests can dirty the caller.
 const head=git(['rev-parse','HEAD^{commit}']);assert.match(head,/^[a-f0-9]{40}$/);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave3-snapshot-'));const checkout=path.join(temp,'repo');
 try{
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',ROOT,checkout],temp);
  git(['checkout','--quiet','--detach',head],checkout);
  assert.equal(git(['rev-parse','HEAD'],checkout),head);assert.equal(git(['status','--porcelain','--untracked-files=all'],checkout),'');
  const catalog=JSON.parse(fs.readFileSync(path.join(checkout,FILE),'utf8'));
  const r=runProductMutationCampaign({repoRoot:checkout,catalog,sourceCommit:head});
  assert.deepEqual(r.catalog_errors,[]);assert.equal(r.source_commit,head);assert.equal(r.mutants.length,10);
  assert.deepEqual(r.mutants.map(m=>m.id),catalog.mutants.map(m=>m.id));
  for(let i=0;i<r.mutants.length;i++){
   const m=r.mutants[i],expected=EXPECTED_COUNTS[path.basename(catalog.mutants[i].test_files[0])];
   assert.equal(m.baseline.exit_code,0,JSON.stringify(m));assert.equal(m.baseline.signal,null);assert.equal(m.baseline.timed_out,false);
   assert.equal(m.status,'killed',JSON.stringify(m));assert.equal(m.classification,'mutant-detected');
   assert.equal(m.exit_code,1,JSON.stringify(m));assert.equal(m.signal,null);assert.equal(m.timed_out,false);assert.equal(m.error_code,null);
   const original=counts(m.baseline.stdout_tail),changed=counts(m.stdout_tail);
   assert.equal(original.tests,expected);assert.equal(original.pass,expected);assert.equal(original.fail,0);
   assert.equal(changed.tests,expected);assert.ok(changed.fail>0);assert.equal(changed.cancelled,0);assert.equal(changed.skipped,0);
   assert.equal(changed.pass+changed.fail,expected);
  }
  assert.equal(r.pass,true,JSON.stringify(r.gate));assert.equal(r.gate.critical_total,9);assert.equal(r.gate.noncritical_executable,1);assert.equal(r.gate.noncritical_score,1);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
