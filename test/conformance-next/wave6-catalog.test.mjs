import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateProductMutationCatalog} from './product-mutation-runner.mjs';
import {SUITES,inspectSuite} from '../../scripts/run-next-nested-tests.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=rel=>JSON.parse(fs.readFileSync(path.join(ROOT,rel),'utf8'));
const catalog=read('test/conformance-next/product-mutations-wave6.json');
const IDS=['NEG-PROJ-04','NEG-GAME-01','NEG-GAME-02','NEG-GAME-03','NEG-GAME-06','NEG-GAME-07'].sort();
test('wave6 seven mutation anchors represent exactly six original negative invariants and their exact severity',()=>{
 const result=validateProductMutationCatalog(catalog);
 assert.equal(result.ok,true,JSON.stringify(result.errors));
 assert.equal(catalog.mutants.length,7);
 assert.equal(catalog.mutants.filter(x=>x.critical).length,6);
 assert.equal(catalog.mutants.filter(x=>!x.critical).length,1);
 assert.deepEqual([...new Set(catalog.mutants.map(x=>x.vector_id))].sort(),IDS);
 const bytes=fs.readFileSync(path.join(ROOT,catalog.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),catalog.coverage_scope.planned_catalog_sha256);
 const originals=new Map(JSON.parse(bytes).vectors.map(x=>[x.id,x]));
 for(const mutant of catalog.mutants){
  const source=originals.get(mutant.vector_id);
  assert.ok(source,mutant.vector_id);
  assert.equal(mutant.critical,source.critical,mutant.id);
  assert.equal(mutant.invariant,source.invariant,mutant.id);
 }
});
test('wave6 covers six new candidates: 55+6=61 represented of79, 18 still missing; main not promoted',()=>{
 const catalogs=['product-mutations.json','product-mutations-wave2-closeout.json','product-mutations-wave3.json',
  'product-mutations-wave4.json','product-mutations-wave5.json'];
 const old=new Set(catalogs.flatMap(name=>read('test/conformance-next/'+name).mutants.map(m=>m.vector_id)));
 assert.equal(old.size,55);
 for(const id of IDS)assert.equal(old.has(id),false,id);
 const all=read('test/corpus-next/negative-vectors.json').vectors;
 assert.equal(all.length,79);
 const combined=new Set([...old,...IDS]);
 assert.equal(combined.size,61);
 assert.equal(all.filter(x=>!combined.has(x.id)).length,18);
});
test('wave6 source mutations have exactly one anchor and remain valid JavaScript',()=>{
 for(const mutant of catalog.mutants){
  const original=fs.readFileSync(path.join(ROOT,mutant.file),'utf8');
  assert.equal(original.split(mutant.find).length-1,1,mutant.id);
  const modified=original.replace(mutant.find,mutant.replace);
  assert.notEqual(modified,original);
  const child=spawnSync(process.execPath,['--check','--input-type=module'],{
    input:modified,encoding:'utf8',timeout:25000,maxBuffer:1024*1024,
  });
  assert.equal(child.error,undefined,child.error?.message);
  assert.equal(child.signal,null);
  assert.equal(child.status,0,mutant.id+': '+child.stderr);
 }
});
test('wave6 new tests are actually discovered by the existing T19 nested CI suite',()=>{
 const s=SUITES.find(x=>x.id==='T19');
 const r=inspectSuite(s,ROOT);
 assert.equal(r.status,'READY');
 const paths=r.tests.map(x=>path.relative(ROOT,x));
 for(const name of ['wave6-project','wave6-game','wave6-catalog','wave6-campaign','wave6-game-01','wave6-game-02','wave6-game-03','wave6-game-06','wave6-game-07']){
  assert.ok(paths.includes('test/conformance-next/'+name+'.test.mjs'),name);
 }
});