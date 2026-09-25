import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
