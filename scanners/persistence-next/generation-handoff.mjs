import { normalizeKeyType } from './bindings.mjs';

export const GENERATION_HANDOFF_CONTRACT = 'sbf.persistence-generation-handoff/1';

export function buildHandleCompositionHandoff({ http_provider_id, binding }) {
	if (typeof http_provider_id !== 'string' || !http_provider_id) throw new TypeError('http_provider_id is required');
	if (!binding || typeof binding !== 'object') throw new TypeError('binding is required');
	const blockers = [];
	if (!binding.persistence_id) blockers.push({ code:'persistence-id-missing', message:'binding has no persistence_id' });
	if (binding.capabilities?.verified_read_by_primary_key !== true) {
		blockers.push({ code:'persistence-read-not-live-verified', message:'read-by-primary-key has not been verified against live persistence evidence' });
	}
	if (binding.capabilities?.key_shape !== 'single') {
		blockers.push({ code:'unsupported-key-shape', message:`handles composition requires a single key, got ${binding.capabilities?.key_shape ?? 'unknown'}` });
	}
	const keyType = normalizeKeyType(binding.capabilities?.effective_key_type ?? binding.capabilities?.key_type);
	if (keyType !== 'uuid') {
		blockers.push({ code:'unsupported-key-type', message:`handles composition currently requires uuid, got ${keyType}` });
	}
	return {
		contract: GENERATION_HANDOFF_CONTRACT,
		status: blockers.length === 0 ? 'ready' : 'blocked',
		providerId: http_provider_id,
		persistenceId: binding.persistence_id ?? null,
		keyType,
		resourceId: binding.resource_id ?? null,
		entityId: binding.entity_id ?? null,
		blockers,
	};
}
