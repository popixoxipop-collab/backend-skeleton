// D-business-rules: pure unit tests for rules/compile.mjs + rules/vocabulary.mjs +
// rules/diagnostics.mjs -- no git repo, no CLI, no filesystem. This is the layer where every rule
// semantic is decided (R3), so it gets direct coverage here; CLI-level coverage (real fixture repo,
// real contract emit, real gate) lives in test/rules-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, projectContractRules, summarizeArtifact, RULES_SOURCE_SCHEMA } from '../rules/compile.mjs';
import {
	FIELD_ASSERTS, CROSS_ASSERTS, PREDICATE_KINDS, FIELD_ASSERT_NAMES, CROSS_ASSERT_NAMES,
	requireFieldAssert, requireCrossAssert, valueMatchesType, typesAreComparable, explainRule,
} from '../rules/vocabulary.mjs';
import { RULE_DIAGNOSTICS, makeRuleDiagnostic, requireRuleDiagnostic, ruleDiagnosticKey, isBlocking } from '../rules/diagnostics.mjs';

// A contract shaped exactly like contracts/emit.mjs's own output, with a projected
// requestBodySchema carrying real constraints -- the shape `contract emit --openapi-file` produces.
function contractWith(properties, { required = [], operationId = 'createWidget' } = {}) {
	return {
		sbf_contract: '8',
		feature_id: '001-widget-management',
		feature_uid: '11111111-1111-4111-8111-111111111111',
		source: { adapter: 'java-spring', module: 'widget', provenance: 'scan+openapi' },
		operations: {
			[operationId]: {
				verb: 'POST', path: '/widgets', pathParams: {}, body: true, provenance: 'scan+openapi',
				requestBodySchema: { type: 'object', required, properties },
			},
		},
		warnings: [],
		completeness: { status: 'complete', operation_count: 1, endpoint_count: 1 },
	};
}

const BASIC_PROPS = {
	name: { type: 'string', maxLength: 10 },
	qty: { type: 'integer', minimum: 1 },
	status: { type: 'string', enum: ['draft', 'published'] },
	other: { type: 'string' },
};

function compile(rules, contract = contractWith(BASIC_PROPS)) {
	return compileRules({ contract, source: { schema: RULES_SOURCE_SCHEMA, rules }, contractRef: 'deadbeef' });
}

