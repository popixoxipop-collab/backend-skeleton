// A5: distinguishes "a contract file was written" from "this contract is complete enough to
// trust". `buildContract()` (contracts/emit.mjs) always succeeds and always returns SOME
// object, even when it found zero usable operations -- Team-IZ-Backend's `codeanalysis` module
// (1 entity, 0 controllers) produces operations:0, warnings:0 with the pre-A5 code, and the
// `contract` gate passed silently (see D-contract-completeness in DECISIONS.md for the full
// before/after). This module is the single place that turns a contract's warnings into a
// completeness verdict and evaluates that verdict against recorded waivers -- contracts/emit.mjs
// stays a pure "what did the scan find" function and never looks at waivers itself, and
// bin/bskel.mjs never re-derives severity/blocking logic inline.
import { readJsonIfExists, writeFileAtomic } from '../lib/fsutil.mjs';
import { specPath } from '../lib/paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

export const SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn' });
export const COMPLETENESS = Object.freeze({ COMPLETE: 'complete', PARTIAL: 'partial', BLOCKED: 'blocked' });

// `waivable: false` codes only ever co-occur with zero operations (CONTRACT_NO_MODULE and
// CONTRACT_EMPTY both mean the endpoint loop in buildContract() never ran at all) -- so gating
// waivers on `completeness === 'blocked'` in cmdContractWaive is sufficient to keep them
// unwaivable; there is no case where either fires with operations > 0.
export const WARNING_CODES = Object.freeze({
	CONTRACT_NO_MODULE: { severity: SEVERITY.ERROR, waivable: false },
	CONTRACT_EMPTY: { severity: SEVERITY.ERROR, waivable: false },
	CONTRACT_UNMATCHED_ENDPOINT: { severity: SEVERITY.ERROR, waivable: true },
	CONTRACT_DUPLICATE_OPERATION_ID: { severity: SEVERITY.ERROR, waivable: true },
	CONTRACT_BODY_UNKNOWN: { severity: SEVERITY.WARN, waivable: true },
	// A1: an operationId correlated by the scan (or by OpenAPI reconciliation) that disagrees
	// with the OpenAPI document on verb or path in a way the inferred/given path prefix can't
	// explain -- a real conflict, not just a missing prefix. Never silently resolved in favor of
	// either source; the scan's own value is kept (fail-closed) and this blocks until a human
	// looks. See contracts/openapi.mjs.
	CONTRACT_OPENAPI_DRIFT: { severity: SEVERITY.ERROR, waivable: true },
	// A1: the scan found a real operationId that simply isn't in the OpenAPI document at all --
	// distinct from DRIFT (found but disagrees) because a waiver keyed on one must never silently
	// cover the other if the underlying cause changes later (see D-contract-completeness's
	// wildcard-waiver reasoning, reapplied here). Left uncorrected (still the unprefixed scan
	// path) specifically so this can't be mistaken for a successful reconciliation.
	CONTRACT_OPENAPI_MISSING_OPERATION: { severity: SEVERITY.ERROR, waivable: true },
	// A1: an unmatched (no operationId) endpoint's verb+normalized-path resolved to more than one
	// OpenAPI operation candidate -- never guessed, see contracts/openapi.mjs's reconcileModule.
	CONTRACT_OPENAPI_AMBIGUOUS: { severity: SEVERITY.ERROR, waivable: true },
	// A1: an operationId was adopted from the OpenAPI document itself (the scan found no
	// @Operation(operationId=...) at all) rather than confirmed against source -- low-risk (same
	// class as CONTRACT_BODY_UNKNOWN): the id is real and addressable, but isn't pinned in Java
	// source, so renaming the handler method silently changes what clients see.
	CONTRACT_OPENAPI_DERIVED_OPERATION_ID: { severity: SEVERITY.WARN, waivable: true },
	// A2: a `matched`/`adopted` operation (path/verb already reconciled) whose OpenAPI requestBody
	// declares an application/json schema, but that schema could not be projected into a
	// self-contained JSON Schema -- an unsupported keyword, an over-long or uncompilable `pattern`,
	// a $ref cycle, or a depth/node-count cap. Deliberately WARN, not ERROR: the contract is still
	// CORRECT (the pre-A2 `body:true -> {type:'object'}` fallback still applies), just less
	// specific -- a missed enhancement, not a defect. Making this ERROR would make `partial`/
	// `blocked` depend on how exotic a downstream DTO's validation annotations happen to be, across
	// every real module -- same class as CONTRACT_BODY_UNKNOWN. See contracts/openapi.mjs's
	// inlineSchema() and D-openapi-request-schema in DECISIONS.md.
	CONTRACT_OPENAPI_SCHEMA_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
	// A3: same shape as CONTRACT_OPENAPI_SCHEMA_UNRESOLVED above, one for the response (2xx) side
	// and one for the error (4xx/5xx) side -- deliberately TWO codes, not one shared with each
	// other or with the request-side code above. An operation's request/response/error projection
	// can each fail independently for unrelated reasons; if they shared a code, a waiver for one
	// failure (keyed on {code, subject=operationId}) would silently also cover the other, and a
	// future severity change to one direction would force splitting a shipped code. Same WARN
	// reasoning: the pre-A3 unconstrained response/error check still applies, so this is a missed
	// enhancement, not a defect. See D-openapi-response-schema in DECISIONS.md.
	CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
	CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
	// A7: at least one non-path parameter on a matched/adopted operation could not be copied into
	// sourceParameters -- an unsupported shape ($ref/content/unknown key/cap exceeded), or a schema
	// inlineSchema() itself could not resolve. WARN, not ERROR: verb/path/body are still correctly
	// contracted, this is a missed enhancement -- same reasoning as CONTRACT_OPENAPI_SCHEMA_UNRESOLVED.
	CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
	// A7: the operation declared `security` in the source document, but at least one named scheme
	// could not be resolved against components.securitySchemes (or the requirement itself was
	// malformed/oversized) -- the WHOLE security value is dropped for that operation rather than a
	// partial/dangling one, and this warns about it. Deliberately a SEPARATE code from
	// CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED (same operation, same subject, unrelated failure) --
	// same "a waiver for one must never silently cover the other" reasoning D-openapi-response-schema
	// already established for the response/error split. WARN: omitting security is still honest
	// ("unspecified"), just less specific than the source document actually was.
	CONTRACT_OPENAPI_SECURITY_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
	// Real dogfooding finding (Phase 3, Team-IZ/Backend, 2026-08-24): A1 §7's `path_prefix_signals`
	// were only ever consulted at `contract export` time (A6's own refusal, contracts/export.mjs's
	// unreflectedPathPrefixes()) -- a module with an unaddressed global prefix signal could still
	// classify as `complete` at `contract emit` time, which is exactly backwards: the paths ARE
	// wrong, `contract export` just happens to independently catch it before publishing. ERROR (not
	// WARN) for the same reason CONTRACT_OPENAPI_DRIFT is ERROR: a wrong path is a correctness
	// defect, not a missed enhancement. Waivable so a false-positive signal (see --allow-unprefixed's
	// own escape hatch) doesn't permanently block a module it genuinely doesn't apply to.
	CONTRACT_UNREFLECTED_PATH_PREFIX: { severity: SEVERITY.ERROR, waivable: true },
	// A8: the operation's request body declared a non-JSON media type (e.g. multipart/form-data)
	// whose schema could not be fully projected -- the media type name is still recorded, its
	// shape is not. Deliberately a SEPARATE code from CONTRACT_OPENAPI_SCHEMA_UNRESOLVED (the
	// application/json-body code) -- the two can co-occur on one operation, and a shared code
	// would let a waiver for one silently cover the other, same reasoning D-openapi-response-schema
	// established for its own response/error split. WARN: verb/path/the JSON body (if any) stay
	// correctly contracted, this is a missed enhancement. No equivalent code exists for per-status
	// responses -- that failure mode is not independent of A3's own response/error unresolved
	// codes (both walk the same responses map through the same inlineSchema() at the same cap), so
	// it reuses CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED/CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED
	// unchanged -- see D-openapi-per-status.
	CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED: { severity: SEVERITY.WARN, waivable: true },
});

