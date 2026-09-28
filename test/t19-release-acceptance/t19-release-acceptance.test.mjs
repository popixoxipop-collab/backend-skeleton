import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const packet=JSON.parse(fs.readFileSync(path.resolve(HERE,'../../evidence/next/T19-RELEASE-ACCEPTANCE.json'),'utf8'));
const SHA40=/^[a-f0-9]{40}$/;
const EXPECTED_RELEASE_HEADS={
  bskel:'80002a1e6536c007d9daaf8e2180fe82f14971e4',
  becoder:'eb8164560ddd343306234a9140dc89c001519792',
  beval:'73595d4f1fb51fa0e7eb99034d9f534965c068a8',
};
const EXPECTED_QA={
  repo:'popixoxipop-collab/backend-skeleton',
  pr:150,
  source_head:'1ae4a506fe1bf7376a0213c52550ef5d1a5906ce',
  run_id:36463531776,
  run_number:1511,
  nested_node22_job:109068277052,
  nested_node24_job:109068276911,
};
const REQUIRED_BLOCKERS=[
  'PRIVATE_HOLDOUT_REQUIRED',
  'TRUSTED_HOLDOUT_ATTESTOR_REQUIRED',
  'NO_T19_RELEASE_CERTIFICATE',
  'FINAL_RELEASE_HEADS_NOT_FROZEN',
];

function validate(value) {
  const errors=[];
  if (value?.schema!=='bskel.t19-release-acceptance/1') errors.push('SCHEMA');
  for (const role of ['bskel','becoder','beval']) {
    if (value?.release_heads?.[role]!==EXPECTED_RELEASE_HEADS[role]) errors.push('HEAD_'+role);
    if (!SHA40.test(value?.release_heads?.[role]??'')) errors.push('HEAD_SHAPE_'+role);
  }

  const qa=value?.qa_authority??{};
  if (qa.repo!==EXPECTED_QA.repo) errors.push('QA_REPO');
  if (qa.pr!==EXPECTED_QA.pr) errors.push('QA_PR');
  if (qa.source_head!==EXPECTED_QA.source_head) errors.push('QA_HEAD');
  if (!SHA40.test(qa.source_head??'')) errors.push('QA_HEAD_SHAPE');

  const ci=qa.exact_source_ci??{};
  if (ci.conclusion!=='success') errors.push('QA_CI');
  if (ci.run_id!==EXPECTED_QA.run_id) errors.push('QA_RUN_ID');
  if (ci.run_number!==EXPECTED_QA.run_number) errors.push('QA_RUN_NUMBER');
  if (ci.nested_node22_job!==EXPECTED_QA.nested_node22_job) errors.push('QA_NODE22_JOB');
  if (ci.nested_node24_job!==EXPECTED_QA.nested_node24_job) errors.push('QA_NODE24_JOB');
  for (const version of ['node22','node24']) {
    const x=ci[version]??{};
    if (x.tests!==74||x.passed!==74||x.failed!==0||x.skipped!==0) errors.push('QA_'+version.toUpperCase());
  }

  const negative=qa.negative_program??{};
  if (negative.catalog_total!==79) errors.push('CATALOG');
  if (negative.harness_mutants_executed!==7) errors.push('HARNESS_MUTANTS');
  if (negative.product_mutants_executed!==13) errors.push('PRODUCT_MUTANTS');
  if (negative.total_mutants_executed!==20) errors.push('TOTAL_MUTANTS');
  if (negative.all_catalog_cases_claimed_executable!==false) errors.push('CATALOG_OVERCLAIM');
  if (qa.current_pr_release_certification_claimed!==false) errors.push('PR_RELEASE_OVERCLAIM');

  const ts=value?.resolved_dependencies?.typescript_express_holdout??{};
  if (ts.issue!==119||ts.state!=='CLOSED'||ts.replacement_pr!==155) errors.push('HOLDOUT_119_STATE');
  const t20=value?.resolved_dependencies?.runtime_security??{};
  if (t20.gate!=='T20-03'||t20.state!=='IMPLEMENTATION_MERGED'||t20.pr!==72) errors.push('T20_STATE');
  if (!SHA40.test(t20.head??'')||!SHA40.test(t20.main??'')) errors.push('T20_SHA');

  const req=value?.release_certificate_requirements??{};
  if (req.private_holdout!=='MISSING') errors.push('PRIVATE_HOLDOUT_STATE');
  if (req.trusted_holdout_attestor!=='MISSING') errors.push('ATTESTOR_STATE');
  if (req.final_release_heads_frozen!==false) errors.push('FINAL_HEAD_STATE');

  const blockers=Array.isArray(value?.blockers)?value.blockers:[];
  for (const required of REQUIRED_BLOCKERS) if (!blockers.includes(required)) errors.push('BLOCKER_'+required);
  for (const obsolete of ['HOLDOUT_ISSUE_119_OPEN','T20_03_NOT_ACCEPTED']) {
    if (blockers.includes(obsolete)) errors.push('OBSOLETE_BLOCKER_'+obsolete);
  }
  if (blockers.length>0 && value?.state!=='BLOCKED') errors.push('BLOCKED_STATE');
  if (blockers.length>0 && value?.release_approved!==false) errors.push('RELEASE_APPROVAL');
  if (blockers.length>0 && value?.default_activation_approved!==false) errors.push('DEFAULT_APPROVAL');
  if (value?.state==='ACCEPTED' && blockers.length>0) errors.push('PREMATURE_ACCEPTANCE');
  return errors;
}

