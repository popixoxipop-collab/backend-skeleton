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

export function operationPayloadSchema(opContract) {
	const properties = { pathParams: opContract.pathParams };
	const required = ['pathParams'];
	if (opContract.body === true) {
		properties.body = { type: 'object' };
		required.push('body');
	} else if (opContract.body === 'unknown') {
		properties.body = { type: 'object' };
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
	const opContract = contract.operations[envelope.operation_id];
	if (!opContract) {
		errors.push(`operation_id "${envelope.operation_id}" is not defined in this feature's contract (known operations: ${Object.keys(contract.operations).join(', ') || '(none)'})`);
		return { ok: false, errors };
	}
	if (envelope.direction === 'request') {
		const payloadSchema = operationPayloadSchema(opContract);
		const validateFn = ajv().compile(payloadSchema);
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
