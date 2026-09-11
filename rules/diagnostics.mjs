// D-business-rules (R6): the frozen code table for every way `bskel rules check` can reject or
// downgrade an authored rule. Mirrors contracts/completeness.mjs's own WARNING_CODES shape
// (a frozen table, severity stamped from the table rather than supplied by the caller, a
// `{code, subject}` key), on its own axis -- the same call lib/cross-feature-collisions.mjs made
// when it added a second evaluator rather than widening WARNING_CODES.
//
// THE SPLIT THAT MATTERS, and why this table has no waiver machinery unlike its contract sibling:
// a contract is built from whatever a real scan and a real OpenAPI document happened to contain,
// so its ERROR warnings describe facts about someone else's repo that a human may legitimately
// need to acknowledge and move past -- hence `bskel contract waive`. `rules.yaml` is 100%
// hand-authored by the person running the command. A rule naming an operation that does not
// exist is not a fact to be waived, it is a typo to be fixed, and offering a waiver for it would
// let a rule that can never fire sit in the artifact looking like enforcement. So:
//
//   severity 'error' -> `rules check` REFUSES (exit BAD_ARGS). Fix the rule; there is no waiver.
//   severity 'warn'  -> the rule is dropped into the artifact's `unsupported[]` with this code and
//                       reported, never silently discarded. The remaining rules still compile.
//
// Every WARN member is an EXPRESSIVENESS gap (this vocabulary cannot say that), never a
// correctness gap -- that distinction is the whole reason the two severities exist here.
export const RULE_SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn' });

export const RULE_DIAGNOSTICS = Object.freeze({
	// ---- ERROR: authored mistakes, refused ----------------------------------------------------
	RULE_UNKNOWN_OPERATION: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a rule names an operationId that this feature\'s contract does not define',
	}),
	RULE_UNKNOWN_POINTER: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a rule names a JSON Pointer that the operation\'s request body schema does not describe',
	}),
	RULE_UNKNOWN_ASSERT: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a rule uses an assertion name outside this vocabulary',
	}),
	RULE_UNKNOWN_KIND: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		// Deliberately its own code rather than folded into RULE_UNKNOWN_ASSERT: `kind` selects
		// WHICH vocabulary applies, so a wrong kind and a wrong assertion are different mistakes
		// with different fixes. Same "never share a code" reasoning contracts/completeness.mjs
		// used to keep CONTRACT_OPENAPI_DRIFT and CONTRACT_OPENAPI_MISSING_OPERATION apart.
		summary: 'a rule declares a kind outside {field, cross, transition}',
	}),
	RULE_VALUE_TYPE: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a rule\'s `value` is the wrong shape for its assertion (e.g. minLength: "3" instead of 3)',
	}),
	RULE_ASSERT_NOT_APPLICABLE: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		// The case this exists for: `minLength` on an integer field. Left uncaught it would compile
		// into a rule that is simply never true, which reads as "enforced" to anyone auditing the
		// artifact -- strictly worse than refusing.
		summary: 'a rule\'s assertion cannot apply to that field\'s declared type',
	}),
	RULE_INCOMPARABLE_TYPES: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a cross-field comparison names two fields whose types are not mutually comparable',
	}),
	RULE_ARITY: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a cross-field rule names the wrong number of pointers for its assertion',
	}),
	RULE_DUPLICATE_ID: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'two rules share the same id -- ids address a rule in `rules explain` and in every violation report, so they must be unique',
	}),
	RULE_TRANSITION_NOT_ENUM: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		// A transition guard is an allow-list over a closed set of states. Without an enum in the
		// contract there is no closed set, so `from`/`to` values cannot be checked for typos --
		// and a typo'd state name is a guard that silently never fires.
		summary: 'a transition rule targets a field whose contract schema declares no enum, so its states cannot be verified',
	}),
	RULE_TRANSITION_UNKNOWN_STATE: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		summary: 'a transition rule names a state absent from that field\'s declared enum',
	}),
	RULE_NO_CONTRACT_SCHEMA: Object.freeze({
		severity: RULE_SEVERITY.ERROR,
		// Fail-closed, deliberately. Without a request body schema there is nothing to validate a
		// pointer against, so every rule on that operation would be accepted blind.
		summary: 'a rule targets an operation with no projected requestBodySchema -- re-run `bskel contract emit --openapi-file <doc>` so pointers can be verified',
	}),

	// ---- WARN: expressiveness gaps, recorded in `unsupported[]` --------------------------------
	RULE_UNSUPPORTED_CONSTRAINT: Object.freeze({
		severity: RULE_SEVERITY.WARN,
		summary: 'a constraint in the contract\'s own schema has no equivalent in this vocabulary and is not enforced',
	}),
	RULE_NON_SCALAR_TARGET: Object.freeze({
		severity: RULE_SEVERITY.WARN,
		summary: 'a contract constraint sits on a nested/array field this vocabulary only addresses at scalar leaves',
	}),
});

export const RULE_DIAGNOSTIC_NAMES = Object.freeze(Object.keys(RULE_DIAGNOSTICS).sort());

export function getRuleDiagnostic(code) {
	return Object.hasOwn(RULE_DIAGNOSTICS, code) ? RULE_DIAGNOSTICS[code] : null;
}

export function requireRuleDiagnostic(code) {
	const spec = getRuleDiagnostic(code);
	if (!spec) throw new Error(`unknown rule diagnostic "${code}" -- known codes: ${RULE_DIAGNOSTIC_NAMES.join(', ')}`);
	return spec;
}

// Severity is stamped FROM the table, never taken from the caller -- contracts/completeness.mjs's
// makeWarning() established this exact rule, for the exact reason that a caller free to pick a
// severity can silently downgrade a refusal into a warning.
export function makeRuleDiagnostic(code, { subject = null, message = '', detail = {} } = {}) {
	const spec = requireRuleDiagnostic(code);
	return { code, severity: spec.severity, subject, message, detail };
}

// The addressing key, code+subject only. Same reasoning as contracts/completeness.mjs's
// warningKey(): message text gets rephrased over time and anything keyed on it silently stops
// matching. `subject` here is a rule id or a source pointer -- both stable.
export function ruleDiagnosticKey(diagnostic) {
	return `${diagnostic.code}::${diagnostic.subject ?? '*'}`;
}

export function isBlocking(diagnostics) {
	return diagnostics.some((d) => d.severity === RULE_SEVERITY.ERROR);
}
