import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProductMutationCampaign } from './conformance-next/product-mutation-runner.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const originalPath=path.join(ROOT,'test/conformance-next/product-mutations-wave2.json');
const originalBytes=fs.readFileSync(originalPath);
const original=JSON.parse(originalBytes);
const catalog=JSON.parse(fs.readFileSync(path.join(ROOT,'test/conformance-next/product-mutations-wave2-closeout.json'),'utf8'));
const IDS=[
 'PMUT2-WORKER-OUTPUT-LIMIT-UNREPORTED','PMUT2-RUST-NEST-CYCLE-UNBOUNDED',
 'PMUT2-TS-EXPRESS-MOUNT-CYCLE-UNBOUNDED','PMUT2-RELEASE-HEAD-BINDING-DROPPED',
 'PMUT2-RELEASE-ROLLBACK-RESTORE-UNVERIFIED',
];
const ORACLE='test/conformance-next/wave2-survivor-invariants.test.mjs';

// Root npm tests run concurrently and some create working-tree fixtures. Read
// one immutable commit, then run the existing strict runner in a private clean
// clone. Never copy mutable checkout bytes or relax the runner's clean guard.
function withCommittedCheckout(repoRoot, work) {
 const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
 const sourceCommit=git(['rev-parse','HEAD^{commit}'],repoRoot);
 assert.match(sourceCommit,/^[0-9a-f]{40}$/);
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'t19-closeout-checkout-'));
 const checkout=path.join(parent,'repo');
 try {
  git(['clone','--quiet','--local','--no-hardlinks','--no-checkout','--',repoRoot,checkout],parent);
  git(['checkout','--quiet','--detach',sourceCommit],checkout);
  assert.equal(git(['rev-parse','HEAD'],checkout),sourceCommit);
  assert.equal(git(['status','--porcelain','--untracked-files=all'],checkout),'');
  return work({checkout,sourceCommit});
 } finally {
  fs.rmSync(parent,{recursive:true,force:true});
 }
}

test('T19 replay snapshot excludes concurrent dirty and untracked caller fixtures',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-dirty-fixture-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','--quiet');
 fs.writeFileSync(path.join(root,'tracked.txt'),'committed\n');
 git('add','tracked.txt');
 git('-c','user.name=T19 fixture','-c','user.email=t19@example.invalid','commit','--quiet','-m','fixture');
 const expected=git('rev-parse','HEAD');
 fs.writeFileSync(path.join(root,'tracked.txt'),'temporary sibling edit\n');
 fs.writeFileSync(path.join(root,'.temporary-sibling-fixture'),'untracked');
 assert.notEqual(git('status','--porcelain','--untracked-files=all'),'');
 withCommittedCheckout(root,({checkout,sourceCommit})=>{
  assert.equal(sourceCommit,expected);
  assert.equal(fs.readFileSync(path.join(checkout,'tracked.txt'),'utf8'),'committed\n');
  assert.equal(fs.existsSync(path.join(checkout,'.temporary-sibling-fixture')),false);
 });
 assert.equal(fs.readFileSync(path.join(root,'tracked.txt'),'utf8'),'temporary sibling edit\n');
 assert.equal(fs.readFileSync(path.join(root,'.temporary-sibling-fixture'),'utf8'),'untracked');
});

test('T19 closeout catalog preserves all original mutations and only adds five behavioral oracles',()=>{
 assert.equal(catalog.source_catalog.sha256,createHash('sha256').update(originalBytes).digest('hex'));
 assert.equal(catalog.mutants.length,23);
 assert.equal(catalog.contract,original.contract);
 for(let i=0;i<original.mutants.length;i++){
  const old=original.mutants[i];const expected=structuredClone(old);
  if(IDS.includes(old.id))expected.test_files.push(ORACLE);
  assert.deepEqual(catalog.mutants[i],expected,old.id);
 }
 assert.equal(catalog.mutants.filter(m=>IDS.includes(m.id)).length,5);
});
test('T19 real replay: all five former survivors must be detected, never via failing baseline or timeout',{timeout:600000},()=>{
 const result=withCommittedCheckout(ROOT,({checkout,sourceCommit})=>{
  const pinnedCatalog=JSON.parse(fs.readFileSync(path.join(checkout,'test/conformance-next/product-mutations-wave2-closeout.json'),'utf8'));
  const selected={contract:pinnedCatalog.contract,mutants:pinnedCatalog.mutants.filter(m=>IDS.includes(m.id))};
  return runProductMutationCampaign({repoRoot:checkout,catalog:selected,sourceCommit});
 });
 assert.deepEqual(result.catalog_errors,[]);
 assert.equal(result.mutants.length,5);
 for(const m of result.mutants){
  assert.equal(m.baseline.exit_code,0,JSON.stringify(m));
  assert.equal(m.status,'killed',JSON.stringify(m));
  assert.equal(m.classification,'mutant-detected');
  assert.ok(Number.isInteger(m.exit_code)&&m.exit_code!==0);
  assert.equal(m.timed_out,false);
  assert.equal(m.signal,null);
 }
 assert.equal(result.pass,true,JSON.stringify(result.gate));
});
