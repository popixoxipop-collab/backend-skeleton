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
const cat=read('test/conformance-next/product-mutations-wave8.json');
const IDS=['NEG-AUTH-02','NEG-AUTH-04','NEG-AUTH-05','NEG-PROJ-05'];

test('Wave8 represents only four original vectors with five valid strict mutants',()=>{
 const result=validateProductMutationCatalog(cat);
 assert.equal(result.ok,true,JSON.stringify(result.errors));
 assert.equal(cat.mutants.length,5);
 assert.equal(cat.mutants.filter(x=>x.critical).length,4);
 assert.equal(cat.mutants.filter(x=>!x.critical).length,1);
 assert.deepEqual([...new Set(cat.mutants.map(x=>x.vector_id))].sort(),IDS);
 const bytes=fs.readFileSync(path.join(ROOT,cat.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),cat.coverage_scope.planned_catalog_sha256);
 const original=new Map(JSON.parse(bytes).vectors.map(x=>[x.id,x]));
 for(const mutant of cat.mutants){
  const o=original.get(mutant.vector_id);
  assert.ok(o,mutant.id);
  assert.equal(mutant.invariant,o.invariant);
  assert.equal(mutant.critical,o.critical);
 }
});
test('Wave8 cannot report the 71/79 development representation as protected main coverage',()=>{
 const oldNames=['product-mutations.json','product-mutations-wave2-closeout.json',...([3,4,5,6,7].map(i=>'product-mutations-wave'+i+'.json'))];
 const old=new Set(oldNames.flatMap(name=>read('test/conformance-next/'+name).mutants.map(x=>x.vector_id)));
 assert.equal(old.size,67);
 for(const id of IDS)assert.equal(old.has(id),false);
 const all=read('test/corpus-next/negative-vectors.json').vectors;
 assert.equal(all.length,79);
 const union=new Set([...old,...IDS]);
 assert.equal(union.size,71);
 assert.equal(all.filter(x=>!union.has(x.id)).length,8);
});
test('Five live source mutation anchors are unique and produce parseable code',()=>{
 for(const mutant of cat.mutants){
  const source=fs.readFileSync(path.join(ROOT,mutant.file),'utf8');
  assert.equal(source.split(mutant.find).length-1,1,mutant.id);
  const changed=source.replace(mutant.find,mutant.replace);
  assert.notEqual(changed,source);
  const z=spawnSync(process.execPath,['--check','--input-type=module'],{
   input:changed,encoding:'utf8',timeout:12000,maxBuffer:1024*1024,
  });
  assert.equal(z.error,undefined);
  assert.equal(z.signal,null);
  assert.equal(z.status,0,mutant.id+': '+z.stderr);
 }
});
test('All Wave8 files are discovered by existing required T19 nested CI',()=>{
 const s=inspectSuite(SUITES.find(x=>x.id==='T19'),ROOT);
 assert.equal(s.status,'READY');
 const paths=s.tests.map(p=>path.relative(ROOT,p));
 for(const name of ['wave8-auth-02','wave8-auth-04','wave8-auth-05','wave8-project-05','wave8-campaign','wave8-catalog'])
  assert.ok(paths.includes('test/conformance-next/'+name+'.test.mjs'),name);
});