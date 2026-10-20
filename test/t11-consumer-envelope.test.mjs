import test from 'node:test';
import assert from 'node:assert/strict';
import {ADAPTERS} from '../scanners/registry.mjs';
import {consumeObservedLegacyReport} from '../next/t11/observed-report-cli-v1.mjs';
function input() {
  return {adapter: ADAPTERS.find(a=>a.id==='python-fastapi'), report:{
    schema:'sbf.scan-report/2', adapter:'python-fastapi', confidence:'high',
    verdict:'green', api_surface_source:'source', related_modules:[],
    files_read:[], path_prefix_signals:[]}};
}
for (const field of ['adapter','report','root']) {
  test(`consumer rejects envelope ${field} accessor before it runs`,()=>{
    const value=input();let calls=0;const previous=value[field];
    Object.defineProperty(value,field,{enumerable:true,get(){calls++;return previous;}});
    assert.throws(()=>consumeObservedLegacyReport(value),/ACCESSOR_UNSUPPORTED/);
    assert.equal(calls,0);
  });
}
test('consumer rejects proxy envelope with zero get traps',()=>{
  let calls=0;const value=new Proxy(input(),{get(target,key){calls++;return target[key];}});
  assert.throws(()=>consumeObservedLegacyReport(value),/PROXY_INPUT_UNSUPPORTED/);
  assert.equal(calls,0);
});
test('ordinary programmatic input remains unchanged and non-authorizing',()=>{
  const value=input();const before=structuredClone(value.report);
  const result=consumeObservedLegacyReport(value);
  assert.equal(result.observation_quality,'reported_fields_only');
  assert.equal(result.promotion_allowed,false);
  assert.equal(result.runtime_certified,false);
  assert.deepEqual(value.report,before);
});
