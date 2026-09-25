import { isPlainObject, validIdentifier } from './_util.mjs';
import { SUPPORT_EXPLANATION_CONTRACT, SUPPORT_STATUSES } from './explain.mjs';

export const SUPPORT_MATRIX_CONTRACT = 'sbf.support-matrix/1';


function assertExplanation(report, index) {
	if (!isPlainObject(report) || report.contract !== SUPPORT_EXPLANATION_CONTRACT) {
		throw new TypeError(`explanations[${index}] must be ${SUPPORT_EXPLANATION_CONTRACT}`);
	}
	if (!validIdentifier(report.adapterId)) throw new TypeError(`explanations[${index}].adapterId is invalid`);
	if (!Array.isArray(report.capabilities)) throw new TypeError(`explanations[${index}].capabilities must be an array`);
	for (const capability of report.capabilities) {
		if (!isPlainObject(capability) || typeof capability.name !== 'string' || capability.name.length === 0 ||
			!SUPPORT_STATUSES.includes(capability.status)) {
			throw new TypeError(`explanations[${index}] has an invalid capability entry`);
		}
	}
}

function sortedUnique(values) {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function defineOwn(target, key, value) {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function capabilityCell(row, name) {
	return Object.hasOwn(row.capabilities, name) ? row.capabilities[name] : undefined;
}

function combineState(values) {
	if (values.length === 0) return 'unknown';
	const unique = new Set(values);
	if (unique.size === 1) return values[0];
	if (unique.has('conflict')) return 'conflict';
	if (unique.has('unknown')) return 'unknown';
	if (unique.has('supported') && unique.has('unsupported')) return 'conflict';
	if (unique.has('partial')) return 'partial';
	if (unique.has('supported')) return 'partial';
	if (unique.has('unsupported')) return 'unsupported';
	return 'not-applicable';
}

function escapeMarkdown(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('|', '\\|')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll('\n', '<br>');
}

export function buildSupportMatrix(explanations) {
	if (!Array.isArray(explanations) || explanations.length === 0) {
		throw new TypeError('explanations must be a non-empty array');
	}
	for (let i = 0; i < explanations.length; i += 1) assertExplanation(explanations[i], i);

	const capabilityNames = sortedUnique(explanations.flatMap((report) => report.capabilities.map((item) => item.name)));
	const adapterIds = sortedUnique(explanations.map((report) => report.adapterId));
	const rows = adapterIds.map((adapterId) => {
		const reports = explanations.filter((report) => report.adapterId === adapterId);
		const capabilities = {};
		for (const capabilityName of capabilityNames) {
			const matching = reports.flatMap((report) =>
				report.capabilities.filter((item) => item.name === capabilityName));
			const status = combineState(matching.map((item) => item.status));
			defineOwn(capabilities, capabilityName, {
				status,
				evidenceRefs: sortedUnique(matching.flatMap((item) => item.evidenceRefs ?? [])),
				constraints: sortedUnique(matching.flatMap((item) => item.constraints ?? [])),
				nextActions: sortedUnique(matching.flatMap((item) => item.nextActions ?? [])),
			});
		}
		return { adapterId, capabilities };
	});
	return {
		contract: SUPPORT_MATRIX_CONTRACT,
		capabilityNames,
		rows,
		note: 'This is a deterministic projection of supplied support explanations, not an independent certification or runtime verdict.',
	};
}

export function renderSupportMatrixMarkdown(matrix) {
	if (!isPlainObject(matrix) || matrix.contract !== SUPPORT_MATRIX_CONTRACT ||
		!Array.isArray(matrix.capabilityNames) || !Array.isArray(matrix.rows)) {
		throw new TypeError(`matrix must be ${SUPPORT_MATRIX_CONTRACT}`);
	}
	const header = ['Adapter', ...matrix.capabilityNames];
	const lines = [
		'# Support matrix',
		'',
		escapeMarkdown(matrix.note),
		'',
		`| ${header.map(escapeMarkdown).join(' | ')} |`,
		`|${header.map(() => '---').join('|')}|`,
	];
	for (const row of matrix.rows) {
		lines.push(`| ${[
			escapeMarkdown(row.adapterId),
			...matrix.capabilityNames.map((name) => escapeMarkdown(capabilityCell(row, name)?.status ?? 'unknown')),
		].join(' | ')} |`);
	}
	return lines.join('\n');
}

export function supportMatrixDiagnostics(matrix) {
	if (!isPlainObject(matrix) || matrix.contract !== SUPPORT_MATRIX_CONTRACT) {
		throw new TypeError(`matrix must be ${SUPPORT_MATRIX_CONTRACT}`);
	}
	const diagnostics = [];
	for (const row of matrix.rows) {
		for (const capabilityName of matrix.capabilityNames) {
			const cell = capabilityCell(row, capabilityName);
			if (!cell || !['conflict', 'unknown', 'unsupported', 'partial'].includes(cell.status)) continue;
			diagnostics.push({
				code: 'BSKEL_SUPPORT_' + cell.status.toUpperCase().replaceAll('-', '_'),
				severity: cell.status === 'conflict' ? 'blocked' : cell.status === 'unsupported' ? 'warning' : 'info',
				status: cell.status,
				adapterId: row.adapterId,
				message: `${capabilityName}: ${cell.status}`,
				evidenceRefs: [...cell.evidenceRefs],
			});
		}
	}
	return diagnostics;
}