test('T19 post-A release packet is current, exact-source, and fail-closed',()=>{
  assert.deepEqual(validate(packet),[]);
});

test('post-A Node 22 and Node 24 T19 lanes are both 74/74 green',()=>{
  assert.deepEqual(packet.qa_authority.exact_source_ci.node22,{tests:74,passed:74,failed:0,skipped:0});
  assert.deepEqual(packet.qa_authority.exact_source_ci.node24,{tests:74,passed:74,failed:0,skipped:0});
});

test('79-case catalog is not misrepresented as 79 directly executed mutation fixtures',()=>{
  assert.equal(packet.qa_authority.negative_program.catalog_total,79);
  assert.equal(packet.qa_authority.negative_program.harness_mutants_executed,7);
  assert.equal(packet.qa_authority.negative_program.product_mutants_executed,13);
  assert.equal(packet.qa_authority.negative_program.total_mutants_executed,20);
  assert.equal(packet.qa_authority.negative_program.all_catalog_cases_claimed_executable,false);
});

test('resolved TypeScript Express and T20 dependencies are not stale blockers',()=>{
  assert.equal(packet.resolved_dependencies.typescript_express_holdout.state,'CLOSED');
  assert.equal(packet.resolved_dependencies.runtime_security.state,'IMPLEMENTATION_MERGED');
  assert.equal(packet.blockers.includes('HOLDOUT_ISSUE_119_OPEN'),false);
  assert.equal(packet.blockers.includes('T20_03_NOT_ACCEPTED'),false);
});

test('private holdout and trusted-attestor requirements keep final release fail-closed',()=>{
  assert.ok(packet.blockers.includes('PRIVATE_HOLDOUT_REQUIRED'));
  assert.ok(packet.blockers.includes('TRUSTED_HOLDOUT_ATTESTOR_REQUIRED'));
  assert.equal(packet.release_approved,false);
  assert.equal(packet.default_activation_approved,false);
  assert.equal(packet.state,'BLOCKED');
});

test('green QA cannot fabricate the final T19 release certificate',()=>{
  const x=structuredClone(packet);
  x.state='ACCEPTED';
  x.release_approved=true;
  x.qa_authority.current_pr_release_certification_claimed=true;
  const errors=validate(x);
  assert.ok(errors.includes('BLOCKED_STATE'));
  assert.ok(errors.includes('RELEASE_APPROVAL'));
  assert.ok(errors.includes('PR_RELEASE_OVERCLAIM'));
  assert.ok(errors.includes('PREMATURE_ACCEPTANCE'));
});

test('exact-source CI provenance identifiers are immutable',()=>{
  for (const [field,bad] of [['run_id',1],['run_number',1],['nested_node22_job',1],['nested_node24_job',1]]) {
    const x=structuredClone(packet);
    x.qa_authority.exact_source_ci[field]=bad;
    assert.ok(validate(x).some((code)=>code.startsWith('QA_')),field);
  }
  const y=structuredClone(packet);
  y.qa_authority.source_head='0'.repeat(40);
  assert.ok(validate(y).includes('QA_HEAD'));
});

test('release-control anchor SHAs are immutable within this blocked packet',()=>{
  for (const role of ['bskel','becoder','beval']) {
    const x=structuredClone(packet);
    x.release_heads[role]='0'.repeat(40);
    assert.ok(validate(x).includes('HEAD_'+role),role);
  }
});

test('final-head freeze remains a separate release-gate requirement',()=>{
  const x=structuredClone(packet);
  x.release_certificate_requirements.final_release_heads_frozen=true;
  assert.ok(validate(x).includes('FINAL_HEAD_STATE'));
  assert.ok(packet.blockers.includes('FINAL_RELEASE_HEADS_NOT_FROZEN'));
});
