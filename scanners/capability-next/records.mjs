import { normalizeCapabilityEvidenceReceipts } from './evidence.mjs';

export const CAPABILITY_STATUSES = Object.freeze([
	'supported',
	'partial',
	'unsupported',
	'unknown',
	'not-applicable',
]);

const STATUS_SET = new Set(CAPABILITY_STATUSES);
const CAPABILITY_RECORD = Symbol('t03.capability-record');

export function isCapabilityStatus(value) {
	return STATUS_SET.has(value);
}

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function makeCapabilityRecord({
	name,
	status,
	evidence = [],
	reason = null,
	conditions = [],
	source = 'next',
	legacyBooleanBridge = false,
} = {}) {
	nonEmpty(name, 'name');
	if (!STATUS_SET.has(status)) throw new TypeError(`status must be one of: ${CAPABILITY_STATUSES.join(', ')}`);
	if (!Array.isArray(conditions) || conditions.some((x) => typeof x !== 'string' || x.trim() === '')) {
		throw new TypeError('conditions must be an array of non-empty strings');
	}
	if (reason !== null && (typeof reason !== 'string' || reason.trim() === '')) throw new TypeError('reason must be null or a non-empty string');
	nonEmpty(source, 'source');

	const evidenceRefs = evidence.length > 0
		? normalizeCapabilityEvidenceReceipts(evidence, { capability: name, status })
		: Object.freeze([]);

	if (status === 'supported' && evidenceRefs.length === 0 && !legacyBooleanBridge) {
		throw new TypeError('supported capability records require semantically scoped verified evidence');
	}
	if (status !== 'supported' && reason === null) throw new TypeError(`${status} capability records require a reason`);

	return Object.freeze({
		name,
		status,
		evidenceRefs,
		reason,
		conditions: Object.freeze([...conditions]),
		source,
		[CAPABILITY_RECORD]: true,
	});
}

export function capabilityRecord(input = {}) {
	return makeCapabilityRecord(input);
}

export function fromLegacyBoolean(name, value) {
	if (typeof value !== 'boolean') throw new TypeError(`legacy capability ${name} must be boolean`);
	return makeCapabilityRecord({
		name,
		status: value ? 'supported' : 'unsupported',
		reason: value ? null : 'legacy adapter boolean is false',
		source: 'legacy-adapter-boolean',
		legacyBooleanBridge: true,
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
		if (record[CAPABILITY_RECORD] !== true) {
			throw new TypeError(`capability ${name} must be produced by capabilityRecord() or the explicit legacy bridge`);
		}
		out[name] = record;
	}
	return Object.freeze(out);
}
