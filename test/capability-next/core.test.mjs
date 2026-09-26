import './evidence-integration.test.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { PROVIDERS } from '../../handles/registry.mjs';
import {
	CAPABILITY_STATUSES,
	SUPPORT_LEVELS,
	CODEGEN_STATES,
	capabilityRecord,
	fromLegacyCapabilities,
	evaluateCapabilityPolicy,
	NON_WAIVABLE_FAILURE_CODES,
	evaluateWaiver,
	certificationRecord,
	buildSupportMatrix,
	legacyCommandRequirements,
	legacyProviderRequirements,
	legacySatisfierHints,
	externalCapabilityFromLegacySatisfier,
	evaluateLegacyCommandPolicy,
	evaluateLegacyProviderPolicy,
	buildLegacyCompatibilityView,
	policyDiagnostics,
	renderPolicyExplain,
	verifyArtifactEvidence,
} from '../../scanners/capability-next/index.mjs';

function identityOnlyEvidence(label) {
	const bytes = Buffer.from(`t03-identity-only-evidence:${label}\n`, 'utf8');
	const ref = {
		artifact_ref: 'sbf.artifact-ref/1',
		family: 't03-identity-only-test',
		version: '1',
		media_type: 'application/octet-stream',
		byte_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
		size_bytes: bytes.length,
	};
	return verifyArtifactEvidence({ ref, bytes });
}

test('five capability statuses remain the 04A frozen vocabulary', () => {
	assert.deepEqual(CAPABILITY_STATUSES, ['supported', 'partial', 'unsupported', 'unknown', 'not-applicable']);
});

test('supported cannot be caller-minted without scoped evidence even by spoofing legacy source', () => {
	assert.throws(() => capabilityRecord({ name: 'api.routes', status: 'supported' }), /semantically scoped verified evidence/);
	assert.throws(() => capabilityRecord({
		name: 'api.routes',
		status: 'supported',
		source: 'legacy-adapter-boolean',
	}), /semantically scoped verified evidence/);
});

test('non-supported states require a reason', () => {
	for (const status of ['partial', 'unknown', 'unsupported', 'not-applicable']) {
		assert.throws(() => capabilityRecord({ name: 'x', status }), /require a reason/);
	}
});

test('legacy boolean bridge preserves old meaning and does not invent evidence', () => {
	const caps = fromLegacyCapabilities({ 'api.operations': true, 'resource.fetch': false });
	assert.equal(caps['api.operations'].status, 'supported');
	assert.equal(caps['api.operations'].source, 'legacy-adapter-boolean');
	assert.deepEqual(caps['api.operations'].evidenceRefs, []);
	assert.match(caps['api.operations'].conditions[0], /does not widen/);
	assert.equal(caps['resource.fetch'].status, 'unsupported');
});

test('policy evaluation fails closed on a missing capability', () => {
	const result = evaluateCapabilityPolicy({
		policyId: 'emit',
		capabilities: {},
		requirements: [{ capability: 'api.operations' }],
	});
	assert.equal(result.allowed, false);
	assert.equal(result.missing[0].status, 'unknown');
	assert.match(result.missing[0].reason, /missing/);
});

test('plain unverified records cannot bypass capabilityRecord()', () => {
	assert.throws(() => evaluateCapabilityPolicy({
		capabilities: {
			'api.routes': {
				name: 'api.routes',
				status: 'supported',
				evidenceRefs: [],
				reason: null,
				conditions: [],
				source: 'forged',
			},
		},
		requirements: [{ capability: 'api.routes' }],
	}), /must be produced by capabilityRecord/);
});

test('partial fails by default but explicit acceptance never rewrites its status', () => {
	const partial = capabilityRecord({
		name: 'api.routes',
		status: 'partial',
		reason: 'dynamic mounts unresolved',
	});
	assert.equal(evaluateCapabilityPolicy({
		capabilities: { 'api.routes': partial },
		requirements: [{ capability: 'api.routes' }],
	}).allowed, false);
	const accepted = evaluateCapabilityPolicy({
		capabilities: { 'api.routes': partial },
		requirements: [{ capability: 'api.routes', acceptedStatuses: ['supported', 'partial'] }],
	});
	assert.equal(accepted.allowed, true);
	assert.equal(accepted.decisions[0].status, 'partial');
});

test('unknown can never be an accepted policy state', () => {
	assert.throws(() => evaluateCapabilityPolicy({
		requirements: [{ capability: 'api.routes', acceptedStatuses: ['unknown'] }],
	}), /unknown cannot/);
});

