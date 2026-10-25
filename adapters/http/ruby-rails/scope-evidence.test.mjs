import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RECEIPT,SOURCE_FILES,digests,problems,replay} from './scope-evidence.mjs';

test('Rails scope receipt replays a real zero-skip 14-case Node run',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(SOURCE_FILES.length>=25);
 const run=replay();
 assert.deepEqual(run.counts,{tests:14,pass:14,fail:0,skipped:0,cancelled:0,todo:0});
 assert.deepEqual(problems(r),[]);
});

test('source SHA mutations and absent pin sets invalidate the receipt',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='scanners/adapters/ruby-rails.mjs';
 assert.ok(problems(r,{...digests(),[p]:'f'.repeat(64)},false).some(x=>x.includes('source digest drift')));
 assert.ok(problems({...r,sources:{}},digests(),false).some(x=>x.includes('source path set')));
});

test('matching fake caller digests cannot forge immutable original Git blobs',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='test/fixtures/ruby-rails/backend/config/routes.rb';
 const forged={...r,sources:{...r.sources,[p]:'0'.repeat(64)}};
 assert.equal(problems(forged,{...digests(),[p]:'0'.repeat(64)},false).length,0);
 assert.ok(problems(forged,{...digests(),[p]:'0'.repeat(64)},true)
  .some(x=>x.includes('original Git blob differs')));
});

test('source revision, runtime authority and fake MET are not accepted',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(problems({...r,source_commit:'0'.repeat(40)}).length);
 for(const [name,value] of [['MET',1],['release',true],['runtime_certified',true],
    ['external_runtime_equal',true],['signed_attestation',true]]){
  assert.ok(problems({...r,assertions:{...r.assertions,[name]:value}},undefined,false)
   .some(x=>x.includes('false authority')));
 }
});

test('recorded fabricated PASS or skipped counts cannot substitute real replay',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(problems({...r,observed:{...r.observed,counts:{...r.observed.counts,pass:13,skipped:1}}},undefined,false)
  .some(x=>x.includes('replay mismatch')));
});
