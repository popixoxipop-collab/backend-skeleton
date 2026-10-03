import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveSourceCommit, runBoundedCommand, runProductMutationCampaign, validateProductMutationCatalog } from './product-mutation-runner.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..','..');
const CATALOG=JSON.parse(fs.readFileSync(path.join(HERE,'product-mutations.json'),'utf8'));

function processIsRunningNonZombie(pid) {
  try { process.kill(pid,0); } catch (err) {
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
  if (process.platform === 'linux') {
    try {
      const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
      const close=stat.lastIndexOf(')');
      const state=close >= 0 ? stat.slice(close + 2).split(' ')[0] : null;
      if (state === 'Z') return false;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  }
  return true;
}

function initFixtureRepo(root) {
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'t19-fixture',version:'1.0.0',private:true})+'\n');
 fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({name:'t19-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'t19-fixture',version:'1.0.0'}}},null,2)+'\n');
 spawnSync('git',['init','-q'],{cwd:root});
 spawnSync('git',['add','-A'],{cwd:root});
 const commit=spawnSync('git',['-c','user.name=T19','-c','user.email=t19@example.invalid','commit','-q','-m','baseline'],{cwd:root,encoding:'utf8'});
 assert.equal(commit.status,0,commit.stderr);
 return spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
}

test('product mutation catalog is safe and links every mutant to a planned negative vector',()=>{
 const result=validateProductMutationCatalog(CATALOG);
 assert.equal(result.ok,true,result.errors.join('\n'));
 assert.equal(result.stats.mutants,13);
 assert.ok(CATALOG.mutants.every((m)=>m.vector_id.startsWith('NEG-')));
});

test('product mutation timeout overrides are explicit, bounded and catalog-validated',()=>{
 const attest=CATALOG.mutants.filter((m)=>m.test_files.includes('test/attest-cli.test.mjs'));
 assert.deepEqual(attest.map((m)=>[m.id,m.timeout_ms]),[
  ['PMUT-ATTEST-EXPECT-HEAD-BYPASS',120000],
  ['PMUT-PRIVATE-KEY-MODE-RELAXED',120000],
 ]);
 for(const timeout_ms of [0,999,120001,1.5,'120000']){
  const bad=structuredClone(CATALOG);
  bad.mutants[0].timeout_ms=timeout_ms;
  const result=validateProductMutationCatalog(bad);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some((x)=>x.includes('timeout_ms')));
 }
 const max=structuredClone(CATALOG);
 max.mutants[0].timeout_ms=120000;
 assert.equal(validateProductMutationCatalog(max).ok,true);
});

test('real product mutation pilot kills every critical mutant',()=>{
 const result=runProductMutationCampaign({repoRoot:ROOT,catalog:CATALOG});
 assert.equal(result.catalog_errors.length,0,result.catalog_errors.join('\n'));
 assert.equal(result.pass,true,JSON.stringify(result,null,2));
 assert.equal(result.gate.critical_failures.length,0);
 assert.equal(result.gate.noncritical_score,1);
 assert.ok(result.mutants.every((m)=>m.status==='killed'),JSON.stringify(result.mutants,null,2));
});