export const WARNING_CODE_NAMES = Object.freeze(Object.keys(WARNING_CODES));

export function getWarningCode(code) {
	return Object.hasOwn(WARNING_CODES, code) ? WARNING_CODES[code] : null;
}

// The typo-defense point for `bskel contract waive --code <CODE>` -- same pattern as
// lib/gate-definitions.mjs's requireGateDefinition.
export function requireWarningCode(code) {
	const spec = getWarningCode(code);
	if (!spec) {
		throw new Error(`unknown contract warning code "${code}" -- known codes: ${WARNING_CODE_NAMES.join(', ')}`);
	}
	return spec;
}

// severity is stamped onto the warning at creation time (so a plain JSON reader never needs this
// module to know what a contract means), but blocking decisions always re-derive severity from
// WARNING_CODES, not from the stamped value -- see evaluateResolution.
export function makeWarning(code, { subject = null, message, detail = {} }) {
	const spec = requireWarningCode(code);
	return { code, severity: spec.severity, subject, message, detail };
}

// The waiver key. Deliberately code+subject only, NEVER message -- message text gets rephrased
// over time, and a waiver keyed on it would silently stop matching. subject is derived from the
// stable verb+path or operationId, not from anything a human might reword.
export function warningKey(warning) {
	return `${warning.code}::${warning.subject ?? '*'}`;
}

