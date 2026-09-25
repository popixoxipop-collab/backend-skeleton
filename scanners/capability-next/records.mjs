export const CAPABILITY_STATUSES = Object.freeze([
	'supported',
	'partial',
	'unsupported',
	'unknown',
	'not-applicable',
]);

const STATUS_SET = new Set(CAPABILITY_STATUSES);

export function isCapabilityStatus(value) {
	return STATUS_SET.has(value);
}

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function evidenceRefs(value = []) {
	if (!Array.isArray(value)) throw new TypeError('evidenceRefs must be an array');
	const refs = value.map((x, i) => nonEmpty(x, `evidenceRefs[${i}]`));
	if (new Set(refs).size !== refs.length) throw new TypeError('evidenceRefs must not contain duplicates');
	return Object.freeze([...refs].sort());
}

export function capabilityRecord({
	name, status, evidenceRefs: refs = [], reason = null, conditions = [], source = 'next',
} = {}) {
	nonEmpty(name, 'name');
	if (!STATUS_SET.has(status)) throw new TypeError(`status must be one of: ${CAPABILITY_STATUSES.join(', ')}`);
	if (!Array.isArray(conditions) || conditions.some((x) => typeof x !== 'string' || x.trim() === '')) {
		throw new TypeError('conditions must be an array of non-empty strings');
	}
	if (reason !== null && (typeof reason !== 'string' || reason.trim() === '')) throw new TypeError('reason must be null or a non-empty string');
	nonEmpty(source, 'source');
	const normalizedRefs = evidenceRefs(refs);
	if (status === 'supported' && normalizedRefs.length === 0 && source !== 'legacy-adapter-boolean') {
		throw new TypeError('supported capability records require evidenceRefs unless they are an explicit legacy boolean bridge');
	}
	if (status !== 'supported' && reason === null) throw new TypeError(`${status} capability records require a reason`);
	return Object.freeze({
		name, status, evidenceRefs: normalizedRefs, reason,
		conditions: Object.freeze([...conditions]), source,
	});
}

export function fromLegacyBoolean(name, value) {
	if (typeof value !== 'boolean') throw new TypeError(`legacy capability ${name} must be boolean`);
	return capabilityRecord({
		name,
		status: value ? 'supported' : 'unsupported',
		reason: value ? null : 'legacy adapter boolean is false',
		source: 'legacy-adapter-boolean',
		conditions: ['Semantics are limited to the legacy capability definition; this bridge does not widen that definition.'],
	});
}

export function fromLegacyCapabilities(capabilities = {}) {
	if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new TypeError('capabilities must be an object');
	return Object.freeze(Object.fromEntries(
		Object.keys(capabilities).sort().map((name) => [name, fromLegacyBoolean(name, capabilities[name])]),
	));
}

export function normalizeCapabilityMap(input = {}) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('capability map must be an object');
	const out = {};
	for (const name of Object.keys(input).sort()) {
		const record = input[name];
		if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`capability ${name} must be a record`);
		if (record.name !== name) throw new TypeError(`capability key ${name} does not match record.name ${record.name}`);
		out[name] = capabilityRecord(record);
	}
	return Object.freeze(out);
}