function errorCodes(result) {
	return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

// ---- vocabulary ---------------------------------------------------------------------------

test('the field vocabulary deliberately excludes required/type/pattern -- observe-schema-projection.mjs already enforces those, and a doubled rule would report one violation twice', () => {
	for (const owned of ['required', 'type', 'pattern']) {
		assert.equal(Object.hasOwn(FIELD_ASSERTS, owned), false, `${owned} must not be in the field vocabulary`);
	}
	// ...but the genuinely-new conditional sibling IS present, because no schema keyword says it.
	assert.ok(Object.hasOwn(CROSS_ASSERTS, 'requiredIf'));
});

test('requireFieldAssert/requireCrossAssert name the known values instead of failing silently', () => {
	assert.throws(() => requireFieldAssert('bogus'), /known field assertions: .*maxLength/);
	assert.throws(() => requireCrossAssert('bogus'), /known cross-field assertions: .*mutuallyExclusive/);
	assert.equal(requireFieldAssert('maxLength').valueType, 'integer');
});

test('valueMatchesType is strict -- a numeric string is never an integer, and an empty enum list is never valid', () => {
	assert.equal(valueMatchesType('integer', 3), true);
	assert.equal(valueMatchesType('integer', 3.5), false);
	assert.equal(valueMatchesType('integer', '3'), false);
	assert.equal(valueMatchesType('number', Number.POSITIVE_INFINITY), false);
	assert.equal(valueMatchesType('array', []), false);
	assert.equal(valueMatchesType('array', ['a']), true);
});

test('typesAreComparable: numerics mix, strings match, booleans are never ordered', () => {
	assert.equal(typesAreComparable('integer', 'number'), true);
	assert.equal(typesAreComparable('string', 'string'), true);
	assert.equal(typesAreComparable('string', 'integer'), false);
	assert.equal(typesAreComparable('boolean', 'boolean'), false);
});

test('explainRule renders each predicate kind as a sentence', () => {
	assert.match(explainRule({ kind: 'field', rule: { pointer: '/qty', assert: 'maximum', value: 5 } }), /\/qty must satisfy/);
	assert.match(explainRule({ kind: 'cross', rule: { pointers: ['/a', '/b'], assert: 'lt' } }), /\/a must be < \/b/);
	assert.match(explainRule({ kind: 'cross', rule: { pointers: ['/a', '/b'], assert: 'requiredIf' } }), /if \/a is present/);
	assert.match(explainRule({ kind: 'transition', rule: { pointer: '/s', from: ['draft'], to: ['live'] } }), /may only change from \{draft\} to \{live\}/);
});

// ---- diagnostics --------------------------------------------------------------------------

test('makeRuleDiagnostic stamps severity from the table, not from the caller', () => {
	const d = makeRuleDiagnostic('RULE_UNKNOWN_OPERATION', { subject: 'r1', message: 'm' });
	assert.equal(d.severity, 'error');
	assert.equal(d.severity, RULE_DIAGNOSTICS.RULE_UNKNOWN_OPERATION.severity);
});

test('requireRuleDiagnostic is the typo-defense point and names the known codes', () => {
	assert.throws(() => requireRuleDiagnostic('RULE_NOPE'), /known codes: .*RULE_UNKNOWN_OPERATION/);
});

test('ruleDiagnosticKey is code+subject only, so rewording a message never changes the key', () => {
	const a = makeRuleDiagnostic('RULE_ARITY', { subject: 'r1', message: 'one wording' });
	const b = makeRuleDiagnostic('RULE_ARITY', { subject: 'r1', message: 'a completely different wording' });
	assert.equal(ruleDiagnosticKey(a), ruleDiagnosticKey(b));
});

test('every WARN-severity diagnostic is an expressiveness gap, never a correctness one -- only ERRORs block', () => {
	const warns = Object.entries(RULE_DIAGNOSTICS).filter(([, s]) => s.severity === 'warn').map(([c]) => c);
	assert.deepEqual(warns.sort(), ['RULE_NON_SCALAR_TARGET', 'RULE_UNSUPPORTED_CONSTRAINT']);
	assert.equal(isBlocking(warns.map((c) => makeRuleDiagnostic(c, {}))), false);
});

// ---- R4: projection from the contract ------------------------------------------------------

test('R4: constraints the contract already states compile into field rules with origin "contract", with ZERO authoring', () => {
	const result = compileRules({ contract: contractWith(BASIC_PROPS), source: null, contractRef: 'x' });
	assert.equal(result.blocking, false);
	const field = result.artifact.operations.createWidget.field;
	assert.deepEqual(field.map((r) => r.assert).sort(), ['enum', 'maxLength', 'minimum']);
	assert.ok(field.every((r) => r.origin === 'contract'));
	assert.equal(summarizeArtifact(result.artifact).declared, 0);
});

test('R3a: required/type/pattern in the contract schema are NOT projected into rules (observe already enforces them)', () => {
	const { rules } = projectContractRules('createWidget', {
		requestBodySchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^a', maxLength: 4 } } },
	});
	assert.deepEqual(rules.map((r) => r.assert), ['maxLength']);
});

test('a contract constraint this vocabulary cannot express is recorded in unsupported[], never silently dropped', () => {
	const result = compileRules({
		contract: contractWith({ tags: { type: 'array', items: { type: 'string' } }, weird: { type: 'string', minItems: 2 } }),
		source: null, contractRef: 'x',
	});
	assert.equal(result.blocking, false);
	const codes = result.artifact.unsupported.map((u) => u.code).sort();
	assert.deepEqual(codes, ['RULE_NON_SCALAR_TARGET', 'RULE_UNSUPPORTED_CONSTRAINT']);
	assert.match(result.artifact.unsupported.find((u) => u.code === 'RULE_UNSUPPORTED_CONSTRAINT').reason, /NOT enforced/);
});

test('an operation with no requestBodySchema projects nothing and does not crash', () => {
	const contract = contractWith({});
	delete contract.operations.createWidget.requestBodySchema;
	const result = compileRules({ contract, source: null, contractRef: 'x' });
	assert.equal(result.blocking, false);
	assert.deepEqual(result.artifact.operations, {});
});

// ---- R6: refusals -------------------------------------------------------------------------

test('R6: an authored rule naming an operation outside the contract is REFUSED, with the known operations named', () => {
	const result = compile([{ id: 'a', kind: 'field', operation: 'nope', pointer: '/name', assert: 'maxLength', value: 5 }]);
	assert.equal(result.blocking, true);
	assert.equal(result.artifact, null, 'nothing is compiled when any rule is refused');
	assert.deepEqual(errorCodes(result), ['RULE_UNKNOWN_OPERATION']);
	assert.match(result.diagnostics[0].message, /known operations: createWidget/);
});

test('R6: a pointer the contract does not describe is REFUSED, with the known fields named', () => {
	const result = compile([{ id: 'b', kind: 'field', operation: 'createWidget', pointer: '/nope', assert: 'maxLength', value: 5 }]);
	assert.deepEqual(errorCodes(result), ['RULE_UNKNOWN_POINTER']);
	assert.match(result.diagnostics[0].message, /known fields: name, other, qty, status/);
});

test('R6: an assertion that cannot apply to the field\'s declared type is REFUSED -- it would compile into a rule that can never fire', () => {
	const result = compile([{ id: 'c', kind: 'field', operation: 'createWidget', pointer: '/qty', assert: 'maxLength', value: 5 }]);
	assert.deepEqual(errorCodes(result), ['RULE_ASSERT_NOT_APPLICABLE']);
	assert.match(result.diagnostics[0].message, /declares as integer/);
});

test('R6: a value of the wrong shape for its assertion is REFUSED', () => {
	const result = compile([{ id: 'd', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'maxLength', value: '5' }]);
	assert.deepEqual(errorCodes(result), ['RULE_VALUE_TYPE']);
	assert.match(result.diagnostics[0].message, /needs an integer value, got "5"/);
});

test('R6: a cross-field comparison between incomparable types is REFUSED rather than given a per-language coercion', () => {
	const result = compile([{ id: 'e', kind: 'cross', operation: 'createWidget', pointers: ['/name', '/qty'], assert: 'lt' }]);
	assert.deepEqual(errorCodes(result), ['RULE_INCOMPARABLE_TYPES']);
	assert.match(result.diagnostics[0].message, /both must be numeric, or both string/);
});

test('R6: wrong arity is REFUSED, for both fixed-arity and n-ary assertions', () => {
	assert.deepEqual(errorCodes(compile([{ id: 'f', kind: 'cross', operation: 'createWidget', pointers: ['/name'], assert: 'lt' }])), ['RULE_ARITY']);
	assert.deepEqual(errorCodes(compile([{ id: 'g', kind: 'cross', operation: 'createWidget', pointers: ['/name'], assert: 'mutuallyExclusive' }])), ['RULE_ARITY']);
});

test('R6a: a transition on a field with no enum is REFUSED -- without a closed state set a typo becomes a guard that never fires', () => {
	const result = compile([{ id: 'h', kind: 'transition', operation: 'createWidget', pointer: '/name', from: ['a'], to: ['b'] }]);
	assert.deepEqual(errorCodes(result), ['RULE_TRANSITION_NOT_ENUM']);
});

test('R6a: a transition naming a state outside the declared enum is REFUSED, with the real states named', () => {
	const result = compile([{ id: 'i', kind: 'transition', operation: 'createWidget', pointer: '/status', from: ['draftt'], to: ['published'] }]);
	assert.deepEqual(errorCodes(result), ['RULE_TRANSITION_UNKNOWN_STATE']);
	assert.match(result.diagnostics[0].message, /known states: draft, published/);
});

test('R6a: an operation with no requestBodySchema resolves NO pointers rather than accepting them blind', () => {
	const contract = contractWith({});
	delete contract.operations.createWidget.requestBodySchema;
	const result = compile([{ id: 'j', kind: 'field', operation: 'createWidget', pointer: '/anything', assert: 'maxLength', value: 3 }], contract);
	assert.deepEqual(errorCodes(result), ['RULE_NO_CONTRACT_SCHEMA']);
});

test('R6: a duplicate rule id is REFUSED -- ids address a rule in every violation report', () => {
	const result = compile([
		{ id: 'same', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'maxLength', value: 5 },
		{ id: 'same', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'minLength', value: 1 },
	]);
	assert.deepEqual(errorCodes(result), ['RULE_DUPLICATE_ID']);
});

test('R6: an unknown kind and an unknown assertion are DIFFERENT codes -- different mistakes, different fixes', () => {
	assert.deepEqual(errorCodes(compile([{ id: 'k', kind: 'bogus', operation: 'createWidget' }])), ['RULE_UNKNOWN_KIND']);
	assert.deepEqual(errorCodes(compile([{ id: 'l', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'bogus', value: 1 }])), ['RULE_UNKNOWN_ASSERT']);
});

test('a nested pointer (/a/b) is refused -- this vocabulary only addresses scalar leaves, matching observe-schema-projection.mjs exactly', () => {
	assert.deepEqual(errorCodes(compile([{ id: 'm', kind: 'field', operation: 'createWidget', pointer: '/name/inner', assert: 'maxLength', value: 3 }])), ['RULE_UNKNOWN_POINTER']);
});

// ---- compiled shape + determinism -----------------------------------------------------------

test('a valid mixed rule set compiles, grouping by operation and kind, with declared/contract origins kept distinct', () => {
	const result = compile([
		{ id: 'qty-cap', kind: 'field', operation: 'createWidget', pointer: '/qty', assert: 'maximum', value: 500 },
		{ id: 'names-differ', kind: 'cross', operation: 'createWidget', pointers: ['/name', '/other'], assert: 'neq' },
		{ id: 'publish', kind: 'transition', operation: 'createWidget', pointer: '/status', from: ['draft'], to: ['published'] },
	]);
	assert.equal(result.blocking, false);
	const summary = summarizeArtifact(result.artifact);
	assert.deepEqual(
		{ field: summary.field, cross: summary.cross, transition: summary.transition, fromContract: summary.fromContract, declared: summary.declared },
		{ field: 4, cross: 1, transition: 1, fromContract: 3, declared: 3 },
	);
	assert.equal(result.artifact.contract_ref, 'deadbeef');
	assert.deepEqual(result.artifact.derived, [], 'derived is always present so no consumer branches on its absence');
});

test('compilation is deterministic -- same inputs produce a byte-identical artifact regardless of authored order', () => {
	const a = compile([
		{ id: 'zzz', kind: 'field', operation: 'createWidget', pointer: '/qty', assert: 'maximum', value: 9 },
		{ id: 'aaa', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'minLength', value: 1 },
	]);
	const b = compile([
		{ id: 'aaa', kind: 'field', operation: 'createWidget', pointer: '/name', assert: 'minLength', value: 1 },
		{ id: 'zzz', kind: 'field', operation: 'createWidget', pointer: '/qty', assert: 'maximum', value: 9 },
	]);
	assert.equal(JSON.stringify(a.artifact), JSON.stringify(b.artifact));
	assert.deepEqual(a.artifact.operations.createWidget.field.map((r) => r.id), [...a.artifact.operations.createWidget.field.map((r) => r.id)].sort());
});

test('an operation with no rules at all is absent from the artifact rather than present-and-empty', () => {
	const contract = contractWith({ other: { type: 'string' } });
	const result = compileRules({ contract, source: null, contractRef: 'x' });
	assert.deepEqual(result.artifact.operations, {});
});

test('PREDICATE_KINDS deliberately excludes `derived` -- it produces a value, so no predicate checker can execute it', () => {
	assert.deepEqual([...PREDICATE_KINDS], ['field', 'cross', 'transition']);
	assert.equal(PREDICATE_KINDS.includes('derived'), false);
});

test('the compiled enum sets stay in lockstep with the vocabulary module (a new member must be added to both)', () => {
	assert.deepEqual(FIELD_ASSERT_NAMES, Object.keys(FIELD_ASSERTS).sort());
	assert.deepEqual(CROSS_ASSERT_NAMES, Object.keys(CROSS_ASSERTS).sort());
});
