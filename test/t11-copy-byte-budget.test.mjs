import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../scanners/registry.mjs';
import { bridgeLegacyHttpWithObservation as bridge } from '../next/t11/observed-bridge-v1.mjs';
const adapter=ADAPTERS.find(a=>a.id==='python-fastapi');
function input(payload){return {adapter,report:{schema:'sbf.scan-report/2',adapter:'python-fastapi',verdict:'green',confidence:'high',api_surface_source:'source',related_modules:[],files_read:[],path_prefix_signals:[],payload}};}
const LIMIT=2*1024*1024;
for(const [name,payload] of [
 ['repeated ASCII',new Array(40).fill('a'.repeat(65536))],
 ['repeated UTF8',new Array(40).fill('\uAC00'.repeat(22000))],
 ['escaped controls',new Array(40).fill('\u0000'.repeat(10000))],
 ['property names',{['k'.repeat(LIMIT+1)]:1}],
 ['single large value','a'.repeat(LIMIT+1)],
 ['repeated property names',new Array(40).fill({['k'.repeat(65536)]:0})],
]){test(`aggregate output-byte budget rejects ${name}`,()=>{const value=input(payload);assert.throws(()=>bridge(value),/T11_DATA_BYTE_LIMIT/);assert.equal(value.report.payload,payload);});}
for(const value of ['plain','\u0000\b\n\r\t"\\','\uAC00\u00e9\uD83D\uDE00','\uD800','\uDC00']){
 test(`bounded string retains exact JSON semantics: ${JSON.stringify(value)}`,()=>{const payload=new Array(4).fill(value), r=bridge(input(payload));assert.deepEqual(r.legacy_bridge.legacy_report.payload,payload);assert.equal(r.promotion_allowed,false);});
}
test('a large but bounded ASCII payload is not rejected',()=>{const payload='a'.repeat(128*1024);assert.equal(bridge(input(payload)).legacy_bridge.legacy_report.payload,payload);});
