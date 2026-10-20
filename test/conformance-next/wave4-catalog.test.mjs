import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateProductMutationCatalog} from './product-mutation-runner.mjs';
import {SUITES,inspectSuite} from '../../scripts/run-next-nested-tests.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const load=rel=>JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));
const file='test/conformance-next/product-mutations-wave4.json';
const cat=load(file);
const NEW=['NEG-PROJ-03','NEG-ROUTE-04','NEG-ROUTE-06','NEG-ROUTE-07','NEG-RUN-02','NEG-RUN-06'].sort();

test('wave4 six new vectors bind exact original invariants and criticalities',()=>{
 const check=validateProductMutationCatalog(cat);
 assert.equal(check.ok,true,JSON.stringify(check.errors));
 assert.equal(cat.mutants.length,6);
 assert.deepEqual([...new Set(cat.mutants.map(x=>x.vector_id))].sort(),NEW);
 const bytes=fs.readFileSync(path.join(root,cat.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),cat.coverage_scope.planned_catalog_sha256);
 const planned=new Map(JSON.parse(bytes).vectors.map(v=>[v.id,v]));
 for(const mutant of cat.mutants){
  const vector=planned.get(mutant.vector_id);
  assert.ok(vector,mutant.vector_id);
  assert.equal(mutant.critical,vector.critical);
  assert.equal(mutant.invariant,vector.invariant);
 }
});
test('wave4 representation is 43+6=49 of the actual 79 original vectors, without changing the prior catalogs',()=>{
 const previousFiles=['test/conformance-next/product-mutations.json',
  'test/conformance-next/product-mutations-wave2-closeout.json',
  'test/conformance-next/product-mutations-wave3.json'];
 const old=new Set(previousFiles.flatMap(f=>load(f).mutants.map(m=>m.vector_id)));
 const full=load('test/corpus-next/negative-vectors.json').vectors;
 assert.equal(old.size,43);
 assert.equal(full.length,79);
 for(const id of NEW)assert.equal(old.has(id),false,id);
 const combined=new Set([...old,...NEW]);
 assert.equal(combined.size,49);
 assert.equal(full.filter(x=>!combined.has(x.id)).length,30);
});
test('all six real mutation anchors are unique and the changed implementation parses',()=>{
 for(const mutant of cat.mutants){
  const original=fs.readFileSync(path.join(root,mutant.file),'utf8');
  assert.equal(original.split(mutant.find).length-1,1,mutant.id);
  const modified=original.replace(mutant.find,mutant.replace);
  assert.notEqual(modified,original);
  const v=spawnSync(process.execPath,['--check','--input-type=module'],{
   input:modified,encoding:'utf8',timeout:30000,maxBuffer:1024*1024
  });
  assert.equal(v.error,undefined,v.error?.message);
  assert.equal(v.signal,null);
  assert.equal(v.status,0,mutant.id+': '+v.stderr);
 }
});
test('T19 existing nested CI discovers the wave4 live campaign and every behavioral file',()=>{
 const suite=SUITES.find(x=>x.id==='T19');
 const found=inspectSuite(suite,root);
 assert.equal(found.status,'READY');
 const files=found.tests.map(p=>path.relative(root,p));
 for(const file of ['wave4-project','wave4-route','wave4-evidence','wave4-run','wave4-catalog','wave4-campaign'])
  assert.ok(files.includes('test/conformance-next/'+file+'.test.mjs'),file);
});