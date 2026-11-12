import test from 'node:test';
import assert from 'node:assert/strict';
import {ADAPTERS} from '../scanners/registry.mjs';
import {bridgeLegacyHttpWithObservation as bridge} from '../next/t11/observed-bridge-v1.mjs';
const adapter=ADAPTERS.find(a=>a.id==='python-fastapi');
function source(extra){return {schema:'sbf.scan-report/2',adapter:'python-fastapi',verdict:'green',confidence:'high',api_surface_source:'source',files_read:[],path_prefix_signals:[],related_modules:[],extra};}
for(const visible of [false,true]){
 test(`repeated symbol-key scans consume the aggregate budget (visible=${visible})`,()=>{
  const shared=visible?{visible:'value'}:{};
  for(let i=0;i<800;i++)Object.defineProperty(shared,Symbol(i),{value:i});
  const report=source(Array(300).fill(shared));
  assert.throws(()=>bridge({adapter,report}),/T11_DATA_INPUT_LIMIT/);
  assert.equal(Reflect.ownKeys(shared).length,visible?801:800);
  assert.equal(report.extra[0],shared);
 });
}
test('bounded aliases preserve ordinary data while ignoring symbols',()=>{
 const shared={value:'kept'};for(let i=0;i<10;i++)shared[Symbol(i)]=i;
 const report=source(Array(5).fill(shared));const result=bridge({adapter,report});
 assert.deepEqual(result.legacy_bridge.legacy_report.extra,Array(5).fill({value:'kept'}));
 assert.equal(result.promotion_allowed,false);
});
test('ignored symbol accessor is never evaluated',()=>{
 let calls=0;const shared={value:1};Object.defineProperty(shared,Symbol('hook'),{get(){calls++;throw Error('symbol hook');}});
 const result=bridge({adapter,report:source([shared])});assert.equal(calls,0);
 assert.deepEqual(result.legacy_bridge.legacy_report.extra,[{value:1}]);
});