test('product mutation campaign never counts a failure as killed when the unmodified scratch baseline already fails',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-baseline-fail-'));
 try{
  fs.mkdirSync(path.join(root,'test'),{recursive:true});
  fs.writeFileSync(path.join(root,'subject.mjs'),'export const value = 1;\n');
  fs.writeFileSync(path.join(root,'test','subject.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../subject.mjs'; test('fails before mutation',()=>assert.equal(value,2));\n");
  const sourceCommit=initFixtureRepo(root);
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{id:'baseline-bad',vector_id:'NEG-TEST-01',critical:true,file:'subject.mjs',find:'value = 1',replace:'value = 3',test_files:['test/subject.test.mjs'],timeout_ms:5000,invariant:'baseline must be green'}]};
  const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit});
  assert.equal(result.pass,false);
  assert.equal(result.mutants[0].status,'survived');
  assert.equal(result.mutants[0].classification,'baseline-failed');
  assert.equal(result.mutants[0].timeout_ms,5000);
  assert.notEqual(result.mutants[0].baseline.exit_code,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// Fixture suite driven by T19_FIXTURE_MODE: counts its runs outside the scratch tree and can SIGKILL the node --test process that runs it.
const SIGNAL_FIXTURE_TEST=[
 "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { value } from '../subject.mjs';",
 "const counter=process.env.T19_FIXTURE_COUNTER;",
 "const run=(fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1;",
 "fs.writeFileSync(counter,String(run));",
 "const mode=process.env.T19_FIXTURE_MODE;",
 "function killRunner(){",
 "  if(process.env.T19_FIXTURE_PROTECTED_PIDS.split(',').includes(String(process.ppid))) throw new Error('refusing to signal the outer test runner');",
 "  process.kill(process.ppid,'SIGKILL');",
 "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);",
 "  process.exit(86);",
 "}",
 "test('signal fixture',()=>{",
 "  if(mode==='kill-always'||(mode==='kill-first'&&run===1)||(mode==='kill-mutated'&&value!==1)) killRunner();",
 "  if(mode==='hang-always'){ setInterval(()=>{},1000); return new Promise(()=>{}); }",
 "  assert.equal(value,mode==='fail-always'?2:1);",
 "});",
 "",
].join('\n');

function runSignalFixtureCampaign(mode,{timeoutMs=30_000}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-signal-'));
 const counter=path.join(root,'fixture-counter.txt');
 const env={T19_FIXTURE_MODE:mode,T19_FIXTURE_COUNTER:counter,T19_FIXTURE_PROTECTED_PIDS:`${process.pid},${process.ppid}`};
 const saved=Object.fromEntries(Object.keys(env).map((key)=>[key,process.env[key]]));
 try{
  fs.mkdirSync(path.join(root,'test'),{recursive:true});
  fs.writeFileSync(path.join(root,'subject.mjs'),'export const value = 1;\n');
  fs.writeFileSync(path.join(root,'test','subject.test.mjs'),SIGNAL_FIXTURE_TEST);
  const sourceCommit=initFixtureRepo(root);
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{id:'signal-fixture',vector_id:'NEG-TEST-04',critical:true,file:'subject.mjs',find:'value = 1',replace:'value = 3',test_files:['test/subject.test.mjs'],timeout_ms:timeoutMs,invariant:'baseline signal handling'}]};
  Object.assign(process.env,env);
  const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit});
  const runs=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
  return {result,mutant:result.mutants[0],runs};
 }finally{
  for(const [key,value] of Object.entries(saved)){
   if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
  fs.rmSync(root,{recursive:true,force:true});
 }
}

test('product mutation baseline killed by a signal is retried once and a recovered baseline keeps a normal mutant verdict',{skip:process.platform==='win32'},()=>{
 const {mutant,runs}=runSignalFixtureCampaign('kill-first');
 assert.equal(mutant.baseline.exit_code,0,JSON.stringify(mutant,null,2));
 assert.equal(mutant.baseline.attempts,2);
 assert.equal(mutant.baseline.prior_attempts.length,1);
 assert.equal(mutant.baseline.prior_attempts[0].exit_code,null);
 assert.equal(mutant.baseline.prior_attempts[0].signal,'SIGKILL');
 assert.equal(mutant.baseline.prior_attempts[0].timed_out,false);
 assert.equal(mutant.status,'killed');
 assert.equal(mutant.classification,'mutant-detected');
 assert.equal(runs,3,'killed baseline, recovered baseline, mutated run');
});

test('product mutation baseline killed by a signal on every attempt stays baseline-failed after one retry and is never counted as killed',{skip:process.platform==='win32'},()=>{
 const {mutant,runs}=runSignalFixtureCampaign('kill-always');
 assert.equal(mutant.status,'survived');
 assert.equal(mutant.classification,'baseline-failed');
 assert.equal(mutant.baseline.exit_code,null);
 assert.equal(mutant.baseline.signal,'SIGKILL');
 assert.equal(mutant.baseline.attempts,2);
 assert.equal(mutant.baseline.prior_attempts.length,1);
 assert.equal(runs,2,'exactly two baseline attempts and no mutated run');
});

test('product mutation baseline that fails an assertion is not retried',()=>{
 const {mutant,runs}=runSignalFixtureCampaign('fail-always');
 assert.equal(mutant.status,'survived');
 assert.equal(mutant.classification,'baseline-failed');
 assert.equal(mutant.baseline.exit_code,1);
 assert.equal(mutant.baseline.attempts,1);
 assert.deepEqual(mutant.baseline.prior_attempts,[]);
 assert.equal(runs,1);
});

