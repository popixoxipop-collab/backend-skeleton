import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRelation,createPersistenceIr
} from '../../scanners/persistence-next/ir.mjs';
import {
  composeResourceBindings,matchPhysicalTable
} from '../../scanners/persistence-next/bindings.mjs';
import {compareSourceMigrationLive} from '../../scanners/persistence-next/drift.mjs';

const ir=(provider,sourceKind,name,schema,primaryColumns=['id'])=>createPersistenceIr({
 provider,source_kind:sourceKind,
 entities:[{provider,name,file:'src/'+provider+'.ts',
  table:{name:'users',schema,source:'explicit'},
  primary_key:{columns:primaryColumns,type:'uuid',source:sourceKind}}]
});

test('NEG-DB-01 composite foreign key order is preserved and an unknown pairing is never silently resolved',()=>{
 const relation={
  columns:['tenant_id','parent_id'],
  references_table:'parents',
  references_schema:'shared',
  references_columns:['tenant_id','id'],
  source:'source',
 };
 const result=normalizeRelation(relation);
 assert.deepEqual(result.columns,relation.columns);
 assert.deepEqual(result.references_columns,relation.references_columns);
 assert.equal(result.references_schema,'shared');
 assert.equal(result.pairing,'unknown',
  'equal column counts do not prove composite FK pairing');
 const sourceClaim=normalizeRelation({...relation,pairing:'resolved'});
 assert.deepEqual(sourceClaim.columns,relation.columns);
 assert.deepEqual(sourceClaim.references_columns,relation.references_columns);
 assert.equal(sourceClaim.pairing,'resolved',
  'explicit pairing evidence is not replaced by the conservative unknown default');
});

test('NEG-DB-02 similar resource/entity names never create an implicit data-fetch binding',()=>{
 const persistence=ir('typeorm','source','User','public');
 const resource={id:'users',name:'User',table:'users'};
 const result=composeResourceBindings({resources:[resource],persistence});
 assert.equal(result.bindings.length,0,'name similarity is never evidence for an implicit binding');
 assert.deepEqual(result.unbound_resources.map(x=>x.resource_id),['users']);
 assert.match(result.unbound_resources[0].reason,/no explicit binding/);
 assert.equal(result.conflicts.length,0);
 const admitted=composeResourceBindings({
  resources:[{...resource,entity_ref:persistence.entities[0].id}],persistence
 });
 assert.equal(admitted.bindings.length,1);
 assert.equal(admitted.bindings[0].entity_id,persistence.entities[0].id);
 assert.equal(admitted.bindings[0].capabilities.verified_read_by_primary_key,false,
  'explicit binding without live DB proof is still not verified for execution');
});

test('NEG-DB-03 identical table names in distinct physical schemas never collide',()=>{
 const persistence=createPersistenceIr({provider:'typeorm',source_kind:'source',entities:[
  {provider:'typeorm',name:'UserA',file:'a.ts',table:{name:'users',schema:'tenant_a',source:'explicit'}},
  {provider:'typeorm',name:'UserB',file:'b.ts',table:{name:'users',schema:'tenant_b',source:'explicit'}}
 ]});
 assert.deepEqual(matchPhysicalTable({persistence,schema:'tenant_a',table:'users'}).map(x=>x.name),['UserA']);
 assert.deepEqual(matchPhysicalTable({persistence,schema:'tenant_b',table:'users'}).map(x=>x.name),['UserB']);
 assert.deepEqual(matchPhysicalTable({persistence,schema:'tenant_c',table:'users'}),[]);
 assert.deepEqual(matchPhysicalTable({persistence,table:'users'}),[],
  'a missing schema is not permission to guess which tenant table is intended');
});

test('NEG-DB-06 source/migration/live disagreement is visible on each relevant plane',()=>{
 const source=ir('typeorm','source','User','public');
 const migrations=ir('flyway','migration','User','public');
 const live=ir('postgres','live','User','public',['tenant_id']);
 const compared=compareSourceMigrationLive({source,migrations,live});
 assert.deepEqual(compared.comparisons.map(x=>x.name),
  ['source-vs-migrations','source-vs-live','migrations-vs-live']);
 assert.deepEqual(compared.comparisons[0].findings,[]);
 for(const plane of compared.comparisons.slice(1)){
  assert.ok(plane.findings.some(x=>x.code==='primary-key-mismatch'));
  assert.deepEqual(plane.findings.find(x=>x.code==='primary-key-mismatch').expected,['id']);
  assert.deepEqual(plane.findings.find(x=>x.code==='primary-key-mismatch').observed,['tenant_id']);
 }
});