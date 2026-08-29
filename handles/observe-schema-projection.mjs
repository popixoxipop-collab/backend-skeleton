// D-runtime-conformance-receipts: pure functions projecting a feature contract's own
// `operations[opId]` shape down to the bounded, checkable-only structure every observe provider's
// generated runtime checker understands. Extracted out of handles/providers/java-spring/observe.mjs
// (the first provider to need this) once python-fastapi needed the identical logic -- nothing here
// touches java-specific or python-specific concepts, it operates only on the contract's own
// JSON-schema-shaped fields (contracts/emit.mjs's own output). See DECISIONS.md
// D-runtime-conformance-receipts, Decision B, for the full "what's checkable is decided ONCE here"
// reasoning.

// A property this project's own contracts already fully control the generation of when there's
// nothing deeper than a directly-checkable value -- string/number/integer/boolean with no nested
// properties/items/$ref/anyOf/allOf/oneOf. What's checkable is decided ONCE here, in JS, at
// `observe emit` time (baked into a projected, pre-simplified resource for the target runtime);
// each provider's own generated checker is a dumb, mechanical executor of an already-simplified
// instruction set, never a second independent JSON-Schema interpreter.
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

export function isScalarLeaf(schema) {
	if (!schema || typeof schema !== 'object') return false;
	if (schema.properties || schema.items || schema.$ref || schema.anyOf || schema.allOf || schema.oneOf) return false;
	return typeof schema.type === 'string' && SCALAR_TYPES.has(schema.type);
}

// Projects a real (possibly arbitrarily deep) JSON Schema object -- contract.operations[id]'s own
// requestBodySchema/responseSchema/errorSchema, present only when `contract emit --openapi-file`
// was used and something resolved (contracts/emit.mjs) -- down to the bounded, checkable-only
// shape every generated checker understands: top-level `required`, scalar-leaf `properties` kept
// as {type, pattern?}, everything else marked `unsupported` at its own JSON Pointer rather than
// silently treated as pass. A non-object root (anyOf/allOf/oneOf/$ref/any non-'object' type -- the
// real shape a multi-status-unioned responseSchema can take) is marked unsupported at the root
// pointer "" wholesale, rather than guessed into a partial projection.
export function projectBodySchema(schema) {
	if (!schema || typeof schema !== 'object') return null;
	if (schema.anyOf || schema.allOf || schema.oneOf || schema.$ref || schema.type !== 'object') {
		return { required: [], properties: {}, unsupported: [''] };
	}
	const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
	const properties = {};
	const unsupported = [];
	for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
		if (isScalarLeaf(propSchema)) {
			properties[key] = { type: propSchema.type, ...(typeof propSchema.pattern === 'string' ? { pattern: propSchema.pattern } : {}) };
		} else {
			unsupported.push(`/${key}`);
		}
	}
	return { required, properties, unsupported };
}

// pathParams is ALWAYS the narrow, bskel-controlled vocabulary contracts/emit.mjs's own
// pathParamsSchema() produces (type:'object', additionalProperties:false, properties/required,
// each property {type:'string', pattern?}) -- passed through structurally rather than re-derived,
// but still routed through the same scalar-leaf check as body properties, defensively, in case a
// hand-edited contract ever puts something deeper there.
export function projectPathParams(pathParamsSchema) {
	const required = Array.isArray(pathParamsSchema?.required) ? pathParamsSchema.required.filter((r) => typeof r === 'string') : [];
	const properties = {};
	const unsupported = [];
	for (const [key, propSchema] of Object.entries(pathParamsSchema?.properties ?? {})) {
		if (isScalarLeaf(propSchema)) {
			properties[key] = { type: propSchema.type, ...(typeof propSchema.pattern === 'string' ? { pattern: propSchema.pattern } : {}) };
		} else {
			unsupported.push(`/${key}`);
		}
	}
	return { required, properties, unsupported };
}

// A8: sourceResponses' own keys are literal status codes/ranges/"default" straight from a real
// source document (schemas/feature-contract.schema.json's own propertyNames pattern), never
// re-bucketed here -- matching status against them at runtime (a real observed code against
// "4XX"/"default") is a bounded, mechanical string comparison, not JSON-Schema interpretation, so
// doing it in each provider's own generated checker doesn't violate the "one interpreter" boundary.
export function projectStatuses(sourceResponses) {
	return sourceResponses ? Object.keys(sourceResponses) : null;
}

export function projectOperation(opContract) {
	return {
		verb: opContract.verb,
		path: opContract.path,
		pathParams: projectPathParams(opContract.pathParams),
		// Normalized to always a JSON string ("true"/"false"/"unknown") -- opContract.body is a
		// true|false|'unknown' tri-state (mixed boolean/string), awkward for a generated checker to
		// parse unambiguously; String() keeps the projected shape uniformly typed.
		body: String(opContract.body),
		request: opContract.body === false ? null : projectBodySchema(opContract.requestBodySchema),
		response: projectBodySchema(opContract.responseSchema),
		error: projectBodySchema(opContract.errorSchema),
		statuses: projectStatuses(opContract.sourceResponses),
	};
}
