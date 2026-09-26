import crypto from 'node:crypto';

import {
	SDK_INPUT_LIMITS,
	cloneAndFreezeJson,
	cloneJsonValue,
	hasOnlyKeys,
	isPlainObject,
	validOpaqueRef,
} from './_util.mjs';
import { planExternalAdapterActivation, validateAdapterSdkManifest } from './manifest.mjs';
import { SDK_OPERATIONS, makeSdkRequest, validateSdkResponse } from './protocol.mjs';

export const CONFORMANCE_REPORT_CONTRACT = 'sbf.adapter-sdk-conformance/1';
export const CONFORMANCE_INPUT_BINDING_FORMAT = 'sbf.adapter-sdk-conformance-input-json/1';

const RESPONSE_STATUSES = new Set(['ok', 'unsupported', 'unknown', 'error']);

function normalizeCases(cases) {
	if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('cases must be a non-empty array');
	if (cases.length > SDK_INPUT_LIMITS.conformanceCases) {
		throw new TypeError(`cases must contain at most ${SDK_INPUT_LIMITS.conformanceCases} entries`);
	}
	for (let index = 0; index < cases.length; index += 1) {
		const testCase = cases[index];
		if (!isPlainObject(testCase) || !hasOnlyKeys(testCase, ['operation', 'payload', 'expectStatus'])) {
			throw new TypeError(`cases[${index}] must contain only operation, payload, and expectStatus`);
		}
		if (!SDK_OPERATIONS.includes(testCase.operation)) throw new TypeError(`cases[${index}].operation is unsupported`);
		if (testCase.payload !== undefined && !isPlainObject(testCase.payload)) throw new TypeError(`cases[${index}].payload must be an object`);
		if (testCase.expectStatus !== undefined && !RESPONSE_STATUSES.has(testCase.expectStatus)) {
			throw new TypeError(`cases[${index}].expectStatus is unsupported`);
		}
	}
	return cloneAndFreezeJson(cases, {
		maxDepth: SDK_INPUT_LIMITS.jsonDepth,
		maxNodes: SDK_INPUT_LIMITS.jsonNodes,
		maxStringBytes: SDK_INPUT_LIMITS.jsonStringBytes,
		maxKeyBytes: SDK_INPUT_LIMITS.jsonKeyBytes,
		maxSerializedBytes: SDK_INPUT_LIMITS.protocolJsonBytes,
	});
}

function inputBinding(manifest, snapshotRef, cases) {
	const canonical = cloneJsonValue({ manifest, snapshotRef, cases }, {
		maxDepth: SDK_INPUT_LIMITS.jsonDepth,
		maxNodes: SDK_INPUT_LIMITS.jsonNodes,
		maxStringBytes: SDK_INPUT_LIMITS.jsonStringBytes,
		maxKeyBytes: SDK_INPUT_LIMITS.jsonKeyBytes,
		maxSerializedBytes: SDK_INPUT_LIMITS.protocolJsonBytes * 2,
	});
	const bytes = `${CONFORMANCE_INPUT_BINDING_FORMAT}\n${JSON.stringify(canonical)}\n`;
	return Object.freeze({
		format: CONFORMANCE_INPUT_BINDING_FORMAT,
		sha256: crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'),
		certificationAuthority: false,
		note: 'This digest binds only the T22 in-memory conformance inputs; it is not a T01 ArtifactRef, support certification, runtime binding, or execution evidence.',
	});
}

export async function runAdapterSdkConformance({
	manifest,
	snapshotRef,
	cases,
	invoke,
}) {
	const manifestValidation = validateAdapterSdkManifest(manifest);
	const failures = [];
	const observations = [];

	if (!manifestValidation.ok) {
		return {
			contract: CONFORMANCE_REPORT_CONTRACT,
			adapterId: manifest?.adapter?.id ?? null,
			status: 'invalid-manifest',
			executed: false,
			inputBinding: null,
			activation: planExternalAdapterActivation(manifest),
			observations,
			failures: manifestValidation.errors,
		};
	}
	if (typeof invoke !== 'function') throw new TypeError('invoke must be a caller-supplied function');
	if (!validOpaqueRef(snapshotRef)) {
		throw new TypeError(`snapshotRef must be a non-empty opaque reference of at most ${SDK_INPUT_LIMITS.snapshotRefBytes} UTF-8 bytes with no control characters`);
	}

	const manifestSnapshot = cloneAndFreezeJson(manifest, {
		maxDepth: 16,
		maxNodes: 4096,
		maxStringBytes: SDK_INPUT_LIMITS.pathBytes,
		maxKeyBytes: 128,
		maxSerializedBytes: SDK_INPUT_LIMITS.manifestBytes,
	});
	const casesSnapshot = normalizeCases(cases);
	const frozenSnapshotRef = String(snapshotRef);
	const binding = inputBinding(manifestSnapshot, frozenSnapshotRef, casesSnapshot);
	const activation = planExternalAdapterActivation(manifestSnapshot);
	const adapterId = manifestSnapshot.adapter.id;

	for (let index = 0; index < casesSnapshot.length; index += 1) {
		const testCase = casesSnapshot[index];
		const request = cloneAndFreezeJson(makeSdkRequest({
			requestId: `case-${index + 1}`,
			operation: testCase.operation,
			adapterId,
			snapshotRef: frozenSnapshotRef,
			payload: testCase.payload ?? {},
		}), {
			maxDepth: SDK_INPUT_LIMITS.jsonDepth,
			maxNodes: SDK_INPUT_LIMITS.jsonNodes,
			maxStringBytes: SDK_INPUT_LIMITS.jsonStringBytes,
			maxKeyBytes: SDK_INPUT_LIMITS.jsonKeyBytes,
			maxSerializedBytes: SDK_INPUT_LIMITS.protocolJsonBytes,
		});

		let response;
		try {
			response = await invoke(request);
		} catch (error) {
			failures.push({ index, reason: 'invoke-threw', message: String(error?.message ?? error) });
			continue;
		}
		const responseValidation = validateSdkResponse(response, request);
		if (!responseValidation.ok) {
			failures.push({ index, reason: 'invalid-response', errors: responseValidation.errors });
			continue;
		}
		const expectedStatus = testCase.expectStatus ?? 'ok';
		if (response.status !== expectedStatus) {
			failures.push({ index, reason: 'status-mismatch', expectedStatus, actualStatus: response.status });
		}
		observations.push({
			index,
			operation: testCase.operation,
			status: response.status,
			diagnosticCount: response.diagnostics.length,
		});
	}
	return {
		contract: CONFORMANCE_REPORT_CONTRACT,
		adapterId,
		status: failures.length === 0 ? 'pass' : 'fail',
		executed: true,
		inputBinding: binding,
		activation: {
			...activation,
			executable: false,
			note: 'the SDK never spawned or imported adapter code; invoke was explicitly supplied by the caller/test harness',
		},
		observations,
		failures,
	};
}
