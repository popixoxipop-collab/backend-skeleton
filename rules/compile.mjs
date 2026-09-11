// D-business-rules (R3/R4/R6): the compiler. Turns a hand-authored rules source document plus the
// feature's own contract into the bounded, deterministic artifact every target-language runtime
// executes.
//
// This is the ONE place rule semantics are decided -- the same doctrine
// handles/observe-schema-projection.mjs states for its own projection: "What's checkable is
// decided ONCE here, in JS ... each provider's own generated checker is a dumb, mechanical
// executor of an already-simplified instruction set, never a second independent JSON-Schema
// interpreter." Three languages can only be guaranteed to agree if they are given instructions,
// not expressions.
//
// PURE. No filesystem, no git, no CLI, no process.exit -- the caller owns I/O and exit codes, the
// same split contracts/emit.mjs holds against bin/bskel.mjs.
import {
	FIELD_ASSERTS, CROSS_ASSERTS, PREDICATE_KINDS, RULE_SCALAR_TYPES,
	FIELD_ASSERT_NAMES, CROSS_ASSERT_NAMES,
	getFieldAssert, getCrossAssert, valueMatchesType, typesAreComparable,
} from './vocabulary.mjs';
import { makeRuleDiagnostic, isBlocking } from './diagnostics.mjs';

export const RULES_SCHEMA_VERSION = '1';
export const RULES_SOURCE_SCHEMA = 'sbf.feature-rules-source/1';

// JSON Schema keywords `handles/observe-schema-projection.mjs` already projects and every
// generated checker already enforces. Seeing one of these while projecting contract constraints is
// not an expressiveness gap -- it is already covered, one layer down -- so it is skipped silently
// rather than reported as unsupported. Keeping this list explicit (rather than "anything not in
// FIELD_ASSERTS") is what makes a genuinely-new keyword show up as a warning instead of vanishing.
const OBSERVE_OWNED_KEYWORDS = Object.freeze(new Set(['type', 'pattern', 'required', 'properties', 'additionalProperties', 'description', 'example', 'examples', 'title', 'default', 'nullable', 'deprecated', 'readOnly', 'writeOnly', '$id', '$schema', '$comment', 'format']));

// Only top-level `/field` pointers are addressable, matching observe-schema-projection.mjs's own
// scalar-leaf boundary exactly -- that module projects `schema.properties[key]` one level deep and
// marks anything deeper `unsupported`. Addressing deeper here would mean this vocabulary could
// describe constraints the runtime checkers have no projected value to evaluate against.
const TOP_LEVEL_POINTER_RE = /^\/[^/]+$/;

function pointerField(pointer) {
	return typeof pointer === 'string' && TOP_LEVEL_POINTER_RE.test(pointer) ? pointer.slice(1) : null;
}

// Resolves a pointer against an operation's projected request body schema, returning the scalar
// leaf's own {type, enum} or a diagnostic-shaped reason it could not. Fail-closed: an operation
// with no requestBodySchema resolves NOTHING (rather than accepting every pointer blind), which is
// what RULE_NO_CONTRACT_SCHEMA reports.
function resolvePointer(opContract, pointer) {
	const schema = opContract?.requestBodySchema;
	if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties) {
		return { ok: false, code: 'RULE_NO_CONTRACT_SCHEMA' };
	}
	const field = pointerField(pointer);
	if (!field || !Object.hasOwn(schema.properties, field)) {
		return { ok: false, code: 'RULE_UNKNOWN_POINTER', known: Object.keys(schema.properties).sort() };
	}
	const propSchema = schema.properties[field];
	if (!propSchema || typeof propSchema !== 'object' || !RULE_SCALAR_TYPES.includes(propSchema.type)) {
		return { ok: false, code: 'RULE_UNKNOWN_POINTER', known: Object.keys(schema.properties).sort(), nonScalar: true };
	}
	return { ok: true, type: propSchema.type, enum: Array.isArray(propSchema.enum) ? propSchema.enum : null };
}

