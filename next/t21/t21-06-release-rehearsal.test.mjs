import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBundle, replayBundle } from './t21-06-release-rehearsal.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PREVIOUS='924f58524652260ed06162f3aef11a490a53966c';
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',['-C',ROOT,...args],{encoding:'utf8',timeout:15000}).trim();
function fresh() {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t21-06-suite-'));
  return {tmp,bundle:path.join(tmp,'bundle'),normal:path.join(tmp,'normal'),fault:path.join(tmp,'fault'),
    cleanup:()=>fs.rmSync(tmp,{force:true,recursive:true})};
}
function plan(f) {return buildBundle({repoRoot:ROOT,previousCommit:PREVIOUS,outputDir:f.bundle});}

test('T21-06 source-locked manifest pins HEAD/tree and records shadow-only policy',()=>{
  const f=fresh();
  try{
    const result=plan(f);
    assert.equal(result.source_commit,git('rev-parse','HEAD'));
    assert.equal(result.source_tree,git('rev-parse','HEAD^{tree}'));
    assert.equal(result.previous_commit,PREVIOUS);
    assert.match(result.manifest_sha256,/^[a-f0-9]{64}$/);
    const bytes=fs.readFileSync(result.manifest_path);
    assert.equal(result.manifest_sha256,sha(bytes));
    const m=JSON.parse(bytes);
    assert.equal(m.supported_scope.authorization.release,false);
    assert.equal(m.supported_scope.nonnegotiable_gates.production_release,'BLOCKED');
    assert.deepEqual(m.supported_scope.permitted_adapters,['java-spring','javascript-express','python-fastapi']);
    assert.ok(m.files.length>=12);
    assert.equal(m.files.some(x=>x.path==='next/t21/t21-06-release-rehearsal.mjs'),true);
    assert.equal(result.release_authorized,false);
  } finally {f.cleanup();}
});

test('T21-06 normal OFF->shadow MISS/HIT->OFF, poison refuses, direct provider recovery',async()=>{
  const f=fresh();
  try{
    const p=plan(f);
    const r=await replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:p.manifest_sha256,outputDir:f.normal});
    assert.equal(r.receipt.status,'PASS_SHADOW_ONLY');
    assert.equal(r.receipt.checks.baseline_no_cache_side_effect,true);
    assert.equal(r.receipt.checks.cold_miss,true);
    assert.equal(r.receipt.checks.warm_hit,true);
    assert.equal(r.receipt.checks.fail_closed_semantic_poison,true);
    assert.equal(r.receipt.checks.successful_rollback,true);
    assert.equal(r.receipt.checks.previous_provider_byte_identical,true);
    assert.equal(r.receipt.checks.disposable_cache_removed,true);
    assert.equal(r.receipt.checks.source_unchanged,true);
    assert.equal(r.receipt.authorization.production_release,false);
    assert.equal(r.receipt.promotion_gate.status,'BLOCKED');
    assert.equal(sha(fs.readFileSync(r.receipt_path)),r.receipt_sha256);
  } finally {f.cleanup();}
});

test('T21-06 deliberately failed candidate stays FAILED while its direct-provider rollback succeeds',async()=>{
  const f=fresh();
  try{
    const p=plan(f);
    const result=await replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:p.manifest_sha256,
      outputDir:f.fault,injectFailure:true});
    assert.equal(result.receipt.status,'FAILED_EXPECTED_WITH_ROLLBACK');
    assert.equal(result.receipt.failure_reason,'INJECTED_CANDIDATE_FAILURE_AFTER_SHADOW_ENABLE');
    assert.equal(result.receipt.checks.successful_rollback,true);
    assert.equal(result.receipt.checks.previous_provider_byte_identical,true);
    assert.equal(result.receipt.checks.disposable_cache_removed,true);
    assert.equal(result.receipt.promotion_gate.status,'BLOCKED');
    assert.equal(result.receipt.authorization.production_release,false);
  } finally {f.cleanup();}
});

test('T21-06 refuses absent/wrong manifest digest BEFORE creating an output directory',async()=>{
  const f=fresh();
  try{
    const p=plan(f);
    await assert.rejects(replayBundle({repoRoot:ROOT,bundleDir:f.bundle,outputDir:f.normal}),
      /externally supplied manifest/);
    await assert.rejects(replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:'0'.repeat(64),
      outputDir:f.normal}),/external digest mismatch/);
    assert.equal(fs.existsSync(f.normal),false);
    assert.match(p.manifest_sha256,/^[a-f0-9]{64}$/);
  }finally{f.cleanup();}
});

test('T21-06 rejects rehashed forged manifest file inventory and authority field',async()=>{
  const f=fresh();
  try{
    plan(f);
    const manifestPath=path.join(f.bundle,'manifest.json');
    const before=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const wrong=structuredClone(before);
    wrong.files[0].sha256='0'.repeat(64);
    const wrongBytes=Buffer.from(JSON.stringify(wrong,null,2)+'\n');
    fs.writeFileSync(manifestPath,wrongBytes);
    await assert.rejects(replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:sha(wrongBytes),
      outputDir:f.normal}),/source bytes\/blob inventory changed/);
    assert.equal(fs.existsSync(f.normal),false);
    const forbidden=structuredClone(before);
    forbidden.authority.production_release_authorized=true;
    const forbiddenBytes=Buffer.from(JSON.stringify(forbidden,null,2)+'\n');
    fs.writeFileSync(manifestPath,forbiddenBytes);
    await assert.rejects(replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:sha(forbiddenBytes),
      outputDir:f.normal}),/manifest authority mismatch/);
    assert.equal(fs.existsSync(f.normal),false);
    const expanded=structuredClone(before);
    expanded.supported_scope.permitted_adapters.push('generic-grep');
    const expandedBytes=Buffer.from(JSON.stringify(expanded,null,2)+'\n');
    fs.writeFileSync(manifestPath,expandedBytes);
    await assert.rejects(replayBundle({repoRoot:ROOT,bundleDir:f.bundle,manifestSha256:sha(expandedBytes),
      outputDir:f.normal}),/supported scope drift/);
    assert.equal(fs.existsSync(f.normal),false);
  }finally{f.cleanup();}
});

test('T21-06 refuses unrelated previous commit and output under repository',()=>{
  const f=fresh();
  try{
    assert.throws(()=>buildBundle({repoRoot:ROOT,previousCommit:'0'.repeat(40),outputDir:f.bundle}));
    assert.equal(fs.existsSync(f.bundle),false);
    assert.throws(()=>buildBundle({repoRoot:ROOT,previousCommit:PREVIOUS,
      outputDir:path.join(ROOT,'next/t21/internal-output-do-not-create')}),/output overlaps repo/);
    assert.equal(fs.existsSync(path.join(ROOT,'next/t21/internal-output-do-not-create')),false);
  }finally{f.cleanup();}
});
