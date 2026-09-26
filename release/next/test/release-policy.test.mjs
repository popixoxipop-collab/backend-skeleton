import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  observedBlockers,
  releasePlanBlockers,
  verifyAll,
  verifyCompatibilityInventory,
  verifyReleasePlan,
} from '../release-policy.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..');
const inventory=JSON.parse(fs.readFileSync(path.join(ROOT,'compatibility-inventory.json'),'utf8'));
const plan=JSON.parse(fs.readFileSync(path.join(ROOT,'release-plan.json'),'utf8'));
const clone=(x)=>structuredClone(x);

test('current integrated-main inventory is structurally valid but release remains blocked',()=>{
  const result=verifyAll(inventory,plan);
  assert.equal(result.ok,true);
  assert.deepEqual(result.inventory.errors,[]);
  assert.deepEqual(result.release_plan.errors,[]);
  assert.deepEqual(result.inventory.observed_blockers,[
    'FINAL_MAIN_PUSH_CI_NOT_DIRECT',
    'INDEPENDENT_QA_NOT_READY',
    'T01_06_NOT_ACCEPTED',
    'TRUST_POLICY_NOT_READY',
  ]);
  assert.deepEqual(releasePlanBlockers(plan),['FINAL_RELEASE_REHEARSAL_NOT_RUN']);
  assert.equal(plan.release_allowed,false);
  assert.equal(plan.default_activation_allowed,false);
});

test('zero-delta equivalence must be exact and still does not count as direct main CI',()=>{
  const x=clone(inventory);
  x.repositories[0].verification.file_delta_count=1;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e)=>e.code==='TREE_EQUIVALENCE'));
  assert.ok(observedBlockers(inventory).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('direct main CI cannot reuse an older or merely tree-equivalent CI head',()=>{
  const x=clone(inventory);
  x.repositories[0].verification.direct_main_ci=true;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e)=>e.code==='DIRECT_CI_HEAD_MISMATCH'));
  assert.ok(observedBlockers(x).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('release cannot hide an observed blocker',()=>{
  const x=clone(plan);
  x.blockers=x.blockers.filter((v)=>v!=='T01_06_NOT_ACCEPTED');
  assert.ok(verifyReleasePlan(x,inventory).errors.some((e)=>e.code==='OBSERVED_BLOCKER_NOT_DECLARED'));
});

test('every mandatory prerequisite must remain present with its pinned required state',()=>{
  const missing=clone(plan);
  missing.prerequisites=missing.prerequisites.filter((x)=>x.id!=='T00-04A');
  assert.ok(verifyReleasePlan(missing,inventory).errors.some((e)=>e.code==='PREREQUISITE_MISSING'));

  const weakened=clone(plan);
  weakened.prerequisites.find((x)=>x.id==='T00-05').required_state='PLANNED';
  assert.ok(verifyReleasePlan(weakened,inventory).errors.some((e)=>e.code==='PREREQUISITE_REQUIRED_STATE'));
});

test('release rehearsal is a real gate and PASS requires evidence',()=>{
  const hidden=clone(plan);
  hidden.blockers=hidden.blockers.filter((v)=>v!=='FINAL_RELEASE_REHEARSAL_NOT_RUN');
  assert.ok(verifyReleasePlan(hidden,inventory).errors.some((e)=>e.code==='OBSERVED_BLOCKER_NOT_DECLARED'));

  const fakePass=clone(plan);
  fakePass.release_rehearsal.observed_state='PASS';
  fakePass.blockers=fakePass.blockers.filter((v)=>v!=='FINAL_RELEASE_REHEARSAL_NOT_RUN');
  assert.ok(verifyReleasePlan(fakePass,inventory).errors.some((e)=>e.code==='REHEARSAL_PASS_WITHOUT_EVIDENCE'));
});

test('release cannot activate default writer while release gate is closed',()=>{
  const x=clone(plan);
  x.default_activation_allowed=true;
  assert.ok(verifyReleasePlan(x,inventory).errors.some((e)=>e.code==='PREMATURE_DEFAULT_ACTIVATION'));
});

test('consumer-first migration order is immutable',()=>{
  const x=clone(plan);
  [x.migration_stages[1],x.migration_stages[2]]=[x.migration_stages[2],x.migration_stages[1]];
  assert.ok(verifyReleasePlan(x,inventory).errors.some((e)=>e.code==='MIGRATION_ORDER'));
});

test('destructive rollback and old-writer overwrite remain forbidden',()=>{
  const x=clone(plan);
  x.rollback_policy.destructive_down_migration_allowed=true;
  x.rollback_policy.old_writer_may_overwrite_next_artifacts=true;
  const codes=verifyReleasePlan(x,inventory).errors.map((e)=>e.code);
  assert.ok(codes.includes('DESTRUCTIVE_DOWN_MIGRATION'));
  assert.ok(codes.includes('OLD_WRITER_OVERWRITE'));
});

test('legacy HTTP identity stays authoritative during additive T01 shipping',()=>{
  const x=clone(inventory);
  x.invariants.legacy_http_identity_authoritative=false;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e)=>e.code==='LEGACY_IDENTITY_AUTHORITY'));
});
