// T21-06: immutable-source, disposable shadow activation and rollback rehearsal.
// Never changes stable CLI, a running provider, live GC, or production release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { buildRegisteredProjectGraph } from '../../scanners/project-graph/registered.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { createCacheIndex } from '../../lib/artifact-store-next/cache-index.mjs';
import { executeT21ShadowProvider } from './t21-05-shadow-provider.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPE = 'next/t21/T21_06_SUPPORTED_SCOPE.json';
const CORE = [
  'next/t21/t21-06-release-rehearsal.mjs', 'next/t21/t21-06-release-rehearsal.test.mjs',
  'next/t21/T21_06_RELEASE_AND_ROLLBACK.md', SCOPE,
  'next/t21/t21-05-shadow-provider.mjs', 'next/t21/t21-05-installed-integration.mjs',
  'scanners/project-graph/registered.mjs', 'scanners/project-graph/shadow.mjs', 'scanners/registry.mjs',
  'lib/scan-scheduler-next/project-cache-runner.mjs', 'lib/scan-scheduler-next/cache-runtime.mjs',
  'lib/scan-scheduler-next/legacy-cache.mjs', 'lib/scan-scheduler-next/cache-key.mjs',
  'lib/artifact-store-next/store.mjs', 'lib/artifact-store-next/cache-index.mjs',
];
const FIX = Object.freeze({
  'java-spring': 'test/fixtures/java-spring',
  'javascript-express': 'test/fixtures/javascript-express/backend',
  'python-fastapi': 'test/fixtures/python-fastapi/backend',
});
const IDS = Object.keys(FIX).sort();
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const reject = (msg) => {throw new Error('T21_REHEARSAL_REJECTED: ' + msg);};
function git(repo,...args) {
  return execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:25000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();
}
function checkRepo(root) {
  if (git(root,'status','--porcelain')) reject('worktree must be clean');
  if (!/^(https:\/\/github\.com\/|git@github\.com:)popixoxipop-collab\/backend-skeleton(?:\.git)?$/.test(git(root,'remote','get-url','origin')))
    reject('repository authority mismatch');
}
function file(root,rel) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('\\') ||
      rel.split('/').some(x=>!x||x==='.'||x==='..')) reject('invalid relative source path');
  const abs=path.resolve(root,rel), delta=path.relative(root,abs);
  if (delta==='..'||delta.startsWith('..'+path.sep)||path.isAbsolute(delta)) reject('source escapes repo');
  const stat=fs.lstatSync(abs);
  if (!stat.isFile()||stat.isSymbolicLink()) reject('source must be a regular file: '+rel);
  return abs;
}
function outputPath(root,requested) {
  if(typeof requested!=='string'||!path.isAbsolute(requested))reject('absolute output required');
  const base=fs.realpathSync(root),parent=fs.realpathSync(path.dirname(path.resolve(requested)));
  const dest=path.join(parent,path.basename(path.resolve(requested)));
  const rel=path.relative(base,dest);
  if(rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)))reject('output overlaps repo');
  if(fs.existsSync(dest))reject('output exists; no overwrite');
  return dest;
}
function scope(root) {
  const p=JSON.parse(fs.readFileSync(file(root,SCOPE),'utf8'));
  if(p.schema!=='t21-06.supported-scope/1'||p.task!=='T21-06'||p.release_intent!=='shadow-rehearsal-only'||!equal(p.permitted_adapters,IDS)||
     !equal(p.supported_operations,['shadow_compare','shadow_disabled_fallback','disposable_cache_rollback','fail_closed_integrity','source_bound_replay'])||
     !equal(p.excluded_operations,['production_enable','stable_cli_cutover','external_beval_becoder_provider_cutover','live_gc_deletion','npm_publish','database_rollback','service_rollback'])||
     p.feature_switch_default!==false||p.authorization?.rehearsal!==true||p.authorization?.release!==false||p.authorization?.live_data!==false||p.authorization?.production_gc!==false||
     p.nonnegotiable_gates?.provider_schema_freeze!=='DRAFT'||p.nonnegotiable_gates?.collector_writer_exclusion!=='NOT_VERIFIED'||p.nonnegotiable_gates?.scheduler_cancellation!=='NOT_VERIFIED'||
     p.nonnegotiable_gates?.production_release!=='BLOCKED'||p.nonnegotiable_gates?.timing_slo!=='NOT_APPROVED'||
     p.nonnegotiable_gates?.signed_independent_attestation!=='MISSING')reject('scope cannot expand/release');
  return p;
}
function inventory(root) {
  const fixtures=git(root,'ls-files','-z','--',...Object.values(FIX)).split('\0').filter(Boolean);
  if(!fixtures.length)reject('fixture inventory empty');
  return [...new Set([...CORE,...fixtures])].sort().map(rel=>{
    const bytes=fs.readFileSync(file(root,rel));
    const blob=git(root,'rev-parse','HEAD:'+rel);
    if(!HEX40.test(blob)||git(root,'hash-object','--',rel)!==blob)reject('file changed from Git: '+rel);
    return {path:rel,bytes:bytes.length,sha256:sha(bytes),git_blob:blob};
  });
}

