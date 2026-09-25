import { isPlainObject } from './_util.mjs';

export const SARIF_VERSION = '2.1.0';

const LEVELS = Object.freeze({
	error: 'error',
	blocked: 'error',
	warning: 'warning',
	info: 'note',
	note: 'note',
});

function normalizeLocation(diagnostic) {
	if (typeof diagnostic.file !== 'string' || diagnostic.file.length === 0) return undefined;
	const startLine = Number.isInteger(diagnostic.startLine) && diagnostic.startLine > 0 ? diagnostic.startLine : 1;
	const region = { startLine };
	if (Number.isInteger(diagnostic.endLine) && diagnostic.endLine >= startLine) region.endLine = diagnostic.endLine;
	return {
		physicalLocation: {
			artifactLocation: { uri: diagnostic.file.replaceAll('\\', '/') },
			region,
		},
	};
}

export function diagnosticsToSarif(diagnostics, {
	toolName = 'bskel-adapter-sdk',
	informationUri = 'https://github.com/popixoxipop-collab/backend-skeleton',
} = {}) {
	if (!Array.isArray(diagnostics)) throw new TypeError('diagnostics must be an array');
	const rules = new Map();
	const results = diagnostics.map((diagnostic, index) => {
		if (!isPlainObject(diagnostic) || typeof diagnostic.code !== 'string' || typeof diagnostic.message !== 'string') {
			throw new TypeError(`diagnostic at index ${index} needs code and message`);
		}
		const severity = LEVELS[diagnostic.severity] ?? 'warning';
		if (!rules.has(diagnostic.code)) {
			rules.set(diagnostic.code, {
				id: diagnostic.code,
				name: diagnostic.code,
				shortDescription: { text: diagnostic.title ?? diagnostic.code },
				...(typeof diagnostic.helpUri === 'string' ? { helpUri: diagnostic.helpUri } : {}),
			});
		}
		const location = normalizeLocation(diagnostic);
		return {
			ruleId: diagnostic.code,
			level: severity,
			message: { text: diagnostic.message },
			...(location ? { locations: [location] } : {}),
			properties: {
				bskelStatus: diagnostic.status ?? null,
				adapterId: diagnostic.adapterId ?? null,
				evidenceRefs: Array.isArray(diagnostic.evidenceRefs) ? [...diagnostic.evidenceRefs] : [],
			},
		};
	});
	return {
		version: SARIF_VERSION,
		'$schema': 'https://json.schemastore.org/sarif-2.1.0.json',
		runs: [{
			tool: {
				driver: {
					name: toolName,
					informationUri,
					rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)),
				},
			},
			results,
		}],
	};
}
