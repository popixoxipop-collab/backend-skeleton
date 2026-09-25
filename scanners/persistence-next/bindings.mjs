import { assertPersistenceIr } from './ir.mjs';

function nonEmpty(value, label) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function entityIndex(ir) {
	return new Map(ir.entities.map((entity) => [entity.id, entity]));
}

function tableKey(table) {
	if (!table?.name) return null;
	return `${table.schema ?? ''}\u0000${table.name}`;
}

function readCapability(entity) {
	const tableKnown = Boolean(entity.table?.name);
	const keyColumns = entity.primary_key?.columns ?? [];
	return {
		candidate_read_by_primary_key: tableKnown && keyColumns.length > 0,
		verified_read_by_primary_key: false,
		write: false,
		key_shape: keyColumns.length === 0 ? 'unknown' : keyColumns.length === 1 ? 'single' : 'composite',
		key_type: entity.primary_key?.type ?? 'unknown',
	};
}

function sameOrdered(a, b) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function composeResourceBindings({ resources = [], persistence, explicit_bindings = [] }) {
	const ir = assertPersistenceIr(persistence);
	if (!Array.isArray(resources)) throw new TypeError('resources must be an array');
	if (!Array.isArray(explicit_bindings)) throw new TypeError('explicit_bindings must be an array');
	const entities = entityIndex(ir);
	const resourceById = new Map();
	for (const resource of resources) {
		const id = nonEmpty(resource.id, 'resource.id');
		if (resourceById.has(id)) throw new Error(`duplicate resource id: ${id}`);
		resourceById.set(id, resource);
	}

	const requested = new Map();
	const conflicts = [];
	for (const binding of explicit_bindings) {
		const resourceId = nonEmpty(binding.resource_id, 'explicit binding resource_id');
		const entityId = nonEmpty(binding.entity_id, 'explicit binding entity_id');
		if (!resourceById.has(resourceId)) {
			conflicts.push({ resource_id: resourceId, code: 'resource-not-found', entity_ids: [entityId] });
			continue;
		}
		if (!entities.has(entityId)) {
			conflicts.push({ resource_id: resourceId, code: 'entity-not-found', entity_ids: [entityId] });
			continue;
		}
		if (!requested.has(resourceId)) requested.set(resourceId, []);
		requested.get(resourceId).push({ entityId, source: binding.source ?? 'explicit' });
	}

	for (const resource of resources) {
		if (!resource.entity_ref) continue;
		if (!entities.has(resource.entity_ref)) {
			conflicts.push({ resource_id: resource.id, code: 'entity-ref-not-found', entity_ids: [resource.entity_ref] });
			continue;
		}
		if (!requested.has(resource.id)) requested.set(resource.id, []);
		requested.get(resource.id).push({ entityId: resource.entity_ref, source: 'entity-ref' });
	}

	const bindings = [];
	const unbound = [];
	for (const resource of resources) {
		const refs = requested.get(resource.id) ?? [];
		const uniqueEntityIds = [...new Set(refs.map((r) => r.entityId))];
		if (uniqueEntityIds.length === 0) {
			unbound.push({ resource_id: resource.id, reason: 'no explicit binding or entity_ref; name/table similarity is deliberately not used' });
			continue;
		}
		if (uniqueEntityIds.length > 1) {
			conflicts.push({ resource_id: resource.id, code: 'multiple-entities', entity_ids: uniqueEntityIds.sort() });
			continue;
		}
		const entity = entities.get(uniqueEntityIds[0]);
		bindings.push({
			resource_id: resource.id,
			entity_id: entity.id,
			table: entity.table,
			primary_key: entity.primary_key,
			capabilities: readCapability(entity),
			provenance: refs.filter((r) => r.entityId === entity.id).map((r) => r.source),
		});
	}

	return {
		bindings: bindings.sort((a, b) => a.resource_id.localeCompare(b.resource_id)),
		unbound_resources: unbound.sort((a, b) => a.resource_id.localeCompare(b.resource_id)),
		conflicts: conflicts.sort((a, b) => a.resource_id.localeCompare(b.resource_id) || a.code.localeCompare(b.code)),
		diagnostics: [{
			code: 'automatic-name-binding-disabled', level: 'info',
			message: 'resource/entity names and table names are not used as implicit bindings; provide entity_ref or an explicit binding',
		}],
	};
}

export function matchPhysicalTable({ persistence, schema = null, table }) {
	const ir = assertPersistenceIr(persistence);
	nonEmpty(table, 'table');
	const matches = ir.entities.filter((entity) => tableKey(entity.table) === tableKey({ schema, name: table }));
	return matches;
}

export function verifyResourceBindingsAgainstObserved({ binding_result, observed, default_schema = null }) {
	if (!binding_result || !Array.isArray(binding_result.bindings)) throw new TypeError('binding_result.bindings must be an array');
	const live = assertPersistenceIr(observed);
	if (live.source_kind !== 'live') throw new TypeError('observed persistence IR must have source_kind=live');
	const byTable = new Map();
	for (const entity of live.entities) {
		if (!entity.table?.name) continue;
		const key = tableKey({ schema: entity.table.schema ?? default_schema, name: entity.table.name });
		if (!byTable.has(key)) byTable.set(key, []);
		byTable.get(key).push(entity);
	}
	return {
		...binding_result,
		bindings: binding_result.bindings.map((binding) => {
			const table = binding.table;
			const key = table?.name ? tableKey({ schema: table.schema ?? default_schema, name: table.name }) : null;
			const matches = key ? (byTable.get(key) ?? []) : [];
			let tableStatus = 'unknown';
			let keyStatus = 'unknown';
			let verified = false;
			if (key && matches.length === 0) tableStatus = 'missing';
			else if (matches.length > 1) tableStatus = 'ambiguous';
			else if (matches.length === 1) {
				tableStatus = 'verified';
				const expected = binding.primary_key?.columns ?? [];
				const actual = matches[0].primary_key?.columns ?? [];
				if (matches[0].primary_key?.source !== 'live') keyStatus = 'unknown';
				else if (sameOrdered(expected, actual) && expected.length > 0) { keyStatus = 'verified'; verified = true; }
				else keyStatus = 'mismatch';
			}
			return {
				...binding,
				capabilities: { ...binding.capabilities, verified_read_by_primary_key: verified },
				verification: { source_kind: 'live', table: tableStatus, primary_key: keyStatus },
			};
		}),
	};
}