export function buildBundle({repoRoot=ROOT,previousCommit,outputDir}={}) {
  const root=fs.realpathSync(repoRoot);
  checkRepo(root);
  const policy=scope(root);
  if(!HEX40.test(previousCommit??''))reject('previous commit must be exact 40-hex Git SHA');
  const commit=git(root,'rev-parse','HEAD'), tree=git(root,'rev-parse','HEAD^{tree}');
  const previousTree=git(root,'rev-parse',previousCommit+'^{tree}');
  if(previousCommit===commit||!HEX40.test(tree)||!HEX40.test(previousTree))reject('invalid source identities');
  try{git(root,'merge-base','--is-ancestor',previousCommit,commit);}
  catch{reject('previous commit must be ancestor of candidate');}
  const manifest={
    schema:'t21-06.shadow-rehearsal-manifest/1',task:'T21-06',
    source:{commit,tree,previous_commit:previousCommit,previous_tree:previousTree},
    supported_scope:policy,files:inventory(root),
    phases:['direct_T02_baseline','cold_shadow','warm_shadow','direct_T02_rollback',
      'self_consistent_poison_rejected','direct_T02_recovery'],
    authority:{shadow_only:true,production_release_authorized:false,live_gc_authorized:false}
  };
  const dest=outputPath(root,outputDir);
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  fs.mkdirSync(dest,{mode:0o700});
  fs.writeFileSync(path.join(dest,'manifest.json'),bytes,{flag:'wx',mode:0o600});
  return {schema:'t21-06.bundle-built/1',manifest_sha256:sha(bytes),manifest_path:path.join(dest,'manifest.json'),
    source_commit:commit,source_tree:tree,previous_commit:previousCommit,files_pinned:manifest.files.length,
    release_authorized:false};
}
function verifiedManifest(root,bundle,expected) {
  if(!HEX64.test(expected??''))reject('externally supplied manifest SHA-256 required');
  const bytes=fs.readFileSync(path.join(bundle,'manifest.json'));
  if(sha(bytes)!==expected)reject('external digest mismatch');
  const m=JSON.parse(bytes.toString('utf8'));
  if(m.schema!=='t21-06.shadow-rehearsal-manifest/1'||m.task!=='T21-06'||
    m.authority?.shadow_only!==true||m.authority?.production_release_authorized!==false||
    m.authority?.live_gc_authorized!==false)reject('manifest authority mismatch');
  checkRepo(root);
  if(!equal(m.supported_scope,scope(root)))reject('supported scope drift');
  if(m.source?.commit!==git(root,'rev-parse','HEAD')||m.source?.tree!==git(root,'rev-parse','HEAD^{tree}'))
    reject('source commit/tree changed');
  try{git(root,'merge-base','--is-ancestor',m.source.previous_commit,m.source.commit);}
  catch{reject('previous ancestry changed');}
  if(m.source.previous_tree!==git(root,'rev-parse',m.source.previous_commit+'^{tree}'))
    reject('previous tree changed');
  if(!equal(m.files,inventory(root)))reject('source bytes/blob inventory changed');
  return m;
}
function checkShadow(result) {
  assert.equal(result.schema,'sbf.t21-shadow-provider-comparison/1');
  assert.equal(result.direct_provider.scans.length,3);
  assert.equal(result.shadow.metrics.passed,3);
  assert.equal(result.shadow.metrics.failed,0);
  assert.equal(result.shadow.metrics.blocked,0);
  assert.equal(result.shadow.verified_equal,true);
  assert.equal(result.shadow.release_authorized,false);
  assert.ok(result.shadow.observations.every(x=>x.semantic_equal));
}

