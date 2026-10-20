import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
 const selected={contract:catalog.contract,mutants:catalog.mutants.filter(m=>IDS.includes(m.id))};
 const result=runProductMutationCampaign({repoRoot:ROOT,catalog:selected});
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
