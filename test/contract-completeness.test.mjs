// Pure unit tests for contracts/completeness.mjs -- no git repo, no CLI, no filesystem writes.
// This is A5's policy layer: contracts/emit.mjs stays a pure "what did the scan find" function,
// and this module is where warnings become a completeness verdict and get weighed against
// recorded waivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SEVERITY, COMPLETENESS, WARNING_CODES,
	requireWarningCode, makeWarning, warningKey, countByCode, classifyContract, evaluateResolution,
} from '../contracts/completeness.mjs';

test('warningKey is built from code+subject only -- changing message must not change the key', () => {
	const a = makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'POST /curricula', message: 'first phrasing' });
	const b = makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'POST /curricula', message: 'completely reworded later' });
	assert.equal(warningKey(a), warningKey(b));
});

test('requireWarningCode throws on an unknown code with the known list attached', () => {
	assert.throws(() => requireWarningCode('CONTRACT_TYPO'), /unknown contract warning code "CONTRACT_TYPO"/);
	assert.throws(() => requireWarningCode('CONTRACT_TYPO'), new RegExp(Object.keys(WARNING_CODES).join('.*')));
});

test('makeWarning stamps severity from the code table, not from the caller', () => {
	const w = makeWarning('CONTRACT_BODY_UNKNOWN', { subject: 'GET /x', message: 'body shape unknown' });
	assert.equal(w.severity, SEVERITY.WARN);
	const e = makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /y', message: 'unmatched' });
	assert.equal(e.severity, SEVERITY.ERROR);
});

test('countByCode tallies occurrences per code', () => {
	const warnings = [
		makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /a', message: 'x' }),
		makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /b', message: 'x' }),
		makeWarning('CONTRACT_BODY_UNKNOWN', { subject: 'GET /c', message: 'x' }),
	];
	assert.deepEqual(countByCode(warnings), { CONTRACT_UNMATCHED_ENDPOINT: 2, CONTRACT_BODY_UNKNOWN: 1 });
});

test('classifyContract: zero operations is always blocked, regardless of warnings', () => {
	assert.equal(classifyContract({ operations: {}, warnings: [] }), COMPLETENESS.BLOCKED);
	const withWarning = { operations: {}, warnings: [makeWarning('CONTRACT_NO_MODULE', { message: 'x' })] };
	assert.equal(classifyContract(withWarning), COMPLETENESS.BLOCKED);
});

test('classifyContract: operations present + zero warnings is complete', () => {
	assert.equal(classifyContract({ operations: { findX: {} }, warnings: [] }), COMPLETENESS.COMPLETE);
});