async function runPhases(root,manifest,injectFailure) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'t21-06-shadow-rollback-'));
  const repoRoot=path.join(scratch,'sources'),cacheRoot=path.join(scratch,'cache');
  const facts={scenario:injectFailure?'injected_failure':'normal_and_poison',
    baseline_no_cache_side_effect:false,cold_miss:false,warm_hit:false,
    candidate_failure_observed:false,fail_closed_semantic_poison:false,
    previous_provider_byte_identical:false,successful_rollback:false,
    disposable_cache_removed:false,source_unchanged:false,production_modified:false};
  let failure=null,baseline=null,opts=null;
  try {
    for(const [id,rel] of Object.entries(FIX)) {
      const target=path.join(repoRoot,'services',id);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.cpSync(path.join(root,rel),target,{recursive:true});
    }
    const graph=buildRegisteredProjectGraph(repoRoot,{adapters:ADAPTERS});
    if(graph.registry_load_errors?.length||graph.schema!==manifest.supported_scope.project_graph_schema)
      reject('T02 graph load failure');
    const picked=graph.projects.filter(x=>x.facets?.http?.selected_adapter)
      .map(x=>x.facets.http.selected_adapter).sort();
    if(!equal(picked,IDS))reject('selected adapter cohort mismatch');
    const digests=Object.fromEntries(IDS.map(id=>[id,digestJson({
      scope:'T21-06.rehearsal/1',source_tree:manifest.source.tree,adapter:id
    })]));
    opts={repoRoot,cacheRoot,graph,adapters:ADAPTERS,implementationDigests:digests,
      rgAvailable:false,maxConcurrency:2,maxEstimatedBytesInFlight:96*1024*1024};
    baseline=await executeT21ShadowProvider({...opts,shadowEnabled:false});
    assert.equal(baseline.schema,'sbf.project-scan-shadow/draft-1');
    assert.equal(baseline.scans.length,3);
    facts.baseline_no_cache_side_effect=!fs.existsSync(cacheRoot);
    assert.equal(facts.baseline_no_cache_side_effect,true);
    const cold=await executeT21ShadowProvider({...opts,shadowEnabled:true});
    const warm=await executeT21ShadowProvider({...opts,shadowEnabled:true});
    checkShadow(cold);checkShadow(warm);
    assert.ok(equal(cold.direct_provider,baseline)&&equal(warm.direct_provider,baseline));
    facts.cold_miss=cold.shadow.observations.every(x=>x.cache_hit===false);
    facts.warm_hit=warm.shadow.observations.every(x=>x.cache_hit===true);
    assert.ok(facts.cold_miss&&facts.warm_hit);
    if(injectFailure)throw new Error('INJECTED_CANDIDATE_FAILURE_AFTER_SHADOW_ENABLE');

    const indexPath=path.join(cacheRoot,'.sbf/cache-next/index.json');
    const oldIndexHash=sha(fs.readFileSync(indexPath));
    const disabled=await executeT21ShadowProvider({...opts,shadowEnabled:false});
    assert.ok(equal(disabled,baseline)&&sha(fs.readFileSync(indexPath))===oldIndexHash);
    facts.previous_provider_byte_identical=true;

    // An internally valid content-addressed artifact with intentionally wrong semantics.
    const index=createCacheIndex(cacheRoot);
    const entry=index.list().find(x=>x.metadata?.adapter_id==='javascript-express');
    assert.ok(entry);
    const store=createArtifactStore(path.join(cacheRoot,'.sbf/cache-next/artifacts'));
    const original=JSON.parse(store.read(entry.artifact).toString('utf8'));
    assert.equal(original.schema,'sbf.scan-report/2');
    const poison={...original,t21_rehearsal_wrong_semantics:true};
    const poisonRef=store.put(Buffer.from(JSON.stringify(poison)));
    index.set(entry.cache_key,poisonRef,{dependencies:entry.dependencies,metadata:entry.metadata});
    assert.ok(equal(JSON.parse(store.read(poisonRef).toString('utf8')),poison));
    try {
      await executeT21ShadowProvider({...opts,shadowEnabled:true});
      reject('self-consistent semantic poison accepted');
    } catch(error) {
      if(error.code!=='T21_SHADOW_SEMANTIC_MISMATCH')throw error;
      facts.fail_closed_semantic_poison=true;
    }
    facts.candidate_failure_observed=true;
  } catch(error) {
    failure=error;
    facts.candidate_failure_observed=true;
  } finally {
    if(baseline&&opts){
      try {
        const rollback=await executeT21ShadowProvider({...opts,shadowEnabled:false});
        facts.successful_rollback=equal(rollback,baseline);
        facts.previous_provider_byte_identical=facts.successful_rollback;
      } catch(error){ facts.rollback_error=String(error); }
    }
    fs.rmSync(cacheRoot,{recursive:true,force:true});
    facts.disposable_cache_removed=!fs.existsSync(cacheRoot);
    fs.rmSync(scratch,{recursive:true,force:true});
    facts.source_unchanged=git(root,'status','--porcelain')==='';
  }
  if(!facts.successful_rollback||!facts.disposable_cache_removed||!facts.source_unchanged)
    reject('rollback did not restore direct-provider identity');
  if(!injectFailure&&(failure||!facts.fail_closed_semantic_poison||!facts.cold_miss||!facts.warm_hit))
    reject('normal replay failed: '+(failure?.message??'missing checks'));
  if(injectFailure&&(!failure||failure.message!=='INJECTED_CANDIDATE_FAILURE_AFTER_SHADOW_ENABLE'))
    reject('forced failure not faithfully reproduced');
  return {status:injectFailure?'FAILED_EXPECTED_WITH_ROLLBACK':'PASS_SHADOW_ONLY',
    failure_reason:failure?.message??null,facts};
}

