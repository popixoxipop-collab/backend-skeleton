import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReplayBundle, verifyReplayBundle, replayBundle, sha256 } from '../next/t22/release-replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch, repo, previous, candidate, good;
function git(args, cwd=repo) {
  const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
    env:{...process.env,GIT_AUTHOR_NAME:'T22 fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'T22 fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',
      GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  assert.equal(result.status,0,result.stderr); return result.stdout.trim();
}
function copyBundle(name) {
  const destination=path.join(scratch,name); fs.cpSync(path.join(scratch,'bundle'),destination,{recursive:true});
  return destination;
}
function editManifest(directory, update) {
  const file=path.join(directory,'manifest.json'), value=JSON.parse(fs.readFileSync(file,'utf8'));
  update(value); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
  return sha256(fs.readFileSync(file));
}
before(()=>{
  scratch=fs.mkdtempSync(path.join(os.tmpdir(),'t22-replay-tests-'));repo=path.join(scratch,'source');fs.mkdirSync(repo);
  // Export immutable tracked sources, not sibling tests' temporary checkout files.
  const head=git(['rev-parse','HEAD'],ROOT), archive=path.join(scratch,'source.tar');
  git(['archive','--format=tar','--output',archive,head],ROOT);
  const extract=spawnSync('tar',['-xf',archive,'-C',repo],{encoding:'utf8',timeout:30000});
  assert.equal(extract.status,0,extract.stderr);
  const packagePath=path.join(repo,'package.json'), original=fs.readFileSync(packagePath,'utf8');
  const baseline=JSON.parse(original);baseline.files=baseline.files.filter(name=>name!=='sdk/');
  assert.ok(!baseline.files.includes('sdk/'));
  fs.writeFileSync(packagePath,JSON.stringify(baseline,null,2)+'\n');
  git(['init','-q']);git(['add','.']);git(['commit','-qm','fixture: package before SDK distribution']);
  previous=git(['rev-parse','HEAD']);
  fs.writeFileSync(packagePath,original);
  const shipping=JSON.parse(original);assert.ok(shipping.files.includes('sdk/'));
  git(['add','package.json']);git(['commit','-qm','fixture: package with current first-party SDK']);
  candidate=git(['rev-parse','HEAD']);
  good=buildReplayBundle({repoRoot:repo,previous,candidate,output:path.join(scratch,'bundle')});
},{timeout:120000});
after(()=>{if(scratch)fs.rmSync(scratch,{recursive:true,force:true});});

test('T22B01 real bundle retains distinct previous/candidate archives and exact Git identities',()=>{
  const v=verifyReplayBundle(path.join(scratch,'bundle'),good.manifestSha256);
  assert.equal(v.manifest.packages.previous.revision,previous);
  assert.equal(v.manifest.packages.candidate.revision,candidate);
  assert.equal(v.manifest.packages.previous.sdk,'absent');
  assert.equal(v.manifest.packages.candidate.sdk,'present');
  assert.notEqual(v.manifest.packages.previous.sha256,v.manifest.packages.candidate.sha256);
  assert.equal(v.manifest.release_authorized,false);
});
test('T22B02 real install -> SDK consumer -> rollback restores every package byte',()=>{
  const r=replayBundle({directory:path.join(scratch,'bundle'),expectedManifestSha256:good.manifestSha256,
    output:path.join(scratch,'run-one')});
  assert.equal(r.status,'pass',JSON.stringify(r.failures));assert.equal(r.rollback_restored,true);
  assert.deepEqual(r.stages.map(s=>s.stage),['baseline','candidate','rollback']);
  assert.deepEqual(r.stages.map(s=>s.probe.sdk),['absent','present','absent']);
  assert.equal(r.stages[0].inventory_sha256,r.stages[2].inventory_sha256);
  assert.equal(r.release_authorized,false);assert.equal(r.runtime_certified,false);
  assert.equal(r.commands.length,6);
  for(const command of r.commands) {
    assert.equal(command.exit_code,0);assert.equal(command.signal,null);assert.equal(command.error,null);
    for(const stream of ['stdout','stderr'])
      assert.equal(sha256(fs.readFileSync(path.join(scratch,'run-one',command[stream].file))),command[stream].sha256);
  }
},{timeout:120000});
test('T22B03 a second replay uses the retained archives and reproduces the package restoration',()=>{
  const r=replayBundle({directory:path.join(scratch,'bundle'),expectedManifestSha256:good.manifestSha256,
    output:path.join(scratch,'run-two')});
  const prior=JSON.parse(fs.readFileSync(path.join(scratch,'run-one/receipt.json'),'utf8'));
  assert.equal(r.status,'pass',JSON.stringify(r.failures));assert.deepEqual(r.stages,prior.stages);
},{timeout:120000});
test('T22B04 missing external pin is rejected',()=>{
  assert.throws(()=>verifyReplayBundle(path.join(scratch,'bundle')),/independent expected/);
});
test('T22B05 changing and rehashing bundle metadata cannot defeat the external pin',()=>{
  const d=copyBundle('changed-manifest');editManifest(d,m=>{m.packages.candidate.revision='a'.repeat(40);});
  fs.writeFileSync(path.join(d,'manifest.sha256'),sha256(fs.readFileSync(path.join(d,'manifest.json')))+'\n');
  assert.throws(()=>verifyReplayBundle(d,good.manifestSha256),/manifest SHA/);
});
for (const slot of ['previous','candidate']) {
  test(`T22B06 altered ${slot} tarball rejected before any installation`,()=>{
    const d=copyBundle('corrupt-'+slot);fs.appendFileSync(path.join(d,slot+'.tgz'),'corrupt');
    const output=path.join(scratch,'must-not-create-'+slot);
    assert.throws(()=>replayBundle({directory:d,expectedManifestSha256:good.manifestSha256,output}),/tarball mismatch/);
    assert.equal(fs.existsSync(output),false);
  });
}
test('T22B07 manifest cannot enable deployment authority even with a new external digest',()=>{
  const d=copyBundle('authority');const hash=editManifest(d,m=>{m.release_authorized=true;});
  assert.throws(()=>verifyReplayBundle(d,hash),/cannot grant authority/);
});
for (const name of ['../escape','/absolute','a\\b','sdk//entry','C:escape']) {
  test(`T22B08 unsafe inventory path rejected: ${name}`,()=>{
    const d=copyBundle('path-'+sha256(Buffer.from(name)).slice(0,8));
    const hash=editManifest(d,m=>{m.packages.candidate.inventory[0].path=name;});
    assert.throws(()=>verifyReplayBundle(d,hash),/invalid package member/);
  });
}
test('T22B09 duplicate package member rejected',()=>{
  const d=copyBundle('duplicate');const hash=editManifest(d,m=>{
    m.packages.candidate.inventory.push(m.packages.candidate.inventory[0]);});
  assert.throws(()=>verifyReplayBundle(d,hash),/invalid package member/);
});
test('T22B10 replay does not execute a substituted harness',()=>{
  const d=copyBundle('harness');const hash=editManifest(d,m=>{m.harness.probe_sha256='0'.repeat(64);});
  assert.throws(()=>verifyReplayBundle(d,hash),/harness identity/);
});
test('T22B11 existing output receipts are never replaced',()=>{
  assert.throws(()=>replayBundle({directory:path.join(scratch,'bundle'),expectedManifestSha256:good.manifestSha256,
    output:path.join(scratch,'run-one')}),/EEXIST/);
});
test('T22B12 rejected candidate probe still performs real baseline rollback and preserves failure',()=>{
  fs.appendFileSync(path.join(repo,'sdk/next/index.mjs'),'\nthrow new Error("T22 controlled candidate failure");\n');
  git(['add','sdk/next/index.mjs']);git(['commit','-qm','fixture: installed candidate cannot load']);
  const broken=git(['rev-parse','HEAD']);
  const bundle=buildReplayBundle({repoRoot:repo,previous,candidate:broken,output:path.join(scratch,'broken-bundle')});
  const r=replayBundle({directory:path.join(scratch,'broken-bundle'),expectedManifestSha256:bundle.manifestSha256,
    output:path.join(scratch,'failed-run')});
  assert.equal(r.status,'fail');assert.equal(r.rollback_restored,true);
  assert.equal(r.baseline_ready,true);assert.equal(r.failures.length,1);
  assert.deepEqual(r.stages.map(s=>s.stage),['baseline','rollback']);
  assert.equal(r.stages[0].inventory_sha256,r.stages[1].inventory_sha256);
  assert.equal(r.commands.filter(c=>c.exit_code!==0).length,1);
  assert.equal(r.release_authorized,false);
},{timeout:120000});
