import { COMMAND_CAPABILITIES, CAPABILITY_SATISFIERS } from '../capabilities.mjs';
import {
	capabilityRecord,
	fromLegacyCapabilities,
	normalizeCapabilityMap,
} from './records.mjs';
import { evaluateCapabilityPolicy } from './policy.mjs';

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function freezeRequirement(capability) {
	return Object.freeze({ capability, acceptedStatuses: Object.freeze(['supported']) });
}

export function legacyCommandRequirements(command) {
	nonEmpty(command, 'command');
	if (!Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITIES, command)) throw new TypeError(`unknown capability-gated command ${command}`);
	return Object.freeze([...COMMAND_CAPABILITIES[command]].map(freezeRequirement));
}

export function legacyProviderRequirements(provider) {
	if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('provider must be an object');
	if (provider.id !== undefined) nonEmpty(provider.id, 'provider.id');
	const requirements = provider.requiresCapabilities ?? [];
	if (!Array.isArray(requirements)) throw new TypeError('provider.requiresCapabilities must be an array');
	return Object.freeze(requirements.map((capability, index) => freezeRequirement(nonEmpty(capability, `provider.requiresCapabilities[${index}]`))));
}

export function legacySatisfierHints() {
	return Object.freeze(Object.fromEntries(
		Object.keys(CAPABILITY_SATISFIERS).sort().map((capability) => {
			const satisfier = CAPABILITY_SATISFIERS[capability];
			return [capability, Object.freeze({ flag: satisfier.flag, note: satisfier.note })];
		}),
	));
}

export function externalCapabilityFromLegacySatisfier({ capability, flag, evidence } = {}) {
	nonEmpty(capability, 'capability');
	nonEmpty(flag, 'flag');
	const satisfier = CAPABILITY_SATISFIERS[capability];
	if (!satisfier) throw new TypeError(`no legacy satisfier is registered for ${capability}`);
	if (satisfier.flag !== flag) throw new TypeError(`legacy satisfier for ${capability} is --${satisfier.flag}, not --${flag}`);
	return capabilityRecord({
		name: capability,
		status: 'supported',
		evidence: [evidence],
		source: `external-satisfier:${flag}`,
		conditions: ['This record proves only the named capability for the exact-byte artifact already verified against its T01 ArtifactRef; it does not widen the adapter descriptor or certify runtime behavior.'],
	});
}

function effectiveCapabilities(adapter, externalCapabilities) {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw new TypeError('adapter must be an object');
	nonEmpty(adapter.id, 'adapter.id');
	const legacy = fromLegacyCapabilities(adapter.capabilities ?? {});
	const external = normalizeCapabilityMap(externalCapabilities ?? {});
	const out = { ...legacy };
	for (const [name, record] of Object.entries(external)) {
		if (record.status !== 'supported') throw new TypeError(`external capability ${name} must be supported evidence, got ${record.status}`);
		if (!record.source.startsWith('external-satisfier:')) throw new TypeError(`external capability ${name} must come from an external-satisfier source`);
		if (out[name]?.status === 'supported') continue;
		out[name] = record;
	}
	return Object.freeze(out);
}

export function evaluateLegacyCommandPolicy({ adapter, command, externalCapabilities = {} } = {}) {
	const requirements = legacyCommandRequirements(command);
	return evaluateCapabilityPolicy({
		policyId: `legacy-command:${command}`,
		capabilities: effectiveCapabilities(adapter, externalCapabilities),
		requirements,
	});
}

export function evaluateLegacyProviderPolicy({ adapter, provider, externalCapabilities = {} } = {}) {
	const requirements = legacyProviderRequirements(provider);
	return evaluateCapabilityPolicy({
		policyId: `legacy-provider:${provider?.id ?? 'unknown'}`,
		capabilities: effectiveCapabilities(adapter, externalCapabilities),
		requirements,
	});
}

export function buildLegacyCompatibilityView({ adapters = [], providers = [] } = {}) {
	if (!Array.isArray(adapters)) throw new TypeError('adapters must be an array');
	if (!Array.isArray(providers)) throw new TypeError('providers must be an array');
	const providerById = new Map(providers.map((provider) => [provider.id, provider]));
	const rows = adapters.map((adapter) => {
		const capabilities = fromLegacyCapabilities(adapter.capabilities ?? {});
		const provider = providerById.get(adapter.id) ?? null;
		return Object.freeze({
			adapterId: adapter.id,
			certified: false,
			capabilities,
			provider: provider ? Object.freeze({
				id: provider.id,
				requiresCapabilities: Object.freeze([...(provider.requiresCapabilities ?? [])].sort()),
			}) : null,
			limitations: Object.freeze([
				'Compatibility projection only: legacy booleans keep their current narrow meanings.',
				'No discovery/contract/runtime-tested certification is implied by this row.',
			]),
		});
	});
	rows.sort((a, b) => a.adapterId.localeCompare(b.adapterId));
	return Object.freeze(rows);
}
