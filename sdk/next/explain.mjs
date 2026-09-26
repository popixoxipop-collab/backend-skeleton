import { cloneJsonValue, isPlainObject, validIdentifier } from './_util.mjs';

export const SUPPORT_EXPLANATION_CONTRACT = 'sbf.support-explanation/1';
export const SUPPORT_STATUSES = Object.freeze(['supported', 'partial', 'unsupported', 'unknown', 'not-applicable', 'conflict']);

function assertArrayOfStrings(value, name) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new TypeError(`${name} must be an array of strings`);
	}
}

function normalizeCapability(item) {
	if (!isPlainObject(item) || typeof item.name !== 'string' || item.name.length === 0 || !SUPPORT_STATUSES.includes(item.status)) {
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
	if (!isPlainObject(item) || typeof item.name !== 'string' || item.name.length === 0 || !SUPPORT_STATUSES.includes(item.status)) {
		throw new TypeError('field entries require name and a known status');
	}
	assertArrayOfStrings(item.provenanceRefs ?? [], 'field.provenanceRefs');
	assertArrayOfStrings(item.constraints ?? [], 'field.constraints');
	assertArrayOfStrings(item.nextActions ?? [], 'field.nextActions');

	const hasValue = Object.hasOwn(item, 'value');
	const conflicts = Array.isArray(item.conflicts) ? cloneJsonValue(item.conflicts) : [];
	if (item.status === 'conflict') {
		if (hasValue) throw new TypeError('a conflict field cannot also declare one authoritative value');
		if (conflicts.length < 2) throw new TypeError('a conflict field requires at least two conflict candidates');
	} else if (conflicts.length > 0) {
		throw new TypeError('field.conflicts is only allowed when status is conflict');
	}
	if (['unknown', 'unsupported', 'not-applicable'].includes(item.status) && hasValue) {
		throw new TypeError('a ' + item.status + ' field cannot declare an authoritative value');
	}
	if (['supported', 'partial', 'conflict'].includes(item.status) && (item.provenanceRefs ?? []).length === 0) {
		throw new TypeError('a ' + item.status + ' field requires at least one provenance reference');
	}
	return {
		name: item.name,
		status: item.status,
		...(hasValue ? { value: cloneJsonValue(item.value) } : {}),
		provenanceRefs: [...(item.provenanceRefs ?? [])],
		conflicts,
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
	if (!validIdentifier(adapterId)) throw new TypeError('adapterId must be a lowercase kebab-case identifier');
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

function escapeMarkdownCell(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('|', '\\|')
		.replaceAll('`', '&#96;')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll('\n', '<br>');
}

function cell(items) {
	if (!items || items.length === 0) return '—';
	return items.map(escapeMarkdownCell).join('<br>');
}

function formatFieldValue(item) {
	if (item.status === 'conflict') return cell(item.conflicts.map((value) => JSON.stringify(value)));
	if (!Object.hasOwn(item, 'value')) return '—';
	return escapeMarkdownCell(JSON.stringify(item.value));
}

export function renderSupportExplanationMarkdown(report) {
	if (!isPlainObject(report) || report.contract !== SUPPORT_EXPLANATION_CONTRACT) {
		throw new TypeError('report.contract must equal ' + SUPPORT_EXPLANATION_CONTRACT);
	}
	const lines = [
		'# Support explanation',
		'',
		'Subject: ' + escapeMarkdownCell(report.subject),
		'',
		'Adapter: ' + escapeMarkdownCell(report.adapterId),
		'',
		'## Capabilities',
		'',
		'| Capability | Status | Evidence | Constraints | Next |',
		'|---|---|---|---|---|',
	];
	for (const item of report.capabilities) {
		lines.push('| ' + escapeMarkdownCell(item.name) + ' | ' + escapeMarkdownCell(item.status) + ' | ' + cell(item.evidenceRefs) + ' | ' + cell(item.constraints) + ' | ' + cell(item.nextActions) + ' |');
	}
	lines.push('', '## Fields', '', '| Field | Status | Value / conflicts | Provenance | Constraints | Next |', '|---|---|---|---|---|---|');
	for (const item of report.fields) {
		lines.push('| ' + escapeMarkdownCell(item.name) + ' | ' + escapeMarkdownCell(item.status) + ' | ' + formatFieldValue(item) + ' | ' + cell(item.provenanceRefs) + ' | ' + cell(item.constraints) + ' | ' + cell(item.nextActions) + ' |');
	}
	if (report.notes.length > 0) {
		lines.push('', '## Notes', '', ...report.notes.map((note) => '- ' + escapeMarkdownCell(note)));
	}
	return lines.join('\n');
}
