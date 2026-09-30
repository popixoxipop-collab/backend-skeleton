import test from 'node:test';
import assert from 'node:assert/strict';
import { isPersistenceTargetAdmitted, persistenceTargetById } from '../../scanners/persistence-next/catalog.mjs';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { composeResourceBindings, verifyResourceBindingsAgainstObserved } from '../../scanners/persistence-next/bindings.mjs';
import { certifyPersistenceBindings } from '../../scanners/persistence-next/certification.mjs';
import { buildHandleCompositionHandoff } from '../../scanners/persistence-next/generation-handoff.mjs';
import {
	PERSISTENCE_SOURCE_FACTS_CONTRACT,
	validatePersistenceSourceFacts,
	fromPersistenceSourceFacts,
} from '../../scanners/persistence-next/source-facts.mjs';

// persistence_id matching is exact: no case folding, trimming or Unicode normalization anywhere.
const ADMITTED = ['jpa-hibernate', 'sqlalchemy-sqlmodel', 'typeorm', 'active-record', 'prisma', 'django-orm', 'eloquent'];
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;
const CONTEXT = {
	producer_revision: 'a'.repeat(40),
	candidate_revision: 'b'.repeat(40),
	profile_id: 'fu07-profile',
	execution_ref: 'fu07-run',
};

function variantsOf(id) {
	const fullwidth = [...id].map((ch) => (ch >= 'a' && ch <= 'z' ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('');
	return [
		`${id[0].toUpperCase()}${id.slice(1)}`,
		id.toUpperCase(),
		` ${id}`, `${id} `, `\t${id}`, `${id}\t`, `${id}\n`, `${id}\r\n`,
		` ${id}`, `${id} `, `﻿${id}`,
		`​${id}`, `${id}​`, `${id}\u0000`,
		fullwidth,
	];
}

function label(id, variant) {
	return `${id} -> ${JSON.stringify(variant)}`;
}

function facts(persistence_id) {
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
	};
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

function verifiedBindingResult(id) {
	const sourceIr = fromPersistenceSourceFacts(facts(id));
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

function codes(entries) {
	return entries.map((entry) => entry.code);
}

test('every spelling variant is a distinct string that is not a catalog id', () => {
	for (const id of ADMITTED) {
		const variants = variantsOf(id);
		assert.equal(new Set(variants).size, variants.length, id);
		for (const variant of variants) {
			assert.notEqual(variant, id, label(id, variant));
			assert.equal(persistenceTargetById(variant), null, label(id, variant));
		}
	}
});

for (const id of ADMITTED) {
	test(`isPersistenceTargetAdmitted is exact for ${id}`, () => {
		assert.equal(isPersistenceTargetAdmitted(id), true, id);
		for (const variant of variantsOf(id)) {
			assert.equal(isPersistenceTargetAdmitted(variant), false, label(id, variant));
		}
	});
}

for (const id of ADMITTED) {
	test(`source facts boundary is exact for ${id}`, () => {
		assert.doesNotThrow(() => validatePersistenceSourceFacts(facts(id)), id);
		for (const variant of variantsOf(id)) {
			assert.throws(
				() => validatePersistenceSourceFacts(facts(variant)),
				/persistence_id is not a registered persistence target/,
				`validate ${label(id, variant)}`,
			);
			assert.throws(
				() => fromPersistenceSourceFacts(facts(variant)),
				/persistence_id is not a registered persistence target/,
				`from ${label(id, variant)}`,
			);
		}
	});
}

for (const id of ADMITTED) {
	test(`binding-level certification and handoff are exact for ${id}`, () => {
		const control = certifyPersistenceBindings({
			http_provider_id: 'java-spring',
			binding_result: verifiedBindingResult(id),
			generation_context: CONTEXT,
		});
		assert.equal(control.status, 'runtime-read-verified', id);
		assert.equal(control.resources[0].generation_handoff.status, 'ready', id);
		assert.deepEqual(control.resources[0].blockers, [], id);

		for (const variant of variantsOf(id)) {
			const bindingResult = verifiedBindingResult(id);
			bindingResult.bindings[0].persistence_id = variant;
			const out = certifyPersistenceBindings({
				http_provider_id: 'java-spring',
				binding_result: bindingResult,
				generation_context: CONTEXT,
			});
			const resource = out.resources[0];
			const tag = label(id, variant);
			assert.equal(out.status, 'partial-or-blocked', tag);
			assert.equal(resource.status, 'blocked', tag);
			assert.equal(resource.scopes.generation_candidate, false, tag);
			assert.deepEqual(codes(resource.blockers), ['persistence-target-not-admitted'], tag);
			assert.equal(resource.generation_handoff.status, 'blocked', tag);
			assert.deepEqual(codes(resource.generation_handoff.blockers), ['persistence-target-not-admitted'], tag);
		}
	});
}

for (const id of ADMITTED) {
	test(`generation handoff is exact for ${id}`, () => {
		const seed = verifiedBindingResult(id).bindings[0];
		const ready = buildHandleCompositionHandoff({ http_provider_id: 'java-spring', binding: structuredClone(seed), ...CONTEXT });
		assert.equal(ready.status, 'ready', id);
		assert.deepEqual(ready.blockers, [], id);

		for (const variant of variantsOf(id)) {
			const binding = { ...structuredClone(seed), persistence_id: variant };
			const out = buildHandleCompositionHandoff({ http_provider_id: 'java-spring', binding, ...CONTEXT });
			const tag = label(id, variant);
			assert.notEqual(out.status, 'ready', tag);
			assert.equal(out.status, 'blocked', tag);
			assert.deepEqual(codes(out.blockers), ['persistence-target-not-admitted'], tag);
		}
	});
}
