import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateMutationGate } from './harness.mjs';

const PRODUCT_TEST_TIMEOUT_MS = 60_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveSourceCommit(repoRoot, requested = null) {
  const run = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (run.status !== 0) throw new Error(`cannot resolve source commit for ${repoRoot}: ${(run.stderr ?? '').trim()}`);
  const actual = (run.stdout ?? '').trim();
  if (!/^[a-f0-9]{40}$/i.test(actual)) throw new Error(`git rev-parse returned an invalid commit: ${actual}`);
  if (requested !== null) {
    if (!/^[a-f0-9]{40}$/i.test(requested)) throw new Error('--source-commit must be an exact 40-hex commit');
    if (requested.toLowerCase() !== actual.toLowerCase()) throw new Error(`--source-commit ${requested} does not match tested checkout ${actual}`);
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', timeout: 10_000 });
  if (status.status !== 0) throw new Error(`cannot inspect checkout cleanliness for ${repoRoot}: ${(status.stderr ?? '').trim()}`);
  if ((status.stdout ?? '').trim()) throw new Error('mutation reports require a clean checkout; uncommitted or untracked bytes would not match source_commit');
  return actual;
}

function safeRepoPath(rel) {
  return nonEmptyString(rel) &&
    !path.isAbsolute(rel) &&
    !rel.includes('\\') &&
    !rel.split('/').includes('..') &&
    !rel.startsWith('.git/') &&
    rel !== '.git' &&
    !rel.startsWith('node_modules/') &&
    rel !== 'node_modules';
}

export function validateProductMutationCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return { ok:false, errors:['catalog must be an object'] };
  if (catalog.contract !== 'sbf.qa-product-mutation-catalog/1') errors.push('contract must be sbf.qa-product-mutation-catalog/1');
  if (!Array.isArray(catalog.mutants) || catalog.mutants.length === 0) errors.push('mutants must be a non-empty array');
  if (errors.length) return { ok:false, errors };

  const ids = new Set();
  for (const [i,m] of catalog.mutants.entries()) {
    const at=`mutants[${i}]`;
    if (!nonEmptyString(m.id)) errors.push(`${at}.id must be non-empty`);
    else if (ids.has(m.id)) errors.push(`duplicate mutant id: ${m.id}`);
    else ids.add(m.id);
    if (typeof m.critical !== 'boolean') errors.push(`${at}.critical must be boolean`);
    if (!safeRepoPath(m.file)) errors.push(`${at}.file is unsafe`);
    if (!nonEmptyString(m.find) || !nonEmptyString(m.replace) || m.find === m.replace) errors.push(`${at} needs distinct find/replace strings`);
    if (!Array.isArray(m.test_files) || m.test_files.length === 0 || m.test_files.some((p)=>!safeRepoPath(p) || !p.endsWith('.test.mjs'))) errors.push(`${at}.test_files are invalid`);
    if (!nonEmptyString(m.invariant)) errors.push(`${at}.invariant must be non-empty`);
    if (!nonEmptyString(m.vector_id)) errors.push(`${at}.vector_id must link to a negative-vector id`);
  }
  return { ok:errors.length===0, errors, stats:{mutants:catalog.mutants.length} };
}

