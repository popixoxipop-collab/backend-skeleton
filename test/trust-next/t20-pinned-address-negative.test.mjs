import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied, createEnforcementGate, verifyAuditLog } from '../../lib/trust-next/enforcement-gate.mjs';
import { rechain } from './enforcement-audit-forge.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

const policy={schema:PERMISSION_MANIFEST_SCHEMA,network:{mode:'allowlist',allow:[{host:'api.example.com',ports:[443]}]}};
const dns=(answers)=>createRecordingHost({dns:{'api.example.com':[answers]}});

test('T20 granted hostname returned by resolver is not a pinned address',async()=>{
  for(const answers of [['api.example.com'],['93.184.216.34','api.example.com']]) {
    const host=dns(answers);
    const gate=createEnforcementGate({manifest:policy,host});
    await assert.rejects(gate.connect('api.example.com',443),
      e=>e instanceof EnforcementDenied && e.reason==='RESOLVE_FAILED');
    assert.equal(host.calls.filter(c=>c.method==='connect').length,0);
    assert.deepEqual(gate.verifyAudit(),{ok:true,errors:[]});
  }
});
test('T20 valid numeric IP remains usable and pinned',async()=>{
  const host=dns(['93.184.216.34']);
  const gate=createEnforcementGate({manifest:policy,host});
  assert.equal((await gate.connect('api.example.com',443)).connected,true);
  assert.equal(gate.audit().find(x=>x.phase==='decision').target.address,'93.184.216.34');
  assert.equal(host.calls.filter(c=>c.method==='connect').length,1);
  assert.deepEqual(gate.verifyAudit(),{ok:true,errors:[]});
});
test('T20 shadow mode rejects a DNS answer that is another hostname',async()=>{
  const host=dns(['second.example.com']);
  const gate=createEnforcementGate({manifest:{schema:PERMISSION_MANIFEST_SCHEMA},host,mode:'shadow'});
  await assert.rejects(gate.connect('api.example.com',443),
    e=>e instanceof EnforcementDenied && e.reason==='RESOLVE_FAILED');
  assert.equal(host.calls.filter(c=>c.method==='connect').length,0);
  assert.deepEqual(gate.verifyAudit(),{ok:true,errors:[]});
});
test('T20 audit refuses forged impossible operation types and lengths after recomputing the hash chain',async()=>{
  const gate=createEnforcementGate({manifest:{schema:PERMISSION_MANIFEST_SCHEMA},host:createRecordingHost()});
  await assert.rejects(gate.invoke('chmod',{}),e=>e instanceof EnforcementDenied&&e.reason==='UNKNOWN_OPERATION');
  const record=gate.audit(), digest=gate.permissionDigest;
  assert.deepEqual(gate.verifyAudit(),{ok:true,errors:[]});
  for(const operation of [42,null,{},['chmod'],'X'.repeat(65)]) {
    const changed=rechain([{...record[0],operation}],digest);
    const verdict=verifyAuditLog(changed,{manifestDigest:digest});
    assert.equal(verdict.ok,false);
    assert.ok(verdict.errors.some(e=>e.code==='AUDIT_OPERATION_UNKNOWN'),JSON.stringify(verdict));
  }
  const capped=createEnforcementGate({manifest:{schema:PERMISSION_MANIFEST_SCHEMA},host:createRecordingHost()});
  await assert.rejects(capped.invoke('Z'.repeat(120),{}),e=>e instanceof EnforcementDenied);
  assert.equal(capped.audit()[0].operation.length,64);
  assert.deepEqual(capped.verifyAudit(),{ok:true,errors:[]});
});