export async function replayBundle({repoRoot=ROOT,bundleDir,manifestSha256,outputDir,injectFailure=false}={}) {
  const root=fs.realpathSync(repoRoot);
  if(typeof bundleDir!=='string'||!path.isAbsolute(bundleDir))reject('bundle must be absolute');
  const manifest=verifiedManifest(root,bundleDir,manifestSha256);
  const dest=outputPath(root,outputDir);
  fs.mkdirSync(dest,{mode:0o700});
  const phases=await runPhases(root,manifest,injectFailure);
  const receipt={
    schema:'t21-06.shadow-release-rehearsal-receipt/1',task:'T21-06',
    manifest_sha256:manifestSha256,source_commit:manifest.source.commit,source_tree:manifest.source.tree,
    previous_commit:manifest.source.previous_commit,supported_adapters:IDS,
    status:phases.status,checks:phases.facts,failure_reason:phases.failure_reason,
    authorization:{production_release:false,live_gc:false,npm_publish:false,external_provider_cutover:false},
    promotion_gate:{status:'BLOCKED',reasons:Object.entries(manifest.supported_scope.nonnegotiable_gates)
      .map(([gate,state])=>({gate,state}))},
    rollback_scope:manifest.supported_scope.rollback_semantics,
  };
  const out=path.join(dest,'receipt.json');
  fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return {receipt,receipt_path:out,receipt_sha256:sha(fs.readFileSync(out))};
}
function params(args,required,allowed) {
  const found={};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(!allowed.includes(key)||Object.hasOwn(found,key))reject('invalid or duplicate flag: '+key);
    if(key==='--inject-failure'){found[key]=true;continue;}
    const value=args[++i];
    if(typeof value!=='string'||value.startsWith('--'))reject('missing value: '+key);
    found[key]=value;
  }
  for(const key of required)if(!Object.hasOwn(found,key))reject('required flag missing: '+key);
  return found;
}
async function main(argv) {
  const [mode,...args]=argv;
  let outcome;
  if(mode==='build'){
    const a=params(args,['--repo','--previous','--output'],['--repo','--previous','--output']);
    outcome=buildBundle({repoRoot:a['--repo'],previousCommit:a['--previous'],outputDir:a['--output']});
  }else if(mode==='replay'){
    const a=params(args,['--repo','--bundle','--manifest-sha256','--output'],
      ['--repo','--bundle','--manifest-sha256','--output','--inject-failure']);
    outcome=await replayBundle({repoRoot:a['--repo'],bundleDir:a['--bundle'],
      manifestSha256:a['--manifest-sha256'],outputDir:a['--output'],injectFailure:!!a['--inject-failure']});
    if(outcome.receipt.status!=='PASS_SHADOW_ONLY')process.exitCode=2;
  }else reject('usage: build or replay');
  console.log(JSON.stringify(outcome,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).catch(error=>{
    console.error(error?.stack??String(error));process.exitCode=2;
  });
}