test('not-applicable never passes accidentally', () => {
	const rec = capabilityRecord({
		name: 'persistence.fetch',
		status: 'not-applicable',
		reason: 'service has no persistence layer',
	});
	assert.equal(evaluateCapabilityPolicy({
		capabilities: { 'persistence.fetch': rec },
		requirements: [{ capability: 'persistence.fetch' }],
	}).allowed, false);
	assert.equal(evaluateCapabilityPolicy({
		capabilities: { 'persistence.fetch': rec },
		requirements: [{ capability: 'persistence.fetch', acceptedStatuses: ['not-applicable'] }],
	}).allowed, true);
});

test('integrity and sandbox failures remain non-waivable', () => {
	for (const failureCode of ['identity.hash-mismatch', 'trust.sandbox-escape']) {
		assert.ok(NON_WAIVABLE_FAILURE_CODES.includes(failureCode));
		const result = evaluateWaiver({
			failureCode,
			subject: 'target:a',
			waiver: {
				scope: 'target:a',
				reason: 'test',
				approver: 'owner',
				expiresAt: '2999-01-01T00:00:00Z',
				failureCodes: [failureCode],
			},
		});
		assert.equal(result.allowed, false);
		assert.match(result.reason, /non-waivable/);
	}
});

test('waivers require exact scope, exact failure coverage and unexpired approval', () => {
	const waiver = {
		scope: 'target:a',
		reason: 'known fixture gap',
		approver: 'reviewer',
		expiresAt: '2026-10-01T00:00:00Z',
		failureCodes: ['quality.low-recall'],
	};
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:b', now: '2026-09-25T00:00:00Z', waiver }).allowed, false);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', now: '2026-09-25T00:00:00Z', waiver }).allowed, true);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', now: '2026-10-02T00:00:00Z', waiver }).allowed, false);
});

test('waiver failure codes reject duplicates', () => {
	assert.throws(() => evaluateWaiver({
		failureCode: 'quality.low-recall',
		subject: 'target:a',
		now: '2026-09-25T00:00:00Z',
		waiver: {
			scope: 'target:a',
			reason: 'x',
			approver: 'reviewer',
			expiresAt: '2026-10-01T00:00:00Z',
			failureCodes: ['quality.low-recall', 'quality.low-recall'],
		},
	}), /must not contain duplicates/);
});

test('exact-byte identity alone cannot mint discovery or contract certification', () => {
	const evidence = identityOnlyEvidence('cert');
	for (const level of ['discovery', 'contract']) {
		assert.throws(() => certificationRecord({
			targetId: 'python-fastapi',
			level,
			evidence: [evidence],
		}), /does not carry independent certification authority/);
	}
});

test('runtime-tested and behavior-tested remain blocked beyond RuntimeBinding, generic CI, build or mock success', () => {
	const evidence = identityOnlyEvidence('runtime');
	assert.throws(() => certificationRecord({
		targetId: 'python-fastapi',
		level: 'runtime-tested',
		profile: 'python-3.12-linux',
		evidence: [evidence],
	}), /exact T16 runtime-execution evidence plus independent T19 acceptance/);
	assert.throws(() => certificationRecord({
		targetId: 'python-fastapi',
		level: 'contract',
		codegen: 'behavior-tested',
		evidence: [evidence],
	}), /generic CI, build success, mocks, or RuntimeBinding presence are insufficient/);
});

test('support and codegen axes stay distinct even while authoritative certification is fail-closed', () => {
	assert.deepEqual(SUPPORT_LEVELS, ['discovery', 'contract', 'runtime-tested']);
	assert.deepEqual(CODEGEN_STATES, ['none', 'scaffold', 'build-tested', 'behavior-tested']);
	assert.deepEqual(buildSupportMatrix([]), []);
	assert.throws(() => buildSupportMatrix([
		{ targetId: 'x', level: 'contract', codegen: 'scaffold', evidence: [identityOnlyEvidence('matrix')] },
	]), /does not carry independent certification authority/);
});

test('legacy command requirements are projected from the stable command capability table', () => {
	assert.deepEqual(legacyCommandRequirements('contract emit'), [
		{ capability: 'api.operations', acceptedStatuses: ['supported'] },
	]);
	assert.deepEqual(legacyCommandRequirements('handles plan'), [
		{ capability: 'codegen.handles', acceptedStatuses: ['supported'] },
	]);
	assert.throws(() => legacyCommandRequirements('not-a-command'), /unknown capability-gated command/);
});

