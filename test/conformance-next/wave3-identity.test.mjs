import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readIdentity,wrapLegacyIdentity,bindingDigest,createArtifactRef,artifactRefMatches,sha256Bytes} from '../../contracts/next/identity.mjs';
const contract=(hash='a',uid='123e4567-e89b-42d3-a456-426614174000')=>({contract_ref:'sbf.contract-ref/1',contract_hash:hash.repeat(64),sbf_contract:'2',feature_id:'001-widget',feature_uid:uid});
const action=(scope=contract())=>({action_ref:'sbf.action-ref/1',contract:scope,operation_id:'readWidget'});

test('NEG-ID-02 aliases cannot repair missing exact operation identity',()=>{
 const valid=action();assert.deepEqual(readIdentity(valid).reference,valid);
 for(const alias of ['readWidget','001-widget.readWidget']){
  const missing={...valid,alias};delete missing.operation_id;
  const before=structuredClone(missing);
  assert.throws(()=>readIdentity(missing),TypeError);
  assert.deepEqual(missing,before);
 }
 assert.throws(()=>readIdentity({...valid,operation_id:''}),TypeError);
});
test('NEG-ID-03 identical field names remain distinct at each request location',()=>{
 const digests=[];
 for(const location of ['path','query','header','cookie','body']){
  const value={field_ref:'sbf.field-ref/1',action:action(),location,pointer:'/id'};
  const wrapped=wrapLegacyIdentity(value);
  assert.deepEqual(readIdentity(wrapped).reference,value);
  digests.push(bindingDigest('field',value));
 }
 assert.equal(new Set(digests).size,5,'field binding digests must include request location');
});
test('NEG-ID-04 same operation label in distinct project contracts cannot collide',()=>{
 const a=action(),b=action(contract('b','223e4567-e89b-42d3-a456-426614174000'));
 assert.equal(a.operation_id,b.operation_id);
 assert.deepEqual(readIdentity(wrapLegacyIdentity(a)).reference,a);
 assert.deepEqual(readIdentity(wrapLegacyIdentity(b)).reference,b);
 assert.notEqual(bindingDigest('action',a),bindingDigest('action',b),'contract scope must contribute to action identity');
 assert.equal(bindingDigest('action',a),bindingDigest('action',structuredClone(a)));
});
test('NEG-ID-05 exact UTF-8 artifact identity never normalizes Unicode',()=>{
 for(const [a,b] of [['caf\u00e9','cafe\u0301'],['\uac00','\u1100\u1161']]){
  assert.equal(a.normalize('NFC'),b.normalize('NFC'));assert.notDeepEqual(Buffer.from(a),Buffer.from(b));
  assert.equal(sha256Bytes(a),createHash('sha256').update(Buffer.from(a)).digest('hex'));
  assert.equal(sha256Bytes(b),createHash('sha256').update(Buffer.from(b)).digest('hex'));
  assert.notEqual(sha256Bytes(a),sha256Bytes(b));
  const ref=createArtifactRef(a,{family:'http',version:'1'});
  assert.equal(artifactRefMatches(a,ref),true);assert.equal(artifactRefMatches(b,ref),false);
 }
});
