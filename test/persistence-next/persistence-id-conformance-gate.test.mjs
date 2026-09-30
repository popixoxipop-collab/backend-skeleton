import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PERSISTENCE_CONFORMANCE_PROFILE,
	PERSISTENCE_CONFORMANCE_REPORT,
	evaluatePersistenceConformance,
} from '../../scanners/persistence-next/conformance.mjs';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { PERSISTENCE_SOURCE_FACTS_CONTRACT, fromPersistenceSourceFacts } from '../../scanners/persistence-next/source-facts.mjs';

const ADMITTED = ['jpa-hibernate', 'sqlalchemy-sqlmodel', 'typeorm', 'active-record', 'prisma', 'django-orm', 'eloquent'];
const BLOCKED = ['drizzle', 'sequelize', 'ef-core', 'gorm', 'diesel'];
const NOT_ADMITTED_PROVIDERS = ['diesel', 'totally-made-up', 'migration:flyway', 'DIESEL', 'diesel '];
const PRISMA_VARIANTS = ['Prisma', 'PRISMA', ' prisma', 'prisma ', 'prisma\n', ' prisma', '​prisma', 'ｐｒｉｓｍａ'];
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;
// [evidence_class, requested_scope, certified_scope of a passing report]
const EVIDENCE = [
	['synthetic', 'contract', 'fixture-contract'],
	['pinned-repo', 'contract', 'contract'],
	['runtime', 'runtime', 'runtime'],
];

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
			fields: [{ name: 'id', type: 'uuid', nullable: false, source: 'source' }],
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

function assertOnlyNotAdmitted(report, persistenceId, tag) {
	assert.equal(report.status, 'fail', tag);
	assert.equal(report.certified_scope, null, tag);
	assert.deepEqual(report.failures, [{ code: 'persistence-target-not-admitted', persistence_id: persistenceId }], tag);
}

// A profile that matches the first entity of `ir` exactly, so no shape failure can mask the id check.
function profileFor(ir, overrides = {}) {
	const entity = ir.entities[0];
	return {
		contract: PERSISTENCE_CONFORMANCE_PROFILE,
		id: 'fu07-conformance',
		persistence_id: ir.provider,
		evidence_class: 'runtime',
		requested_scope: 'runtime',
		source_ref: { kind: 'synthetic', id: 'fu07' },
		entities: [{
			name: entity.name,
			mode: 'exact',
			table: { name: entity.table.name, schema: entity.table.schema, source: entity.table.source },
			primary_key: { columns: entity.primary_key.columns, type: entity.primary_key.type, source: entity.primary_key.source },
			fields: entity.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
			relations: [],
		}],
		required_diagnostics: [],
		forbidden_diagnostics: [],
		allow_extra_entities: false,
		...overrides,
	};
}

for (const id of ADMITTED) {
	test(`conformance report for admitted target ${id} is unchanged`, () => {
		const ir = fromPersistenceSourceFacts(facts(id));
		for (const [evidence_class, requested_scope, certified_scope] of EVIDENCE) {
			const profile = profileFor(ir, { id: `fu07-${id}`, evidence_class, requested_scope });
			const report = evaluatePersistenceConformance({ ir, profile });
			const expected = {
				contract: PERSISTENCE_CONFORMANCE_REPORT,
				profile_id: `fu07-${id}`,
				persistence_id: id,
				status: 'pass',
				evidence_class,
				requested_scope,
				certified_scope,
				failures: [],
				counts: { expected_entities: 1, actual_entities: 1, diagnostics: 0 },
			};
			assert.deepEqual(report, expected, `${id}/${evidence_class}`);
			assert.equal(JSON.stringify(report), JSON.stringify(expected), `${id}/${evidence_class} serialized`);
		}
	});
}

