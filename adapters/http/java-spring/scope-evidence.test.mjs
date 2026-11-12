import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {COMMAND,RECEIPT,SOURCE_FILES,digests,problems,replay} from './scope-evidence.mjs';

test('Spring scope receipt replays a real zero-skip 14-case Node run',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(SOURCE_FILES.length>=50);
 const run=replay();
 assert.deepEqual(run.counts,{tests:14,pass:14,fail:0,skipped:0,cancelled:0,todo:0});
 assert.deepEqual(problems(r),[]);
});

test('source SHA mutations and absent pin sets invalidate the receipt',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='scanners/adapters/java-spring.mjs';
 assert.ok(problems(r,{...digests(),[p]:'f'.repeat(64)},false).some(x=>x.includes('source digest drift')));
 assert.ok(problems({...r,sources:{}},digests(),false).some(x=>x.includes('source path set')));
});

test('matching fake caller digests cannot forge immutable original Git blobs',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='test/fixtures/java-spring/build.gradle';
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

test('the authenticated replay command is immutable and fabricated commands are rejected',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.equal(Object.isFrozen(COMMAND),true);
 assert.throws(()=>COMMAND.splice(1),TypeError);
 const forged={...r,observed:{...r.observed,command:['node','-e','print fake TAP totals']}};
 assert.ok(problems(forged,undefined,false).some(x=>x.includes('replay mismatch')));
});

test('Spring analyzer, registry, prefix fixture and workflow truth remain pinned',()=>{
 const deps=['scanners/adapters/java-spring.mjs','scanners/adapters/_java-spring-analyzer.mjs',
  'scanners/registry.mjs','test/fixtures/java-spring/src/main/java/com/example/app/global/config/ApiPathConfig.java',
  'test/fixtures/java-spring/src/main/resources/application.yml','.github/workflows/ci.yml',
  'next/t00/baseline.lock.json','scripts/run-next-nested-tests.mjs'];
 for(const p of deps)assert.ok(SOURCE_FILES.includes(p),'missing dependency pin '+p);
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='scanners/adapters/_java-spring-analyzer.mjs';
 const tampered={...digests(),[p]:'0'.repeat(64)};
 assert.ok(problems(r,tampered,false).some(x=>x.includes('source digest drift '+p)));
 const forged={...r,sources:{...r.sources,[p]:'0'.repeat(64)}};
 assert.ok(problems(forged,tampered,true).some(x=>x.includes('original Git blob differs '+p)));
});
