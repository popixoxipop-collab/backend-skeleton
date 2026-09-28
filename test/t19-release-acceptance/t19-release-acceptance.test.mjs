import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const packet=JSON.parse(fs.readFileSync(path.resolve(HERE,'../../evidence/next/T19-RELEASE-ACCEPTANCE.json'),'utf8'));
const SHA40=/^[a-f0-9]{40}$/;

function validateFailClosedPacket(value) {
  const errors=[];
  if (value?.schema!=='bskel.t19-release-acceptance/1') errors.push('SCHEMA');
  for (const role of ['bskel','becoder','beval']) {
    if (!SHA40.test(value?.release_heads?.[role]??'')) errors.push('HEAD_'+role);
  }
  const qa=value?.qa_authority??{};
  if (qa.repo!=='popixoxipop-collab/backend-skeleton') errors.push('QA_REPO');
  if (!Number.isInteger(qa.pr)||qa.pr<=0) errors.push('QA_PR');
  const qaHead=qa.source_head??qa.head;
  if (!SHA40.test(qaHead??'')) errors.push('QA_HEAD');
  const ci=qa.exact_source_ci??qa.exact_head_ci??{};
  if (ci.conclusion!=='success') errors.push('QA_CI');
  for (const field of ['run_id','run_number','nested_node22_job','nested_node24_job']) {
    if (!Number.isInteger(ci[field])||ci[field]<=0) errors.push('QA_'+field.toUpperCase());
  }
  const negative=qa.negative_program??{};
  if (negative.catalog_total!==79) errors.push('CATALOG');
  if (negative.harness_mutants_executed!==7) errors.push('HARNESS_MUTANTS');
  if (negative.product_mutants_executed!==13) errors.push('PRODUCT_MUTANTS');
  if (negative.total_mutants_executed!==20) errors.push('TOTAL_MUTANTS');
  if (negative.all_catalog_cases_claimed_executable!==false) errors.push('CATALOG_OVERCLAIM');
  if (qa.current_pr_release_certification_claimed!==false) errors.push('PR_RELEASE_OVERCLAIM');

  const blockers=Array.isArray(value?.blockers)?value.blockers:[];
  if (blockers.length===0) errors.push('BLOCKERS_REQUIRED_UNTIL_T00E');
  if (blockers.length>0 && value?.state!=='BLOCKED') errors.push('BLOCKED_STATE');
  if (blockers.length>0 && value?.release_approved!==false) errors.push('RELEASE_APPROVAL');
  if (blockers.length>0 && value?.default_activation_approved!==false) errors.push('DEFAULT_APPROVAL');
  if (value?.state==='ACCEPTED' && blockers.length>0) errors.push('PREMATURE_ACCEPTANCE');
  return errors;
}

test('historical T19 release packet stays structurally valid and fail-closed until T00-E replaces it',()=>{
  assert.deepEqual(validateFailClosedPacket(packet),[]);
});

test('79-case catalog is not misrepresented as 79 directly executed mutation fixtures',()=>{
  assert.equal(packet.qa_authority.negative_program.catalog_total,79);
  assert.equal(packet.qa_authority.negative_program.harness_mutants_executed,7);
  assert.equal(packet.qa_authority.negative_program.product_mutants_executed,13);
  assert.equal(packet.qa_authority.negative_program.total_mutants_executed,20);
  assert.equal(packet.qa_authority.negative_program.all_catalog_cases_claimed_executable,false);
});

test('green historical QA cannot authorize release while the packet still has blockers',()=>{
  const x=structuredClone(packet);
  x.state='ACCEPTED';
  x.release_approved=true;
  x.default_activation_approved=true;
  const errors=validateFailClosedPacket(x);
  assert.ok(errors.includes('BLOCKED_STATE'));
  assert.ok(errors.includes('RELEASE_APPROVAL'));
  assert.ok(errors.includes('DEFAULT_APPROVAL'));
  assert.ok(errors.includes('PREMATURE_ACCEPTANCE'));
});

test('B does not claim a final T19 release certificate owned by T00-E',()=>{
  assert.equal(packet.qa_authority.current_pr_release_certification_claimed,false);
  const x=structuredClone(packet);
  x.qa_authority.current_pr_release_certification_claimed=true;
  assert.ok(validateFailClosedPacket(x).includes('PR_RELEASE_OVERCLAIM'));
});

test('release-control anchor fields must remain commit-shaped even in a blocked historical packet',()=>{
  for (const role of ['bskel','becoder','beval']) {
    const x=structuredClone(packet);
    x.release_heads[role]='not-a-sha';
    assert.ok(validateFailClosedPacket(x).includes('HEAD_'+role));
  }
});

test('QA provenance identifiers remain non-empty and commit-bound',()=>{
  const x=structuredClone(packet);
  const ci=x.qa_authority.exact_source_ci??x.qa_authority.exact_head_ci;
  ci.run_id=0;
  assert.ok(validateFailClosedPacket(x).includes('QA_RUN_ID'));
  const y=structuredClone(packet);
  if ('source_head' in y.qa_authority) y.qa_authority.source_head='0';
  else y.qa_authority.head='0';
  assert.ok(validateFailClosedPacket(y).includes('QA_HEAD'));
});

test('removing all blockers without a T00-E replacement packet fails closed',()=>{
  const x=structuredClone(packet);
  x.blockers=[];
  assert.ok(validateFailClosedPacket(x).includes('BLOCKERS_REQUIRED_UNTIL_T00E'));
});
