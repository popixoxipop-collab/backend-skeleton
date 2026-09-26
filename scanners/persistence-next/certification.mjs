import { buildHandleCompositionHandoff } from './generation-handoff.mjs';

export const PERSISTENCE_CERTIFICATION_CONTRACT = 'sbf.persistence-certification/1';

function certifyOne(httpProviderId, binding, generationContext) {
	const blockers = [];
	if (!binding?.entity_id) blockers.push({ code:'entity-binding-missing', message:'no bound persistence entity' });
	if (!binding?.table?.name) blockers.push({ code:'physical-table-unknown', message:'physical table is unknown' });
	const keyColumns = binding?.primary_key?.columns ?? [];
	if (keyColumns.length === 0) blockers.push({ code:'primary-key-unknown', message:'physical primary key is unknown' });

	const candidateRead = binding?.capabilities?.candidate_read_by_primary_key === true;
	const verifiedRead = binding?.capabilities?.verified_read_by_primary_key === true;
	if (!candidateRead) blockers.push({ code:'read-by-primary-key-not-candidate', message:'source facts do not establish a physical table + primary key candidate' });
	if (!verifiedRead) blockers.push({ code:'read-by-primary-key-not-verified', message:'live persistence verification has not established the read mapping' });

	const handoff = buildHandleCompositionHandoff({
		http_provider_id:httpProviderId,
		binding,
		producer_revision:generationContext?.producer_revision ?? null,
		candidate_revision:generationContext?.candidate_revision ?? null,
		profile_id:generationContext?.profile_id ?? null,
		execution_ref:generationContext?.execution_ref ?? null,
	});
	return {
		resource_id: binding?.resource_id ?? null,
		entity_id: binding?.entity_id ?? null,
		persistence_id: binding?.persistence_id ?? null,
		status: blockers.length === 0 ? 'runtime-read-verified' : 'blocked',
		scopes: {
			source_binding: Boolean(binding?.entity_id),
			read_candidate: candidateRead,
			read_live_verified: verifiedRead,
			write: false,
			generation_candidate: handoff.status === 'ready',
		},
		verification: binding?.verification ?? null,
		generation_handoff: handoff,
		blockers,
	};
}

export function certifyPersistenceBindings({ http_provider_id, binding_result, generation_context = null }) {
	if (typeof http_provider_id !== 'string' || !http_provider_id) throw new TypeError('http_provider_id is required');
	if (!binding_result || !Array.isArray(binding_result.bindings)) throw new TypeError('binding_result.bindings must be an array');

	const resources = binding_result.bindings
		.map((binding) => certifyOne(http_provider_id, binding, generation_context))
		.sort((a,b)=>(a.resource_id ?? '').localeCompare(b.resource_id ?? ''));

	const globalBlockers = [];
	for (const conflict of binding_result.conflicts ?? []) {
		globalBlockers.push({
			code:'binding-conflict',
			resource_id:conflict.resource_id ?? null,
			detail:conflict.code ?? null,
			message:'resource/entity binding conflict must be resolved before certification',
		});
	}
	for (const unbound of binding_result.unbound_resources ?? []) {
		globalBlockers.push({
			code:'resource-unbound',
			resource_id:unbound.resource_id ?? null,
			message:unbound.reason ?? 'resource has no persistence binding',
		});
	}

	return {
		contract:PERSISTENCE_CERTIFICATION_CONTRACT,
		http_provider_id,
		status: globalBlockers.length === 0 && resources.every((resource)=>resource.status === 'runtime-read-verified')
			? 'runtime-read-verified'
			: 'partial-or-blocked',
		resources,
		global_blockers:globalBlockers,
		notes:[
			'T10 certification never grants write behavior.',
			'generation_candidate means the persistence handoff satisfies T10 key/read constraints only; T14 must still approve the provider/persistence/key combination.',
		],
	};
}
