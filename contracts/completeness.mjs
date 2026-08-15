// A5: distinguishes "a contract file was written" from "this contract is complete enough to
// trust". `buildContract()` (contracts/emit.mjs) always succeeds and always returns SOME
// object, even when it found zero usable operations -- Team-IZ-Backend's `codeanalysis` module
// (1 entity, 0 controllers) produces operations:0, warnings:0 with the pre-A5 code, and the
// `contract` gate passed silently (see D-contract-completeness in DECISIONS.md for the full
// before/after). This module is the single place that turns a contract's warnings into a
// completeness verdict and evaluates that verdict against recorded waivers -- contracts/emit.mjs
// stays a pure "what did the scan find" function and never looks at waivers itself, and
// bin/bskel.mjs never re-derives severity/blocking logic inline.
import { readJsonIfExists } from '../lib/fsutil.mjs';
import { specPath } from '../lib/paths.mjs';

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
	const parsed = readJsonIfExists(resolutionPath(root, featureId));
	return parsed ?? { schema: RESOLUTION_SCHEMA, feature_id: featureId, waivers: [] };
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