function materializeTrackedCommit(repoRoot, target, sourceCommit) {
  fs.mkdirSync(target,{recursive:true});
  const archive=spawnSync('git',['-C',repoRoot,'archive','--format=tar',sourceCommit],{
    encoding:null,timeout:30_000,maxBuffer:128*1024*1024,
  });
  if(archive.status!==0) throw new Error(`git archive ${sourceCommit} failed: ${Buffer.from(archive.stderr??'').toString('utf8').trim()}`);
  const extract=spawnSync('tar',['-xf','-','-C',target],{
    input:archive.stdout,encoding:'utf8',timeout:30_000,maxBuffer:16*1024*1024,
  });
  if(extract.status!==0) throw new Error(`tar extract of ${sourceCommit} failed: ${(extract.stderr??'').trim()}`);
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function installControlledDependencies(sourceRoot) {
  const packageJson=path.join(sourceRoot,'package.json');
  const lockfile=path.join(sourceRoot,'package-lock.json');
  if(!fs.existsSync(packageJson)||!fs.existsSync(lockfile)) {
    throw new Error('controlled product mutation execution requires tracked package.json and package-lock.json');
  }
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  const run=spawnSync(npm,['ci','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:sourceRoot,encoding:'utf8',timeout:180_000,
    env:{...process.env,npm_config_update_notifier:'false'},
  });
  if(run.status!==0) throw new Error(`controlled npm ci failed: ${(run.stderr??run.stdout??'').slice(-2400)}`);
  return {
    mode:'npm-ci-ignore-scripts',
    package_lock_sha256:sha256File(lockfile),
    node_modules:path.join(sourceRoot,'node_modules'),
  };
}

function attachControlledDependencies(scratch, dependencyInfo) {
  const target=path.join(scratch,'node_modules');
  if(fs.existsSync(target)) fs.rmSync(target,{recursive:true,force:true});
  if(!fs.existsSync(dependencyInfo.node_modules)) throw new Error('controlled dependency installation did not produce node_modules');
  fs.symlinkSync(dependencyInfo.node_modules,target,process.platform==='win32'?'junction':'dir');
  const exclude=path.join(scratch,'.git','info','exclude');
  fs.appendFileSync(exclude,'\nnode_modules/\n');
}

function runGit(scratch, args) {
  const run=spawnSync('git',args,{cwd:scratch,encoding:'utf8',timeout:20_000,env:{...process.env,GIT_AUTHOR_NAME:'T19 mutation runner',GIT_AUTHOR_EMAIL:'t19@example.invalid',GIT_COMMITTER_NAME:'T19 mutation runner',GIT_COMMITTER_EMAIL:'t19@example.invalid'}});
  if(run.status!==0) throw new Error(`scratch git ${args.join(' ')} failed: ${(run.stderr??'').trim()}`);
}

function commitScratchSnapshot(scratch,message) {
  runGit(scratch,['add','-A']);
  const diff=spawnSync('git',['diff','--cached','--quiet'],{cwd:scratch,encoding:'utf8'});
  if(diff.status===0) return;
  if(diff.status!==1) throw new Error(`scratch git diff --cached --quiet failed: ${(diff.stderr??'').trim()}`);
  runGit(scratch,['commit','--quiet','-m',message]);
}

function initializeScratchGit(scratch) {
  runGit(scratch,['init','-q']);
  runGit(scratch,['config','gc.auto','0']);
  runGit(scratch,['config','maintenance.auto','false']);
  commitScratchSnapshot(scratch,'baseline');
}

function runTestFiles(scratch, testFiles, timeoutMs) {
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const args=['--test',...testFiles.map((p)=>path.join(scratch,p))];
  const run=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:timeoutMs,env});
  return {
    exit_code:Number.isInteger(run.status)?run.status:null,
    signal:run.signal??null,
    stdout_tail:(run.stdout??'').slice(-1400),
    stderr_tail:(run.stderr??'').slice(-1400),
  };
}

function cleanupScratch(parent) {
  try {
    fs.rmSync(parent,{recursive:true,force:true,maxRetries:12,retryDelay:100});
  } catch (err) {
    // Scratch cleanup must never turn a correctly classified mutation into a false test failure.
    // Git can briefly finish object-store housekeeping after the child test exits on loaded CI.
    if (!['ENOTEMPTY','EBUSY','EPERM'].includes(err?.code)) throw err;
  }
}

function applyMutation(scratch,mutant) {
  const file=path.join(scratch,mutant.file);
  const original=fs.readFileSync(file,'utf8');
  const first=original.indexOf(mutant.find);
  const last=original.lastIndexOf(mutant.find);
  if(first===-1) return {ok:false,reason:'mutation anchor not found'};
  if(first!==last) return {ok:false,reason:'mutation anchor is not unique'};
  fs.writeFileSync(file,original.slice(0,first)+mutant.replace+original.slice(first+mutant.find.length));
  return {ok:true};
}

