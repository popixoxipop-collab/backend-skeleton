import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildHandleCompositionHandoff,
	bindHandleCompositionHandoffArtifact,
} from '../../scanners/persistence-next/generation-handoff.mjs';

const SNAPSHOT_REF='sha256:'+'a'.repeat(64);

const CONTEXT = {
	producer_revision:'a'.repeat(40),
	candidate_revision:'b'.repeat(40),
	profile_id:'java-spring+jpa-hibernate',
	execution_ref:'t10-live-verify:run-1',
};

function binding(overrides={}) {
	return {
		resource_id:'users',
		entity_id:'entity:jpa-hibernate:User:users',
		persistence_id:'jpa-hibernate',
		capabilities:{
			verified_read_by_primary_key:true,
			key_shape:'single',
			key_type:'uuid',
			effective_key_type:'uuid',
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

function ready(overrides={}) {
	return buildHandleCompositionHandoff({
		http_provider_id:'java-spring',
		binding:binding(),
		...CONTEXT,
		...overrides,
	});
}

function artifact(bytes) {
	return {
		artifact_ref:'sbf.artifact-ref/1',
		family:'persistence-generation-handoff',
		version:'1',
		media_type:'application/json',
		byte_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
		size_bytes:bytes.length,
	};
}

test('verified single UUID binding requires immutable generation provenance before it is ready',()=>{
	const out=ready();
	assert.equal(out.status,'ready');
	assert.equal(out.providerId,'java-spring');
	assert.equal(out.persistenceId,'jpa-hibernate');
	assert.equal(out.keyType,'uuid');
	assert.equal(out.combinationId,'java-spring+jpa-hibernate+uuid');
	assert.equal(out.producerRevision,CONTEXT.producer_revision);
	assert.equal(out.candidateRevision,CONTEXT.candidate_revision);
	assert.equal(out.profileId,CONTEXT.profile_id);
	assert.equal(out.executionRef,CONTEXT.execution_ref);
	assert.equal(out.liveProvider,'postgres-introspection');
	assert.equal(out.liveSnapshotRef,SNAPSHOT_REF);
	assert.deepEqual(out.blockers,[]);
});

test('missing immutable generation context is fail-closed even for a live-verified UUID binding',()=>{
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:binding()});
	assert.equal(out.status,'blocked');
	assert.deepEqual(
		out.blockers.map((x)=>x.code),
		['producer-revision-missing','candidate-revision-missing','profile-id-missing','execution-ref-missing'],
	);
});

test('missing live verifier identity is fail-closed',()=>{
	const b=binding({verification:{source_kind:'live',table:'verified',primary_key:'verified',key_type:'verified'}});
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='live-provider-not-verified'));
});

test('missing live snapshot identity is fail-closed',()=>{
	const b=binding(); delete b.verification.observed_snapshot_ref;
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='live-snapshot-not-verified'));
});

test('source-only persistence binding cannot become generation-ready',()=>{
	const b=binding();b.capabilities={...b.capabilities,verified_read_by_primary_key:false};
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='persistence-read-not-live-verified'));
});

test('composite keys remain blocked even if DB mapping itself is verified',()=>{
	const b=binding();b.capabilities={...b.capabilities,key_shape:'composite'};
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='unsupported-key-shape'));
});

test('non UUID key types remain blocked for current handles composition',()=>{
	const b=binding();b.capabilities={...b.capabilities,key_type:'bigint',effective_key_type:'bigint'};
	const out=buildHandleCompositionHandoff({http_provider_id:'typescript-express',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.equal(out.keyType,'bigint');
	assert.ok(out.blockers.some((x)=>x.code==='unsupported-key-type'));
});

test('missing persistence identity is fail-closed',()=>{
	const b=binding();delete b.persistence_id;
	const out=buildHandleCompositionHandoff({http_provider_id:'java-spring',binding:b,...CONTEXT});
	assert.equal(out.status,'blocked');
	assert.ok(out.blockers.some((x)=>x.code==='persistence-id-missing'));
});

test('exact handoff bytes bind to a T01 ArtifactRef without self-accepting certification',()=>{
	const handoff=ready();
	const bytes=Buffer.from(JSON.stringify(handoff));
	const ref=artifact(bytes);
	const bound=bindHandleCompositionHandoffArtifact({handoff_bytes:bytes,artifact_ref:ref});
	assert.equal(bound.status,'bound');
	assert.equal(bound.producerRevision,CONTEXT.producer_revision);
	assert.equal(bound.candidateRevision,CONTEXT.candidate_revision);
	assert.equal(bound.combinationId,'java-spring+jpa-hibernate+uuid');
	assert.equal(bound.profileId,CONTEXT.profile_id);
	assert.equal(bound.executionRef,CONTEXT.execution_ref);
	assert.equal(bound.liveProvider,'postgres-introspection');
	assert.equal(bound.liveSnapshotRef,SNAPSHOT_REF);
	assert.deepEqual(bound.artifactRef,ref);
	assert.match(bound.note,/independent T19\/T14 acceptance/);
});

test('handoff ArtifactRef substitution or byte drift fails closed',()=>{
	const handoff=ready();
	const bytes=Buffer.from(JSON.stringify(handoff));
	const ref=artifact(bytes);
	assert.throws(
		()=>bindHandleCompositionHandoffArtifact({handoff_bytes:Buffer.concat([bytes,Buffer.from(' ')]),artifact_ref:ref}),
		/do not match ArtifactRef/,
	);
	assert.throws(
		()=>bindHandleCompositionHandoffArtifact({
			handoff_bytes:bytes,
			artifact_ref:{...ref,byte_sha256:'0'.repeat(64)},
		}),
		/do not match ArtifactRef/,
	);
});
