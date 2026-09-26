import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceIr } from '../../scanners/persistence-next/ir.mjs';
import { comparePersistenceIr, compareSourceMigrationLive } from '../../scanners/persistence-next/drift.mjs';

function ir(provider, sourceKind, entities) { return createPersistenceIr({ provider, source_kind: sourceKind, entities }); }

test('explicit table absent from live is high-confidence drift', () => {
	const source = ir('jpa','source',[{ provider:'jpa', name:'User', table:{name:'users',schema:'public',source:'explicit'}, primary_key:{columns:['id'],source:'source'}, fields:[{name:'id',source:'source'}] }]);
	const live = ir('postgres','live',[]);
	const out = comparePersistenceIr({ expected: source, observed: live, default_schema:'public' });
	assert.deepEqual(out.findings[0], { entity_id: source.entities[0].id, code:'table-missing', table:'users', confidence:'high' });
});

test('inferred table absence is reported with medium confidence', () => {
	const source = ir('sqlmodel','source',[{ provider:'sqlmodel', name:'User', table:{name:'user',source:'inferred'}, primary_key:{columns:['id'],source:'source'} }]);
	const live = ir('postgres','live',[]);
	assert.equal(comparePersistenceIr({ expected:source, observed:live }).findings[0].confidence,'medium');
});

test('known expected key and unknown migration PK becomes unknown, not mismatch', () => {
	const source = ir('jpa','source',[{ provider:'jpa', name:'User', table:{name:'users',source:'explicit'}, primary_key:{columns:['id'],source:'source'}, fields:[{name:'id',source:'source'}] }]);
	const migration = ir('flyway','migration',[{ provider:'flyway', name:'users', table:{name:'users',source:'observed'}, primary_key:{columns:[],source:'unknown'}, fields:[{name:'id',source:'migration'}] }]);
	const out = comparePersistenceIr({ expected:source, observed:migration });
	assert.equal(out.findings.length,0);
	assert.equal(out.unknowns[0].code,'observed-primary-key-unknown');
});

test('source/migration/live comparison keeps all planes separate', () => {
	const source = ir('jpa','source',[{ provider:'jpa', name:'User', table:{name:'users',source:'explicit'}, primary_key:{columns:['id'],source:'source'}, fields:[{name:'id',source:'source'}] }]);
	const migrations = ir('flyway','migration',[{ provider:'flyway', name:'users', table:{name:'users',source:'observed'}, primary_key:{columns:[],source:'unknown'}, fields:[{name:'id',source:'migration'}] }]);
	const live = ir('postgres','live',[{ provider:'postgres', name:'users', table:{name:'users',source:'observed'}, primary_key:{columns:['id'],source:'live'}, fields:[{name:'id',source:'live'}] }]);
	const out = compareSourceMigrationLive({source,migrations,live});
	assert.deepEqual(out.comparisons.map((x)=>x.name),['source-vs-migrations','source-vs-live','migrations-vs-live']);
});

test('live observation of no primary key is a mismatch, not unknown', () => {
	const source = ir('jpa','source',[{ provider:'jpa', name:'User', table:{name:'users',schema:'public',source:'explicit'}, primary_key:{columns:['id'],source:'source'} }]);
	const live = ir('postgres','live',[{ provider:'postgres', name:'users', table:{name:'users',schema:'public',source:'observed'}, primary_key:{columns:[],source:'live'} }]);
	const out = comparePersistenceIr({ expected:source, observed:live });
	assert.equal(out.unknowns.length,0);
	assert.equal(out.findings[0].code,'primary-key-mismatch');
	assert.deepEqual(out.findings[0].observed,[]);
});

test('composite primary-key order is part of the observed key shape', () => {
	const source = ir('jpa','source',[{ provider:'jpa', name:'Membership', table:{name:'memberships',source:'explicit'}, primary_key:{columns:['tenant_id','user_id'],source:'source'} }]);
	const live = ir('postgres','live',[{ provider:'postgres', name:'memberships', table:{name:'memberships',source:'observed'}, primary_key:{columns:['user_id','tenant_id'],source:'live'} }]);
	const out = comparePersistenceIr({ expected:source, observed:live });
	assert.equal(out.findings[0].code,'primary-key-mismatch');
});
