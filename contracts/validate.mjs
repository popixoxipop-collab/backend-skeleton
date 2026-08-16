// D-ajv-runtime (see DECISIONS.md): unlike archify, ajv here is a real runtime dependency of
// `bskel` itself, not a devDependency used only to pre-compile a fixed set of schemas at build
// time. Archify's 5 diagram schemas are fixed at package-build time, so standalone-compiling
// them once makes sense; a per-feature contract's operation schemas don't exist until `bskel
// contract emit` runs for THAT feature, so there is nothing to standalone-compile in advance.
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
	const schemaPath = path.join(import.meta.dirname, '..', 'schemas', 'agent-envelope.schema.json');
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
export function operationPayloadSchema(opContract) {
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
	if (envelope.direction === 'request') {
		const payloadSchema = operationPayloadSchema(opContract);
		// A2: before this, payloadSchema was always 100% synthesized by this codebase, so
		// ajv().compile() never threw. Now it can embed a projected requestBodySchema, and the
		// contract file itself is hand-editable on disk (the `contract` gate would go stale, but
		// this function doesn't consult gates) -- a malformed schema must fail cleanly, not crash.
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
	// response/error directions: not constrained beyond the envelope's own structure -- we don't
	// have response DTO field shapes without deeper Java parsing than Phase 2's scan does. See
	// DECISIONS.md D-contract-scope.
	return { ok: errors.length === 0, errors };
}

export function validateEnvelope(envelope, contract) {
	const structural = validateEnvelopeStructure(envelope);
	if (!structural.ok) {
		return { ok: false, errors: structural.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
	}
	return validateAgainstContract(envelope, contract);
}
