import { isPlainObject, validIdentifier } from './_util.mjs';
import { createSupportExplanation } from './explain.mjs';

export const FIVE_STATE_CAPABILITY_STATUSES = Object.freeze([
	'supported',
	'partial',
	'unsupported',
	'unknown',
	'not-applicable',
]);

const STATUS_SET = new Set(FIVE_STATE_CAPABILITY_STATUSES);

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function stringArray(value, name) {
	if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
	return value.map((item, index) => nonEmpty(item, `${name}[${index}]`));
}

function normalizeFiveStateRecord(record, index) {
	if (!isPlainObject(record)) throw new TypeError(`records[${index}] must be a plain object`);
	const name = nonEmpty(record.name, `records[${index}].name`);
	if (!STATUS_SET.has(record.status)) {
		throw new TypeError(`records[${index}].status must be one of: ${FIVE_STATE_CAPABILITY_STATUSES.join(', ')}`);
	}
	const evidenceRefs = stringArray(record.evidenceRefs ?? [], `records[${index}].evidenceRefs`);
	const conditions = stringArray(record.conditions ?? [], `records[${index}].conditions`);
	const reason = record.reason === null || record.reason === undefined
		? null
		: nonEmpty(record.reason, `records[${index}].reason`);
	if (record.status === 'supported' && evidenceRefs.length === 0 && record.source !== 'legacy-adapter-boolean') {
		throw new TypeError(`records[${index}] supported capability requires evidenceRefs unless it is an explicit legacy bridge`);
	}
	if (record.status !== 'supported' && reason === null) {
		throw new TypeError(`records[${index}] ${record.status} capability requires a reason`);
	}
	return {
		name,
		status: record.status,
		evidenceRefs,
		conditions,
		reason,
		source: typeof record.source === 'string' && record.source.length > 0 ? record.source : 'five-state-record',
	};
}

export function projectFiveStateCapabilities({
	subject,
	adapterId,
	records,
	nextActions = {},
	notes = [],
}) {
	if (typeof subject !== 'string' || subject.length === 0) throw new TypeError('subject must be non-empty');
	if (!validIdentifier(adapterId)) throw new TypeError('adapterId must be a lowercase kebab-case identifier');
	if (!Array.isArray(records)) throw new TypeError('records must be an array');
	if (!isPlainObject(nextActions)) throw new TypeError('nextActions must be a plain object');
	if (!Array.isArray(notes) || notes.some((item) => typeof item !== 'string')) throw new TypeError('notes must be an array of strings');

	const normalized = records.map(normalizeFiveStateRecord);
	const seen = new Set();
	for (const record of normalized) {
		if (seen.has(record.name)) throw new TypeError(`duplicate capability record: ${record.name}`);
		seen.add(record.name);
	}

	return createSupportExplanation({
		subject,
		adapterId,
		capabilities: normalized
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((record) => ({
				name: record.name,
				status: record.status,
				summary: record.reason ?? '',
				evidenceRefs: [...record.evidenceRefs],
				constraints: [
					...record.conditions,
					...(record.reason ? [record.reason] : []),
					`source:${record.source}`,
				],
				nextActions: stringArray(nextActions[record.name] ?? [], `nextActions.${record.name}`),
			})),
		fields: [],
		notes: [
			'Projected from five-state capability records; conflict is intentionally not a record status and may only arise when multiple evidence views are aggregated.',
			...notes,
		],
	});
}
