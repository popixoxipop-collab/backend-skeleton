import './evidence-integration.test.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { PROVIDERS } from '../../handles/registry.mjs';
import {
	CAPABILITY_STATUSES,
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

function evidence(label) {
	const bytes = Buffer.from(`t03-test-evidence:${label}\n`, 'utf8');
	const ref = {
		artifact_ref: 'sbf.artifact-ref/1',
		family: 't03-test-evidence',
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
		evidence: [evidence('partial')],
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
	assert.equal(evaluateWaiver({
		failureCode: 'quality.low-recall',
		subject: 'target:b',
		now: '2026-09-25T00:00:00Z',
		waiver,
	}).allowed, false);
	assert.equal(evaluateWaiver({
		failureCode: 'quality.low-recall',
		subject: 'target:a',
		now: '2026-09-25T00:00:00Z',
		waiver,
	}).allowed, true);
	assert.equal(evaluateWaiver({
		failureCode: 'quality.low-recall',
		subject: 'target:a',
		now: '2026-10-02T00:00:00Z',
		waiver,
	}).allowed, false);
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

test('discovery and contract certification require verified evidence receipts', () => {
	assert.throws(() => certificationRecord({ targetId: 'x', level: 'discovery' }), /requires verified T01 ArtifactRef evidence/);
	assert.throws(() => certificationRecord({
		targetId: 'x',
		level: 'contract',
		evidence: ['proof'],
	}), /verifyArtifactEvidence/);
	const discovery = certificationRecord({
		targetId: 'x',
		level: 'discovery',
		evidence: [evidence('discovery')],
	});
	const contract = certificationRecord({
		targetId: 'x',
		level: 'contract',
		codegen: 'scaffold',
		evidence: [evidence('contract')],
	});
	assert.equal(discovery.level, 'discovery');
	assert.equal(discovery.codegen, 'none');
	assert.equal(contract.level, 'contract');
	assert.equal(contract.codegen, 'scaffold');
});

test('support matrix is deterministic and rejects duplicate certification rows', () => {
	const matrix = buildSupportMatrix([
		{ targetId: 'z', level: 'discovery', evidence: [evidence('z')] },
		{ targetId: 'a', level: 'contract', evidence: [evidence('a')] },
	]);
	assert.deepEqual(matrix.map((x) => x.targetId), ['a', 'z']);
	assert.throws(() => buildSupportMatrix([
		{ targetId: 'a', level: 'discovery', evidence: [evidence('a1')] },
		{ targetId: 'a', level: 'discovery', evidence: [evidence('a2')] },
	]), /duplicate certification row/);
});

test('duplicate exact evidence refs are rejected', () => {
	const receipt = evidence('same');
	assert.throws(() => capabilityRecord({
		name: 'x',
		status: 'supported',
		evidence: [receipt, receipt],
	}), /duplicate ArtifactRefs/);
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

test('legacy satisfier metadata is only a hint; verified artifact evidence is required', () => {
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
	const external = externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidence: evidence('openapi'),
	});
	assert.equal(evaluateLegacyCommandPolicy({
		adapter: fastapi,
		command: 'contract emit',
		externalCapabilities: { 'api.operations': external },
	}).allowed, true);
});

test('wrong satisfier flags and fabricated serialized external records fail closed', () => {
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'something-else',
		evidence: evidence('x'),
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
