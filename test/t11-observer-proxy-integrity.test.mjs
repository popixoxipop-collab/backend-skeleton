import test from 'node:test';
import assert from 'node:assert/strict';
import { observeLegacyScanReport as observe } from '../next/t11/report-observation-v1.mjs';
function report() { return {schema:'sbf.scan-report/2',adapter:'python-fastapi',verdict:'green',confidence:'high',api_surface_source:'source',files_read:[],path_prefix_signals:[],related_modules:[{module:'app',controllers:[],entities:[],enums:[],dtos:[]}]}; }
for (const location of ['report','related_modules','module','files_read','path_prefix_signals','verdict','controllers','entities','enums','dtos']) {
  test(`direct observer rejects Proxy ${location} before running traps`, () => {
    let calls=0; const wrap = value => new Proxy(value,{get(t,k){calls++;return t[k];},ownKeys(t){calls++;return Reflect.ownKeys(t);},getOwnPropertyDescriptor(t,k){calls++;return Object.getOwnPropertyDescriptor(t,k);},getPrototypeOf(t){calls++;return Object.getPrototypeOf(t);}});
    let value=report();
    if(location==='report')value=wrap(value);
    else if(location==='module')value.related_modules[0]=wrap(value.related_modules[0]);
    else if(['controllers','entities','enums','dtos'].includes(location))value.related_modules[0][location]=wrap([]);
    else value[location]=wrap(location==='verdict'?{}:value[location]);
    assert.throws(()=>observe(value),/T11_OBSERVATION_PROXY_UNSUPPORTED/);
    assert.equal(calls,0);
  });
}
test('revoked report Proxy gets an explicit rejection',()=>{const {proxy,revoke}=Proxy.revocable(report(),{});revoke();assert.throws(()=>observe(proxy),/T11_OBSERVATION_PROXY_UNSUPPORTED/);});
test('plain reports remain deterministic non-promoting evidence',()=>{const input=report(),before=structuredClone(input);assert.deepEqual(observe(input),observe(before));assert.deepEqual(input,before);assert.equal(observe(input).quality,'reported_fields_only');assert.equal(observe(input).promotionAllowed,false);});
