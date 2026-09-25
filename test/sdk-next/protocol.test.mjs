import assert from 'node:assert/strict';
import test from 'node:test';

import {
	SDK_ENTRYPOINT_PROTOCOL,
	makeSdkRequest,
	validateSdkRequest,
	validateSdkResponse,
} from '../../sdk/next/index.mjs';

test('worker response is bound to the originating request and adapter', () => {
	const request = makeSdkRequest({
		requestId: 'req-1',
		operation: 'detect',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
		payload: {},
	});
	assert.equal(validateSdkRequest(request).ok, true);
	assert.equal(validateSdkResponse({
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'response',
		requestId: 'req-1',
		adapterId: 'typescript-nestjs',
		status: 'ok',
		result: { detected: true },
		diagnostics: [],
	}, request).ok, true);

	const swapped = validateSdkResponse({
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'response',
		requestId: 'other-request',
		adapterId: 'other-adapter',
		status: 'ok',
		result: {},
		diagnostics: [],
	}, request);
	assert.equal(swapped.ok, false);
	assert.deepEqual(swapped.errors.map((e) => e.path).sort(), ['/adapterId', '/requestId']);
});

test('protocol rejects undeclared operations and extra envelope keys', () => {
	const request = {
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'request',
		requestId: 'req-2',
		operation: 'execute-shell',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
		payload: {},
		command: 'rm -rf /',
	};
	const result = validateSdkRequest(request);
	assert.equal(result.ok, false);
	assert.match(result.errors.map((e) => e.message).join('\n'), /unknown request keys/);
	assert.match(result.errors.map((e) => e.message).join('\n'), /not a supported SDK operation/);
});

test('makeSdkRequest refuses invalid data before a runner can see it', () => {
	assert.throws(() => makeSdkRequest({
		requestId: 'req with spaces',
		operation: 'detect',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
	}), /invalid SDK request/);
});


test('protocol rejects non-JSON nested values and cycles', () => {
	for (const payload of [
		{ fn: () => true },
		{ value: 1n },
		{ value: Infinity },
		{ value: new Date() },
	]) {
		const result = validateSdkRequest({
			contract: SDK_ENTRYPOINT_PROTOCOL,
			direction: 'request',
			requestId: 'req-json',
			operation: 'analyze',
			adapterId: 'typescript-nestjs',
			snapshotRef: 'sha256:example',
			payload,
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.map((e) => e.message).join('\n'), /bounded JSON object/);
	}

	const cyclic = {};
	cyclic.self = cyclic;
	const result = validateSdkRequest({
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'request',
		requestId: 'req-cycle',
		operation: 'analyze',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
		payload: cyclic,
	});
	assert.equal(result.ok, false);
});

test('makeSdkRequest clones JSON payload so later caller mutation cannot rewrite the request', () => {
	const payload = { nested: { value: 1 }, list: [1, 2] };
	const request = makeSdkRequest({
		requestId: 'req-clone',
		operation: 'analyze',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
		payload,
	});
	payload.nested.value = 999;
	payload.list.push(3);
	assert.deepEqual(request.payload, { list: [1, 2], nested: { value: 1 } });
});

test('protocol rejects excessively deep JSON values without overflowing the validator', () => {
	let payload = {};
	let cursor = payload;
	for (let i = 0; i < 70; i += 1) {
		cursor.next = {};
		cursor = cursor.next;
	}
	const result = validateSdkRequest({
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'request',
		requestId: 'req-depth',
		operation: 'analyze',
		adapterId: 'typescript-nestjs',
		snapshotRef: 'sha256:example',
		payload,
	});
	assert.equal(result.ok, false);
});