export function countByCode(warnings) {
	const counts = {};
	for (const w of warnings) counts[w.code] = (counts[w.code] ?? 0) + 1;
	return counts;
}

// Completeness from the contract's own content alone -- knows nothing about waivers (see
// evaluateResolution for the waiver-aware verdict). Zero operations always means `blocked`
// regardless of what warnings say (a blocked contract usually has zero warnings too, since the
// endpoint loop that would generate them never ran -- but this stays correct either way).
export function classifyContract({ operations, warnings }) {
	if (Object.keys(operations).length === 0) return COMPLETENESS.BLOCKED;
	if (warnings.some((w) => w.severity === SEVERITY.ERROR)) return COMPLETENESS.PARTIAL;
	return COMPLETENESS.COMPLETE;
}

const RESOLUTION_SCHEMA = 'sbf.contract-resolution/1';

export function resolutionPath(root, featureId) {
	return specPath(root, featureId, 'contracts', `${featureId}.resolution.json`);
}

export function loadResolution(root, featureId) {
	const path = resolutionPath(root, featureId);
	const parsed = readJsonIfExists(path);
	if (parsed === null) {
		return { schema: RESOLUTION_SCHEMA, feature_id: featureId, waivers: [] };
	}
	// S5 (D-persistence-integrity): lib-style read function -- throws a plain Error (same
	// convention as lib/state.mjs's loadState), which bin/bskel.mjs's main() catch-all already
	// treats as a documented case ("a malformed-state read", exit 14/BAD_ARGS).
	const { ok, errors } = validateAgainstSchema('contract-resolution.schema.json', parsed);
	if (!ok) {
		throw new Error(`${path}: does not match schemas/contract-resolution.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

// S5 (D-persistence-integrity): the write-side sibling of loadResolution() above -- validated
// before it touches disk, same "fail loud here, not later" reasoning as every other write site
// this item touched. Deliberately does NOT lock by itself: the load-modify-save race this file
// has (`bskel contract waive` reads the current resolution, appends new waiver entries, then
// writes -- no synchronization) can only be closed by locking the WHOLE cycle, not just the final
// write -- see bin/bskel.mjs's cmdContractWaive, which wraps loadResolution()...saveResolution()
// in withLockSync(), the same shape lib/state.mjs's setGate() already uses for its own
// load-modify-save.
export function saveResolution(root, featureId, resolution) {
	const { ok, errors } = validateAgainstSchema('contract-resolution.schema.json', resolution);
	if (!ok) {
		throw new Error(`refusing to write an invalid contract resolution for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(resolutionPath(root, featureId), `${JSON.stringify(resolution, null, 2)}\n`);
	return resolution;
}

// The waiver-aware verdict `bskel contract emit`/`bskel contract waive` act on. `blocked` is
// never waivable, full stop -- a contract with zero operations has nothing waiving could fix.
// For `partial`, only ERROR-severity warnings can block (a WARN like CONTRACT_BODY_UNKNOWN never
// blocks, waived or not). Deliberately no wildcard match: a waiver only cancels the EXACT
// code+subject pair recorded for it, so a new unmatched endpoint added later is never silently
// covered by an old "--all" waive -- see the "waiver invalidation" test in test/contract-cli.test.mjs.
export function evaluateResolution(contract, resolution) {
	const status = classifyContract(contract);
	const waivers = resolution.waivers ?? [];
	const waivedKeys = new Set(waivers.map(warningKey));

	const errorWarnings = contract.warnings.filter((w) => w.severity === SEVERITY.ERROR);
	const unwaived = errorWarnings.filter((w) => !waivedKeys.has(warningKey(w)));
	const waived = errorWarnings.filter((w) => waivedKeys.has(warningKey(w)));

	const currentErrorKeys = new Set(errorWarnings.map(warningKey));
	const staleWaivers = waivers.filter((w) => !currentErrorKeys.has(warningKey(w)));

	const blocking = status === COMPLETENESS.BLOCKED || unwaived.length > 0;

	return { status, blocking, unwaived, waived, staleWaivers };
}
