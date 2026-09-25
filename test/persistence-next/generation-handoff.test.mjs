import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandleCompositionHandoff } from '../../scanners/persistence-next/generation-handoff.mjs';

function binding(overrides={}) {
	return {
		resource_id:'users',
		entity_id:'entity:user',
		persistence_id:'jpa-hibernate',
		capabilities:{
			verified_read_by_primary_key:true,
			key_shape:'single',
			key_type:'uuid',
			effective_key_type:'uuid',
		},
		...overrides,
	};
}

test('verified single UUID persistence binding is ready for T14 catalog lookup',()=>{
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:binding()});
	assert.deepEqual(out,{
		contract:'sbf.persistence-generation-handoff/1',status:'ready',
		providerId:'java-spring',persistenceId:'jpa-hibernate',keyType:'uuid',
		resourceId:'users',entityId:'entity:user',blockers:[],
	});
});

test('source-only persistence binding cannot become generation-ready',()=>{
	const b=binding();b.capabilities={...b.capabilities,verified_read_by_primary_key:false};
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='persistence-read-not-live-verified'));
});

test('composite keys remain blocked even if DB mapping itself is verified',()=>{
	const b=binding();b.capabilities={...b.capabilities,key_shape:'composite'};
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='unsupported-key-shape'));
});

test('non UUID key types remain blocked for current handles composition',()=>{
	const b=binding();b.capabilities={...b.capabilities,key_type:'bigint',effective_key_type:'bigint'};
	const out=buildHandleCompositionHandoff({http_provider_id:'typescript-express',binding:b});
	assert.equal(out.status,'blocked');
	assert.equal(out.keyType,'bigint');
	assert.ok(out.blockers.some((x)=>x.code==='unsupported-key-type'));
});

test('missing persistence identity is fail-closed',()=>{
	const b=binding();delete b.persistence_id;
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='persistence-id-missing'));
});