// R4: every constraint the user's own OpenAPI document already asserts, transported into a rule.
// Not synthesis -- the same "copying is not synthesizing" posture D-openapi-passthrough (A7)
// established for the contract itself. A constraint this vocabulary cannot express is recorded in
// `unsupported[]`, never dropped.
export function projectContractRules(operationId, opContract) {
	const rules = [];
	const diagnostics = [];
	const schema = opContract?.requestBodySchema;
	if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties) {
		return { rules, diagnostics };
	}
	for (const [field, propSchema] of Object.entries(schema.properties).sort(([a], [b]) => a.localeCompare(b))) {
		const pointer = `/${field}`;
		if (!propSchema || typeof propSchema !== 'object') continue;
		if (!RULE_SCALAR_TYPES.includes(propSchema.type)) {
			// Deeper than a scalar leaf -- observe already marks this pointer `unsupported` in its own
			// projection; recorded here too so a rules audit is self-contained.
			diagnostics.push(makeRuleDiagnostic('RULE_NON_SCALAR_TARGET', {
				subject: `${operationId}${pointer}`,
				message: `${operationId} ${pointer}: not a scalar leaf, so no field rule was projected for it`,
				detail: { operation: operationId, pointer },
			}));
			continue;
		}
		for (const [keyword, value] of Object.entries(propSchema).sort(([a], [b]) => a.localeCompare(b))) {
			if (OBSERVE_OWNED_KEYWORDS.has(keyword)) continue;
			const spec = getFieldAssert(keyword);
			if (!spec) {
				diagnostics.push(makeRuleDiagnostic('RULE_UNSUPPORTED_CONSTRAINT', {
					subject: `${operationId}${pointer}`,
					message: `${operationId} ${pointer}: "${keyword}" has no equivalent in this rule vocabulary and is NOT enforced`,
					detail: { operation: operationId, pointer, keyword },
				}));
				continue;
			}
			if (!spec.appliesTo.includes(propSchema.type) || !valueMatchesType(spec.valueType, value)) {
				// The document itself is internally inconsistent (e.g. minLength on an integer).
				// Reported, not refused: this is someone else's document, not a rule the user authored
				// here, so the same "a contract is built from whatever was found" posture applies.
				diagnostics.push(makeRuleDiagnostic('RULE_UNSUPPORTED_CONSTRAINT', {
					subject: `${operationId}${pointer}`,
					message: `${operationId} ${pointer}: "${keyword}" does not apply to a ${propSchema.type} field, so it was NOT enforced`,
					detail: { operation: operationId, pointer, keyword, fieldType: propSchema.type },
				}));
				continue;
			}
			rules.push({
				id: `contract:${operationId}:${field}:${keyword}`,
				pointer,
				assert: keyword,
				value,
				origin: 'contract',
			});
		}
	}
	return { rules, diagnostics };
}

function compileFieldRule(rule, opContract) {
	const resolved = resolvePointer(opContract, rule.pointer);
	if (!resolved.ok) {
		return { error: makeRuleDiagnostic(resolved.code, {
			subject: rule.id,
			message: resolved.code === 'RULE_NO_CONTRACT_SCHEMA'
				? `rule "${rule.id}": operation "${rule.operation}" has no projected requestBodySchema, so ${rule.pointer} cannot be verified`
				: `rule "${rule.id}": ${rule.pointer} is not a scalar field of operation "${rule.operation}"${resolved.known ? ` -- known fields: ${resolved.known.join(', ')}` : ''}`,
			detail: { rule: rule.id, operation: rule.operation, pointer: rule.pointer, ...(resolved.known ? { knownFields: resolved.known } : {}) },
		}) };
	}
	const spec = getFieldAssert(rule.assert);
	if (!spec) {
		return { error: makeRuleDiagnostic('RULE_UNKNOWN_ASSERT', {
			subject: rule.id,
			message: `rule "${rule.id}": unknown field assertion "${rule.assert}" -- known field assertions: ${FIELD_ASSERT_NAMES.join(', ')}`,
			detail: { rule: rule.id, assert: rule.assert, known: FIELD_ASSERT_NAMES },
		}) };
	}
	if (!spec.appliesTo.includes(resolved.type)) {
		return { error: makeRuleDiagnostic('RULE_ASSERT_NOT_APPLICABLE', {
			subject: rule.id,
			message: `rule "${rule.id}": "${rule.assert}" cannot apply to ${rule.pointer}, which the contract declares as ${resolved.type} (it applies to: ${spec.appliesTo.join(', ')})`,
			detail: { rule: rule.id, assert: rule.assert, fieldType: resolved.type, appliesTo: [...spec.appliesTo] },
		}) };
	}
	if (!valueMatchesType(spec.valueType, rule.value)) {
		return { error: makeRuleDiagnostic('RULE_VALUE_TYPE', {
			subject: rule.id,
			message: `rule "${rule.id}": "${rule.assert}" needs ${spec.valueType === 'integer' || spec.valueType === 'array' ? 'an' : 'a'} ${spec.valueType} value, got ${JSON.stringify(rule.value)}`,
			detail: { rule: rule.id, assert: rule.assert, expected: spec.valueType, got: rule.value ?? null },
		}) };
	}
	return { compiled: { id: rule.id, pointer: rule.pointer, assert: rule.assert, value: rule.value, origin: 'declared' } };
}

