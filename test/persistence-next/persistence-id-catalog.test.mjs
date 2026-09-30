import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../../scanners/persistence-next/catalog.mjs';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { composeResourceBindings, verifyResourceBindingsAgainstObserved } from '../../scanners/persistence-next/bindings.mjs';
import { certifyPersistenceBindings } from '../../scanners/persistence-next/certification.mjs';
import { buildHandleCompositionHandoff } from '../../scanners/persistence-next/generation-handoff.mjs';
import {
	PERSISTENCE_SOURCE_FACTS_CONTRACT,
	validatePersistenceSourceFacts,
	fromPersistenceSourceFacts,
} from '../../scanners/persistence-next/source-facts.mjs';

const ADMITTED = ['jpa-hibernate', 'sqlalchemy-sqlmodel', 'typeorm', 'active-record', 'prisma', 'django-orm', 'eloquent'];
const BLOCKED = ['drizzle', 'sequelize', 'ef-core', 'gorm', 'diesel'];
const UNREGISTERED = [
	'totally-made-up', 'postgres-introspection', 'DIESEL', 'Diesel', ' diesel', 'diesel ', 'diesel\n',
	'__proto__', 'constructor', 'toString',
];
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;
const CONTEXT = {
	producer_revision: 'a'.repeat(40),
	candidate_revision: 'b'.repeat(40),
	profile_id: 'fu07-profile',
	execution_ref: 'fu07-run',
};

function facts(persistence_id, overrides = {}) {
	return {
		contract: PERSISTENCE_SOURCE_FACTS_CONTRACT,
		producer_id: 'fu07-test-producer',
		persistence_id,
		language: 'rust',
		complete: true,
		entities: [{
			name: 'User',
			source: { file: 'src/user.rs', line: 3, detail: 'model' },
			table: { name: 'users', schema: 'public', basis: 'explicit' },
			primary_key: { columns: ['id'], type: 'uuid', basis: 'explicit' },
			fields: [{ name: 'id', type: 'uuid', nullable: false, basis: 'explicit' }],
			relations: [],
		}],
		unknowns: [],
		...overrides,
	};
}

function goldenIr(id) {
	return {
		contract: 'sbf.persistence-ir/1',
		provider: id,
		source_kind: 'source',
		entities: [{
			id: `entity:${id}:User:src%2Fuser.rs`,
			provider: id,
			name: 'User',
			module: null,
			file: 'src/user.rs',
			table: { name: 'users', schema: 'public', source: 'explicit' },
			primary_key: { columns: ['id'], type: 'uuid', source: 'source' },
			fields: [{ name: 'id', type: 'uuid', nullable: false, source: 'source' }],
			relations: [],
			source_refs: [{ kind: 'source', provider: id, file: 'src/user.rs', line: 3, detail: 'model' }],
		}],
		diagnostics: [],
		metadata: {
			upstream_contract: 'bskel.internal.persistence-source-facts/0',
			producer_id: 'fu07-test-producer',
			language: 'rust',
			upstream_complete: true,
		},
	};
}

function directIr(provider) {
	return createPersistenceIr({
		provider,
		source_kind: 'source',
		entities: [{
			provider,
			name: 'User',
			file: 'src/user.rs',
			table: { name: 'users', schema: 'public', source: 'explicit' },
			primary_key: { columns: ['id'], type: 'uuid', source: 'source' },
		}],
	});
}

function liveIr() {
	return createPersistenceIr({
		provider: 'postgres-introspection',
		source_kind: 'live',
		metadata: { snapshot_ref: SNAPSHOT },
		entities: [{
			provider: 'postgres-introspection',
			name: 'users',
			table: { name: 'users', schema: 'public', source: 'observed' },
			primary_key: { columns: ['id'], type: 'unknown', source: 'live' },
			fields: [{ name: 'id', type: 'uuid', nullable: false, source: 'live' }],
		}],
	});
}

function verifiedBindings(sourceIr) {
	const composed = composeResourceBindings({
		resources: [{ id: 'users', entity_ref: sourceIr.entities[0].id }],
		persistence: sourceIr,
	});
	return verifyResourceBindingsAgainstObserved({
		binding_result: composed,
		observed: liveIr(),
		expected_live_provider: 'postgres-introspection',
		expected_live_snapshot_ref: SNAPSHOT,
	});
}

