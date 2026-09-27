import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const packet=JSON.parse(fs.readFileSync(path.resolve(HERE,'../../evidence/next/T19-RELEASE-ACCEPTANCE.json'),'utf8'));
const SHA40=/^[a-f0-9]{40}$/;
const EXPECTED_RELEASE_HEADS={
  bskel:'bb18182c54a3a8f682ed2d1a6bac26749fcf267e',
  becoder:'eb8164560ddd343306234a9140dc89c001519792',
  beval:'f7189e4208f04867b493c7d874a77325ad84afa3',
};
const EXPECTED_DIRECT_EOE_REQUEST='95631e68-a325-4b91-a4dc-46869c983b51';
const EXPECTED_QA={
  head:'1a4e4da3b62bf0113d240c32bfede06f7884966d',
  run_id:36218926731,
  run_number:1259,
  nested_node22_job:108340401748,
  nested_node24_job:108340401697,
};

function validate(value) {
  const errors=[];
  if (value?.schema!=='bskel.t19-release-acceptance/1') errors.push('SCHEMA');
  for (const role of ['bskel','becoder','beval']) {
    if (value?.release_heads?.[role]!==EXPECTED_RELEASE_HEADS[role]) errors.push('HEAD_'+role);
  }
  if (value?.qa_authority?.head!==EXPECTED_QA.head) errors.push('QA_HEAD');
  const ci=value?.qa_authority?.exact_head_ci??{};
  if (ci.conclusion!=='success') errors.push('QA_CI');
  if (ci.run_id!==EXPECTED_QA.run_id) errors.push('QA_RUN_ID');
  if (ci.run_number!==EXPECTED_QA.run_number) errors.push('QA_RUN_NUMBER');
  if (ci.nested_node22_job!==EXPECTED_QA.nested_node22_job) errors.push('QA_NODE22_JOB');
  if (ci.nested_node24_job!==EXPECTED_QA.nested_node24_job) errors.push('QA_NODE24_JOB');
  const direct=value?.qa_authority?.direct_eoe??{};
  if (direct.request_id!==EXPECTED_DIRECT_EOE_REQUEST) errors.push('DIRECT_QA_REQUEST');
  if (direct.tests!==40 || direct.passed!==40 || direct.failed!==0 || direct.skipped!==0) errors.push('DIRECT_QA');
  if (value?.qa_authority?.negative_program?.catalog_total!==79) errors.push('CATALOG');
  if (value?.qa_authority?.negative_program?.all_catalog_cases_claimed_executable!==false) errors.push('CATALOG_OVERCLAIM');
  if (value?.qa_authority?.current_pr_release_certification_claimed!==false) errors.push('PR_RELEASE_OVERCLAIM');
  if (value?.holdout_findings?.some((x)=>x.issue===119&&x.state==='OPEN')!==true) errors.push('HOLDOUT_119');
  if (value?.runtime_security_dependency?.gate!=='T20-03'||value?.runtime_security_dependency?.state!=='NOT_ACCEPTED') errors.push('T20_STATE');
  if (value?.runtime_security_dependency?.full_closeout_claimed!==false) errors.push('T20_CLOSEOUT_OVERCLAIM');

  const blockers=Array.isArray(value?.blockers)?value.blockers:[];
  for (const required of ['HOLDOUT_ISSUE_119_OPEN','NO_T19_RELEASE_CERTIFICATE','T20_03_NOT_ACCEPTED']) {
    if (!blockers.includes(required)) errors.push('BLOCKER_'+required);
  }
  if (blockers.length>0 && value?.state!=='BLOCKED') errors.push('BLOCKED_STATE');
  if (blockers.length>0 && value?.release_approved!==false) errors.push('RELEASE_APPROVAL');
  if (blockers.length>0 && value?.default_activation_approved!==false) errors.push('DEFAULT_APPROVAL');
  if (value?.state==='ACCEPTED' && blockers.length>0) errors.push('PREMATURE_ACCEPTANCE');
  return errors;
}

test('T19 release packet is exact-head, fail-closed, and honestly BLOCKED',()=>{
  assert.deepEqual(validate(packet),[]);
});

test('green QA alone cannot erase holdout/runtime/release-certificate blockers',()=>{
  const x=structuredClone(packet);
  x.state='ACCEPTED';
  x.release_approved=true;
  const errors=validate(x);
  assert.ok(errors.includes('BLOCKED_STATE'));
  assert.ok(errors.includes('RELEASE_APPROVAL'));
  assert.ok(errors.includes('PREMATURE_ACCEPTANCE'));
});

test('79-case catalog is not misrepresented as fully executable',()=>{
  assert.equal(packet.qa_authority.negative_program.catalog_total,79);
  assert.equal(packet.qa_authority.negative_program.harness_mutants_executed,7);
  assert.equal(packet.qa_authority.negative_program.product_mutants_executed,13);
  assert.equal(packet.qa_authority.negative_program.total_mutants_executed,20);
  assert.equal(packet.qa_authority.negative_program.all_catalog_cases_claimed_executable,false);
});


test('exact-head CI provenance identifiers are immutable',()=>{
  for (const [field,bad] of [
    ['run_id',1],
    ['run_number',1],
    ['nested_node22_job',1],
    ['nested_node24_job',1],
  ]) {
    const x=structuredClone(packet);
    x.qa_authority.exact_head_ci[field]=bad;
    assert.ok(validate(x).some((code)=>code.startsWith('QA_')),field);
  }
  const y=structuredClone(packet);
  y.qa_authority.head='0'.repeat(40);
  assert.ok(validate(y).includes('QA_HEAD'));
});

test('blocked packet cannot claim full T20 closeout',()=>{
  const x=structuredClone(packet);
  x.runtime_security_dependency.full_closeout_claimed=true;
  assert.ok(validate(x).includes('T20_CLOSEOUT_OVERCLAIM'));
});


test('release candidate heads are immutable release-control anchors',()=>{
  for (const role of ['bskel','becoder','beval']) {
    const x=structuredClone(packet);
    x.release_heads[role]='0'.repeat(40);
    assert.ok(validate(x).includes('HEAD_'+role),role);
  }
});


test('missing or misspelled T20 state fails closed',()=>{
  for (const bad of [undefined,null,'BLOCKED','NOT_ACCEPT']) {
    const x=structuredClone(packet);
    if (bad===undefined) delete x.runtime_security_dependency.state;
    else x.runtime_security_dependency.state=bad;
    assert.ok(validate(x).includes('T20_STATE'),String(bad));
  }
});


test('direct EOE request identifier is immutable',()=>{
  const x=structuredClone(packet);
  x.qa_authority.direct_eoe.request_id='00000000-0000-4000-8000-000000000000';
  assert.ok(validate(x).includes('DIRECT_QA_REQUEST'));
  const y=structuredClone(packet);
  delete y.qa_authority.direct_eoe.request_id;
  assert.ok(validate(y).includes('DIRECT_QA_REQUEST'));
});
