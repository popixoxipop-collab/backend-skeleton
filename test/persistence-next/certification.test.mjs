import test from 'node:test';
import assert from 'node:assert/strict';
import { certifyPersistenceBindings } from '../../scanners/persistence-next/certification.mjs';

const SNAPSHOT_REF='sha256:'+'a'.repeat(64);

const GENERATION_CONTEXT={
	producer_revision:'a'.repeat(40),
	candidate_revision:'b'.repeat(40),
	profile_id:'java-spring+jpa-hibernate',
	execution_ref:'t10-live-verify:run-1',
};

function verifiedBinding(overrides={}) {
	return {
		resource_id:'users',
		entity_id:'entity:jpa-hibernate:User:users',
		persistence_id:'jpa-hibernate',
		table:{name:'users',schema:'public',source:'explicit'},
		primary_key:{columns:['id'],type:'uuid',source:'source'},
		capabilities:{
			candidate_read_by_primary_key:true,
			verified_read_by_primary_key:true,
			key_shape:'single',
			key_type:'uuid',
			effective_key_type:'uuid',
			key_type_status:'verified',
		},
		verification:{
			source_kind:'live',
			provider:'verified',
			expected_provider:'postgres-introspection',
			observed_provider:'postgres-introspection',
			expected_snapshot_ref:SNAPSHOT_REF,
			observed_snapshot_ref:SNAPSHOT_REF,
			table:'verified',
			primary_key:'verified',
			key_type:'verified',
		},
		...overrides,
	};
}

test('certification marks verified read while keeping write false and requires bound generation context',()=>{
	const cert=certifyPersistenceBindings({
		http_provider_id:'java-spring',
		binding_result:{bindings:[verifiedBinding()],conflicts:[],unbound_resources:[]},
		generation_context:GENERATION_CONTEXT,
	});
	assert.equal(cert.status,'runtime-read-verified');
	assert.equal(cert.resources[0].status,'runtime-read-verified');
	assert.equal(cert.resources[0].scopes.read_live_verified,true);
	assert.equal(cert.resources[0].scopes.write,false);
	assert.equal(cert.resources[0].scopes.generation_candidate,true);
	assert.equal(cert.resources[0].generation_handoff.persistenceId,'jpa-hibernate');
	assert.equal(cert.resources[0].generation_handoff.combinationId,'java-spring+jpa-hibernate+uuid');
});

test('runtime-read verification alone cannot become a generation candidate without immutable context',()=>{
	const cert=certifyPersistenceBindings({
		http_provider_id:'java-spring',
		binding_result:{bindings:[verifiedBinding()],conflicts:[],unbound_resources:[]},
	});
	assert.equal(cert.resources[0].status,'runtime-read-verified');
	assert.equal(cert.resources[0].scopes.generation_candidate,false);
	assert.ok(cert.resources[0].generation_handoff.blockers.some((x)=>x.code==='producer-revision-missing'));
	assert.ok(cert.resources[0].generation_handoff.blockers.some((x)=>x.code==='candidate-revision-missing'));
});

test('source-only binding remains blocked and is not a generation candidate',()=>{
	const b=verifiedBinding();
	b.capabilities={...b.capabilities,verified_read_by_primary_key:false};
	b.verification=null;
	const cert=certifyPersistenceBindings({
		http_provider_id:'java-spring',
		binding_result:{bindings:[b],conflicts:[],unbound_resources:[]},
		generation_context:GENERATION_CONTEXT,
	});
	assert.equal(cert.status,'partial-or-blocked');
	assert.equal(cert.resources[0].status,'blocked');
	assert.equal(cert.resources[0].scopes.generation_candidate,false);
	assert.ok(cert.resources[0].blockers.some((x)=>x.code==='read-by-primary-key-not-verified'));
});

test('verified composite mapping is runtime-readable but not current handles-generation candidate',()=>{
	const b=verifiedBinding({
		primary_key:{columns:['tenant_id','id'],type:'composite',source:'source'},
		capabilities:{
			candidate_read_by_primary_key:true,verified_read_by_primary_key:true,
			key_shape:'composite',key_type:'composite',effective_key_type:'composite',key_type_status:'source-only',
		},
	});
	const cert=certifyPersistenceBindings({
		http_provider_id:'java-spring',
		binding_result:{bindings:[b],conflicts:[],unbound_resources:[]},
		generation_context:GENERATION_CONTEXT,
	});
	assert.equal(cert.resources[0].status,'runtime-read-verified');
	assert.equal(cert.resources[0].scopes.generation_candidate,false);
	assert.ok(cert.resources[0].generation_handoff.blockers.some((x)=>x.code==='unsupported-key-shape'));
});

test('binding conflicts and unbound resources remain visible at certification boundary',()=>{
	const cert=certifyPersistenceBindings({
		http_provider_id:'java-spring',
		binding_result:{
			bindings:[verifiedBinding()],
			conflicts:[{resource_id:'orders',code:'multiple-entities'}],
			unbound_resources:[{resource_id:'audit',reason:'no entity_ref'}],
		},
		generation_context:GENERATION_CONTEXT,
	});
	assert.equal(cert.status,'partial-or-blocked');
	assert.deepEqual(cert.global_blockers.map((x)=>x.code),['binding-conflict','resource-unbound']);
});

test('T10 certification does not claim T14 catalog approval',()=>{
	const cert=certifyPersistenceBindings({
		http_provider_id:'typescript-express',
		binding_result:{bindings:[verifiedBinding({persistence_id:'prisma'})],conflicts:[],unbound_resources:[]},
		generation_context:{...GENERATION_CONTEXT,profile_id:'typescript-express+prisma'},
	});
	assert.equal(cert.resources[0].scopes.generation_candidate,true);
	assert.equal(cert.resources[0].generation_handoff.combinationId,'typescript-express+prisma+uuid');
	assert.match(cert.notes[1],/T14 must still approve/);
});