test('product mutation baseline that exceeds its timeout is retried once and reported as timed out',()=>{
 const {mutant}=runSignalFixtureCampaign('hang-always',{timeoutMs:1000});
 assert.equal(mutant.status,'survived');
 assert.equal(mutant.classification,'baseline-failed');
 assert.equal(mutant.baseline.timed_out,true);
 assert.equal(mutant.baseline.error_code,'ETIMEDOUT');
 assert.equal(mutant.baseline.attempts,2);
 assert.equal(mutant.baseline.prior_attempts.length,1);
 assert.equal(mutant.baseline.prior_attempts[0].timed_out,true);
 if(process.platform!=='win32') assert.equal(mutant.baseline.signal,'SIGKILL');
});

test('product mutation run killed by a signal is not counted as killed and is not retried',{skip:process.platform==='win32'},()=>{
 const {mutant,runs}=runSignalFixtureCampaign('kill-mutated');
 assert.equal(mutant.baseline.exit_code,0);
 assert.equal(mutant.baseline.attempts,1);
 assert.equal(mutant.status,'survived');
 assert.equal(mutant.classification,'mutant-survived');
 assert.equal(mutant.exit_code,null);
 assert.equal(mutant.signal,'SIGKILL');
 assert.equal(mutant.timed_out,false);
 assert.equal(runs,2,'one baseline attempt and one mutated attempt');
});

test('product mutation campaign ignores live ignored bytes and executes only the claimed commit tree',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-ignored-bytes-'));
 try{
  fs.mkdirSync(path.join(root,'test'),{recursive:true});
  fs.writeFileSync(path.join(root,'.gitignore'),'ignored.txt\nnode_modules/\n');
  fs.writeFileSync(path.join(root,'subject.mjs'),'export const value = 1;\n');
  fs.writeFileSync(path.join(root,'test','subject.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { value } from '../subject.mjs'; test('commit-only source',()=>{ assert.equal(value,1); assert.equal(fs.existsSync(new URL('../ignored.txt', import.meta.url)),false); });\n");
  const sourceCommit=initFixtureRepo(root);
  fs.writeFileSync(path.join(root,'ignored.txt'),'live ignored poison\n');
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{id:'commit-only',vector_id:'NEG-TEST-02',critical:true,file:'subject.mjs',find:'value = 1',replace:'value = 2',test_files:['test/subject.test.mjs'],invariant:'ignored live bytes never enter claimed commit execution'}]};
  const result=runProductMutationCampaign({repoRoot:root,catalog,sourceCommit});
  // A one-critical-mutant fixture intentionally has no noncritical denominator, so the
  // campaign-level gate is fail-closed. The provenance assertion is that the clean baseline
  // ran from the commit tree and the injected mutation was detected.
  assert.equal(result.mutants[0].baseline.exit_code,0,JSON.stringify(result,null,2));
  assert.equal(result.source_materialization,'git-archive');
  assert.equal(result.source_commit,sourceCommit);
  assert.equal(result.dependency_install.mode,'npm-ci-ignore-scripts');
  assert.equal(result.mutants[0].status,'killed');

  // The shared bounded runner must kill an actual node --test worker process group, not
  // merely the test-runner parent PID.
  const pidFile=path.join(root,'bounded-worker.pid');
  const hangFile=path.join(root,'bounded-hang-tree.mjs');
  fs.writeFileSync(hangFile,"import { spawn } from 'node:child_process'; import fs from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.env.PID_FILE,String(child.pid)); setInterval(()=>{},1000);\n");
  const started=Date.now();
  const hung=runBoundedCommand(process.execPath,[hangFile],{cwd:root,timeoutMs:1000,env:{...process.env,PID_FILE:pidFile}});
  const elapsed=Date.now()-started;
  assert.equal(hung.error?.code,'ETIMEDOUT');
  assert.ok(elapsed < 5000,`hard timeout returned too slowly: ${elapsed}ms`);
  if(process.platform!=='win32') {
    assert.equal(hung.signal,'SIGKILL');
    const workerPid=Number(fs.readFileSync(pidFile,'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
    const alive=processIsRunningNonZombie(workerPid);
    assert.equal(alive,false,`timed-out product descendant worker ${workerPid} remained runnable after process-group kill`);
  }

  // Setup failures before mutation execution must still remove the controlled source tree.
  const broken=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-broken-deps-'));
  try{
   fs.mkdirSync(path.join(broken,'test'),{recursive:true});
   fs.writeFileSync(path.join(broken,'package.json'),JSON.stringify({name:'broken',version:'1.0.0',private:true})+'\n');
   fs.writeFileSync(path.join(broken,'subject.mjs'),'export const value = 1;\n');
   fs.writeFileSync(path.join(broken,'test','subject.test.mjs'),"import test from 'node:test'; test('noop',()=>{});\n");
   spawnSync('git',['init','-q'],{cwd:broken});
   spawnSync('git',['add','-A'],{cwd:broken});
   const commit=spawnSync('git',['-c','user.name=T19','-c','user.email=t19@example.invalid','commit','-q','-m','no-lock'],{cwd:broken,encoding:'utf8'});
   assert.equal(commit.status,0,commit.stderr);
   const badCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:broken,encoding:'utf8'}).stdout.trim();
   const badCatalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{id:'setup-fail',vector_id:'NEG-TEST-03',critical:true,file:'subject.mjs',find:'value = 1',replace:'value = 2',test_files:['test/subject.test.mjs'],invariant:'setup failure cleans controlled source'}]};
   const prefix='bskel-t19-controlled-source-';
   const before=fs.readdirSync(os.tmpdir()).filter((name)=>name.startsWith(prefix)).sort();
   assert.throws(()=>runProductMutationCampaign({repoRoot:broken,catalog:badCatalog,sourceCommit:badCommit}),/requires tracked package\.json and package-lock\.json/);
   const after=fs.readdirSync(os.tmpdir()).filter((name)=>name.startsWith(prefix)).sort();
   assert.deepEqual(after,before);
  }finally{fs.rmSync(broken,{recursive:true,force:true});}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('product mutation catalog refuses traversal paths',()=>{
 const bad=structuredClone(CATALOG);
 bad.mutants[0].file='../scanners/index.mjs';
 const result=validateProductMutationCatalog(bad);
 assert.equal(result.ok,false);
 assert.ok(result.errors.some((x)=>x.includes('unsafe')));
});

