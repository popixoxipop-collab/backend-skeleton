import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PERSISTENCE_CONFORMANCE_PROFILE,
	PERSISTENCE_CONFORMANCE_REPORT,
	evaluatePersistenceConformance,
} from '../../scanners/persistence-next/conformance.mjs';
import { PERSISTENCE_SOURCE_FACTS_CONTRACT, fromPersistenceSourceFacts } from '../../scanners/persistence-next/source-facts.mjs';

const ADMITTED = ['jpa-hibernate', 'sqlalchemy-sqlmodel', 'typeorm', 'active-record', 'prisma', 'django-orm', 'eloquent'];
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
