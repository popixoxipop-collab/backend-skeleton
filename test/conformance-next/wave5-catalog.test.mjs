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
const catalog=read('test/conformance-next/product-mutations-wave5.json');
const ids=['NEG-DB-01','NEG-DB-02','NEG-DB-03','NEG-DB-06','NEG-GEN-05','NEG-PROJ-06'];
test('wave5 original severity and wording, exactly seven bounded mutations representing six new vectors',()=>{
 const valid=validateProductMutationCatalog(catalog);
 assert.equal(valid.ok,true,JSON.stringify(valid.errors));
 assert.equal(catalog.mutants.length,7);
 assert.equal(catalog.mutants.filter(x=>x.critical).length,6);
 assert.equal(catalog.mutants.filter(x=>!x.critical).length,1);
 assert.deepEqual([...new Set(catalog.mutants.map(x=>x.vector_id))].sort(),ids);
 const bytes=fs.readFileSync(path.join(ROOT,catalog.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),catalog.coverage_scope.planned_catalog_sha256);
 const original=new Map(JSON.parse(bytes).vectors.map(x=>[x.id,x]));
 for(const mutant of catalog.mutants){
  const wanted=original.get(mutant.vector_id);
  assert.ok(wanted,mutant.vector_id);
  assert.equal(mutant.critical,wanted.critical,mutant.id);
  assert.equal(mutant.invariant,wanted.invariant,mutant.id);
 }
});
test('wave5 adds six previously missing types: candidate 49 ->55 of79; main remains35 until merge',()=>{
 const prior=['product-mutations.json','product-mutations-wave2-closeout.json',
  'product-mutations-wave3.json','product-mutations-wave4.json']
  .flatMap(name=>read('test/conformance-next/'+name).mutants.map(x=>x.vector_id));
 const seen=new Set(prior);
 assert.equal(seen.size,49);
 for(const id of ids)assert.equal(seen.has(id),false,id);
 const all=read('test/corpus-next/negative-vectors.json').vectors;
 assert.equal(all.length,79);
 const union=new Set([...prior,...ids]);
 assert.equal(union.size,55);
 assert.equal(all.filter(x=>!union.has(x.id)).length,24);
});
test('wave5 injected source anchor is unique and resulting actual JS remains syntax-valid',()=>{
 for(const m of catalog.mutants){
  const original=fs.readFileSync(path.join(ROOT,m.file),'utf8');
  assert.equal(original.split(m.find).length-1,1,m.id+' anchor uniqueness');
  const changed=original.replace(m.find,m.replace);
  assert.notEqual(changed,original);
  const child=spawnSync(process.execPath,['--check','--input-type=module'],{
   input:changed,encoding:'utf8',timeout:15000,maxBuffer:1024*1024
  });
  assert.equal(child.error,undefined,child.error?.message);
  assert.equal(child.signal,null);
  assert.equal(child.status,0,m.id+': '+child.stderr);
 }
});
test('wave5 tests are discovered by the already-required nested T19 CI without workflow edits',()=>{
 const found=inspectSuite(SUITES.find(x=>x.id==='T19'),ROOT);
 assert.equal(found.status,'READY');
 const paths=found.tests.map(p=>path.relative(ROOT,p));
 for(const name of ['wave5-persistence','wave5-generation','wave5-project','wave5-catalog','wave5-campaign'])
  assert.ok(paths.includes('test/conformance-next/'+name+'.test.mjs'),name);
});