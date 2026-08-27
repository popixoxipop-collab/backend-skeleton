import fs from 'node:fs';
import { makeWarning, classifyContract } from './completeness.mjs';
import { findMethodParams } from '../scanners/adapters/_java-spring-analyzer.mjs';
import { pathPrefixCandidates, unreflectedPathPrefixes } from './export.mjs';

// D-security-2: a plain UUID `pattern`, not `format: 'uuid'`. ajv-formats' uuid format accepts
// an optional `urn:uuid:` prefix (per its RFC 4122 reading), but Spring's `UUID` path-variable
// converter expects the bare form -- a contract using `format: 'uuid'` could certify a
// `urn:uuid:...` request as valid when the real endpoint would reject it. Found by the Codex
// security review, verified against the installed ajv-formats@3.0.1.
//
// A2: exported so contracts/openapi.mjs's inlineSchema() can apply the identical fix one layer
// down -- springdoc renders a Java `UUID` request-body field as `{type:'string', format:'uuid'}`,
// the exact shape this const was created to avoid, just inside a projected body schema instead of
// a path param. Direction stays one-way (openapi.mjs imports from emit.mjs, never the reverse).
export const BARE_UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// A7/A8/A9/A10: the single source of truth for schemas/feature-contract.schema.json's `sbf_contract`
// const -- bin/bskel.mjs's loadContract() imports this too, so the friendly "re-emit with the
// current bskel" message and the value actually written here cannot drift apart. Bumped "7" -> "8"
// for this item (sourceDescription) -- again cheap, the friendly re-emit pre-check needs zero
// code change -- see D-openapi-description.
export const CONTRACT_SCHEMA_VERSION = '8';

// A9 (D-openapi-path-params): `sourcePathParamSchemas` (a Map<name, schema>, contracts/openapi.mjs's
// applyPathParameterSchemas -- present only for a matched/adopted operation whose source document
// resolved at least one real path-param schema) is preferred per-segment over the name heuristic
// below. The heuristic remains the fallback for any segment the source doesn't answer (no source
// document at all, source declared no schema for that name, or the schema failed to resolve) --
// this function's OWN correctness posture is unchanged for those cases, exactly as before this
// item. `pathParamsHeuristic` names every segment that still fell back, so a downstream consumer
// (contracts/export.mjs's collectOmissions()) can tell, per operation, whether ANY segment is still
// a guess -- `null` (never `[]`) when every segment was source-resolved or the route has none.
function pathParamsSchema(routePath, sourcePathParamSchemas = null) {
	const params = [...routePath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
	const properties = {};
	const heuristicNames = [];
	for (const p of params) {
		const sourced = sourcePathParamSchemas ? sourcePathParamSchemas.get(p) : undefined;
		if (sourced) {
			properties[p] = sourced;
			continue;
		}
		// Naming convention seen throughout Team-IZ-Backend (`UUID organizationId`, etc.) --
		// a heuristic, not a guarantee; wrong for a path param that happens to end in "Id" but
		// isn't a UUID, which just means an over-strict uuid-shaped check on that one field.
		properties[p] = /id$/i.test(p) ? { type: 'string', pattern: BARE_UUID_PATTERN } : { type: 'string' };
		heuristicNames.push(p);
	}
	return {
		pathParams: { type: 'object', additionalProperties: false, properties, required: params },
		pathParamsHeuristic: heuristicNames.length > 0 ? heuristicNames : null,
	};
}

// Re-reads the controller source (already located by the scan) to check whether this specific
// method's parameter list has @RequestBody -- verb alone is not reliable in this codebase
// (e.g. `deleteOrganization` is DELETE but still takes a @RequestBody confirm-name payload).
// A2 Phase 1 (D-java-analyzer): confirmed live that the old non-greedy `([\s\S]*?)\)\s*\{` regex
// (the exact pattern the catalog's own A2 Why names alongside extractController()) failed to
// match at all against a return type with a space inside a generic (`ResponseEntity<Map<String,
// Object>>`) -- findMethodParams() shares the same balanced-delimiter analyzer that fixes the
// scanner's identical GenericWithSpaceController case.
function detectRequestBody(filePath, methodName) {
	if (!filePath || !fs.existsSync(filePath)) return null;
	const text = fs.readFileSync(filePath, 'utf8');
	const params = findMethodParams(text, methodName);
	if (params === null) return null;
	return /@RequestBody/.test(params);
}

// A1: shared with contracts/openapi.mjs so "which module" and "which endpoint is which" are
// defined in exactly one place -- openapi.mjs imports these (never the reverse), so a
// reconciliation is guaranteed to line up with the same module/endpoint buildContract() sees,
// as long as both are called with the same (scanReport, moduleName) inputs.
export function selectModule(scanReport, moduleName) {
	return moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];
}

