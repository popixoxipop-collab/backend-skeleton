import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const packet=JSON.parse(fs.readFileSync(path.resolve(HERE,'../../evidence/next/T19-RELEASE-ACCEPTANCE.json'),'utf8'));
const SHA40=/^[a-f0-9]{40}$/;

function validate(value) {
  const errors=[];
  if (value?.schema!=='bskel.t19-release-acceptance/1') errors.push('SCHEMA');
  for (const role of ['bskel','becoder','beval']) if (!SHA40.test(value?.release_heads?.[role]??'')) errors.push('HEAD_'+role);
  if (!SHA40.test(value?.qa_authority?.head??'')) errors.push('QA_HEAD');
  if (value?.qa_authority?.exact_head_ci?.conclusion!=='success') errors.push('QA_CI');
  const direct=value?.qa_authority?.direct_eoe??{};
  if (direct.tests!==40 || direct.passed!==40 || direct.failed!==0 || direct.skipped!==0) errors.push('DIRECT_QA');
  if (value?.qa_authority?.negative_program?.catalog_total!==79) errors.push('CATALOG');
  if (value?.qa_authority?.negative_program?.all_catalog_cases_claimed_executable!==false) errors.push('CATALOG_OVERCLAIM');
  if (value?.qa_authority?.current_pr_release_certification_claimed!==false) errors.push('PR_RELEASE_OVERCLAIM');
  if (value?.holdout_findings?.some((x)=>x.issue===119&&x.state==='OPEN')!==true) errors.push('HOLDOUT_119');
  if (value?.runtime_security_dependency?.gate!=='T20-03'||value?.runtime_security_dependency?.state==='ACCEPTED') errors.push('T20_STATE');

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
  assert.equal(packet.qa_authority.negative_program.all_catalog_cases_claimed_executable,false);
});
