import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runProductMutationCampaign, validateProductMutationCatalog } from './product-mutation-runner.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..','..');
const CATALOG=JSON.parse(fs.readFileSync(path.join(HERE,'product-mutations.json'),'utf8'));

test('product mutation catalog is safe and links every mutant to a planned negative vector',()=>{
 const result=validateProductMutationCatalog(CATALOG);
 assert.equal(result.ok,true,result.errors.join('\n'));
 assert.equal(result.stats.mutants,7);
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

test('product mutation catalog refuses traversal paths',()=>{
 const bad=structuredClone(CATALOG);
 bad.mutants[0].file='../scanners/index.mjs';
 const result=validateProductMutationCatalog(bad);
 assert.equal(result.ok,false);
 assert.ok(result.errors.some((x)=>x.includes('unsafe')));
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
  assert.equal(report.pass,true,JSON.stringify(report,null,2));
  assert.equal(report.mutants.length,7);
  assert.ok(report.mutants.every((m)=>m.status==='killed'));
 }finally{fs.rmSync(outDir,{recursive:true,force:true});}
});