function certify(sourceIr) {
	return certifyPersistenceBindings({
		http_provider_id: 'java-spring',
		binding_result: verifiedBindings(sourceIr),
		generation_context: CONTEXT,
	});
}

function assertNotAdmittedAndBlocked(out) {
	const resource = out.resources[0];
	assert.equal(out.status, 'partial-or-blocked');
	assert.equal(resource.status, 'blocked');
	assert.equal(resource.scopes.generation_candidate, false);
	assert.equal(resource.generation_handoff.status, 'blocked');
	assert.ok(resource.blockers.some((b) => b.code === 'persistence-target-not-admitted'), 'certification blocker');
	assert.ok(resource.generation_handoff.blockers.some((b) => b.code === 'persistence-target-not-admitted'), 'handoff blocker');
}

for (const id of UNREGISTERED) {
	test(`source facts reject unregistered persistence_id ${JSON.stringify(id)}`, () => {
		assert.throws(() => validatePersistenceSourceFacts(facts(id)), /persistence_id is not a registered persistence target/);
		assert.throws(() => fromPersistenceSourceFacts(facts(id)), /persistence_id is not a registered persistence target/);
	});
}

test('source facts still reject a non-string or empty persistence_id before any catalog lookup', () => {
	for (const value of [undefined, null, '', '   ', 5, true, {}, ['diesel'], { id: 'diesel' }]) {
		assert.throws(() => validatePersistenceSourceFacts(facts(value)), /persistence_id must be a non-empty string/, String(JSON.stringify(value)));
	}
});

for (const id of BLOCKED) {
	test(`blocked target ${id} is accepted only with an explicit blocked marker`, () => {
		const target = catalog.persistenceTargetById(id);
		assert.equal(target.state, 'blocked-upstream-facts');
		const ir = fromPersistenceSourceFacts(facts(id));
		const markers = ir.diagnostics.filter((d) => d.code === 'persistence-target-blocked');
		assert.equal(markers.length, 1);
		assert.equal(markers[0].level, 'warning');
		assert.equal(markers[0].producer, 'fu07-test-producer');
		assert.equal(markers[0].persistence_id, id);
		assert.equal(markers[0].blocker, target.blocker);
		assert.equal(ir.metadata.persistence_target_state, 'blocked-upstream-facts');
		assert.equal(ir.provider, id);
		assert.equal(ir.entities.length, 1);
		assert.equal(ir.entities[0].table.source, 'explicit');
	});
}

test('blocked marker coexists with upstream unknown and incomplete diagnostics', () => {
	const ir = fromPersistenceSourceFacts(facts('ef-core', {
		complete: false,
		unknowns: [{ code: 'SEMANTIC_MODEL_UNAVAILABLE', entity: 'User', reason: 'Roslyn semantic model not available' }],
	}));
	assert.deepEqual(
		ir.diagnostics.map((d) => d.code).sort(),
		['persistence-target-blocked', 'upstream-persistence-facts-incomplete', 'upstream-persistence-unknown'],
	);
	assert.equal(ir.metadata.upstream_complete, false);
	assert.equal(ir.metadata.persistence_target_state, 'blocked-upstream-facts');
});

for (const id of ADMITTED) {
	test(`admitted target ${id} produces the unchanged IR with no blocked marker`, () => {
		const ir = fromPersistenceSourceFacts(facts(id));
		assert.deepEqual(ir, goldenIr(id));
		assert.equal(ir.diagnostics.some((d) => d.code === 'persistence-target-blocked'), false);
		assert.equal('persistence_target_state' in ir.metadata, false);
	});
}

