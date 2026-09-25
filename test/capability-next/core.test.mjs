import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CAPABILITY_STATUSES,
	capabilityRecord,
	fromLegacyCapabilities,
	evaluateCapabilityPolicy,
	NON_WAIVABLE_FAILURE_CODES,
	evaluateWaiver,
	certificationRecord,
	buildSupportMatrix,
} from '../../scanners/capability-next/index.mjs';

test('five capability statuses are explicit and stable', () => {
	assert.deepEqual(CAPABILITY_STATUSES, ['supported', 'partial', 'unsupported', 'unknown', 'not-applicable']);
});

test('supported next capability requires evidence', () => {
	assert.throws(() => capabilityRecord({ name: 'api.routes', status: 'supported' }), /require evidenceRefs/);
	const rec = capabilityRecord({ name: 'api.routes', status: 'supported', evidenceRefs: ['fixture:routes'] });
	assert.equal(rec.status, 'supported');
});

test('partial/unknown/unsupported/not-applicable require a reason', () => {
	for (const status of ['partial', 'unknown', 'unsupported', 'not-applicable']) {
		assert.throws(() => capabilityRecord({ name: 'x', status }), /require a reason/);
	}
});

test('legacy boolean bridge preserves legacy meaning without inventing evidence', () => {
	const caps = fromLegacyCapabilities({ 'api.operations': true, 'resource.fetch': false });
	assert.equal(caps['api.operations'].status, 'supported');
	assert.equal(caps['api.operations'].source, 'legacy-adapter-boolean');
	assert.deepEqual(caps['api.operations'].evidenceRefs, []);
	assert.match(caps['api.operations'].conditions[0], /does not widen/);
	assert.equal(caps['resource.fetch'].status, 'unsupported');
});

test('policy evaluation fails closed on a missing capability', () => {
	const result = evaluateCapabilityPolicy({ policyId: 'emit', capabilities: {}, requirements: [{ capability: 'api.operations' }] });
	assert.equal(result.allowed, false);
	assert.equal(result.missing[0].status, 'unknown');
	assert.match(result.missing[0].reason, /missing/);
});

test('unknown cannot be configured as an accepted policy status', () => {
	assert.throws(() => evaluateCapabilityPolicy({ requirements: [{ capability: 'x', acceptedStatuses: ['unknown'] }] }), /unknown cannot/);
});

test('partial fails by default but can be explicitly accepted', () => {
	const partial = capabilityRecord({ name: 'api.routes', status: 'partial', reason: 'dynamic mounts unresolved', evidenceRefs: ['fixture:a'] });
	assert.equal(evaluateCapabilityPolicy({ capabilities: { 'api.routes': partial }, requirements: [{ capability: 'api.routes' }] }).allowed, false);
	assert.equal(evaluateCapabilityPolicy({ capabilities: { 'api.routes': partial }, requirements: [{ capability: 'api.routes', acceptedStatuses: ['supported', 'partial'] }] }).allowed, true);
});

test('not-applicable never passes accidentally', () => {
	const rec = capabilityRecord({ name: 'persistence.fetch', status: 'not-applicable', reason: 'service has no persistence layer' });
	assert.equal(evaluateCapabilityPolicy({ capabilities: { 'persistence.fetch': rec }, requirements: [{ capability: 'persistence.fetch' }] }).allowed, false);
	assert.equal(evaluateCapabilityPolicy({ capabilities: { 'persistence.fetch': rec }, requirements: [{ capability: 'persistence.fetch', acceptedStatuses: ['not-applicable'] }] }).allowed, true);
});

test('integrity and sandbox failures are non-waivable', () => {
	assert.ok(NON_WAIVABLE_FAILURE_CODES.includes('identity.hash-mismatch'));
	assert.ok(NON_WAIVABLE_FAILURE_CODES.includes('trust.sandbox-escape'));
	for (const failureCode of ['identity.hash-mismatch', 'trust.sandbox-escape']) {
		const result = evaluateWaiver({ failureCode, waiver: { scope: '*', reason: 'test', approver: 'owner', expiresAt: '2999-01-01T00:00:00Z', failureCodes: [failureCode] } });
		assert.equal(result.allowed, false);
		assert.match(result.reason, /non-waivable/);
	}
});

test('waivers require scope, reason, approver, expiry and exact failure coverage', () => {
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', waiver: null }).allowed, false);
	assert.throws(() => evaluateWaiver({ failureCode: 'quality.low-recall', waiver: { scope: 'x' } }), /waiver.reason/);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', now: '2026-09-25T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['other'] } }).allowed, false);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', now: '2026-09-25T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['quality.low-recall'] } }).allowed, true);
});

test('expired waiver fails closed', () => {
	const result = evaluateWaiver({ failureCode: 'quality.low-recall', now: '2026-10-02T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['quality.low-recall'] } });
	assert.equal(result.allowed, false);
	assert.match(result.reason, /expired/);
});

test('contract and runtime-tested certification require evidence, runtime additionally requires a profile', () => {
	assert.throws(() => certificationRecord({ targetId: 'python-fastapi', level: 'contract' }), /requires evidenceRefs/);
	assert.throws(() => certificationRecord({ targetId: 'python-fastapi', level: 'runtime-tested', evidenceRefs: ['run:1'] }), /requires profile/);
	const runtime = certificationRecord({ targetId: 'python-fastapi', level: 'runtime-tested', evidenceRefs: ['run:1'], profile: 'python-3.12-linux' });
	assert.equal(runtime.level, 'runtime-tested');
});

test('codegen status is independent from support level', () => {
	const discovery = certificationRecord({ targetId: 'x', level: 'discovery', codegen: 'none' });
	const runtimeNoCodegen = certificationRecord({ targetId: 'y', level: 'runtime-tested', codegen: 'none', evidenceRefs: ['run:y'], profile: 'linux' });
	const contractWithScaffold = certificationRecord({ targetId: 'z', level: 'contract', codegen: 'scaffold', evidenceRefs: ['contract:z'] });
	assert.equal(discovery.codegen, 'none');
	assert.equal(runtimeNoCodegen.codegen, 'none');
	assert.equal(contractWithScaffold.codegen, 'scaffold');
});

test('support matrix is deterministic and rejects duplicate certification rows', () => {
	const matrix = buildSupportMatrix([
		{ targetId: 'z', level: 'discovery' },
		{ targetId: 'a', level: 'contract', evidenceRefs: ['contract:a'] },
	]);
	assert.deepEqual(matrix.map((x) => x.targetId), ['a', 'z']);
	assert.throws(() => buildSupportMatrix([
		{ targetId: 'a', level: 'discovery' },
		{ targetId: 'a', level: 'discovery' },
	]), /duplicate certification row/);
});

test('records sort evidence refs deterministically and reject duplicates', () => {
	const rec = capabilityRecord({ name: 'x', status: 'supported', evidenceRefs: ['z', 'a'] });
	assert.deepEqual(rec.evidenceRefs, ['a', 'z']);
	assert.throws(() => capabilityRecord({ name: 'x', status: 'supported', evidenceRefs: ['a', 'a'] }), /duplicates/);
});
