import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReplayBundle,replayBundle,sha256} from './package-replay.mjs';
const base=path.resolve(process.env.T10_REPLAY_BUNDLE??'');
const output=path.resolve(process.env.T10_TEST_OUTPUT??'');
assert.ok(process.env.T10_REPLAY_BUNDLE && process.env.T10_TEST_OUTPUT);
fs.mkdirSync(output,{mode:0o700});
const pin=fs.readFileSync(path.join(base,'manifest.sha256'),'utf8').trim();
// This test driver uses the retained build pin. Deployment/replay CLI requires caller-supplied external pin.
const copy=name=>{const d=path.join(output,name);fs.cpSync(base,d,{recursive:true});return d;};
function edit(d,fn){const p=path.join(d,'manifest.json');const m=JSON.parse(fs.readFileSync(p));fn(m);fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');return sha256(fs.readFileSync(p));}
function run(d,pin,name,fault=null){return replayBundle({directory:d,expectedManifestSha256:pin,output:path.join(output,name),fault});}
test('true immutable historical revision and candidate package have 416/418 inventories',()=>{const {manifest:m}=verifyReplayBundle(base,pin);assert.equal(m.packages.previous.revision,'0ed446344c36ec500d54a59c41ecd8ca72cfc842');assert.equal(m.packages.candidate.revision,'9117a6f3f5dd03fdbb5dbd6221f5315971e66af7');assert.equal(m.packages.previous.consumer,'absent');assert.equal(m.packages.candidate.consumer,'present');assert.notEqual(m.packages.previous.sha256,m.packages.candidate.sha256);assert.match(m.packages.candidate.sha256,/^[0-9a-f]{64}$/);assert.equal(m.packages.previous.inventory.length,416);assert.equal(m.packages.candidate.inventory.length,418);});
test('two real offline installs/reinstalls restore all paths bytes and modes',()=>{const a=run(base,pin,'normal-one');const b=run(base,pin,'normal-two');for(const r of[a,b]){assert.equal(r.status,'pass',JSON.stringify(r.failures));assert.equal(r.rollback_restored,true);assert.deepEqual(r.stages.map(s=>s.file_count),[416,418,416]);assert.equal(r.stages[0].inventory_sha256,r.stages[2].inventory_sha256);assert.equal(r.stages[1].probe.checks.filter(s=>s.startsWith('installed-eight-mode')).length,8);for(const k of['release_authorized','runtime_certified','publication_performed'])assert.equal(r[k],false);}assert.deepEqual(a.stages,b.stages);},{timeout:120000});
test('actual candidate probe SIGTERM restores baseline and stays failure',()=>{const r=run(base,pin,'interruption','candidate-probe-sigterm');assert.equal(r.status,'fail');assert.equal(r.rollback_restored,true);assert.deepEqual(r.stages.map(s=>s.stage),['baseline','rollback']);assert.equal(r.stages[0].inventory_sha256,r.stages[1].inventory_sha256);assert.equal(r.commands.filter(c=>c.signal==='SIGTERM').length,1);assert.match(r.commands.find(c=>c.signal==='SIGTERM').command[1],/installed-persistence-probe/);},{timeout:90000});
test('no external digest is rejected',()=>assert.throws(()=>verifyReplayBundle(base),/independent expected/));
test('metadata and bundled digest changes cannot replace external pin',()=>{const d=copy('metadata');edit(d,m=>m.packages.candidate.revision='a'.repeat(40));fs.writeFileSync(path.join(d,'manifest.sha256'),sha256(fs.readFileSync(path.join(d,'manifest.json'))));assert.throws(()=>verifyReplayBundle(d,pin),/manifest SHA/);});
for(const slot of ['previous','candidate']) test('corrupt '+slot+' archive rejected before install',()=>{const d=copy('archive-'+slot);fs.appendFileSync(path.join(d,slot+'.tgz'),'bad');assert.throws(()=>run(d,pin,'forbidden-'+slot),/tarball mismatch/);assert.equal(fs.existsSync(path.join(output,'forbidden-'+slot)),false);});
for(const p of ['../escape','/absolute','a\\b','a//b','C:escape']) test('unsafe inventory path '+p,()=>{const d=copy('path-'+sha256(p).slice(0,10));const h=edit(d,m=>m.packages.candidate.inventory[0].path=p);assert.throws(()=>verifyReplayBundle(d,h),/invalid package member/);});
test('duplicate inventory rejected',()=>{const d=copy('duplicate');const h=edit(d,m=>m.packages.candidate.inventory.push(m.packages.candidate.inventory[0]));assert.throws(()=>verifyReplayBundle(d,h),/invalid package member/);});
test('invalid mode rejected',()=>{const d=copy('invalid-mode');const h=edit(d,m=>m.packages.candidate.inventory[0].mode=0o777);assert.throws(()=>verifyReplayBundle(d,h),/invalid package member/);});
for(const kind of ['sha256','installed_mode','extra']) test('real installed candidate detects '+kind+' inventory mismatch then restores baseline',()=>{const d=copy('installed-'+kind);const h=edit(d,m=>{if(kind==='extra')m.packages.candidate.inventory.push({path:'nonexistent.txt',size:0,mode:420,installed_mode:420,sha256:sha256('')});else m.packages.candidate.inventory[0][kind]=kind==='sha256'?'0'.repeat(64):493;});const r=run(d,h,'rejected-'+kind);assert.equal(r.status,'fail');assert.equal(r.rollback_restored,true);assert.match(r.failures.join(),/installed package differs/);},{timeout:90000});
for(const key of ['release_authorized','runtime_certified','publication_performed'])test('cannot enable '+key,()=>{const d=copy(key);const h=edit(d,m=>m[key]=true);assert.throws(()=>verifyReplayBundle(d,h),/cannot grant authority/);});
test('substituted harness rejected',()=>{const d=copy('harness');const h=edit(d,m=>m.harness.probe_sha256='0'.repeat(64));assert.throws(()=>verifyReplayBundle(d,h),/harness identity/);});
test('existing output protected',()=>assert.throws(()=>run(base,pin,'normal-one'),/EEXIST/));
test('symlink archive rejected',()=>{const d=copy('symlink');fs.unlinkSync(path.join(d,'candidate.tgz'));fs.symlinkSync(path.join(base,'candidate.tgz'),path.join(d,'candidate.tgz'));assert.throws(()=>verifyReplayBundle(d,pin),/bounded regular file/);});
test('unknown fault mode rejected',()=>assert.throws(()=>run(base,pin,'invalid-fault','unknown'),/unknown fault mode/));
