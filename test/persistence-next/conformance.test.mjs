import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import {
	PERSISTENCE_CONFORMANCE_PROFILE,
	validatePersistenceConformanceProfile,
	evaluatePersistenceConformance,
} from '../../scanners/persistence-next/conformance.mjs';

function ir(overrides={}) {
	return createPersistenceIr({
		provider:'prisma',source_kind:'source',
		entities:[{
			provider:'prisma',name:'User',
			table:{name:'users',schema:'auth',source:'explicit'},
			primary_key:{columns:['user_id'],type:'String',source:'source'},
			fields:[
				{name:'user_id',type:'String',nullable:false,source:'source'},
				{name:'email',type:'String',nullable:false,source:'source'},
			],
			relations:[],
		}],
		diagnostics:[],
		...overrides,
	});
}

function profile(overrides={}) {
	return {
		contract:PERSISTENCE_CONFORMANCE_PROFILE,
		id:'prisma-synthetic-user',
		persistence_id:'prisma',
		evidence_class:'synthetic',
		requested_scope:'contract',
		source_ref:{kind:'synthetic',id:'user-basic'},
		entities:[{
			name:'User',mode:'exact',
			table:{name:'users',schema:'auth',source:'explicit'},
			primary_key:{columns:['user_id'],type:'String',source:'source'},
			fields:[
				{name:'user_id',type:'String',nullable:false},
				{name:'email',type:'String',nullable:false},
			],
			relations:[],
		}],
		required_diagnostics:[],
		forbidden_diagnostics:['prisma-primary-key-unresolved'],
		allow_extra_entities:false,
		...overrides,
	};
}

test('synthetic conformance can pass but is visibly fixture-scoped, not runtime certified',()=>{
	const report=evaluatePersistenceConformance({ir:ir(),profile:profile()});
	assert.equal(report.status,'pass');
	assert.equal(report.evidence_class,'synthetic');
	assert.equal(report.certified_scope,'fixture-contract');
});

test('runtime scope cannot be requested from synthetic evidence',()=>{
	assert.throws(()=>validatePersistenceConformanceProfile(profile({requested_scope:'runtime'})),/runtime scope requires runtime evidence_class/);
});

test('pinned-repo evidence can certify only the requested non-runtime scope',()=>{
	const report=evaluatePersistenceConformance({ir:ir(),profile:profile({
		id:'prisma-pinned',
		evidence_class:'pinned-repo',
		requested_scope:'contract',
		source_ref:{repo:'example/repo',commit:'0'.repeat(40),path:'prisma/schema.prisma'},
	})});
	assert.equal(report.status,'pass');
	assert.equal(report.certified_scope,'contract');
});

test('provider mismatch fails even when entity shapes happen to match',()=>{
	const actual=createPersistenceIr({
		provider:'typeorm',source_kind:'source',
		entities:[{
			provider:'typeorm',name:'User',
			table:{name:'users',schema:'auth',source:'explicit'},
			primary_key:{columns:['user_id'],type:'String',source:'source'},
			fields:[
				{name:'user_id',type:'String',nullable:false,source:'source'},
				{name:'email',type:'String',nullable:false,source:'source'},
			],
			relations:[],
		}],
	});
	const report=evaluatePersistenceConformance({ir:actual,profile:profile()});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='provider-mismatch'));
});

test('ordered primary-key mismatch fails',()=>{
	const report=evaluatePersistenceConformance({
		ir:createPersistenceIr({provider:'prisma',source_kind:'source',entities:[{
			provider:'prisma',name:'Membership',
			table:{name:'memberships',source:'explicit'},
			primary_key:{columns:['user_id','tenant_id'],type:'composite',source:'source'},
		}]}),
		profile:profile({
			id:'ordered-pk',
			entities:[{
				name:'Membership',mode:'subset',
				table:{name:'memberships',source:'explicit'},
				primary_key:{columns:['tenant_id','user_id'],type:'composite',source:'source'},
				fields:[],relations:[],
			}],
			forbidden_diagnostics:[],
		}),
	});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='primary-key-columns-mismatch'));
});

test('exact entity mode rejects unexpected physical fields',()=>{
	const actual=ir();
	actual.entities[0].fields.push({name:'role',type:'String',nullable:false,source:'source'});
	const report=evaluatePersistenceConformance({ir:actual,profile:profile()});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='unexpected-field'));
});

test('subset entity mode permits extra fields but still requires declared fields',()=>{
	const actual=ir();
	actual.entities[0].fields.push({name:'role',type:'String',nullable:false,source:'source'});
	const p=profile();
	p.entities[0].mode='subset';
	const report=evaluatePersistenceConformance({ir:actual,profile:p});
	assert.equal(report.status,'pass');
});

test('relation comparison preserves local and referenced column order',()=>{
	const actual=createPersistenceIr({provider:'ef-core',source_kind:'source',entities:[{
		provider:'ef-core',name:'Membership',
		table:{name:'memberships',schema:'auth',source:'explicit'},
		primary_key:{columns:['tenant_id','user_id'],type:'composite',source:'source'},
		relations:[{
			columns:['tenant_id','organization_id'],
			references_table:'organizations',references_schema:'auth',
			references_columns:['tenant_id','id'],pairing:'resolved',source:'source',
		}],
	}]});
	const p=profile({
		id:'relation-order',
		persistence_id:'ef-core',
		entities:[{
			name:'Membership',mode:'subset',
			table:{name:'memberships',schema:'auth',source:'explicit'},
			primary_key:{columns:['tenant_id','user_id'],type:'composite',source:'source'},
			fields:[],
			relations:[{
				columns:['organization_id','tenant_id'],
				references_table:'organizations',references_schema:'auth',
				references_columns:['id','tenant_id'],pairing:'resolved',
			}],
		}],
		forbidden_diagnostics:[],
	});
	const report=evaluatePersistenceConformance({ir:actual,profile:p});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='relation-missing-or-mismatched'));
});

test('required and forbidden diagnostics are both enforced',()=>{
	const actual=ir({diagnostics:[{code:'expected-gap'},{code:'bad-gap'}]});
	const p=profile({required_diagnostics:['expected-gap'],forbidden_diagnostics:['bad-gap']});
	const report=evaluatePersistenceConformance({ir:actual,profile:p});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='forbidden-diagnostic-present'));
});

test('extra entities are rejected unless profile explicitly allows them',()=>{
	const actual=ir();
	actual.entities.push({
		id:'extra',provider:'prisma',name:'Audit',
		table:{name:'audit',schema:null,source:'explicit'},
		primary_key:{columns:['id'],type:'String',source:'source'},
		fields:[],relations:[],source_refs:[],
	});
	let report=evaluatePersistenceConformance({ir:actual,profile:profile()});
	assert.equal(report.status,'fail');
	assert.ok(report.failures.some((x)=>x.code==='unexpected-entity'));
	report=evaluatePersistenceConformance({ir:actual,profile:profile({allow_extra_entities:true})});
	assert.equal(report.status,'pass');
});