test('conformance identity check is on the IR provider: an admitted IR is not failed for the profile id alone', () => {
	const ir = fromPersistenceSourceFacts(facts('prisma'));
	const report = evaluatePersistenceConformance({ ir, profile: profileFor(ir, { persistence_id: 'diesel' }) });
	assert.equal(report.status, 'fail');
	assert.equal(report.certified_scope, null);
	assert.deepEqual(report.failures, [{ code: 'provider-mismatch', expected: 'diesel', actual: 'prisma' }]);
});

for (const id of BLOCKED) {
	test(`conformance cannot certify blocked target ${id} at any evidence class`, () => {
		const ir = fromPersistenceSourceFacts(facts(id));
		for (const [evidence_class, requested_scope] of EVIDENCE) {
			const report = evaluatePersistenceConformance({ ir, profile: profileFor(ir, { evidence_class, requested_scope }) });
			assertOnlyNotAdmitted(report, id, `${id}/${evidence_class}`);
			assert.equal(report.persistence_id, id, `${id}/${evidence_class}`);
		}
	});
}

test('a profile that requires the persistence-target-blocked diagnostic still cannot certify a blocked target', () => {
	for (const id of BLOCKED) {
		const ir = fromPersistenceSourceFacts(facts(id));
		const report = evaluatePersistenceConformance({ ir, profile: profileFor(ir, { required_diagnostics: ['persistence-target-blocked'] }) });
		assertOnlyNotAdmitted(report, id, id);
	}
});

test('the conformance gate keys on the catalog id, so stripping the blocked marker from the IR changes nothing', () => {
	for (const id of BLOCKED) {
		const ir = fromPersistenceSourceFacts(facts(id));
		ir.diagnostics = ir.diagnostics.filter((diagnostic) => diagnostic.code !== 'persistence-target-blocked');
		delete ir.metadata.persistence_target_state;
		assertOnlyNotAdmitted(evaluatePersistenceConformance({ ir, profile: profileFor(ir) }), id, id);
	}
});

for (const provider of NOT_ADMITTED_PROVIDERS) {
	test(`conformance cannot certify an IR built directly for non-admitted provider ${JSON.stringify(provider)}`, () => {
		const ir = directIr(provider);
		assert.equal(ir.provider, provider);
		assertOnlyNotAdmitted(evaluatePersistenceConformance({ ir, profile: profileFor(ir) }), provider, provider);
	});
}

test('conformance cannot certify a live introspection IR because postgres-introspection is not a catalog target', () => {
	const ir = liveIr();
	assertOnlyNotAdmitted(evaluatePersistenceConformance({ ir, profile: profileFor(ir) }), 'postgres-introspection', 'live');
});

test('conformance matches the persistence id exactly, so spelling variants of an admitted id are not certified', () => {
	for (const variant of PRISMA_VARIANTS) {
		const ir = directIr(variant);
		assert.equal(ir.provider, variant);
		assertOnlyNotAdmitted(evaluatePersistenceConformance({ ir, profile: profileFor(ir) }), variant, JSON.stringify(variant));
	}
});

test('a blocked IR under an admitted profile id reports both provider-mismatch and persistence-target-not-admitted', () => {
	const ir = fromPersistenceSourceFacts(facts('diesel'));
	const report = evaluatePersistenceConformance({ ir, profile: profileFor(ir, { persistence_id: 'prisma' }) });
	assert.equal(report.status, 'fail');
	assert.equal(report.certified_scope, null);
	assert.deepEqual(report.failures.map((failure) => failure.code).sort(), ['persistence-target-not-admitted', 'provider-mismatch']);
});

test('the catalog failure is added to the shape failures instead of replacing them', () => {
	const ir = fromPersistenceSourceFacts(facts('gorm'));
	const profile = profileFor(ir);
	profile.entities[0].table.name = 'accounts';
	const report = evaluatePersistenceConformance({ ir, profile });
	assert.equal(report.status, 'fail');
	assert.equal(report.certified_scope, null);
	assert.deepEqual(report.failures.map((failure) => failure.code).sort(), ['persistence-target-not-admitted', 'table-mismatch']);
});
