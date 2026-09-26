import { formatArtifactRef, isPlainObject, normalizeArtifactRef, validIdentifier } from './_util.mjs';
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

function projectionEvidenceRefs(value, { status, source, index }) {
	if (!Array.isArray(value)) throw new TypeError(`records[${index}].evidenceRefs must be an array`);
	if (status === 'supported' && source === 'legacy-adapter-boolean') {
		if (value.length !== 0) throw new TypeError(`records[${index}] legacy supported bridge must not invent evidenceRefs`);
		return [];
	}
	if (status === 'supported') {
		if (value.length === 0) throw new TypeError(`records[${index}] supported capability requires T01 sbf.artifact-ref/1 evidence`);
		return value.map((ref, evidenceIndex) => {
			try {
				normalizeArtifactRef(ref);
				return formatArtifactRef(ref);
			} catch (error) {
				throw new TypeError(`records[${index}].evidenceRefs[${evidenceIndex}] must be a T01 sbf.artifact-ref/1 object; arbitrary strings are not certification evidence: ${error.message}`);
			}
		});
	}
	return value.map((item, evidenceIndex) => {
		if (typeof item === 'string') return nonEmpty(item, `records[${index}].evidenceRefs[${evidenceIndex}]`);
		try {
			return formatArtifactRef(item);
		} catch (error) {
			throw new TypeError(`records[${index}].evidenceRefs[${evidenceIndex}] must be a non-empty display string or T01 ArtifactRef: ${error.message}`);
		}
	});
}

function normalizeFiveStateRecord(record, index) {
	if (!isPlainObject(record)) throw new TypeError(`records[${index}] must be a plain object`);
	const name = nonEmpty(record.name, `records[${index}].name`);
	if (!STATUS_SET.has(record.status)) {
		throw new TypeError(`records[${index}].status must be one of: ${FIVE_STATE_CAPABILITY_STATUSES.join(', ')}`);
	}
	const evidenceRefs = projectionEvidenceRefs(record.evidenceRefs ?? [], { status: record.status, source: record.source, index });
	const conditions = stringArray(record.conditions ?? [], `records[${index}].conditions`);
	const reason = record.reason === null || record.reason === undefined
		? null
		: nonEmpty(record.reason, `records[${index}].reason`);
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
				nextActions: stringArray(Object.hasOwn(nextActions, record.name) ? nextActions[record.name] : [], `nextActions.${record.name}`),
			})),
		fields: [],
		notes: [
			'Projected from the T03 five-state vocabulary; T22 does not create a separate supported verdict. supported projection requires a T01 sbf.artifact-ref/1 identity (or the explicit legacy boolean bridge), and remains non-certifying until upstream bytes/review are independently verified. conflict is only an aggregate evidence-view state.',
			...notes,
		],
	});
}
