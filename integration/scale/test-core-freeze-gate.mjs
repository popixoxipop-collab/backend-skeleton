import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCoreFreezeActivation} from './core-freeze-gate.mjs';

const SHA='a'.repeat(40);
const GOOD={
 schema:'bskel.scale-core-freeze-activation/1',candidate:'T00-04A',
 baseline:{state:'ACCEPTED',heads:{bskel:SHA,becoder:SHA,beval:SHA},exact_head_ci:'success',independent_review:'pass'},
 current_main_heads:{bskel:SHA,becoder:SHA,beval:SHA},
 identity:{exact_head_ci:'success',scope_compliant:true,legacy_compatibility:true,artifact_ref_semantics:'exact-bytes',identity_envelope_family:'http',additive_only:true},
 capability:{exact_head_ci:'success',scope_compliant:true,statuses:['supported','partial','unsupported','unknown','not-applicable'],certification_wire_promoted:false,runtime_tested_requires_verified_runtime_evidence:true},
 lease:{policy_revision:'T00-03-r1',verifier_ci:'success',fail_closed:true},
 semantics:{unknown_preserved:true,runtime_cannot_repair_contract:true,causality_not_inferred:true}
};

test('accepts only a fully satisfied 04A activation snapshot',()=>assert.equal(evaluateCoreFreezeActivation(GOOD).ok,true));
test('blocks an unaccepted baseline',()=>{const x=structuredClone(GOOD);x.baseline.state='SUBMITTED';assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='BASELINE_NOT_ACCEPTED'));});
test('blocks main-head drift',()=>{const x=structuredClone(GOOD);x.current_main_heads.beval='b'.repeat(40);assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='BASELINE_DRIFT'));});
test('blocks queued baseline CI',()=>{const x=structuredClone(GOOD);x.baseline.exact_head_ci='queued';assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='BASELINE_CI_NOT_GREEN'));});
test('blocks missing independent review',()=>{const x=structuredClone(GOOD);x.baseline.independent_review='blocked';assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='BASELINE_REVIEW_NOT_PASS'));});
test('blocks identity scope violation',()=>{const x=structuredClone(GOOD);x.identity.scope_compliant=false;assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='IDENTITY_SCOPE_NOT_COMPLIANT'));});
test('blocks semantic instead of exact-byte artifact identity',()=>{const x=structuredClone(GOOD);x.identity.artifact_ref_semantics='semantic';assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='ARTIFACT_REF_SEMANTICS_MISMATCH'));});
test('blocks capability vocabulary drift',()=>{const x=structuredClone(GOOD);x.capability.statuses=['supported','unknown'];assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='CAPABILITY_STATUS_SET_MISMATCH'));});
test('blocks premature certification wire promotion',()=>{const x=structuredClone(GOOD);x.capability.certification_wire_promoted=true;assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='CERTIFICATION_WIRE_PREMATURELY_PROMOTED'));});
test('blocks capability scope violation',()=>{const x=structuredClone(GOOD);x.capability.scope_compliant=false;assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='CAPABILITY_SCOPE_NOT_COMPLIANT'));});
test('blocks weak lease policy',()=>{const x=structuredClone(GOOD);x.lease.fail_closed=false;assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='LEASE_NOT_FAIL_CLOSED'));});
test('blocks runtime contract repair authority',()=>{const x=structuredClone(GOOD);x.semantics.runtime_cannot_repair_contract=false;assert.ok(evaluateCoreFreezeActivation(x).errors.some(e=>e.code==='RUNTIME_AUTHORITY_BOUNDARY_MISSING'));});
