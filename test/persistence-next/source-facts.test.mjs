import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PERSISTENCE_SOURCE_FACTS_CONTRACT,
	validatePersistenceSourceFacts,
	fromPersistenceSourceFacts,
} from '../../scanners/persistence-next/source-facts.mjs';

function base(overrides={}) {
	return {
		contract:PERSISTENCE_SOURCE_FACTS_CONTRACT,
		producer_id:'t08-csharp-efcore',
		persistence_id:'ef-core',
		language:'csharp',
		complete:true,
		entities:[{
			id:'ef:user',
			name:'User',
			module:'Accounts',
			source:{file:'src/User.cs',line:10,detail:'EF Core model'},
			table:{name:'users',schema:'auth',basis:'explicit'},
			primary_key:{columns:['tenant_id','user_id'],type:'composite',basis:'explicit'},
			fields:[
				{name:'tenant_id',type:'Guid',nullable:false,basis:'explicit'},
				{name:'user_id',type:'Guid',nullable:false,basis:'explicit'},
			],
			relations:[{
				columns:['tenant_id','org_id'],
				references_table:'organizations',
				references_schema:'auth',
				references_columns:['tenant_id','org_id'],
				pairing:'resolved',
			}],
		}],
		unknowns:[],
		...overrides,
	};
}

test('source facts bridge preserves explicit physical identity and ordered relation columns',()=>{
	const ir=fromPersistenceSourceFacts(base());
	assert.equal(ir.provider,'ef-core');
	assert.equal(ir.entities[0].table.source,'explicit');
	assert.deepEqual(ir.entities[0].primary_key.columns,['tenant_id','user_id']);
	assert.deepEqual(ir.entities[0].relations[0].columns,['tenant_id','org_id']);
	assert.deepEqual(ir.entities[0].relations[0].references_columns,['tenant_id','org_id']);
	assert.equal(ir.metadata.producer_id,'t08-csharp-efcore');
});

test('default physical names remain inferred rather than explicit',()=>{
	const facts=base();
	facts.persistence_id='gorm';
	facts.language='go';
	facts.producer_id='t08-go-gorm';
	facts.entities[0].table={name:'users',schema:null,basis:'default'};
	facts.entities[0].fields=[{name:'id',type:'uuid.UUID',nullable:false,basis:'default'}];
	facts.entities[0].primary_key={columns:['id'],type:'uuid',basis:'default'};
	const ir=fromPersistenceSourceFacts(facts);
	assert.equal(ir.entities[0].table.source,'inferred');
	assert.equal(ir.entities[0].fields[0].source,'source-default');
});

test('unknown table basis cannot carry a guessed table name',()=>{
	const facts=base();
	facts.entities[0].table={name:'users',schema:null,basis:'unknown'};
	assert.throws(()=>validatePersistenceSourceFacts(facts),/unknown basis/);
});

test('unknown PK basis cannot carry guessed columns',()=>{
	const facts=base();
	facts.entities[0].primary_key={columns:['id'],type:'uuid',basis:'unknown'};
	assert.throws(()=>validatePersistenceSourceFacts(facts),/cannot carry columns/);
});

test('resolved relation requires a table and equal non-empty column lists',()=>{
	const facts=base();
	facts.entities[0].relations[0]={columns:['tenant_id'],references_table:'organizations',references_columns:['tenant_id','id'],pairing:'resolved'};
	assert.throws(()=>validatePersistenceSourceFacts(facts),/resolved pairing/);
});

test('incomplete upstream report remains usable but visibly diagnosed',()=>{
	const facts=base({complete:false,unknowns:[{code:'SEMANTIC_MODEL_UNAVAILABLE',entity:'User',reason:'Roslyn semantic model not available'}]});
	const ir=fromPersistenceSourceFacts(facts);
	assert.equal(ir.entities.length,1);
	assert.ok(ir.diagnostics.some((d)=>d.code==='upstream-persistence-facts-incomplete'));
	assert.ok(ir.diagnostics.some((d)=>d.source_code==='SEMANTIC_MODEL_UNAVAILABLE'));
	assert.equal(ir.metadata.upstream_complete,false);
});

test('duplicate upstream entity ids fail closed',()=>{
	const facts=base();
	facts.entities=[facts.entities[0],structuredClone(facts.entities[0])];
	assert.throws(()=>validatePersistenceSourceFacts(facts),/duplicate persistence source entity id/);
});
