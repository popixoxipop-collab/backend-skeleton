import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateMutationGate } from './harness.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function copyProject(repoRoot,scratch) {
  fs.cpSync(repoRoot,scratch,{
    recursive:true,
    dereference:false,
    filter:(src)=>{
      const rel=path.relative(repoRoot,src);
      if (!rel) return true;
      const first=rel.split(path.sep)[0];
      return first !== '.git' && first !== 'node_modules';
    },
  });
  const sourceNodeModules=path.join(repoRoot,'node_modules');
  if (fs.existsSync(sourceNodeModules)) fs.symlinkSync(sourceNodeModules,path.join(scratch,'node_modules'),'dir');
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

export function runProductMutationCampaign({repoRoot,catalog}) {
  const validation=validateProductMutationCatalog(catalog);
  if(!validation.ok) return {pass:false,catalog_errors:validation.errors,mutants:[],gate:null};
  const results=[];
  for(const mutant of catalog.mutants){
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-mutant-'));
    const scratch=path.join(parent,'repo');
    try{
      copyProject(repoRoot,scratch);
      const applied=applyMutation(scratch,mutant);
      if(!applied.ok){
        results.push({id:mutant.id,vector_id:mutant.vector_id,critical:mutant.critical,status:'survived',reason:applied.reason,exit_code:null});
        continue;
      }
      const env={...process.env}; delete env.NODE_TEST_CONTEXT;
      const args=['--test',...mutant.test_files.map((p)=>path.join(scratch,p))];
      const run=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:20_000,env});
      const code=run.status;
      const killed=Number.isInteger(code)&&code!==0;
      results.push({
        id:mutant.id,vector_id:mutant.vector_id,critical:mutant.critical,
        status:killed?'killed':'survived',exit_code:Number.isInteger(code)?code:null,signal:run.signal??null,
        stdout_tail:(run.stdout??'').slice(-1400),stderr_tail:(run.stderr??'').slice(-1400),
      });
    }finally{fs.rmSync(parent,{recursive:true,force:true});}
  }
  const gate=evaluateMutationGate({mutants:results.map(({id,critical,status})=>({id,critical,status}))});
  return {pass:gate.pass,catalog_errors:[],mutants:results,gate};
}


function parseArgs(argv) {
  const out={repo_root:'.',catalog:null,out:null};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--repo-root'){out.repo_root=argv[++i]??null;continue;}
    if(argv[i]==='--catalog'){out.catalog=argv[++i]??null;continue;}
    if(argv[i]==='--out'){out.out=argv[++i]??null;continue;}
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if(!out.repo_root||!out.catalog) throw new Error('--repo-root and --catalog are required');
  return out;
}

export function main(argv=process.argv.slice(2),stdout=process.stdout,stderr=process.stderr){
  try{
    const options=parseArgs(argv);
    const catalog=JSON.parse(fs.readFileSync(options.catalog,'utf8'));
    const report=runProductMutationCampaign({repoRoot:options.repo_root,catalog});
    const encoded=JSON.stringify({contract:'sbf.qa-product-mutation-report/1',...report},null,2)+'\n';
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
