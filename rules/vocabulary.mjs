// D-business-rules (R3): the closed vocabulary of business-rule assertions this project compiles
// into target-language code. Frozen, small, and every member mechanically executable in Java,
// Python, and TypeScript without interpretation -- that constraint is the whole design, not a
// convenience. See DECISIONS.md's D-business-rules, R3.
//
// This module is PURE DATA plus pure predicates over it. It imports nothing, so it can be read by
// the compiler, the CLI, and every provider emitter without any risk of the import cycle
// D-zero-config-scan hit (adapter -> lib/doctor.mjs -> lib/verify.mjs -> scanners/registry.mjs).
//
// DELIBERATE NON-OVERLAP with `handles/observe-schema-projection.mjs`. That module already
// projects `required`/`type`/`pattern` out of a contract's own requestBodySchema, and every
// provider's generated checker already enforces those three. This vocabulary covers exactly the
// constraints that projection DROPS -- so a single violation is never reported twice by two
// different checkers, and neither module has to know what the other kept. `required` as an
// unconditional assertion is therefore deliberately absent here: it is the contract's/OpenAPI
// document's own statement, not a business rule layered on top. Its genuinely-new sibling,
// `requiredIf` (conditional on another field), IS here, because no schema keyword expresses it.

// ---- field assertions: one scalar JSON Pointer, one bounded comparison ----------------------
//
// `valueType` is what the rule's own `value` must be (validated at compile time, so a generated
// runtime never has to defend against a malformed rule). `appliesTo` is the set of projected
// scalar types the assertion is meaningful against -- checked against the contract's own
// requestBodySchema at compile time (R6), which is how a rule that says "minLength on an integer"
// is refused with the real type named instead of silently never firing.
export const FIELD_ASSERTS = Object.freeze({
	minLength:        Object.freeze({ valueType: 'integer', appliesTo: Object.freeze(['string']), summary: 'string length >= value' }),
	maxLength:        Object.freeze({ valueType: 'integer', appliesTo: Object.freeze(['string']), summary: 'string length <= value' }),
	minimum:          Object.freeze({ valueType: 'number',  appliesTo: Object.freeze(['number', 'integer']), summary: 'number >= value' }),
	maximum:          Object.freeze({ valueType: 'number',  appliesTo: Object.freeze(['number', 'integer']), summary: 'number <= value' }),
	exclusiveMinimum: Object.freeze({ valueType: 'number',  appliesTo: Object.freeze(['number', 'integer']), summary: 'number > value' }),
	exclusiveMaximum: Object.freeze({ valueType: 'number',  appliesTo: Object.freeze(['number', 'integer']), summary: 'number < value' }),
	multipleOf:       Object.freeze({ valueType: 'number',  appliesTo: Object.freeze(['number', 'integer']), summary: 'number is an exact multiple of value' }),
	enum:             Object.freeze({ valueType: 'array',   appliesTo: Object.freeze(['string', 'number', 'integer', 'boolean']), summary: 'value is one of a fixed list' }),
});

// ---- cross-field assertions: two or more pointers, compared to each other -------------------
//
// `arity: 2` means exactly two pointers; `arity: 'n'` means two or more. `comparison: true` marks
// the members whose operands must be mutually comparable (both numeric, or both string) -- a
// `lt` between a string and an integer is refused at compile time rather than given some
// language-specific coercion behavior that would differ across the three runtimes.
export const CROSS_ASSERTS = Object.freeze({
	lt:                Object.freeze({ arity: 2,   comparison: true,  summary: 'first < second' }),
	lte:               Object.freeze({ arity: 2,   comparison: true,  summary: 'first <= second' }),
	gt:                Object.freeze({ arity: 2,   comparison: true,  summary: 'first > second' }),
	gte:               Object.freeze({ arity: 2,   comparison: true,  summary: 'first >= second' }),
	eq:                Object.freeze({ arity: 2,   comparison: true,  summary: 'first == second' }),
	neq:               Object.freeze({ arity: 2,   comparison: true,  summary: 'first != second' }),
	requiredIf:        Object.freeze({ arity: 2,   comparison: false, summary: 'if the first is present, the second must be too' }),
	mutuallyExclusive: Object.freeze({ arity: 'n', comparison: false, summary: 'at most one of these may be present' }),
});

// ---- the three predicate rule kinds -----------------------------------------------------------
//
// `derived` is deliberately NOT here: it produces a value rather than answering true/false about
// one, so it cannot be executed by a predicate checker at all and takes a different compilation
// path entirely (R5). Keeping the predicate kinds in their own frozen list is what lets the
// compiler and every checker iterate them generically.
export const PREDICATE_KINDS = Object.freeze(['field', 'cross', 'transition']);

// Every kind an authored rule may declare -- PREDICATE_KINDS plus `derived`. Used only at the
// "is this kind even real" dispatch point in rules/compile.mjs; every other consumer (the
// checkers, `rules explain`'s search) still branches on PREDICATE_KINDS vs. `derived` separately,
// because the two are executed through genuinely different mechanisms (R5).
export const ALL_RULE_KINDS = Object.freeze([...PREDICATE_KINDS, 'derived']);

// R5/Phase 3: the closed arithmetic vocabulary a `derived` rule's expr tree may use. Deliberately
// tiny and binary-only (exactly 2 args per op) -- the explicit "no arbitrary arithmetic beyond the
// frozen operator set" scope boundary this item's own plan named. A third operand is expressed by
// nesting (`mul(mul(a,b),c)`), never by widening arity.
export const DERIVED_OPS = Object.freeze(['add', 'sub', 'mul', 'div']);