test('product mutation runner refuses to label dirty checkout bytes with the clean HEAD',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-dirty-head-'));
 try{
  spawnSync('git',['init','-q'],{cwd:root});
  fs.writeFileSync(path.join(root,'tracked.txt'),'clean\n');
  spawnSync('git',['add','.'],{cwd:root});
  spawnSync('git',['-c','user.name=T19','-c','user.email=t19@example.invalid','commit','-q','-m','baseline'],{cwd:root});
  fs.writeFileSync(path.join(root,'tracked.txt'),'dirty\n');
  assert.throws(()=>resolveSourceCommit(root),/clean checkout/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('product mutation runner rejects a claimed source commit that differs from the tested checkout',()=>{
 const env={...process.env}; delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,[path.join(HERE,'product-mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'product-mutations.json'),'--source-commit','0'.repeat(40)],{encoding:'utf8',env});
 assert.equal(r.status,1);
 assert.match(r.stderr,/does not match tested checkout/);
 const head=spawnSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 const upper=spawnSync(process.execPath,[path.join(HERE,'product-mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'product-mutations.json'),'--source-commit',head.toUpperCase()],{encoding:'utf8',env});
 assert.equal(upper.status,1);
 assert.match(upper.stderr,/canonical lowercase 40-hex/);
 assert.throws(()=>runProductMutationCampaign({repoRoot:ROOT,catalog:CATALOG,sourceCommit:head.toUpperCase()}),/canonical lowercase 40-hex/);
 const tree=spawnSync('git',['-C',ROOT,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).stdout.trim();
 assert.throws(()=>runProductMutationCampaign({repoRoot:ROOT,catalog:CATALOG,sourceCommit:tree}),/Git commit object/);
});

test('product mutation runner CLI writes a machine-readable report',()=>{
 const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-mutation-cli-'));
 try{
  const outPath=path.join(outDir,'report.json');
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const r=spawnSync(process.execPath,[path.join(HERE,'product-mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'product-mutations.json'),'--out',outPath],{encoding:'utf8',env});
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(fs.readFileSync(outPath,'utf8'));
  assert.equal(report.contract,'sbf.qa-product-mutation-report/1');
  const head=spawnSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.equal(report.source_commit,head);
  assert.equal(report.source_materialization,'git-archive');
  assert.equal(report.dependency_install.mode,'npm-ci-ignore-scripts');
  assert.match(report.dependency_install.package_lock_sha256,/^[a-f0-9]{64}$/);
  assert.equal(report.catalog_sha256,createHash('sha256').update(JSON.stringify(CATALOG)).digest('hex'));
  assert.equal(report.pass,true,JSON.stringify(report,null,2));
  assert.equal(report.mutants.length,13);
  assert.ok(report.mutants.every((m)=>m.status==='killed'));
 }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});

