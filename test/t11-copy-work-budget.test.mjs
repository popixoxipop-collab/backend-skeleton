import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../scanners/registry.mjs';
import { bridgeLegacyHttpWithObservation as bridge } from '../next/t11/observed-bridge-v1.mjs';
const adapter = ADAPTERS.find(a => a.id === 'python-fastapi');
function input(payload) { return {adapter,report:{schema:'sbf.scan-report/2',adapter:'python-fastapi',verdict:'green',confidence:'high',api_surface_source:'source',related_modules:[],files_read:[],path_prefix_signals:[],payload}}; }
test('aggregate work includes empty slots repeatedly copied through shared aliases',()=>{
  const inner=new Array(800), outer=new Array(300).fill(inner), value=input(outer);
  assert.throws(()=>bridge(value),/T11_DATA_INPUT_LIMIT/);
  assert.equal(value.report.payload,outer);assert.equal(outer[0],inner);assert.equal(outer[299],inner);assert.equal(0 in inner,false);
});
test('aggregate sparse budget also holds for distinct nested arrays',()=>{
  const value=input(Array.from({length:300},()=>new Array(800)));
  assert.throws(()=>bridge(value),/T11_DATA_INPUT_LIMIT/);
});
test('small shared sparse data retains its shape without granting authority',()=>{
  const inner=new Array(20), outer=new Array(20).fill(inner), value=input(outer), result=bridge(value);
  assert.equal(result.legacy_bridge.legacy_report.payload.length,20);
  assert.equal(result.legacy_bridge.legacy_report.payload[0].length,20);
  assert.equal(result.promotion_allowed,false);assert.equal(0 in inner,false);
});
test('many small empty containers remain valid data',()=>{
  const result=bridge(input(Array.from({length:1000},()=>[])));
  assert.equal(result.legacy_bridge.legacy_report.payload.length,1000);
});
