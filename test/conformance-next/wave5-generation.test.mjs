import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHandleCompositionHandoff} from '../../scanners/persistence-next/generation-handoff.mjs';

const input=type=>({
 http_provider_id:'java-spring',
 producer_revision:'a'.repeat(40),candidate_revision:'b'.repeat(40),
 profile_id:'java-spring+jpa-hibernate',
 execution_ref:'t10-live:fixture-snapshot',
 binding:{
  resource_id:'users',entity_id:'entity:jpa-hibernate:User:src',
  persistence_id:'jpa-hibernate',
  capabilities:{verified_read_by_primary_key:true,key_shape:'single',key_type:type,effective_key_type:type},
  verification:{provider:'verified',observed_provider:'postgres-introspection',
   observed_snapshot_ref:'sha256:'+'a'.repeat(64)},
 }
});

test('NEG-GEN-05 a UUID-only handle composition cannot silently accept bigint or unknown key codec',()=>{
 const approved=buildHandleCompositionHandoff(input('uuid'));
 assert.equal(approved.status,'ready');
 assert.deepEqual(approved.blockers,[]);
 assert.equal(approved.keyType,'uuid');
 for(const type of ['bigint','unknown','non-uuid']){
  const out=buildHandleCompositionHandoff(input(type));
  assert.equal(out.status,'blocked',type);
  assert.equal(out.keyType,type);
  assert.ok(out.blockers.some(x=>x.code==='unsupported-key-type'),type);
  assert.equal(out.combinationId,'java-spring+jpa-hibernate+'+type);
 }
});