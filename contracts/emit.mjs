import fs from 'node:fs';
import { makeWarning, classifyContract } from './completeness.mjs';

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

// A5: warnings are structured ({code, severity, subject, message, detail}), not bare strings --
// see contracts/completeness.mjs. The three original warning conditions (no-module/unmatched/
// duplicate) and their exact message text are unchanged; two are new (CONTRACT_EMPTY,
// CONTRACT_BODY_UNKNOWN). This function still never looks at waivers -- it reports what the scan
// found, nothing more; bin/bskel.mjs's cmdContractEmit is what weighs warnings against
// contracts/completeness.mjs's evaluateResolution() to decide whether to block.
export function buildContract({ featureId, featureUid, scanReport, module: moduleName }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	const operations = {};
	const warnings = [];
	let endpointCount = 0;

	if (!targetModule) {
		warnings.push(makeWarning('CONTRACT_NO_MODULE', {
			message: 'no related module in the scan report -- emitting an empty operation set. Pass --module, or re-run `bskel scan` with terms that actually match the intended feature.',
		}));
	} else {
		for (const controller of targetModule.controllers) {
			for (const ep of controller.endpoints) {
				endpointCount++;
				if (!ep.operationId) {
					warnings.push(makeWarning('CONTRACT_UNMATCHED_ENDPOINT', {
						subject: `${ep.verb} ${ep.path}`,
						message: `${ep.verb} ${ep.path} (method ${ep.method}) has no correlated operationId in the scan -- skipped, it cannot be addressed by operation_id in the envelope`,
						detail: { verb: ep.verb, path: ep.path, method: ep.method },
					}));
					continue;
				}
				if (operations[ep.operationId]) {
					warnings.push(makeWarning('CONTRACT_DUPLICATE_OPERATION_ID', {
						subject: ep.operationId,
						message: `duplicate operationId "${ep.operationId}" seen more than once -- keeping the first occurrence`,
						detail: { verb: ep.verb, path: ep.path, method: ep.method },
					}));
					continue;
				}
				const hasBody = detectRequestBody(controller.file, ep.method);
				if (hasBody === null) {
					// Low-risk metadata gap, not a routing/addressing problem -- warn, not error (see
					// WARNING_CODES in completeness.mjs). operationPayloadSchema() already treats
					// body:'unknown' as optional, so this just makes that leniency visible instead of silent.
					warnings.push(makeWarning('CONTRACT_BODY_UNKNOWN', {
						subject: `${ep.verb} ${ep.path}`,
						message: `${ep.verb} ${ep.path} (operationId "${ep.operationId}") -- could not determine whether this method takes a @RequestBody (controller source not found or method signature not matched); payload body is treated as optional`,
						detail: { verb: ep.verb, path: ep.path, method: ep.method, operationId: ep.operationId },
					}));
				}
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

	// Fires regardless of WHY operations ended up empty (no module matched, or a module matched
	// but had zero controllers/endpoints, or every endpoint was unmatched/duplicate) -- the other
	// warnings explain the cause, this one states the consequence: nothing here can be trusted.
	if (Object.keys(operations).length === 0) {
		warnings.push(makeWarning('CONTRACT_EMPTY', {
			message: 'this contract has zero operations -- it cannot be used by `contract validate`/`tool-schema`, or routed to by `handles emit`. Fix --module/--terms, or if this module genuinely has no HTTP surface (yet), there is nothing to contract.',
		}));
	}

	const completeness = {
		status: classifyContract({ operations, warnings }),
		operation_count: Object.keys(operations).length,
		endpoint_count: endpointCount,
	};

	return {
		sbf_contract: '2',
		feature_id: featureId,
		feature_uid: featureUid,
		generated_at: new Date().toISOString(),
		source: targetModule
			? { adapter: scanReport.adapter, module: targetModule.module, provenance: 'scan' }
			: { adapter: scanReport.adapter ?? null, module: null, provenance: 'none' },
		operations,
		warnings,
		completeness,
	};
}
