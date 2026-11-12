import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {COMMAND,RECEIPT,SOURCE_FILES,digests,problems,replay} from './scope-evidence.mjs';

test('Gin scope receipt replays a real zero-skip 16-case Node run',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(SOURCE_FILES.length>=45);
 assert.deepEqual(replay().counts,{tests:16,pass:16,fail:0,skipped:0,cancelled:0,todo:0});
 assert.deepEqual(problems(r),[]);
});

test('source SHA mutations and absent pin sets invalidate the receipt',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='scanners/language/native-server/go.mjs';
 assert.ok(problems(r,{...digests(),[p]:'f'.repeat(64)},false).some(x=>x.includes('source digest drift')));
 assert.ok(problems({...r,sources:{}},digests(),false).some(x=>x.includes('source path set')));
});

test('matching fake caller digests cannot forge immutable upstream Git-source bytes',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='adapters/http/go-gin/fixtures/upstream/realtime-chat/main.go';
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

test('fabricated PASS, skip or replay command cannot substitute the real run',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.ok(problems({...r,observed:{...r.observed,counts:{...r.observed.counts,pass:15,skipped:1}}},undefined,false)
  .some(x=>x.includes('replay mismatch')));
 assert.equal(Object.isFrozen(COMMAND),true);
 assert.throws(()=>COMMAND.splice(1),TypeError);
 const forged={...r,observed:{...r.observed,command:['node','-e','print fake TAP totals']}};
 assert.ok(problems(forged,undefined,false).some(x=>x.includes('replay mismatch')));
});

test('Gin analyzer, Wave A leaf, baseline lock, nested runner and ownership truth stay pinned',()=>{
 const deps=['scanners/language/native-server/go.mjs','scanners/language/native-server/protocol.mjs',
  'adapters/http-wave-a/gin.mjs','adapters/http-wave-a/_shared.mjs',
  'adapters/http-wave-a/BASELINE.json','test/http-wave-a/native-server.test.mjs',
  'test/language-native-server/native-server.test.mjs','next/t00/baseline.lock.json',
  'next/t00/ownership-map.json','scripts/run-next-nested-tests.mjs'];
 for(const p of deps)assert.ok(SOURCE_FILES.includes(p),'missing dependency pin '+p);
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='adapters/http-wave-a/gin.mjs';
 const tampered={...digests(),[p]:'0'.repeat(64)};
 assert.ok(problems(r,tampered,false).some(x=>x.includes('source digest drift '+p)));
 const forged={...r,sources:{...r.sources,[p]:'0'.repeat(64)}};
 assert.ok(problems(forged,tampered,true).some(x=>x.includes('original Git blob differs '+p)));
});

test('receipt field sets reject injected authority and removed evidence keys',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 assert.deepEqual(problems({...r,approval:'forged'},undefined,false),['invalid receipt field set']);
 const {limits,...missing}=r;
 assert.deepEqual(problems(missing,undefined,false),['invalid receipt field set']);
});
