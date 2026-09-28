import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveSourceCommit, runProductMutationCampaign, validateProductMutationCatalog } from './product-mutation-runner.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..','..');
const CATALOG=JSON.parse(fs.readFileSync(path.join(HERE,'product-mutations.json'),'utf8'));

test('product mutation catalog is safe and links every mutant to a planned negative vector',()=>{
 const result=validateProductMutationCatalog(CATALOG);
 assert.equal(result.ok,true,result.errors.join('\n'));
 assert.equal(result.stats.mutants,13);
 assert.ok(CATALOG.mutants.every((m)=>m.vector_id.startsWith('NEG-')));
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
  const catalog={contract:'sbf.qa-product-mutation-catalog/1',mutants:[{id:'baseline-bad',vector_id:'NEG-TEST-01',critical:true,file:'subject.mjs',find:'value = 1',replace:'value = 3',test_files:['test/subject.test.mjs'],invariant:'baseline must be green'}]};
  const result=runProductMutationCampaign({repoRoot:root,catalog});
  assert.equal(result.pass,false);
  assert.equal(result.mutants[0].status,'survived');
  assert.equal(result.mutants[0].classification,'baseline-failed');
  assert.notEqual(result.mutants[0].baseline.exit_code,0);
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
  assert.equal(report.catalog_sha256,createHash('sha256').update(JSON.stringify(CATALOG)).digest('hex'));
  assert.equal(report.pass,true,JSON.stringify(report,null,2));
  assert.equal(report.mutants.length,13);
  assert.ok(report.mutants.every((m)=>m.status==='killed'));
 }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});

