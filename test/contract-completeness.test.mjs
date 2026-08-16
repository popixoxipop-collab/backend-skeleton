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
