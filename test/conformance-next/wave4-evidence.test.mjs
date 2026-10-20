import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEvidencePack} from './harness.mjs';

const pack=()=>({
 contract:'sbf.qa-evidence/1',scope:'wave4:assertions',
 source_commit:'a'.repeat(40),adapter_id:'mock',target_profile:'synthetic',
 verdict:'pass',
 commands:[{argv:'node --test synthetic',status:'executed',exit_code:0}],
 assertions:[{id:'control',required:true,status:'passed'},{id:'required-detail',required:true,status:'passed'}],
 artifacts:[]
});
test('NEG-RUN-06 any missing/failed/blocked required assertion prevents PASS, even with other successes',()=>{
 const baseline=verifyEvidencePack(pack());
 assert.equal(baseline.ok,true,baseline.errors.join('\n'));
 for(const status of ['failed','skipped','blocked']){
  const value=pack();value.assertions[1].status=status;
  const actual=verifyEvidencePack(value);
  assert.equal(actual.ok,false,status);
  assert.ok(actual.errors.some(x=>x.includes('pass verdict cannot hide required assertion')),JSON.stringify(actual));
 }
});
test('NEG-RUN-06 optional skipped assertion does not falsely block valid evidence',()=>{
 const value=pack();value.assertions[1].required=false;value.assertions[1].status='skipped';
 const r=verifyEvidencePack(value);
 assert.equal(r.ok,true,r.errors.join('\n'));
});