function compileCrossRule(rule, opContract) {
	const spec = getCrossAssert(rule.assert);
	if (!spec) {
		return { error: makeRuleDiagnostic('RULE_UNKNOWN_ASSERT', {
			subject: rule.id,
			message: `rule "${rule.id}": unknown cross-field assertion "${rule.assert}" -- known cross-field assertions: ${CROSS_ASSERT_NAMES.join(', ')}`,
			detail: { rule: rule.id, assert: rule.assert, known: CROSS_ASSERT_NAMES },
		}) };
	}
	const pointers = Array.isArray(rule.pointers) ? rule.pointers : [];
	const arityOk = spec.arity === 'n' ? pointers.length >= 2 : pointers.length === spec.arity;
	if (!arityOk) {
		return { error: makeRuleDiagnostic('RULE_ARITY', {
			subject: rule.id,
			message: `rule "${rule.id}": "${rule.assert}" needs ${spec.arity === 'n' ? 'two or more' : `exactly ${spec.arity}`} pointers, got ${pointers.length}`,
			detail: { rule: rule.id, assert: rule.assert, arity: spec.arity, got: pointers.length },
		}) };
	}
	const types = [];
	for (const pointer of pointers) {
		const resolved = resolvePointer(opContract, pointer);
		if (!resolved.ok) {
			return { error: makeRuleDiagnostic(resolved.code, {
				subject: rule.id,
				message: resolved.code === 'RULE_NO_CONTRACT_SCHEMA'
					? `rule "${rule.id}": operation "${rule.operation}" has no projected requestBodySchema, so ${pointer} cannot be verified`
					: `rule "${rule.id}": ${pointer} is not a scalar field of operation "${rule.operation}"${resolved.known ? ` -- known fields: ${resolved.known.join(', ')}` : ''}`,
				detail: { rule: rule.id, operation: rule.operation, pointer, ...(resolved.known ? { knownFields: resolved.known } : {}) },
			}) };
		}
		types.push(resolved.type);
	}
	if (spec.comparison && !typesAreComparable(types[0], types[1])) {
		return { error: makeRuleDiagnostic('RULE_INCOMPARABLE_TYPES', {
			subject: rule.id,
			message: `rule "${rule.id}": cannot compare ${pointers[0]} (${types[0]}) with ${pointers[1]} (${types[1]}) -- both must be numeric, or both string`,
			detail: { rule: rule.id, pointers: [...pointers], types },
		}) };
	}
	return { compiled: { id: rule.id, pointers: [...pointers], assert: rule.assert, types, origin: 'declared' } };
}