// A string, not object identity, so it survives serialization into the openapi snapshot and
// doesn't depend on both callers sharing the exact same parsed scanReport object.
export function endpointKey(controllerIndex, endpointIndex) {
	return `${controllerIndex}:${endpointIndex}`;
}

// A5: warnings are structured ({code, severity, subject, message, detail}), not bare strings --
// see contracts/completeness.mjs. The three original warning conditions (no-module/unmatched/
// duplicate) and their exact message text are unchanged; two are new (CONTRACT_EMPTY,
// CONTRACT_BODY_UNKNOWN). This function still never looks at waivers -- it reports what the scan
// found, nothing more; bin/bskel.mjs's cmdContractEmit is what weighs warnings against
// contracts/completeness.mjs's evaluateResolution() to decide whether to block.
//
// A1: `openapi` (default null) is an already-computed contracts/openapi.mjs Reconciliation --
// this function never opens the OpenAPI file itself (same "stays pure" discipline as never
// looking at waivers). `openapi === null` is a hard guarantee of byte-identical output to
// pre-A1 behavior -- see test/contract.test.mjs's "openapi param omitted" test.
export function buildContract({ featureId, featureUid, scanReport, module: moduleName, openapi = null }) {
	const targetModule = selectModule(scanReport, moduleName);

	const operations = {};
	const warnings = [];
	let endpointCount = 0;

	if (!targetModule) {
		warnings.push(makeWarning('CONTRACT_NO_MODULE', {
			message: 'no related module in the scan report -- emitting an empty operation set. Pass --module, or re-run `bskel scan` with terms that actually match the intended feature.',
		}));
	} else {
		for (const [ci, controller] of targetModule.controllers.entries()) {
			for (const [ei, ep] of controller.endpoints.entries()) {
				endpointCount++;
				const res = openapi ? openapi.byEndpoint.get(endpointKey(ci, ei)) ?? null : null;

				let operationId = ep.operationId;
				let verb = ep.verb;
				let route = ep.path;
				let provenance = 'scan';
				let openapiAttempted = false;
				let openapiReason = null;
				// A2/A3: only ever set for matched/adopted (contracts/openapi.mjs's applyRequestBodySchema/
				// applyResponseSchemas run for those two kinds only) -- stays null for every other kind.
				let requestBodySchema = null;
				let requestBodyRequired = false;
				let schemaUnresolvedReason = null;
				let responseSchema = null;
				let responseSchemaUnresolvedReason = null;
				let errorSchema = null;
				let errorSchemaUnresolvedReason = null;
				// A7: same matched/adopted-only discipline as A2/A3's fields above -- stays null for
				// every other kind.
				let sourceParameters = null;
				let parametersUnresolved = null;
				let sourceSecurity = null;
				let securityUnresolvedReason = null;
				let sourceSummary = null;
				let sourceTags = null;
				// A8: same discipline, for the two new passthrough fields.
				let sourceResponses = null;
				let sourceRequestBody = null;
				let requestMediaTypesUnresolvedReason = null;
				// A9: same discipline -- transient (Map), consulted below by pathParamsSchema(), never
				// itself spread into the persisted operation object (see that function's own comment).
				let pathParamSchemas = null;
				// A10: same discipline, for the opt-in operation-level description.
				let sourceDescription = null;
				let descriptionUnresolvedReason = null;

				if (res) {
					switch (res.kind) {
						case 'matched':
							// operationId came from source (scan), verb/path are OpenAPI-confirmed --
							// this is A1's main fix: the endpoint was already addressable, but its path
							// was wrong (missing e.g. a global /api/v0 prefix the scanner can't see).
							verb = res.verb;
							route = res.path;
							provenance = 'scan+openapi';
							requestBodySchema = res.requestBodySchema ?? null;
							requestBodyRequired = res.requestBodyRequired ?? false;
							schemaUnresolvedReason = res.schemaUnresolvedReason ?? null;
							responseSchema = res.responseSchema ?? null;
							responseSchemaUnresolvedReason = res.responseSchemaUnresolvedReason ?? null;
							errorSchema = res.errorSchema ?? null;
							errorSchemaUnresolvedReason = res.errorSchemaUnresolvedReason ?? null;
							sourceParameters = res.sourceParameters ?? null;
							parametersUnresolved = res.parametersUnresolved ?? null;
							sourceSecurity = res.sourceSecurity ?? null;
							securityUnresolvedReason = res.securityUnresolvedReason ?? null;
							sourceSummary = res.sourceSummary ?? null;
							sourceTags = res.sourceTags ?? null;
							sourceResponses = res.sourceResponses ?? null;
							sourceRequestBody = res.sourceRequestBody ?? null;
							requestMediaTypesUnresolvedReason = res.requestMediaTypesUnresolvedReason ?? null;
							pathParamSchemas = res.pathParamSchemas ?? null;
						sourceDescription = res.sourceDescription ?? null;
						descriptionUnresolvedReason = res.descriptionUnresolvedReason ?? null;
							break;
						case 'adopted':
							// No @Operation(operationId=...) in source at all -- the id itself comes from
							// the document, not from anything pinned in Java. Real and addressable, but
							// flagged (WARN, not ERROR) since renaming the handler method would silently
							// change it.
							operationId = res.operationId;
							verb = res.verb;
							route = res.path;
							provenance = 'openapi';
							requestBodySchema = res.requestBodySchema ?? null;
							requestBodyRequired = res.requestBodyRequired ?? false;
							schemaUnresolvedReason = res.schemaUnresolvedReason ?? null;
							responseSchema = res.responseSchema ?? null;
							responseSchemaUnresolvedReason = res.responseSchemaUnresolvedReason ?? null;
							errorSchema = res.errorSchema ?? null;
							errorSchemaUnresolvedReason = res.errorSchemaUnresolvedReason ?? null;
							sourceParameters = res.sourceParameters ?? null;
							parametersUnresolved = res.parametersUnresolved ?? null;
							sourceSecurity = res.sourceSecurity ?? null;
							securityUnresolvedReason = res.securityUnresolvedReason ?? null;
							sourceSummary = res.sourceSummary ?? null;
							sourceTags = res.sourceTags ?? null;
							sourceResponses = res.sourceResponses ?? null;
							sourceRequestBody = res.sourceRequestBody ?? null;
							requestMediaTypesUnresolvedReason = res.requestMediaTypesUnresolvedReason ?? null;
							pathParamSchemas = res.pathParamSchemas ?? null;
						sourceDescription = res.sourceDescription ?? null;
						descriptionUnresolvedReason = res.descriptionUnresolvedReason ?? null;
							warnings.push(makeWarning('CONTRACT_OPENAPI_DERIVED_OPERATION_ID', {
								subject: operationId,
								message: `operationId "${operationId}" for ${res.verb} ${res.path} was not found in the source (no @Operation(operationId=...)) -- adopted directly from the OpenAPI document instead`,
								detail: { verb: res.verb, path: res.path, scan_verb: ep.verb, scan_path: ep.path },
							}));
							break;
						case 'drift':
							// operationId matches on both sides, but verb/path disagree in a way the
							// path prefix can't explain -- possibly the scanner's "nearest preceding
							// @Operation(" heuristic mis-attributed this id to the wrong method. Fail
							// closed: keep the scan's own value, don't silently adopt the document's.
							warnings.push(makeWarning('CONTRACT_OPENAPI_DRIFT', {
								subject: ep.operationId,
								message: `operationId "${ep.operationId}" disagrees with the OpenAPI document on ${res.reason} -- scan has ${ep.verb} ${ep.path}, OpenAPI has ${res.openapi.verb} ${res.openapi.path}. Not auto-resolved.`,
								detail: { reason: res.reason, scan: { verb: ep.verb, path: ep.path }, openapi: res.openapi },
							}));
							break;
						case 'missing':
							// The scan's operationId isn't in the document anywhere -- left uncorrected
							// (still the unprefixed scan path) specifically so this can't be mistaken
							// for a successful reconciliation.
							warnings.push(makeWarning('CONTRACT_OPENAPI_MISSING_OPERATION', {
								subject: ep.operationId,
								message: `operationId "${ep.operationId}" (${ep.verb} ${ep.path}) was not found anywhere in the OpenAPI document -- path left uncorrected`,
								detail: { verb: ep.verb, path: ep.path },
							}));
							break;
						case 'ambiguous':
							warnings.push(makeWarning('CONTRACT_OPENAPI_AMBIGUOUS', {
								subject: `${ep.verb} ${ep.path}`,
								message: `${ep.verb} ${ep.path} matched more than one OpenAPI operation candidate -- not guessed`,
								detail: { verb: ep.verb, path: ep.path, candidates: res.candidates },
							}));
							continue; // still has no operationId -- can't be addressed either way
						case 'unresolved':
							// No candidate, or the path prefix couldn't be determined -- falls through
							// to the ordinary CONTRACT_UNMATCHED_ENDPOINT path below, with detail
							// recording that OpenAPI reconciliation was attempted and why it didn't help.
							openapiAttempted = true;
							openapiReason = res.reason;
							break;
						default:
							break;
					}
				}

				if (!operationId) {
					warnings.push(makeWarning('CONTRACT_UNMATCHED_ENDPOINT', {
						subject: `${ep.verb} ${ep.path}`,
						message: `${ep.verb} ${ep.path} (method ${ep.method}) has no correlated operationId in the scan -- skipped, it cannot be addressed by operation_id in the envelope`,
						detail: {
							verb: ep.verb, path: ep.path, method: ep.method,
							...(openapiAttempted ? { openapi_attempted: true, openapi_reason: openapiReason } : {}),
						},
					}));
					continue;
				}
				if (operations[operationId]) {
					warnings.push(makeWarning('CONTRACT_DUPLICATE_OPERATION_ID', {
						subject: operationId,
						message: `duplicate operationId "${operationId}" seen more than once -- keeping the first occurrence`,
						detail: { verb, path: route, method: ep.method },
					}));
					continue;
				}
				const hasBody = detectRequestBody(controller.file, ep.method);
				if (hasBody === null) {
					// Low-risk metadata gap, not a routing/addressing problem -- warn, not error (see
					// WARNING_CODES in completeness.mjs). operationPayloadSchema() already treats
					// body:'unknown' as optional, so this just makes that leniency visible instead of silent.
					warnings.push(makeWarning('CONTRACT_BODY_UNKNOWN', {
						subject: `${verb} ${route}`,
						message: `${verb} ${route} (operationId "${operationId}") -- could not determine whether this method takes a @RequestBody (controller source not found or method signature not matched); payload body is treated as optional`,
						detail: { verb, path: route, method: ep.method, operationId },
					}));
				}
				// A2: the schema was found and couldn't be projected -- distinct from "no schema to
				// project at all" (requestBodySchema stays null with no warning in that case, see
				// contracts/openapi.mjs's applyRequestBodySchema). Falls back to the pre-A2 bare-object
				// check (operationPayloadSchema treats a missing requestBodySchema as before); never
				// blocks completeness (WARN, see contracts/completeness.mjs).
				if (schemaUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_SCHEMA_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) matched an OpenAPI operation with a JSON request body, but its schema could not be projected (${schemaUnresolvedReason}) -- the body is still validated, just as a bare object instead of its real shape`,
						detail: { reason: schemaUnresolvedReason, verb, path: route, operationId },
					}));
				}
				// A3: same "found but couldn't project" distinction as the request-body warning above,
				// applied separately to response (2xx) and error (4xx/5xx) -- two DIFFERENT codes (see
				// D-openapi-response-schema), so a projection failure on one direction never shares a
				// waiver key with an unrelated failure on another direction for the same operation.
				if (responseSchemaUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) documents a 2xx JSON response, but its schema could not be projected (${responseSchemaUnresolvedReason}) -- the response stays unconstrained, same as before --openapi-file`,
						detail: { reason: responseSchemaUnresolvedReason, verb, path: route, operationId },
					}));
				}
				if (errorSchemaUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) documents a 4xx/5xx JSON response, but its schema could not be projected (${errorSchemaUnresolvedReason}) -- the error payload stays unconstrained, same as before --openapi-file`,
						detail: { reason: errorSchemaUnresolvedReason, verb, path: route, operationId },
					}));
				}
				// A7: at least one non-path parameter on this matched/adopted operation could not be
				// copied verbatim -- an unsupported parameter shape ($ref/content/unknown key/cap
				// exceeded) or a schema inlineSchema() itself could not resolve. One warning per
				// operation (not per parameter), same "subject is the operationId" shape as the schema-
				// unresolved codes above -- the message enumerates every individual failure.
				if (parametersUnresolved) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) has ${parametersUnresolved.length} parameter(s) that could not be copied from the source document: ${parametersUnresolved.map((p) => `${p.in ?? '?'} "${p.name ?? '?'}" (${p.reason})`).join(', ')}`,
						detail: { verb, path: route, operationId, unresolved: parametersUnresolved },
					}));
				}
				// A7: the operation declared `security` in the source document, but at least one named
				// scheme could not be resolved against components.securitySchemes (or the requirement
				// itself was malformed/oversized) -- the WHOLE security value is dropped for this
				// operation, never a dangling reference (see contracts/openapi.mjs's applySecurity).
				if (securityUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_SECURITY_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) declares a security requirement that could not be copied (${securityUnresolvedReason}) -- security stays unrepresented for this operation, same as before --openapi-file`,
						detail: { reason: securityUnresolvedReason, verb, path: route, operationId },
					}));
				}
				// A8: the operation's request body declared a non-application/json media type (e.g.
				// multipart/form-data) whose schema could not be fully projected -- the media type
				// itself is still recorded in sourceRequestBody (see contracts/openapi.mjs's
				// applyRequestMediaTypes), only its shape is missing. A SEPARATE code from
				// CONTRACT_OPENAPI_SCHEMA_UNRESOLVED (the application/json body's own code): the two
				// CAN co-occur on one operation (an endpoint legally accepting both application/json
				// and multipart/form-data), and warningKey is {code, subject=operationId} -- sharing a
				// code would let a waiver for one silently cover the other, the same reasoning
				// D-openapi-response-schema's response/error split already established and A7 reused
				// for parameters/security.
				if (requestMediaTypesUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) declares a non-JSON request media type that could not be fully copied (${requestMediaTypesUnresolvedReason}) -- the media type name is still recorded where possible, its shape is not`,
						detail: { reason: requestMediaTypesUnresolvedReason, verb, path: route, operationId },
					}));
				}
				// A10: only fires when --descriptions was passed AND the source declared one AND it
				// exceeded MAX_DESCRIPTION_LENGTH -- independent from every other unresolved code above
				// (a genuinely new failure mode, not reusing an existing one), same reasoning A8 used to
				// justify its own new multipart code instead of overloading an existing one.
				if (descriptionUnresolvedReason) {
					warnings.push(makeWarning('CONTRACT_OPENAPI_DESCRIPTION_UNRESOLVED', {
						subject: operationId,
						message: `operationId "${operationId}" (${verb} ${route}) declares a description that could not be copied (${descriptionUnresolvedReason}) -- description stays unrepresented for this operation, same as before --descriptions`,
						detail: { reason: descriptionUnresolvedReason, verb, path: route, operationId },
					}));
				}
				const { pathParams, pathParamsHeuristic } = pathParamsSchema(route, pathParamSchemas);
				operations[operationId] = {
					verb,
					path: route,
					pathParams,
					body: hasBody === null ? 'unknown' : hasBody,
					provenance,
					// A2/A3/A7: omitted entirely (not null/false) when there's nothing to project/copy --
					// keeps `openapi:null` (and any operation that isn't matched/adopted) byte-identical
					// to pre-A2/A3/A7 output, the same guarantee A1 established for its own fields.
					...(requestBodySchema ? { requestBodySchema, requestBodyRequired } : {}),
					...(responseSchema ? { responseSchema } : {}),
					...(errorSchema ? { errorSchema } : {}),
					...(sourceParameters ? { sourceParameters } : {}),
					...(sourceSecurity ? { sourceSecurity } : {}),
					...(sourceSummary ? { sourceSummary } : {}),
					...(sourceTags ? { sourceTags } : {}),
					...(sourceResponses ? { sourceResponses } : {}),
					...(sourceRequestBody ? { sourceRequestBody } : {}),
					// A9: omitted (not []) when every segment resolved from source, or the route has none.
					...(pathParamsHeuristic ? { pathParamsHeuristic } : {}),
					// A10: omitted entirely when --descriptions was not passed, the source had none, or
					// it failed the length cap -- same "omitted, never null/false" discipline as every
					// other field above.
					...(sourceDescription ? { sourceDescription } : {}),
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

	// Real dogfooding finding (Phase 3, Team-IZ/Backend, 2026-08-24): reuses A6's own
	// pathPrefixCandidates()/unreflectedPathPrefixes() (contracts/export.mjs) rather than
	// re-deriving prefix detection here -- this is the SAME check `contract export` already runs,
	// just moved earlier so `completeness` itself reflects it instead of only being caught later at
	// export time. Runs against the final `operations` (post-reconciliation, if any) rather than
	// gating on `!openapi`, because a partially-reconciled contract (matched paths corrected, a
	// drift/missing one left at its uncorrected scan path) is exactly the mixed case
	// unreflectedPathPrefixes() itself warns is no safer than a wholly-unprefixed contract.
	for (const prefix of unreflectedPathPrefixes({ operations }, pathPrefixCandidates(scanReport.path_prefix_signals))) {
		warnings.push(makeWarning('CONTRACT_UNREFLECTED_PATH_PREFIX', {
			subject: prefix,
			message: `the scan found a global path-prefix signal (${prefix}) that this contract's operation paths do not reflect -- \`contract export\` already refuses to publish this by default (see D-openapi-export); this warning surfaces the same issue at \`contract emit\` time instead of only at export time. Re-run with --openapi-file to correct the paths, or waive if this signal genuinely does not apply to this module.`,
			detail: { prefix },
		}));
	}

	const completeness = {
		status: classifyContract({ operations, warnings }),
		operation_count: Object.keys(operations).length,
		endpoint_count: endpointCount,
	};

	// A7: only schemes actually referenced by at least one operation's COPIED sourceSecurity
	// requirement anywhere in this contract -- omitted entirely (not {}) when openapi is null or no
	// operation ended up with a resolvable security requirement, same byte-identity discipline as
	// every other openapi-derived field.
	const sourceSecuritySchemes = openapi && openapi.sourceSecuritySchemes && openapi.sourceSecuritySchemes.size > 0
		? Object.fromEntries(openapi.sourceSecuritySchemes)
		: null;

	return {
		sbf_contract: CONTRACT_SCHEMA_VERSION,
		feature_id: featureId,
		feature_uid: featureUid,
		source: targetModule
			? { adapter: scanReport.adapter, module: targetModule.module, provenance: openapi ? 'scan+openapi' : 'scan' }
			: { adapter: scanReport.adapter ?? null, module: null, provenance: 'none' },
		...(sourceSecuritySchemes ? { sourceSecuritySchemes } : {}),
		operations,
		warnings,
		completeness,
	};
}
