// D-ajv-runtime (see DECISIONS.md): unlike archify, ajv here is a real runtime dependency of
// `bskel` itself, not a devDependency used only to pre-compile a fixed set of schemas at build
// time. Archify's 5 diagram schemas are fixed at package-build time, so standalone-compiling
// them once makes sense; a per-feature contract's operation schemas don't exist until `bskel
// contract emit` runs for THAT feature, so there is nothing to standalone-compile in advance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// P1 (D-npm-packaging): `import.meta.dirname` (Node >=20.11) was this codebase's only call site
// requiring a Node floor above what package.json declares (>=18) -- every other file already
// uses this portable pattern. Fixing the one outlier, not raising the floor, since nothing else
// in the runtime code needs anything newer than plain ES2022/Node 18.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ajv = null;
function ajv() {
	if (!_ajv) {
		_ajv = new Ajv2020({ allErrors: true, strict: false });
		try {
			addFormats(_ajv);
		} catch {
			// ajv-formats not installed -- format keywords (uuid, date-time) become no-ops rather
			// than a hard failure; validate() below still catches everything else.
		}
	}
	return _ajv;
}

function loadEnvelopeSchema() {
	const schemaPath = path.join(__dirname, '..', 'schemas', 'agent-envelope.schema.json');
	return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

export function validateEnvelopeStructure(envelope) {
	const schema = loadEnvelopeSchema();
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	const ok = validateFn(envelope);
	return { ok, errors: ok ? [] : (validateFn.errors ?? []) };
}

// A2: `requestBodySchema` (projected from a real OpenAPI document, contracts/openapi.mjs's
// inlineSchema()) replaces the bare {type:'object'} placeholder when present -- every branch is
// byte-identical to pre-A2 output when it's absent (the common case: openapi=null, or an
// operation that isn't matched/adopted). Requiredness of the `body` KEY in the envelope is
// decided by the SAME `body===true` condition as before, not by the document's
// `requestBody.required` -- the scan remains the oracle for whether an operation takes a body at
// all (A1's provenance split); `requestBodySchema` only ever tightens what's INSIDE that body.
// `additionalProperties:false` is deliberately never added to `bodySchema` itself -- see
// D-openapi-request-schema: Team-IZ-Backend has no Jackson customization, so the real endpoints
// accept and ignore unknown body fields (Spring Boot's default), and a contract that rejects what
// the real API accepts is a false negative, not a safety improvement.
//
// A3: `direction` selects which of the operation's three projected schemas this payload is
// checked against. `request` behavior is completely unchanged (byte-identical, that branch always
// returns a schema). `response`/`error` return `null` -- unconstrained, exactly as before A3 --
// when the operation has no projected responseSchema/errorSchema; when it does, the payload must
// be `{body: <the actual response/error body>}`, NOT the bare body. The wrapper (rather than
// payload being the response body directly) keeps a future status-code field additive
// (`payload.status`) instead of requiring a breaking `sbf` bump, and keeps this function's return
// shape uniform across all three directions ("a named-parts object, additionalProperties:false")
// -- see D-openapi-response-schema. An unrecognized `direction` also returns null (unconstrained),
// matching the envelope schema's own enum being the actual gate on valid direction values.
export function operationPayloadSchema(opContract, direction = 'request') {
	if (direction === 'request') {
		const properties = { pathParams: opContract.pathParams };
		const required = ['pathParams'];
		const bodySchema = opContract.requestBodySchema ?? { type: 'object' };
		if (opContract.body === true) {
			properties.body = bodySchema;
			required.push('body');
		} else if (opContract.body === 'unknown') {
			properties.body = bodySchema;
		}
		// body === false: deliberately absent from `properties` -- with additionalProperties:false
		// below, a payload that includes a body for a known-bodyless operation is rejected outright.
		return { type: 'object', additionalProperties: false, properties, required };
	}
	if (direction === 'response' || direction === 'error') {
		const schema = direction === 'response' ? opContract.responseSchema : opContract.errorSchema;
		if (!schema) return null;
		return { type: 'object', additionalProperties: false, properties: { body: schema }, required: ['body'] };
	}
	return null;
}

// Validates a full envelope against a specific feature's contract: feature_id/feature_uid must
// match the contract exactly (not just be well-formed), operation_id must be one the contract
// actually knows about, and payload must satisfy that operation's specific pathParams/body
// shape -- this is what makes "wrong feature" and "wrong operation" and "right operation but
// missing a required path param" all fail differently and traceably, not just "invalid JSON".
export function validateAgainstContract(envelope, contract) {
	const errors = [];
	if (envelope.feature_id !== contract.feature_id) {
		errors.push(`feature_id mismatch: envelope has "${envelope.feature_id}", contract is for "${contract.feature_id}"`);
	}
	if (envelope.feature_uid !== contract.feature_uid) {
		errors.push(`feature_uid mismatch: envelope has "${envelope.feature_uid}", contract is for "${contract.feature_uid}" (a stale payload from a renamed/recreated feature would land here)`);
	}
	// D-security-1: Object.hasOwn, not a plain `[key]` lookup -- `contract.operations` is a
	// plain object, so `operation_id: "constructor"` (or "toString", "__proto__", etc.) would
	// otherwise resolve an inherited Object.prototype property and pass as if it were a real,
	// defined operation. Found by the Codex security review, verified against this exact code.
	const opContract = Object.hasOwn(contract.operations, envelope.operation_id)
		? contract.operations[envelope.operation_id]
		: undefined;
	if (!opContract) {
		errors.push(`operation_id "${envelope.operation_id}" is not defined in this feature's contract (known operations: ${Object.keys(contract.operations).join(', ') || '(none)'})`);
		return { ok: false, errors };
	}
	// A3: direction-agnostic -- operationPayloadSchema() returns null for response/error when
	// nothing was projected (unconstrained, exactly as every direction behaved before A2/A3), and a
	// real schema otherwise. request behavior is unchanged (that branch always returns a schema).
	const payloadSchema = operationPayloadSchema(opContract, envelope.direction);
	if (payloadSchema) {
		// A2: before A2, payloadSchema was always 100% synthesized by this codebase, so
		// ajv().compile() never threw. Now it can embed a projected schema, and the contract file
		// itself is hand-editable on disk (the `contract` gate would go stale, but this function
		// doesn't consult gates) -- a malformed schema must fail cleanly, not crash.
		let validateFn;
		try {
			validateFn = ajv().compile(payloadSchema);
		} catch (err) {
			errors.push(`this operation's contract payload schema could not be compiled: ${err.message} -- the contract file may have been hand-edited (re-run \`bskel contract emit\`)`);
			return { ok: false, errors };
		}
		const ok = validateFn(envelope.payload);
		if (!ok) {
			for (const e of validateFn.errors ?? []) {
				errors.push(`payload${e.instancePath} ${e.message}`);
			}
		}
	}
	// No payloadSchema (unknown direction, or a known direction with nothing projected for this
	// operation): not constrained beyond the envelope's own structure -- see D-contract-scope.
	return { ok: errors.length === 0, errors };
}

export function validateEnvelope(envelope, contract) {
	const structural = validateEnvelopeStructure(envelope);
	if (!structural.ok) {
		return { ok: false, errors: structural.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
	}
	return validateAgainstContract(envelope, contract);
}