test('admitted target keeps its unknown and incomplete diagnostics exactly as before', () => {
	const ir = fromPersistenceSourceFacts(facts('prisma', {
		complete: false,
		unknowns: [{ code: 'IMPLICIT_ID', entity: 'User', reason: 'implicit id' }],
	}));
	assert.deepEqual(ir.diagnostics, [
		{
			code: 'upstream-persistence-unknown', level: 'info', producer: 'fu07-test-producer',
			source_code: 'IMPLICIT_ID', entity: 'User', message: 'implicit id',
		},
		{
			code: 'upstream-persistence-facts-incomplete', level: 'warning', producer: 'fu07-test-producer',
			message: 'upstream analysis reports complete=false; emitted facts are preserved but cannot imply full persistence coverage',
		},
	]);
	assert.deepEqual(Object.keys(ir.metadata).sort(), ['language', 'producer_id', 'upstream_complete', 'upstream_contract']);
});

test('isPersistenceTargetAdmitted admits exactly the implemented-draft catalog targets', () => {
	for (const target of catalog.PERSISTENCE_TARGET_CATALOG) {
		assert.equal(catalog.isPersistenceTargetAdmitted(target.id), target.state === 'implemented-draft', target.id);
	}
	for (const id of ADMITTED) assert.equal(catalog.isPersistenceTargetAdmitted(id), true, id);
	for (const id of BLOCKED) assert.equal(catalog.isPersistenceTargetAdmitted(id), false, id);
	for (const id of [...UNREGISTERED, undefined, null, '', 5, {}, ['prisma']]) {
		assert.equal(catalog.isPersistenceTargetAdmitted(id), false, JSON.stringify(id) ?? String(id));
	}
});

for (const id of ADMITTED) {
	test(`admitted target ${id} still reaches runtime-read-verified and a ready handoff`, () => {
		const out = certify(fromPersistenceSourceFacts(facts(id)));
		const resource = out.resources[0];
		assert.equal(out.status, 'runtime-read-verified');
		assert.equal(resource.status, 'runtime-read-verified');
		assert.equal(resource.persistence_id, id);
		assert.equal(resource.scopes.generation_candidate, true);
		assert.equal(resource.generation_handoff.status, 'ready');
		assert.deepEqual(resource.blockers, []);
		assert.deepEqual(resource.generation_handoff.blockers, []);
	});
}

for (const id of BLOCKED) {
	test(`blocked target ${id} cannot reach runtime-read-verified or a ready handoff`, () => {
		assertNotAdmittedAndBlocked(certify(fromPersistenceSourceFacts(facts(id))));
	});
}

for (const id of ['diesel', 'totally-made-up', 'postgres-introspection']) {
	test(`IR built directly for non-admitted provider ${id} cannot bypass certification`, () => {
		assertNotAdmittedAndBlocked(certify(directIr(id)));
	});
}

test('generation handoff refuses a hand-built binding whose persistence_id is not admitted', () => {
	const seed = verifiedBindings(fromPersistenceSourceFacts(facts('jpa-hibernate'))).bindings[0];
	const ready = buildHandleCompositionHandoff({ http_provider_id: 'java-spring', binding: seed, ...CONTEXT });
	assert.equal(ready.status, 'ready');
	for (const id of [...BLOCKED, 'totally-made-up', 'DIESEL', '__proto__']) {
		const binding = { ...structuredClone(seed), persistence_id: id };
		const out = buildHandleCompositionHandoff({ http_provider_id: 'java-spring', binding, ...CONTEXT });
		assert.equal(out.status, 'blocked', id);
		assert.ok(out.blockers.some((b) => b.code === 'persistence-target-not-admitted'), id);
	}
});

test('a binding without persistence_id keeps the existing handoff blocker and cannot be certified', () => {
	const bindingResult = verifiedBindings(fromPersistenceSourceFacts(facts('jpa-hibernate')));
	delete bindingResult.bindings[0].persistence_id;
	const handoff = buildHandleCompositionHandoff({ http_provider_id: 'java-spring', binding: bindingResult.bindings[0], ...CONTEXT });
	assert.equal(handoff.status, 'blocked');
	assert.ok(handoff.blockers.some((b) => b.code === 'persistence-id-missing'));
	const out = certifyPersistenceBindings({ http_provider_id: 'java-spring', binding_result: bindingResult, generation_context: CONTEXT });
	assert.equal(out.resources[0].status, 'blocked');
	assert.equal(out.resources[0].scopes.generation_candidate, false);
});
