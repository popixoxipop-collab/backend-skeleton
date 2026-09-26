import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PERSISTENCE_PROVIDER_CONTRACT,
	validatePersistenceProvider,
	buildPersistenceRegistry,
	listPersistenceProviders,
	persistenceProviderById,
} from '../../scanners/persistence-next/providers/registry.mjs';

function fake(id) {
	return { id, contract:PERSISTENCE_PROVIDER_CONTRACT, detect:()=>false, scan:()=>({contract:'sbf.persistence-ir/1',provider:id}) };
}

test('registry validates provider contract and functions', () => {
	assert.equal(validatePersistenceProvider(fake('demo')).id,'demo');
	assert.throws(()=>validatePersistenceProvider({...fake('demo'),contract:'bad'}),/sbf.persistence-provider\/1/);
	assert.throws(()=>validatePersistenceProvider({...fake('demo'),detect:null}),/detect/);
});

test('registry rejects duplicate provider ids', () => {
	assert.throws(()=>buildPersistenceRegistry([fake('same'),fake('same')]),/duplicate persistence provider id/);
});

test('registry sorts providers deterministically', () => {
	assert.deepEqual(buildPersistenceRegistry([fake('zeta'),fake('alpha')]).map((x)=>x.id),['alpha','zeta']);
});

test('shipped T10 provider registry contains Prisma, ActiveRecord and Django without arbitration', () => {
	assert.deepEqual(listPersistenceProviders().map((x)=>x.id),['active-record','django-orm','prisma']);
	assert.equal(persistenceProviderById('active-record').id,'active-record');
	assert.equal(persistenceProviderById('missing'),null);
});