test('provider requirements stay independent from command dispatch capabilities', () => {
	assert.deepEqual(legacyProviderRequirements({
		id: 'java-spring',
		requiresCapabilities: ['resource.fetch'],
	}), [{ capability: 'resource.fetch', acceptedStatuses: ['supported'] }]);
});

test('legacy satisfier metadata is only a hint and exact-byte identity alone cannot promote it', () => {
	const hints = legacySatisfierHints();
	assert.equal(hints['api.operations'].flag, 'openapi-file');
	const fastapi = {
		id: 'python-fastapi',
		capabilities: {
			'api.operations': false,
			'api.request-shape': false,
			'resource.fetch': true,
			'codegen.handles': true,
		},
	};
	assert.equal(evaluateLegacyCommandPolicy({ adapter: fastapi, command: 'contract emit' }).allowed, false);
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidence: identityOnlyEvidence('openapi'),
	}), /do not authorize capability api\.operations status supported/);
});

test('wrong satisfier flags and fabricated serialized external records fail closed', () => {
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'something-else',
		evidence: identityOnlyEvidence('x'),
	}), /openapi-file/);
	const adapter = { id: 'x', capabilities: { 'api.operations': false } };
	assert.throws(() => evaluateLegacyCommandPolicy({
		adapter,
		command: 'contract emit',
		externalCapabilities: {
			'api.operations': {
				name: 'api.operations',
				status: 'supported',
				evidenceRefs: [],
				reason: null,
				conditions: [],
				source: 'external-satisfier:openapi-file',
			},
		},
	}), /must be produced by capabilityRecord/);
});

test('provider policy stays separate from command dispatch', () => {
	const adapter = {
		id: 'fixture',
		capabilities: {
			'codegen.handles': true,
			'resource.fetch': false,
		},
	};
	assert.equal(evaluateLegacyCommandPolicy({ adapter, command: 'handles plan' }).allowed, true);
	assert.equal(evaluateLegacyProviderPolicy({
		adapter,
		provider: { id: 'fixture', requiresCapabilities: ['resource.fetch'] },
	}).allowed, false);
});

test('legacy compatibility view is deterministic and explicitly uncertified', () => {
	const rows = buildLegacyCompatibilityView({
		adapters: [
			{ id: 'z', capabilities: { 'api.operations': true } },
			{ id: 'a', capabilities: { 'api.operations': false, 'codegen.handles': true } },
		],
		providers: [{ id: 'a', requiresCapabilities: ['resource.fetch'] }],
	});
	assert.deepEqual(rows.map((x) => x.adapterId), ['a', 'z']);
	assert.ok(rows.every((row) => row.certified === false));
});

test('real shipped adapters project into an uncertified compatibility view', () => {
	const rows = buildLegacyCompatibilityView({ adapters: ADAPTERS, providers: PROVIDERS });
	assert.deepEqual(rows.map((x) => x.adapterId), [
		'generic-grep',
		'java-spring',
		'javascript-express',
		'python-fastapi',
		'ruby-rails',
		'typescript-express',
	]);
	assert.ok(rows.every((row) => row.certified === false));
});

test('real first-party handles providers retain resource.fetch at provider level', () => {
	for (const provider of PROVIDERS) {
		assert.deepEqual(legacyProviderRequirements(provider), [
			{ capability: 'resource.fetch', acceptedStatuses: ['supported'] },
		], provider.id);
	}
});

test('policy diagnostics keep missing distinct from rejected status', () => {
	const missing = evaluateCapabilityPolicy({
		policyId: 'x',
		requirements: [{ capability: 'api.security.enforced' }],
	});
	assert.deepEqual(policyDiagnostics(missing).map((x) => x.code), ['CAPABILITY_MISSING']);
	const unsupported = capabilityRecord({
		name: 'api.security.enforced',
		status: 'unsupported',
		reason: 'no enforcement evidence',
	});
	const rejected = evaluateCapabilityPolicy({
		policyId: 'x',
		capabilities: { 'api.security.enforced': unsupported },
		requirements: [{ capability: 'api.security.enforced' }],
	});
	assert.deepEqual(policyDiagnostics(rejected).map((x) => x.code), ['CAPABILITY_STATUS_REJECTED']);
});

test('policy explanation never advises bypassing evidence', () => {
	const result = evaluateCapabilityPolicy({
		policyId: 'emit',
		requirements: [{ capability: 'api.operations' }],
	});
	const text = renderPolicyExplain(result);
	assert.match(text, /^policy emit: blocked/);
	assert.match(text, /CAPABILITY_MISSING/);
	assert.doesNotMatch(text, /force|ignore|bypass/i);
});
