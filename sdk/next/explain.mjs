import { isPlainObject, stableClone } from './_util.mjs';

export const SUPPORT_EXPLANATION_CONTRACT = 'sbf.support-explanation/1';
export const SUPPORT_STATUSES = Object.freeze(['supported', 'partial', 'unsupported', 'unknown', 'not-applicable', 'conflict']);

function assertArrayOfStrings(value, name) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new TypeError(`${name} must be an array of strings`);
	}
}

function normalizeCapability(item) {
	if (!isPlainObject(item) || typeof item.name !== 'string' || !SUPPORT_STATUSES.includes(item.status)) {
		throw new TypeError('capability entries require name and a known status');
	}
	assertArrayOfStrings(item.constraints ?? [], 'capability.constraints');
	assertArrayOfStrings(item.nextActions ?? [], 'capability.nextActions');
	assertArrayOfStrings(item.evidenceRefs ?? [], 'capability.evidenceRefs');
	return {
		name: item.name,
		status: item.status,
		summary: typeof item.summary === 'string' ? item.summary : '',
		evidenceRefs: [...(item.evidenceRefs ?? [])],
		constraints: [...(item.constraints ?? [])],
		nextActions: [...(item.nextActions ?? [])],
	};
}

function normalizeField(item) {
	if (!isPlainObject(item) || typeof item.name !== 'string' || !SUPPORT_STATUSES.includes(item.status)) {
		throw new TypeError('field entries require name and a known status');
	}
	assertArrayOfStrings(item.provenanceRefs ?? [], 'field.provenanceRefs');
	assertArrayOfStrings(item.constraints ?? [], 'field.constraints');
	assertArrayOfStrings(item.nextActions ?? [], 'field.nextActions');
	return {
		name: item.name,
		status: item.status,
		...(Object.hasOwn(item, 'value') ? { value: stableClone(item.value) } : {}),
		provenanceRefs: [...(item.provenanceRefs ?? [])],
		conflicts: Array.isArray(item.conflicts) ? stableClone(item.conflicts) : [],
		constraints: [...(item.constraints ?? [])],
		nextActions: [...(item.nextActions ?? [])],
	};
}

export function createSupportExplanation({
	subject,
	adapterId,
	capabilities = [],
	fields = [],
	notes = [],
}) {
	if (typeof subject !== 'string' || subject.length === 0) throw new TypeError('subject must be non-empty');
	if (typeof adapterId !== 'string' || adapterId.length === 0) throw new TypeError('adapterId must be non-empty');
	assertArrayOfStrings(notes, 'notes');
	return {
		contract: SUPPORT_EXPLANATION_CONTRACT,
		subject,
		adapterId,
		capabilities: capabilities.map(normalizeCapability),
		fields: fields.map(normalizeField),
		notes: [
			'confidence or detection certainty is not runtime-behavior proof; runtime-tested status needs separate evidence',
			...notes,
		],
	};
}

function cell(items) {
	if (!items || items.length === 0) return '—';
	return items.join('<br>');
}

export function renderSupportExplanationMarkdown(report) {
	if (!isPlainObject(report) || report.contract !== SUPPORT_EXPLANATION_CONTRACT) {
		throw new TypeError(`report.contract must equal ${SUPPORT_EXPLANATION_CONTRACT}`);
	}
	const lines = [
		`# Support explanation — ${report.subject}`,
		'',
		`Adapter: \`${report.adapterId}\``,
		'',
		'## Capabilities',
		'',
		'| Capability | Status | Evidence | Constraints | Next |',
		'|---|---|---|---|---|',
	];
	for (const item of report.capabilities) {
		lines.push(`| ${item.name} | ${item.status} | ${cell(item.evidenceRefs)} | ${cell(item.constraints)} | ${cell(item.nextActions)} |`);
	}
	lines.push('', '## Fields', '', '| Field | Status | Provenance | Constraints | Next |', '|---|---|---|---|---|');
	for (const item of report.fields) {
		lines.push(`| ${item.name} | ${item.status} | ${cell(item.provenanceRefs)} | ${cell(item.constraints)} | ${cell(item.nextActions)} |`);
	}
	if (report.notes.length > 0) {
		lines.push('', '## Notes', '', ...report.notes.map((note) => `- ${note}`));
	}
	return lines.join('\n');
}