function compileTransitionRule(rule, opContract) {
	const resolved = resolvePointer(opContract, rule.pointer);
	if (!resolved.ok) {
		return { error: makeRuleDiagnostic(resolved.code, {
			subject: rule.id,
			message: resolved.code === 'RULE_NO_CONTRACT_SCHEMA'
				? `rule "${rule.id}": operation "${rule.operation}" has no projected requestBodySchema, so ${rule.pointer} cannot be verified`
				: `rule "${rule.id}": ${rule.pointer} is not a scalar field of operation "${rule.operation}"${resolved.known ? ` -- known fields: ${resolved.known.join(', ')}` : ''}`,
			detail: { rule: rule.id, operation: rule.operation, pointer: rule.pointer, ...(resolved.known ? { knownFields: resolved.known } : {}) },
		}) };
	}
	// A transition guard is an allow-list over a CLOSED set of states. Without an enum there is no
	// closed set, so a typo'd state name would compile into a guard that silently never fires --
	// refused rather than accepted, the same fail-closed call D-security-7 made for an
	// unrecognized @PreAuthorize shape.
	if (!resolved.enum) {
		return { error: makeRuleDiagnostic('RULE_TRANSITION_NOT_ENUM', {
			subject: rule.id,
			message: `rule "${rule.id}": ${rule.pointer} declares no enum in the contract, so its transition states cannot be verified -- add an enum to the OpenAPI document and re-run \`bskel contract emit\``,
			detail: { rule: rule.id, pointer: rule.pointer },
		}) };
	}
	const from = Array.isArray(rule.from) ? rule.from : [];
	const to = Array.isArray(rule.to) ? rule.to : [];
	const unknown = [...from, ...to].filter((s) => !resolved.enum.includes(s));
	if (unknown.length > 0) {
		return { error: makeRuleDiagnostic('RULE_TRANSITION_UNKNOWN_STATE', {
			subject: rule.id,
			message: `rule "${rule.id}": state(s) ${unknown.map((s) => JSON.stringify(s)).join(', ')} are not in ${rule.pointer}'s declared enum -- known states: ${resolved.enum.join(', ')}`,
			detail: { rule: rule.id, pointer: rule.pointer, unknown, known: [...resolved.enum] },
		}) };
	}
	if (from.length === 0 || to.length === 0) {
		return { error: makeRuleDiagnostic('RULE_ARITY', {
			subject: rule.id,
			message: `rule "${rule.id}": a transition rule needs at least one \`from\` and one \`to\` state`,
			detail: { rule: rule.id, from: from.length, to: to.length },
		}) };
	}
	return { compiled: { id: rule.id, pointer: rule.pointer, from: [...from], to: [...to], origin: 'declared' } };
}

const KIND_COMPILERS = Object.freeze({
	field: compileFieldRule,
	cross: compileCrossRule,
	transition: compileTransitionRule,
});

/**
 * Compiles an authored rules source document against a feature contract.
 *
 * @param {object} args
 * @param {object} args.contract    a feature contract (schemas/feature-contract.schema.json shape)
 * @param {object} args.source      the parsed rules.yaml document ({schema, rules: []}); null/absent is legal and yields a contract-only artifact
 * @param {string} args.contractRef sha256 of the contract file on disk, so a compiled artifact can never be silently paired with a different contract
 * @returns {{artifact: object|null, diagnostics: object[], blocking: boolean}}
 */
