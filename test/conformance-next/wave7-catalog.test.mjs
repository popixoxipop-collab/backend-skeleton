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
const cat=read('test/conformance-next/product-mutations-wave7.json');
const IDS=['NEG-SCHEMA-01','NEG-SCHEMA-04','NEG-SCHEMA-05','NEG-SCHEMA-06','NEG-SCHEMA-07','NEG-SCHEMA-08'];

test('wave7 anchors and original severity/invariant text are byte-accurately pinned',()=>{
 const check=validateProductMutationCatalog(cat);
 assert.equal(check.ok,true,JSON.stringify(check.errors));
 assert.equal(cat.mutants.length,8);
 assert.equal(cat.mutants.filter(x=>x.critical).length,7);
 assert.equal(cat.mutants.filter(x=>!x.critical).length,1);
 assert.deepEqual([...new Set(cat.mutants.map(x=>x.vector_id))].sort(),IDS);
 const bytes=fs.readFileSync(path.join(ROOT,cat.coverage_scope.planned_catalog));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),cat.coverage_scope.planned_catalog_sha256);
 const originals=new Map(JSON.parse(bytes).vectors.map(x=>[x.id,x]));
 for(const m of cat.mutants){
  const original=originals.get(m.vector_id);
  assert.ok(original,m.vector_id);
  assert.equal(m.critical,original.critical,m.id);
  assert.equal(m.invariant,original.invariant,m.id);
 }
});

test('wave7 adds six new vector representations to a stacked candidate, never protected main',()=>{
 const names=['product-mutations.json','product-mutations-wave2-closeout.json',
  'product-mutations-wave3.json','product-mutations-wave4.json',
  'product-mutations-wave5.json','product-mutations-wave6.json'];
 const prior=new Set(names.flatMap(name=>read('test/conformance-next/'+name).mutants.map(x=>x.vector_id)));
 assert.equal(prior.size,61);
 for(const id of IDS) assert.equal(prior.has(id),false,id);
 const full=read('test/corpus-next/negative-vectors.json').vectors;
 assert.equal(full.length,79);
 const combined=new Set([...prior,...IDS]);
 assert.equal(combined.size,67);
 assert.equal(full.filter(x=>!combined.has(x.id)).length,12);
});

test('wave7 mutation anchors occur exactly once, altered source remains syntactically valid',()=>{
 for(const m of cat.mutants){
  const original=fs.readFileSync(path.join(ROOT,m.file),'utf8');
  assert.equal(original.split(m.find).length-1,1,m.id);
  const mutant=original.replace(m.find,m.replace);
  assert.notEqual(mutant,original);
  const node=spawnSync(process.execPath,['--check','--input-type=module'],{
    input:mutant,encoding:'utf8',timeout:20000,maxBuffer:1024*1024,
  });
  assert.equal(node.error,undefined,node.error?.message);
  assert.equal(node.signal,null);
  assert.equal(node.status,0,m.id+': '+node.stderr);
 }
});
test('wave7 is discovered by the existing T19 CI, with one focused oracle for each vector',()=>{
 const s=SUITES.find(x=>x.id==='T19');
 const discovered=inspectSuite(s,ROOT);
 assert.equal(discovered.status,'READY');
 const paths=discovered.tests.map(x=>path.relative(ROOT,x));
 for(const name of ['catalog','campaign','schema-01','schema-04','schema-05',
  'schema-06','schema-07','schema-08'])
  assert.ok(paths.includes('test/conformance-next/wave7-'+name+'.test.mjs'),name);
});