import {
	SDK_INPUT_LIMITS,
	cloneJsonValue,
	hasOnlyKeys,
	isJsonValue,
	isPlainObject,
	pushError,
	validIdentifier,
	validOpaqueRef,
} from './_util.mjs';
import { SDK_ENTRYPOINT_PROTOCOL } from './manifest.mjs';

export const SDK_OPERATIONS = Object.freeze(['detect', 'analyze', 'diagnostics', 'read-set']);

function validRequestId(value) {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function boundedProtocolJson(value) {
	return isJsonValue(value, {
		maxDepth: SDK_INPUT_LIMITS.jsonDepth,
		maxNodes: SDK_INPUT_LIMITS.jsonNodes,
		maxStringBytes: SDK_INPUT_LIMITS.jsonStringBytes,
		maxKeyBytes: SDK_INPUT_LIMITS.jsonKeyBytes,
		maxSerializedBytes: SDK_INPUT_LIMITS.protocolJsonBytes,
	});
}

export function validateSdkRequest(request) {
	const errors = [];
	if (!isPlainObject(request)) return { ok: false, errors: [{ path: '', message: 'request must be an object' }] };
	if (!boundedProtocolJson(request)) {
		pushError(errors, '', `request must be bounded JSON data no larger than ${SDK_INPUT_LIMITS.protocolJsonBytes} serialized UTF-8 bytes`);
	}
	if (!hasOnlyKeys(request, ['contract', 'direction', 'requestId', 'operation', 'adapterId', 'snapshotRef', 'payload'])) {
		pushError(errors, '', 'contains unknown request keys');
	}
	if (request.contract !== SDK_ENTRYPOINT_PROTOCOL) pushError(errors, '/contract', `must equal ${SDK_ENTRYPOINT_PROTOCOL}`);
	if (request.direction !== 'request') pushError(errors, '/direction', 'must equal request');
	if (!validRequestId(request.requestId)) pushError(errors, '/requestId', 'must be a stable 1..128 character request id');
	if (!SDK_OPERATIONS.includes(request.operation)) pushError(errors, '/operation', 'is not a supported SDK operation');
	if (!validIdentifier(request.adapterId)) pushError(errors, '/adapterId', 'must be a bounded lowercase kebab-case id');
	if (!validOpaqueRef(request.snapshotRef)) {
		pushError(errors, '/snapshotRef', `must be a non-empty opaque reference of at most ${SDK_INPUT_LIMITS.snapshotRefBytes} UTF-8 bytes with no control characters; it is never interpreted as a path or URL by this SDK`);
	}
	if (!isPlainObject(request.payload) || !boundedProtocolJson(request.payload)) {
		pushError(errors, '/payload', `must be a bounded JSON object no larger than ${SDK_INPUT_LIMITS.protocolJsonBytes} serialized UTF-8 bytes`);
	}
	return { ok: errors.length === 0, errors };
}

export function validateSdkResponse(response, request) {
	const errors = [];
	if (!isPlainObject(response)) return { ok: false, errors: [{ path: '', message: 'response must be an object' }] };
	if (!boundedProtocolJson(response)) {
		pushError(errors, '', `response must be bounded JSON data no larger than ${SDK_INPUT_LIMITS.protocolJsonBytes} serialized UTF-8 bytes`);
	}
	if (!hasOnlyKeys(response, ['contract', 'direction', 'requestId', 'adapterId', 'status', 'result', 'diagnostics'])) {
		pushError(errors, '', 'contains unknown response keys');
	}
	if (response.contract !== SDK_ENTRYPOINT_PROTOCOL) pushError(errors, '/contract', `must equal ${SDK_ENTRYPOINT_PROTOCOL}`);
	if (response.direction !== 'response') pushError(errors, '/direction', 'must equal response');
	if (response.requestId !== request?.requestId) pushError(errors, '/requestId', 'must match the originating request');
	if (response.adapterId !== request?.adapterId) pushError(errors, '/adapterId', 'must match the originating request');
	if (!['ok', 'unsupported', 'unknown', 'error'].includes(response.status)) pushError(errors, '/status', 'must be ok, unsupported, unknown, or error');
	if ((!isPlainObject(response.result) && response.result !== null) || !boundedProtocolJson(response.result)) {
		pushError(errors, '/result', 'must be a bounded JSON object or null');
	}
	if (!Array.isArray(response.diagnostics)) {
		pushError(errors, '/diagnostics', 'must be an array of structured diagnostic objects');
	} else {
		if (response.diagnostics.length > SDK_INPUT_LIMITS.diagnostics) {
			pushError(errors, '/diagnostics', `must contain at most ${SDK_INPUT_LIMITS.diagnostics} entries`);
		}
		if (response.diagnostics.some((item) => !isPlainObject(item) || !boundedProtocolJson(item))) {
			pushError(errors, '/diagnostics', 'must contain only bounded JSON diagnostic objects');
		}
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
		payload: cloneJsonValue(payload, {
			maxDepth: SDK_INPUT_LIMITS.jsonDepth,
			maxNodes: SDK_INPUT_LIMITS.jsonNodes,
			maxStringBytes: SDK_INPUT_LIMITS.jsonStringBytes,
			maxKeyBytes: SDK_INPUT_LIMITS.jsonKeyBytes,
			maxSerializedBytes: SDK_INPUT_LIMITS.protocolJsonBytes,
		}),
	};
	const validation = validateSdkRequest(request);
	if (!validation.ok) {
		const details = validation.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
		throw new TypeError(`invalid SDK request: ${details}`);
	}
	return request;
}
