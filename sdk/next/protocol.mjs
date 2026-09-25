import { hasOnlyKeys, isPlainObject, pushError, validIdentifier } from './_util.mjs';
import { SDK_ENTRYPOINT_PROTOCOL } from './manifest.mjs';

export const SDK_OPERATIONS = Object.freeze(['detect', 'analyze', 'diagnostics', 'read-set']);

function validRequestId(value) {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function validateSdkRequest(request) {
	const errors = [];
	if (!isPlainObject(request)) return { ok: false, errors: [{ path: '', message: 'request must be an object' }] };
	if (!hasOnlyKeys(request, ['contract', 'direction', 'requestId', 'operation', 'adapterId', 'snapshotRef', 'payload'])) {
		pushError(errors, '', 'contains unknown request keys');
	}
	if (request.contract !== SDK_ENTRYPOINT_PROTOCOL) pushError(errors, '/contract', `must equal ${SDK_ENTRYPOINT_PROTOCOL}`);
	if (request.direction !== 'request') pushError(errors, '/direction', 'must equal request');
	if (!validRequestId(request.requestId)) pushError(errors, '/requestId', 'must be a stable 1..128 character request id');
	if (!SDK_OPERATIONS.includes(request.operation)) pushError(errors, '/operation', 'is not a supported SDK operation');
	if (!validIdentifier(request.adapterId)) pushError(errors, '/adapterId', 'must be a lowercase kebab-case id');
	if (typeof request.snapshotRef !== 'string' || request.snapshotRef.length === 0) pushError(errors, '/snapshotRef', 'must be a non-empty opaque snapshot reference');
	if (!isPlainObject(request.payload)) pushError(errors, '/payload', 'must be an object');
	return { ok: errors.length === 0, errors };
}

export function validateSdkResponse(response, request) {
	const errors = [];
	if (!isPlainObject(response)) return { ok: false, errors: [{ path: '', message: 'response must be an object' }] };
	if (!hasOnlyKeys(response, ['contract', 'direction', 'requestId', 'adapterId', 'status', 'result', 'diagnostics'])) {
		pushError(errors, '', 'contains unknown response keys');
	}
	if (response.contract !== SDK_ENTRYPOINT_PROTOCOL) pushError(errors, '/contract', `must equal ${SDK_ENTRYPOINT_PROTOCOL}`);
	if (response.direction !== 'response') pushError(errors, '/direction', 'must equal response');
	if (response.requestId !== request?.requestId) pushError(errors, '/requestId', 'must match the originating request');
	if (response.adapterId !== request?.adapterId) pushError(errors, '/adapterId', 'must match the originating request');
	if (!['ok', 'unsupported', 'unknown', 'error'].includes(response.status)) pushError(errors, '/status', 'must be ok, unsupported, unknown, or error');
	if (!isPlainObject(response.result) && response.result !== null) pushError(errors, '/result', 'must be an object or null');
	if (!Array.isArray(response.diagnostics) || response.diagnostics.some((item) => !isPlainObject(item))) {
		pushError(errors, '/diagnostics', 'must be an array of structured diagnostic objects');
	}
	return { ok: errors.length === 0, errors };
}

export function makeSdkRequest({ requestId, operation, adapterId, snapshotRef, payload = {} }) {
	const request = {
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'request',
		requestId,
		operation,
		adapterId,
		snapshotRef,
		payload,
	};
	const validation = validateSdkRequest(request);
	if (!validation.ok) {
		const details = validation.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
		throw new TypeError(`invalid SDK request: ${details}`);
	}
	return request;
}
