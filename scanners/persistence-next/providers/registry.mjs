import { prismaPersistenceProvider } from './prisma.mjs';
import { activeRecordPersistenceProvider } from './active-record.mjs';
import { djangoOrmPersistenceProvider } from './django-orm.mjs';

export const PERSISTENCE_PROVIDER_CONTRACT = 'sbf.persistence-provider/1';

export function validatePersistenceProvider(provider) {
	if (!provider || typeof provider !== 'object') throw new TypeError('persistence provider must be an object');
	if (provider.contract !== PERSISTENCE_PROVIDER_CONTRACT) throw new TypeError(`provider ${provider.id ?? '<unknown>'} must declare ${PERSISTENCE_PROVIDER_CONTRACT}`);
	if (typeof provider.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(provider.id)) throw new TypeError('persistence provider id must be kebab-case');
	if (typeof provider.detect !== 'function') throw new TypeError(`provider ${provider.id} must expose detect(projectRoot)`);
	if (typeof provider.scan !== 'function') throw new TypeError(`provider ${provider.id} must expose scan(projectRoot)`);
	return provider;
}

export function buildPersistenceRegistry(providers) {
	if (!Array.isArray(providers)) throw new TypeError('providers must be an array');
	const byId = new Map();
	for (const raw of providers) {
		const provider = validatePersistenceProvider(raw);
		if (byId.has(provider.id)) throw new Error(`duplicate persistence provider id: ${provider.id}`);
		byId.set(provider.id, provider);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const PROVIDERS = buildPersistenceRegistry([
	prismaPersistenceProvider,
	activeRecordPersistenceProvider,
	djangoOrmPersistenceProvider,
]);

export function listPersistenceProviders() {
	return PROVIDERS.map((provider) => ({ id: provider.id, contract: provider.contract }));
}

export function persistenceProviderById(id) {
	return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function detectPersistenceProviders(projectRoot) {
	const matches = [];
	const errors = [];
	for (const provider of PROVIDERS) {
		try {
			if (provider.detect(projectRoot)) matches.push(provider.id);
		} catch (error) {
			errors.push({ provider: provider.id, code: 'persistence-provider-detect-failed', message: error?.message ?? String(error) });
		}
	}
	return { matches, errors };
}

export function scanPersistenceProvider(providerId, projectRoot) {
	const provider = persistenceProviderById(providerId);
	if (!provider) throw new Error(`unknown persistence provider: ${providerId}`);
	const ir = provider.scan(projectRoot);
	if (!ir || ir.contract !== 'sbf.persistence-ir/1') throw new Error(`provider ${providerId} returned an invalid persistence IR contract`);
	if (ir.provider !== providerId) throw new Error(`provider ${providerId} returned IR for ${ir.provider ?? '<missing>'}`);
	return ir;
}