test('classifyContract: operations present + at least one ERROR warning is partial', () => {
	const warnings = [makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /a', message: 'x' })];
	assert.equal(classifyContract({ operations: { findX: {} }, warnings }), COMPLETENESS.PARTIAL);
});

test('classifyContract: operations present + only WARN-severity warnings stays complete', () => {
	const warnings = [makeWarning('CONTRACT_BODY_UNKNOWN', { subject: 'GET /a', message: 'x' })];
	assert.equal(classifyContract({ operations: { findX: {} }, warnings }), COMPLETENESS.COMPLETE);
});

test('evaluateResolution: an unwaived ERROR warning blocks', () => {
	const contract = { operations: { findX: {} }, warnings: [makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /a', message: 'x' })] };
	const result = evaluateResolution(contract, { waivers: [] });
	assert.equal(result.status, COMPLETENESS.PARTIAL);
	assert.equal(result.blocking, true);
	assert.equal(result.unwaived.length, 1);
	assert.equal(result.waived.length, 0);
});

test('evaluateResolution: a waiver matching code+subject exactly un-blocks', () => {
	const contract = { operations: { findX: {} }, warnings: [makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /a', message: 'x' })] };
	const resolution = { waivers: [{ code: 'CONTRACT_UNMATCHED_ENDPOINT', subject: 'GET /a', reason: 'test' }] };
	const result = evaluateResolution(contract, resolution);
	assert.equal(result.blocking, false);
	assert.equal(result.unwaived.length, 0);
	assert.equal(result.waived.length, 1);
	assert.equal(result.status, COMPLETENESS.PARTIAL, 'waiving does not change completeness status, only blocking');
});

test('evaluateResolution: a waiver for a different subject does not cover this warning', () => {
	const contract = { operations: { findX: {} }, warnings: [makeWarning('CONTRACT_UNMATCHED_ENDPOINT', { subject: 'GET /a', message: 'x' })] };
	const resolution = { waivers: [{ code: 'CONTRACT_UNMATCHED_ENDPOINT', subject: 'GET /completely-different', reason: 'test' }] };
	const result = evaluateResolution(contract, resolution);
	assert.equal(result.blocking, true);
	assert.equal(result.unwaived.length, 1);
});

test('evaluateResolution: only WARN-severity warnings never block, waived or not', () => {
	const contract = { operations: { findX: {} }, warnings: [makeWarning('CONTRACT_BODY_UNKNOWN', { subject: 'GET /a', message: 'x' })] };
	const result = evaluateResolution(contract, { waivers: [] });
	assert.equal(result.blocking, false);
	assert.equal(result.status, COMPLETENESS.COMPLETE);
});

test('evaluateResolution: a waiver with no matching current warning is reported as stale, and does not affect blocking', () => {
	const contract = { operations: { findX: {} }, warnings: [] };
	const resolution = { waivers: [{ code: 'CONTRACT_UNMATCHED_ENDPOINT', subject: 'GET /long-gone', reason: 'test' }] };
	const result = evaluateResolution(contract, resolution);
	assert.equal(result.blocking, false);
	assert.equal(result.staleWaivers.length, 1);
});

test('evaluateResolution: blocked (zero operations) is never waivable, even with a matching waiver', () => {
	const contract = { operations: {}, warnings: [makeWarning('CONTRACT_NO_MODULE', { message: 'x' })] };
	const resolution = { waivers: [{ code: 'CONTRACT_NO_MODULE', subject: null, reason: 'test' }] };
	const result = evaluateResolution(contract, resolution);
	assert.equal(result.status, COMPLETENESS.BLOCKED);
	assert.equal(result.blocking, true, 'blocked must block regardless of any waiver present');
});

// A1: the 4 OpenAPI reconciliation warning codes.
test('the 4 A1 warning codes exist in WARNING_CODES with the expected severity/waivable', () => {
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_DRIFT, { severity: SEVERITY.ERROR, waivable: true });
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_MISSING_OPERATION, { severity: SEVERITY.ERROR, waivable: true });
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_AMBIGUOUS, { severity: SEVERITY.ERROR, waivable: true });
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_DERIVED_OPERATION_ID, { severity: SEVERITY.WARN, waivable: true });
	for (const code of ['CONTRACT_OPENAPI_DRIFT', 'CONTRACT_OPENAPI_MISSING_OPERATION', 'CONTRACT_OPENAPI_AMBIGUOUS', 'CONTRACT_OPENAPI_DERIVED_OPERATION_ID']) {
		assert.doesNotThrow(() => requireWarningCode(code));
	}
});

test('evaluateResolution: an unwaived CONTRACT_OPENAPI_DRIFT blocks; an exact code+subject waiver resolves it', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [makeWarning('CONTRACT_OPENAPI_DRIFT', { subject: 'findWidget', message: 'x' })],
	};
	const unwaived = evaluateResolution(contract, { waivers: [] });
	assert.equal(unwaived.blocking, true);

	const waived = evaluateResolution(contract, { waivers: [{ code: 'CONTRACT_OPENAPI_DRIFT', subject: 'findWidget', reason: 'x' }] });
	assert.equal(waived.blocking, false);
});

test('evaluateResolution: CONTRACT_OPENAPI_DERIVED_OPERATION_ID (WARN) never blocks, waived or not', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [makeWarning('CONTRACT_OPENAPI_DERIVED_OPERATION_ID', { subject: 'createWidget', message: 'x' })],
	};
	assert.equal(evaluateResolution(contract, { waivers: [] }).blocking, false);
});

// A2: the request-body-schema-projection warning code.
test('CONTRACT_OPENAPI_SCHEMA_UNRESOLVED exists with {severity: WARN, waivable: true}', () => {
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_SCHEMA_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_SCHEMA_UNRESOLVED'));
});

test('evaluateResolution: CONTRACT_OPENAPI_SCHEMA_UNRESOLVED (WARN) never blocks, waived or not', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [makeWarning('CONTRACT_OPENAPI_SCHEMA_UNRESOLVED', { subject: 'createWidget', message: 'x' })],
	};
	assert.equal(evaluateResolution(contract, { waivers: [] }).blocking, false);
	assert.equal(classifyContract(contract), COMPLETENESS.COMPLETE);
});

