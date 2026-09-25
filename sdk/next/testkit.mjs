import { planExternalAdapterActivation, validateAdapterSdkManifest } from './manifest.mjs';
import { makeSdkRequest, validateSdkResponse } from './protocol.mjs';

export const CONFORMANCE_REPORT_CONTRACT = 'sbf.adapter-sdk-conformance/1';

export async function runAdapterSdkConformance({
	manifest,
	snapshotRef,
	cases,
	invoke,
}) {
	const manifestValidation = validateAdapterSdkManifest(manifest);
	const activation = planExternalAdapterActivation(manifest);
	const failures = [];
	const observations = [];

	if (!manifestValidation.ok) {
		return {
			contract: CONFORMANCE_REPORT_CONTRACT,
			adapterId: manifest?.adapter?.id ?? null,
			status: 'invalid-manifest',
			executed: false,
			activation,
			observations,
			failures: manifestValidation.errors,
		};
	}
	if (typeof invoke !== 'function') throw new TypeError('invoke must be a caller-supplied function');
	if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('cases must be a non-empty array');

	for (let index = 0; index < cases.length; index += 1) {
		const testCase = cases[index];
		const request = makeSdkRequest({
			requestId: `case-${index + 1}`,
			operation: testCase.operation,
			adapterId: manifest.adapter.id,
			snapshotRef,
			payload: testCase.payload ?? {},
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
		adapterId: manifest.adapter.id,
		status: failures.length === 0 ? 'pass' : 'fail',
		executed: true,
		activation: {
			...activation,
			executable: false,
			note: 'the SDK never spawned or imported adapter code; invoke was explicitly supplied by the caller/test harness',
		},
		observations,
		failures,
	};
}
