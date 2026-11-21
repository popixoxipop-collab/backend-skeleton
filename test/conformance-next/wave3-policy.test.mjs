import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {verifyCompatibilityInventory,observedBlockers,verifyReleasePlan,loadEvidenceStore} from '../../release/next/release-policy.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL('../../release/next/'+name,import.meta.url),'utf8'));
const inventory=read('compatibility-inventory.json'),plan=read('release-plan.json');
const store=loadEvidenceStore(fileURLToPath(new URL('../../release/next/evidence-manifest.json',import.meta.url)));
const states=['queued','pending','in_progress','interrupted','outcome_unknown','cancelled',null,undefined];

test('NEG-RUN-07 inventory rejects nonterminal state despite success-shaped conclusion',()=>{
 assert.equal(verifyCompatibilityInventory(inventory).ok,true);
 for(const state of states){
  const value=structuredClone(inventory);value.repositories[0].verification.status=state;
  const r=verifyCompatibilityInventory(value);
  assert.equal(r.ok,false,String(state));assert.ok(r.errors.some(e=>e.code==='CI_STATUS'),String(state));
 }
});
test('NEG-RUN-07 release blocker cannot be removed by a nonterminal success-shaped run',()=>{
 assert.equal(observedBlockers(inventory).includes('CURRENT_MAIN_CI_NOT_GREEN'),false);
 for(const state of states){
  const value=structuredClone(inventory);value.repositories[0].verification.status=state;
  assert.ok(observedBlockers(value).includes('CURRENT_MAIN_CI_NOT_GREEN'),String(state));
 }
});
test('NEG-RELEASE-04 writer modes cannot change before the approved consumer stage',()=>{
 const control=verifyReleasePlan(plan,inventory,store,null);
 assert.equal(control.ok,true,JSON.stringify(control.errors));
 for(let index=0;index<plan.migration_stages.length;index++){
  const value=structuredClone(plan);value.migration_stages[index].writer_mode='next-global';
  const r=verifyReleasePlan(value,inventory,store,null);
  assert.equal(r.ok,false);
  assert.ok(r.errors.some(e=>e.code==='MIGRATION_STAGE_SEMANTICS'&&e.field==='writer_mode'));
 }
 assert.equal(plan.release_allowed,false,'test must not grant real release authority');
});