// A3: the response/error schema-projection warning codes.
test('CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED and CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED exist with {severity: WARN, waivable: true}', () => {
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED'));
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED'));
});

test('evaluateResolution: both new A3 codes never block, waived or not; completeness stays COMPLETE even with both present', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [
			makeWarning('CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED', { subject: 'createWidget', message: 'x' }),
			makeWarning('CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED', { subject: 'createWidget', message: 'y' }),
		],
	};
	assert.equal(evaluateResolution(contract, { waivers: [] }).blocking, false);
	assert.equal(classifyContract(contract), COMPLETENESS.COMPLETE);
});

// A7: the two source-backed passthrough warning codes.
test('CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED and CONTRACT_OPENAPI_SECURITY_UNRESOLVED exist with {severity: WARN, waivable: true}', () => {
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_SECURITY_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED'));
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_SECURITY_UNRESOLVED'));
});

test('evaluateResolution: both new A7 codes never block, waived or not; completeness stays COMPLETE even with both present', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [
			makeWarning('CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED', { subject: 'createWidget', message: 'x' }),
			makeWarning('CONTRACT_OPENAPI_SECURITY_UNRESOLVED', { subject: 'createWidget', message: 'y' }),
		],
	};
	assert.equal(evaluateResolution(contract, { waivers: [] }).blocking, false);
	assert.equal(classifyContract(contract), COMPLETENESS.COMPLETE);
});

// A7: a waiver for one of the two codes must never silently cover the other on the same operation
// -- same operation, same subject (operationId), genuinely unrelated failures. Direct proof that
// two codes (not one shared code) was the right call, same as D-openapi-response-schema's own test
// for the request/response/error split.
test('a waiver for CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED does not cover CONTRACT_OPENAPI_SECURITY_UNRESOLVED on the same operation', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [
			makeWarning('CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED', { subject: 'createWidget', message: 'x' }),
			makeWarning('CONTRACT_OPENAPI_SECURITY_UNRESOLVED', { subject: 'createWidget', message: 'y' }),
		],
	};
	// Both are WARN, so neither blocks regardless -- the waiver-independence claim is about the
	// WAIVER KEY, not about blocking, so assert on evaluateResolution's own waived/unwaived split.
	const resolution = { waivers: [{ code: 'CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED', subject: 'createWidget', reason: 'x' }] };
	const result = evaluateResolution(contract, resolution);
	// Neither WARN contributes to errorWarnings at all (evaluateResolution only tracks ERROR
	// severity in unwaived/waived) -- so this asserts the waiver key computation itself is distinct,
	// via warningKey, rather than through evaluateResolution's blocking-only view.
	assert.notEqual(
		warningKey(contract.warnings[0]),
		warningKey(contract.warnings[1]),
		'CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED and CONTRACT_OPENAPI_SECURITY_UNRESOLVED on the same subject must produce different waiver keys',
	);
	assert.equal(result.blocking, false);
});

// A8: exactly ONE new warning code (per-status failure reuses A3's own two response/error codes --
// see D-openapi-per-status -- since it is not independent of them; the multipart-schema failure
// genuinely is independent, hence its own code).
test('CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED exists with {severity: WARN, waivable: true}', () => {
	assert.deepEqual(WARNING_CODES.CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED, { severity: SEVERITY.WARN, waivable: true });
	assert.doesNotThrow(() => requireWarningCode('CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED'));
});

// A real operation can legally accept both application/json and multipart/form-data at once -- a
// waiver for the JSON body's own failure (CONTRACT_OPENAPI_SCHEMA_UNRESOLVED, A2) must never
// silently cover an unrelated multipart-schema failure on the same operation.
test('a waiver for CONTRACT_OPENAPI_SCHEMA_UNRESOLVED does not cover CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED on the same operation', () => {
	const contract = {
		operations: { findX: {} },
		warnings: [
			makeWarning('CONTRACT_OPENAPI_SCHEMA_UNRESOLVED', { subject: 'createWidget', message: 'x' }),
			makeWarning('CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED', { subject: 'createWidget', message: 'y' }),
		],
	};
	assert.notEqual(
		warningKey(contract.warnings[0]),
		warningKey(contract.warnings[1]),
		'CONTRACT_OPENAPI_SCHEMA_UNRESOLVED and CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED on the same subject must produce different waiver keys',
	);
});
