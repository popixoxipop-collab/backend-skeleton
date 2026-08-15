import fs from 'node:fs';

// D-security-2: a plain UUID `pattern`, not `format: 'uuid'`. ajv-formats' uuid format accepts
// an optional `urn:uuid:` prefix (per its RFC 4122 reading), but Spring's `UUID` path-variable
// converter expects the bare form -- a contract using `format: 'uuid'` could certify a
// `urn:uuid:...` request as valid when the real endpoint would reject it. Found by the Codex
// security review, verified against the installed ajv-formats@3.0.1.
const BARE_UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function pathParamsSchema(routePath) {
	const params = [...routePath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
	const properties = {};
	for (const p of params) {
		// Naming convention seen throughout Team-IZ-Backend (`UUID organizationId`, etc.) --
		// a heuristic, not a guarantee; wrong for a path param that happens to end in "Id" but
		// isn't a UUID, which just means an over-strict uuid-shaped check on that one field.
		properties[p] = /id$/i.test(p) ? { type: 'string', pattern: BARE_UUID_PATTERN } : { type: 'string' };
	}
	return { type: 'object', additionalProperties: false, properties, required: params };
}

// Re-reads the controller source (already located by the scan) to check whether this specific
// method's parameter list has @RequestBody -- verb alone is not reliable in this codebase
// (e.g. `deleteOrganization` is DELETE but still takes a @RequestBody confirm-name payload).
function detectRequestBody(filePath, methodName) {
	if (!filePath || !fs.existsSync(filePath)) return null;
	const text = fs.readFileSync(filePath, 'utf8');
	const methodRe = new RegExp(`public\\s+\\S+\\s+${methodName}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`);
	const match = text.match(methodRe);
	if (!match) return null;
	return /@RequestBody/.test(match[1]);
}

export function buildContract({ featureId, featureUid, scanReport, module: moduleName }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	const operations = {};
	const warnings = [];

	if (!targetModule) {
		warnings.push('no related module in the scan report -- emitting an empty operation set. Pass --module, or re-run `bskel scan` with terms that actually match the intended feature.');
	} else {
		for (const controller of targetModule.controllers) {
			for (const ep of controller.endpoints) {
				if (!ep.operationId) {
					warnings.push(`${ep.verb} ${ep.path} (method ${ep.method}) has no correlated operationId in the scan -- skipped, it cannot be addressed by operation_id in the envelope`);
					continue;
				}
				if (operations[ep.operationId]) {
					warnings.push(`duplicate operationId "${ep.operationId}" seen more than once -- keeping the first occurrence`);
					continue;
				}
				const hasBody = detectRequestBody(controller.file, ep.method);
				operations[ep.operationId] = {
					verb: ep.verb,
					path: ep.path,
					pathParams: pathParamsSchema(ep.path),
					body: hasBody === null ? 'unknown' : hasBody,
					provenance: 'scan',
				};
			}
		}
	}

	return {
		sbf_contract: '1',
		feature_id: featureId,
		feature_uid: featureUid,
		generated_at: new Date().toISOString(),
		source: targetModule
			? { adapter: scanReport.adapter, module: targetModule.module, provenance: 'scan' }
			: { adapter: scanReport.adapter ?? null, module: null, provenance: 'none' },
		operations,
		warnings,
	};
}