export function runProductMutationCampaign({repoRoot,catalog,sourceCommit=null}) {
  const validation=validateProductMutationCatalog(catalog);
  if(!validation.ok) return {pass:false,catalog_errors:validation.errors,mutants:[],gate:null};
  const resolvedSourceCommit=sourceCommit??resolveSourceCommit(repoRoot);
  if(!/^[a-f0-9]{40}$/i.test(resolvedSourceCommit)) throw new Error('product mutation campaign requires an exact source commit');
  const controlledParent=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-controlled-source-'));
  const controlledSource=path.join(controlledParent,'source');
  materializeTrackedCommit(repoRoot,controlledSource,resolvedSourceCommit);
  const dependencyInfo=installControlledDependencies(controlledSource);
  const results=[];
  try{
    for(const mutant of catalog.mutants){
      const parent=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-mutant-'));
      const scratch=path.join(parent,'repo');
      try{
        materializeTrackedCommit(repoRoot,scratch,resolvedSourceCommit);
        initializeScratchGit(scratch);
        attachControlledDependencies(scratch,dependencyInfo);
        const baseline=runTestFiles(scratch,mutant.test_files,PRODUCT_TEST_TIMEOUT_MS);
      if(baseline.exit_code!==0){
        results.push({id:mutant.id,vector_id:mutant.vector_id,critical:mutant.critical,status:'survived',classification:'baseline-failed',reason:'unmodified scratch test suite did not pass; mutant cannot be counted as killed',baseline});
        continue;
      }
      const applied=applyMutation(scratch,mutant);
      if(!applied.ok){
        results.push({id:mutant.id,vector_id:mutant.vector_id,critical:mutant.critical,status:'survived',classification:'mutation-not-applied',reason:applied.reason,baseline});
        continue;
      }
      commitScratchSnapshot(scratch,`mutant ${mutant.id}`);
      const run=runTestFiles(scratch,mutant.test_files,PRODUCT_TEST_TIMEOUT_MS);
      const killed=Number.isInteger(run.exit_code)&&run.exit_code!==0;
      results.push({
        id:mutant.id,vector_id:mutant.vector_id,critical:mutant.critical,
        status:killed?'killed':'survived',classification:killed?'mutant-detected':'mutant-survived',baseline,
        exit_code:run.exit_code,signal:run.signal,stdout_tail:run.stdout_tail,stderr_tail:run.stderr_tail,
      });
      }finally{cleanupScratch(parent);}
    }
    const gate=evaluateMutationGate({mutants:results.map(({id,critical,status})=>({id,critical,status}))});
    return {
      pass:gate.pass,catalog_errors:[],mutants:results,gate,
      source_materialization:'git-archive',
      source_commit:resolvedSourceCommit,
      dependency_install:{
        mode:dependencyInfo.mode,
        package_lock_sha256:dependencyInfo.package_lock_sha256,
      },
    };
  } finally {
    cleanupScratch(controlledParent);
  }
}


function parseArgs(argv) {
  const out={repo_root:'.',catalog:null,out:null,source_commit:null};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--repo-root'){out.repo_root=argv[++i]??null;continue;}
    if(argv[i]==='--catalog'){out.catalog=argv[++i]??null;continue;}
    if(argv[i]==='--out'){out.out=argv[++i]??null;continue;}
    if(argv[i]==='--source-commit'){out.source_commit=argv[++i]??null;continue;}
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if(!out.repo_root||!out.catalog) throw new Error('--repo-root and --catalog are required');
  return out;
}

export function main(argv=process.argv.slice(2),stdout=process.stdout,stderr=process.stderr){
  try{
    const options=parseArgs(argv);
    const catalog=JSON.parse(fs.readFileSync(options.catalog,'utf8'));
    const source_commit=resolveSourceCommit(options.repo_root,options.source_commit);
    const catalog_sha256=createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    const report=runProductMutationCampaign({repoRoot:options.repo_root,catalog,sourceCommit:source_commit});
    const encoded=JSON.stringify({contract:'sbf.qa-product-mutation-report/1',catalog_sha256,...report},null,2)+'\n';
    if(options.out) fs.writeFileSync(options.out,encoded);
    else stdout.write(encoded);
    stderr.write(`qa-product-mutation: ${report.pass?'PASS':'FAIL'} -- ${report.mutants.filter((m)=>m.status==='killed').length}/${report.mutants.length} mutants killed\n`);
    return report.pass?0:3;
  }catch(err){
    stderr.write(`qa-product-mutation: ${err.message}\n`);
    return 1;
  }
}

const entry=process.argv[1]?path.resolve(process.argv[1]):null;
if(entry&&entry===fileURLToPath(import.meta.url)) process.exitCode=main();