export function compileRules({ contract, source = null, contractRef = '' }) {
	const diagnostics = [];
	const authored = Array.isArray(source?.rules) ? source.rules : [];
	const operations = contract?.operations ?? {};

	// Ids address a rule in `rules explain` and in every runtime violation report, so a duplicate
	// makes a violation unattributable. Checked across ALL kinds and operations, once, up front.
	const seenIds = new Set();
	for (const rule of authored) {
		const id = typeof rule?.id === 'string' ? rule.id : '';
		if (!id) continue;
		if (seenIds.has(id)) {
			diagnostics.push(makeRuleDiagnostic('RULE_DUPLICATE_ID', {
				subject: id,
				message: `rule id "${id}" is used more than once -- ids must be unique within a feature`,
				detail: { rule: id },
			}));
		}
		seenIds.add(id);
	}

	// Contract-projected rules first (R4), so `origin: 'contract'` entries are always present even
	// when rules.yaml does not exist at all -- pointing at an OpenAPI document is enough to get
	// real enforcement, with zero authoring.
	const byOperation = new Map();
	function bucket(operationId) {
		if (!byOperation.has(operationId)) byOperation.set(operationId, { field: [], cross: [], transition: [] });
		return byOperation.get(operationId);
	}
	for (const [operationId, opContract] of Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))) {
		const projected = projectContractRules(operationId, opContract);
		diagnostics.push(...projected.diagnostics);
		if (projected.rules.length > 0) bucket(operationId).field.push(...projected.rules);
	}

	for (const rule of authored) {
		const id = typeof rule?.id === 'string' ? rule.id : '';
		const kind = rule?.kind;
		if (!PREDICATE_KINDS.includes(kind)) {
			diagnostics.push(makeRuleDiagnostic('RULE_UNKNOWN_KIND', {
				subject: id || '(unnamed rule)',
				message: `rule "${id || '(unnamed)'}": unknown kind "${kind}" -- known kinds: ${PREDICATE_KINDS.join(', ')}`,
				detail: { rule: id, kind: kind ?? null, known: [...PREDICATE_KINDS] },
			}));
			continue;
		}
		const opContract = operations[rule.operation];
		if (!opContract) {
			diagnostics.push(makeRuleDiagnostic('RULE_UNKNOWN_OPERATION', {
				subject: id || '(unnamed rule)',
				message: `rule "${id || '(unnamed)'}": operation "${rule.operation}" is not in this feature's contract -- known operations: ${Object.keys(operations).sort().join(', ') || '(none)'}`,
				detail: { rule: id, operation: rule.operation ?? null, known: Object.keys(operations).sort() },
			}));
			continue;
		}
		const { compiled, error } = KIND_COMPILERS[kind](rule, opContract);
		if (error) { diagnostics.push(error); continue; }
		bucket(rule.operation)[kind].push(compiled);
	}

	const blocking = isBlocking(diagnostics);
	if (blocking) return { artifact: null, diagnostics, blocking };

	// Deterministic ordering everywhere: operations by id, rules by id within each kind. A second
	// compile of the same inputs must produce a byte-identical artifact (the bar
	// handles/conformance.mjs already sets for emit, applied here to compilation).
	const compiledOperations = {};
	for (const operationId of [...byOperation.keys()].sort((a, b) => a.localeCompare(b))) {
		const kinds = byOperation.get(operationId);
		const entry = {};
		for (const kind of PREDICATE_KINDS) {
			if (kinds[kind].length === 0) continue;
			entry[kind] = kinds[kind].slice().sort((a, b) => a.id.localeCompare(b.id));
		}
		if (Object.keys(entry).length > 0) compiledOperations[operationId] = entry;
	}

	return {
		artifact: {
			sbf_feature_rules: RULES_SCHEMA_VERSION,
			feature_id: contract.feature_id,
			feature_uid: contract.feature_uid,
			contract_ref: contractRef,
			operations: compiledOperations,
			// R5/Phase 3: `derived` compiles to a generated pure function rather than a predicate,
			// so it is a separate top-level list, always present (empty until that phase lands) so
			// no consumer has to branch on its absence.
			derived: [],
			unsupported: diagnostics
				.filter((d) => d.severity === 'warn')
				.map((d) => ({ code: d.code, subject: d.subject, reason: d.message }))
				.sort((a, b) => `${a.code}${a.subject}`.localeCompare(`${b.code}${b.subject}`)),
		},
		diagnostics,
		blocking: false,
	};
}

// Counts by kind/origin, for `rules check`/`rules list` reporting. Pure, so the CLI never
// re-derives these inline.
export function summarizeArtifact(artifact) {
	const summary = { operations: 0, field: 0, cross: 0, transition: 0, derived: 0, fromContract: 0, declared: 0, unsupported: 0 };
	if (!artifact) return summary;
	summary.operations = Object.keys(artifact.operations ?? {}).length;
	summary.derived = (artifact.derived ?? []).length;
	summary.unsupported = (artifact.unsupported ?? []).length;
	for (const kinds of Object.values(artifact.operations ?? {})) {
		for (const kind of PREDICATE_KINDS) {
			for (const rule of kinds[kind] ?? []) {
				summary[kind] += 1;
				if (rule.origin === 'contract') summary.fromContract += 1;
				else summary.declared += 1;
			}
		}
	}
	return summary;
}
