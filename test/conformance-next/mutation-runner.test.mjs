import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveSourceCommit, runBoundedTestCommand, runMutationCampaign, validateMutationCatalog } from './mutation-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'mutations.json'), 'utf8'));

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
  spawnSync('git',['init','-q'],{cwd:root});
  spawnSync('git',['add','-A'],{cwd:root});
  const commit=spawnSync('git',['-c','user.name=T19','-c','user.email=t19@example.invalid','commit','-q','-m','baseline'],{cwd:root,encoding:'utf8'});
  assert.equal(commit.status,0,commit.stderr);
  return spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
}

test('mutation catalog is structurally safe and limited to T19-owned test paths', () => {
  const result = validateMutationCatalog(CATALOG);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.mutants, 7);
});

test('actual T19 mutation campaign kills every critical mutant and meets the noncritical gate', () => {
  const result = runMutationCampaign({ repoRoot: ROOT, catalog: CATALOG });
  assert.equal(result.catalog_errors.length, 0, result.catalog_errors.join('\n'));
  assert.equal(result.pass, true, JSON.stringify(result, null, 2));
  assert.equal(result.gate.critical_failures.length, 0);
  assert.equal(result.gate.noncritical_score, 1);
  assert.deepEqual(result.mutants.map((m) => m.status), Array(result.mutants.length).fill('killed'));

  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-hard-timeout-'));
  try {
    const pidFile=path.join(root,'worker.pid');
    const hangFile=path.join(root,'hang-tree.mjs');
    fs.writeFileSync(hangFile,"import { spawn } from 'node:child_process'; import fs from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.env.PID_FILE,String(child.pid)); setInterval(()=>{},1000);\n");
    const started=Date.now();
    const hung=runBoundedTestCommand(process.execPath,[hangFile],{cwd:root,timeoutMs:1000,env:{...process.env,PID_FILE:pidFile}});
    const elapsed=Date.now()-started;
    assert.equal(hung.error?.code,'ETIMEDOUT');
    assert.ok(elapsed < 5000,`hard timeout returned too slowly: ${elapsed}ms`);
    if(process.platform!=='win32') {
      assert.equal(hung.signal,'SIGKILL');
      const workerPid=Number(fs.readFileSync(pidFile,'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      const alive=processIsRunningNonZombie(workerPid);
      assert.equal(alive,false,`timed-out descendant worker ${workerPid} remained runnable after process-group kill`);
    }

    const noisy=runBoundedTestCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(512*1024)); process.stdout.write('TAIL-MARKER')"],{cwd:root,timeoutMs:5000,env:{...process.env}});
    assert.equal(noisy.status,0,noisy.stderr);
    assert.ok(noisy.stdout.length <= 256*1024,'supervisor retained more than the bounded stdout tail');
    assert.ok(noisy.stdout.endsWith('TAIL-MARKER'),'bounded stdout tail did not preserve the latest bytes');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('mutation campaign never counts a failure as killed when the unmodified scratch baseline already fails', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-baseline-fail-'));
  try {
    const dir=path.join(root,'test','conformance-next');
    fs.mkdirSync(dir,{recursive:true});
    fs.mkdirSync(path.join(root,'test','corpus-next'),{recursive:true});
    fs.writeFileSync(path.join(dir,'subject.mjs'),'export const value = 1;\n');
    fs.writeFileSync(path.join(dir,'subject.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './subject.mjs'; test('fails before mutation',()=>assert.equal(value,2));\n");
    const sourceCommit=initFixtureRepo(root);
    const catalog={contract:'sbf.qa-mutation-catalog/1',mutants:[{id:'baseline-bad',critical:true,file:'test/conformance-next/subject.mjs',find:'value = 1',replace:'value = 3',test_files:['test/conformance-next/subject.test.mjs'],invariant:'baseline must be green'}]};
    const result=runMutationCampaign({repoRoot:root,catalog,sourceCommit});
    assert.equal(result.pass,false);
    assert.equal(result.mutants[0].status,'survived');
    assert.equal(result.mutants[0].classification,'baseline-failed');
    assert.notEqual(result.mutants[0].baseline.exit_code,0);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('mutation catalog rejects a source path outside the T19 namespace', () => {
  const bad = structuredClone(CATALOG);
  bad.mutants[0].file = 'scanners/index.mjs';
  const result = validateMutationCatalog(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('T19 test paths')));
});


test('mutation runner refuses to label dirty checkout bytes with the clean HEAD', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-dirty-head-'));
  try {
    spawnSync('git',['init','-q'],{cwd:root});
    fs.writeFileSync(path.join(root,'tracked.txt'),'clean\n');
    spawnSync('git',['add','.'],{cwd:root});
    spawnSync('git',['-c','user.name=T19','-c','user.email=t19@example.invalid','commit','-q','-m','baseline'],{cwd:root});
    fs.writeFileSync(path.join(root,'tracked.txt'),'dirty\n');
    assert.throws(()=>resolveSourceCommit(root),/clean checkout/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('mutation runner rejects a claimed source commit that differs from the tested checkout', () => {
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const r=spawnSync(process.execPath,[path.join(HERE,'mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'mutations.json'),'--source-commit','0'.repeat(40)],{encoding:'utf8',env});
  assert.equal(r.status,1);
  assert.match(r.stderr,/does not match tested checkout/);
  const head=spawnSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const upper=spawnSync(process.execPath,[path.join(HERE,'mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'mutations.json'),'--source-commit',head.toUpperCase()],{encoding:'utf8',env});
  assert.equal(upper.status,1);
  assert.match(upper.stderr,/canonical lowercase 40-hex/);
  assert.throws(()=>runMutationCampaign({repoRoot:ROOT,catalog:CATALOG,sourceCommit:head.toUpperCase()}),/canonical lowercase 40-hex/);
  const tree=spawnSync('git',['-C',ROOT,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).stdout.trim();
  assert.throws(()=>runMutationCampaign({repoRoot:ROOT,catalog:CATALOG,sourceCommit:tree}),/Git commit object/);
});

test('mutation runner CLI writes a machine-readable killed-mutant report', () => {
  const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-mutation-cli-'));
  try {
    const outPath=path.join(outDir,'report.json');
    const env={...process.env};
    delete env.NODE_TEST_CONTEXT;
    const r=spawnSync(process.execPath,[path.join(HERE,'mutation-runner.mjs'),'--repo-root',ROOT,'--catalog',path.join(HERE,'mutations.json'),'--out',outPath],{encoding:'utf8',env});
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(fs.readFileSync(outPath,'utf8'));
    assert.equal(report.contract,'sbf.qa-mutation-report/1');
    const head=spawnSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
    assert.equal(report.source_commit,head);
    assert.equal(report.source_materialization,'git-archive');
    assert.equal(report.catalog_sha256,createHash('sha256').update(JSON.stringify(CATALOG)).digest('hex'));
    assert.equal(report.pass,true,JSON.stringify(report,null,2));
    assert.equal(report.mutants.length,7);
    assert.ok(report.mutants.every((m)=>m.status==='killed'));
  } finally { fs.rmSync(outDir,{recursive:true,force:true}); }
});