// PascalCase for Java/TypeScript method names (`computeTotal`), snake_case for Python
// (`compute_total`) -- pure string transforms, reused by all three provider emitters so a
// resource/field name is capitalized identically everywhere rather than three subtly different
// regexes drifting apart.
export function pascalCase(name) {
	return String(name).replace(/(^\w|[-_]\w)/g, (m) => m.replace(/[-_]/, '').toUpperCase());
}

export function snakeCase(name) {
	return String(name)
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[-\s]+/g, '_')
		.toLowerCase();
}

// Where a compiled rule came from. `contract` = projected from the feature's own
// requestBodySchema, i.e. a fact the user's OpenAPI document already asserts, transported (R4 --
// the same "copying is not synthesizing" posture D-openapi-passthrough established). `declared` =
// a human wrote it in rules.yaml. Kept distinct in the compiled artifact so an auditor can always
// tell which constraints the document licensed and which a human added on top.
export const RULE_ORIGINS = Object.freeze(['contract', 'declared']);

// The scalar types a rule can address, matching observe-schema-projection.mjs's own SCALAR_TYPES
// exactly -- a rule can only constrain something that module already projects as a scalar leaf.
export const RULE_SCALAR_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean']);

export const FIELD_ASSERT_NAMES = Object.freeze(Object.keys(FIELD_ASSERTS).sort());
export const CROSS_ASSERT_NAMES = Object.freeze(Object.keys(CROSS_ASSERTS).sort());

export function getFieldAssert(name) {
	return Object.hasOwn(FIELD_ASSERTS, name) ? FIELD_ASSERTS[name] : null;
}

export function getCrossAssert(name) {
	return Object.hasOwn(CROSS_ASSERTS, name) ? CROSS_ASSERTS[name] : null;
}

// The typo-defense points, same shape as lib/gate-definitions.mjs's requireGateDefinition() and
// contracts/completeness.mjs's requireWarningCode(): name the known values rather than letting a
// misspelled assertion silently compile to a rule that can never fire.
export function requireFieldAssert(name) {
	const spec = getFieldAssert(name);
	if (!spec) throw new Error(`unknown field assertion "${name}" -- known field assertions: ${FIELD_ASSERT_NAMES.join(', ')}`);
	return spec;
}

export function requireCrossAssert(name) {
	const spec = getCrossAssert(name);
	if (!spec) throw new Error(`unknown cross-field assertion "${name}" -- known cross-field assertions: ${CROSS_ASSERT_NAMES.join(', ')}`);
	return spec;
}

// Is `value` the right shape for this assertion's declared valueType? Deliberately strict:
// `integer` rejects 1.5 AND rejects a numeric string, because a rule whose operand needs coercing
// is a rule whose behavior would differ between Java, Python, and JS.
export function valueMatchesType(valueType, value) {
	switch (valueType) {
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'number':  return typeof value === 'number' && Number.isFinite(value);
		case 'array':   return Array.isArray(value) && value.length > 0;
		case 'none':    return value === undefined;
		default:        return false;
	}
}

// Two projected scalar types are comparable if they are both numeric or both string. Booleans are
// deliberately never comparable with `lt`/`gt` (ordering booleans is a language-specific accident,
// not a business rule); `eq`/`neq` between two booleans is still refused here for the same reason
// consistency matters more than convenience -- use a field `enum` assertion instead.
export function typesAreComparable(a, b) {
	const numeric = new Set(['number', 'integer']);
	if (numeric.has(a) && numeric.has(b)) return true;
	return a === 'string' && b === 'string';
}

// Renders one compiled rule as a plain-English sentence, for `bskel rules explain`. Pure and
// exported (rather than built inline in the CLI) so it has a direct unit test, and so the same
// wording can be reused by any future renderer -- the same call lib/workflow.mjs made when it
// exported isMutatingCommand() instead of inlining it.
export function explainRule({ kind, rule }) {
	if (kind === 'field') {
		const spec = getFieldAssert(rule.assert);
		const what = spec ? spec.summary.replace('value', JSON.stringify(rule.value)) : `${rule.assert} ${JSON.stringify(rule.value)}`;
		return `${rule.pointer} must satisfy: ${what}`;
	}
	if (kind === 'cross') {
		const spec = getCrossAssert(rule.assert);
		if (rule.assert === 'requiredIf') return `if ${rule.pointers[0]} is present, ${rule.pointers[1]} must be present too`;
		if (rule.assert === 'mutuallyExclusive') return `at most one of ${rule.pointers.join(', ')} may be present`;
		return `${rule.pointers[0]} must be ${spec ? spec.summary.replace('first ', '').replace(' second', '') : rule.assert} ${rule.pointers[1]}`;
	}
	if (kind === 'transition') {
		return `${rule.pointer} may only change from {${rule.from.join(', ')}} to {${rule.to.join(', ')}}`;
	}
	if (kind === 'derived') {
		return `${rule.resource}.${rule.field} is computed from (${rule.params.join(', ')}) -- see \`rules/derived.mjs\`'s renderExprInfix() for the exact formula, or the generated <Resource>Rules class itself`;
	}
	return `(no explanation available for kind "${kind}")`;
}
