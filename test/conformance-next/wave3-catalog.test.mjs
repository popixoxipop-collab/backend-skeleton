import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateProductMutationCatalog} from './product-mutation-runner.mjs';
import {SUITES,inspectSuite} from '../../scripts/run-next-nested-tests.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const catalog=read('test/conformance-next/product-mutations-wave3.json');
const VECTORS=['NEG-ID-02','NEG-ID-03','NEG-ID-04','NEG-ID-05','NEG-RELEASE-03','NEG-RELEASE-04','NEG-ROUTE-02','NEG-RUN-07'];

test('wave3 catalog preserves the planned invariant and severity for all eight new vectors',()=>{
 const validation=validateProductMutationCatalog(catalog);assert.equal(validation.ok,true,JSON.stringify(validation.errors));
 assert.equal(catalog.mutants.length,10);assert.equal(catalog.mutants.filter(m=>m.critical).length,9);
 assert.deepEqual([...new Set(catalog.mutants.map(m=>m.vector_id))].sort(),VECTORS);
 const bytes=fs.readFileSync(path.join(ROOT,catalog.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),catalog.coverage_scope.planned_catalog_sha256);
 const vectors=new Map(JSON.parse(bytes).vectors.map(v=>[v.id,v]));
 for(const mutant of catalog.mutants){assert.equal(mutant.invariant,vectors.get(mutant.vector_id).invariant);assert.equal(mutant.critical,vectors.get(mutant.vector_id).critical);}
});
test('wave3 represents eight previously missing vectors without relabeling original coverage',()=>{
 const before=new Set(['test/conformance-next/product-mutations.json','test/conformance-next/product-mutations-wave2-closeout.json'].flatMap(p=>read(p).mutants.map(m=>m.vector_id)));
 assert.equal(before.size,35);
 for(const id of VECTORS)assert.equal(before.has(id),false,id);
 const planned=read('test/corpus-next/negative-vectors.json').vectors;assert.equal(planned.length,79);
 const combined=new Set([...before,...VECTORS]);assert.equal(combined.size,43);assert.equal(planned.filter(v=>!combined.has(v.id)).length,36);
});
test('all mutation anchors are unique and replacements remain syntactically valid',()=>{
 for(const mutant of catalog.mutants){
  const source=fs.readFileSync(path.join(ROOT,mutant.file),'utf8');
  assert.equal(source.split(mutant.find).length-1,1,mutant.id);
  const changed=source.replace(mutant.find,mutant.replace);
  if(mutant.file.endsWith('.json'))assert.doesNotThrow(()=>JSON.parse(changed));
  else{
   const r=spawnSync(process.execPath,['--check','--input-type=module'],{input:changed,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
   assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null);assert.equal(r.status,0,mutant.id+': '+r.stderr);
  }
 }
});
test('existing T19 nested CI discovers every new behavioral and campaign test without workflow edits',()=>{
 const suite=SUITES.find(x=>x.id==='T19');const inspected=inspectSuite(suite,ROOT);assert.equal(inspected.status,'READY');
 const names=inspected.tests.map(x=>path.relative(ROOT,x));
 for(const name of ['wave3-identity','wave3-policy','wave3-routes','wave3-package','wave3-catalog','wave3-campaign'])
  assert.ok(names.includes('test/conformance-next/'+name+'.test.mjs'),name);
});
