import { test } from 'node:test';
import assert from 'node:assert/strict';
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
		const result = evaluateWaiver({ failureCode, subject: 'target:a', waiver: { scope: '*', reason: 'test', approver: 'owner', expiresAt: '2999-01-01T00:00:00Z', failureCodes: [failureCode] } });
		assert.equal(result.allowed, false);
		assert.match(result.reason, /non-waivable/);
	}
});

test('waivers require scope, reason, approver, expiry and exact failure coverage', () => {
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', waiver: null }).allowed, false);
	assert.throws(() => evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', waiver: { scope: 'x' } }), /waiver.reason/);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', now: '2026-09-25T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['other'] } }).allowed, false);
	assert.equal(evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', now: '2026-09-25T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['quality.low-recall'] } }).allowed, true);
});

test('expired waiver fails closed', () => {
	const result = evaluateWaiver({ failureCode: 'quality.low-recall', subject: 'target:a', now: '2026-10-02T00:00:00Z', waiver: { scope: 'target:a', reason: 'known fixture gap', approver: 'reviewer', expiresAt: '2026-10-01T00:00:00Z', failureCodes: ['quality.low-recall'] } });
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
	const discovery = certificationRecord({ targetId: 'x', level: 'discovery', codegen: 'none', evidenceRefs: ['discovery:x'] });
	const runtimeNoCodegen = certificationRecord({ targetId: 'y', level: 'runtime-tested', codegen: 'none', evidenceRefs: ['run:y'], profile: 'linux' });
	const contractWithScaffold = certificationRecord({ targetId: 'z', level: 'contract', codegen: 'scaffold', evidenceRefs: ['contract:z'] });
	assert.equal(discovery.codegen, 'none');
	assert.equal(runtimeNoCodegen.codegen, 'none');
	assert.equal(contractWithScaffold.codegen, 'scaffold');
});

test('support matrix is deterministic and rejects duplicate certification rows', () => {
	const matrix = buildSupportMatrix([
		{ targetId: 'z', level: 'discovery', evidenceRefs: ['discovery:z'] },
		{ targetId: 'a', level: 'contract', evidenceRefs: ['contract:a'] },
	]);
	assert.deepEqual(matrix.map((x) => x.targetId), ['a', 'z']);
	assert.throws(() => buildSupportMatrix([
		{ targetId: 'a', level: 'discovery', evidenceRefs: ['discovery:a'] },
		{ targetId: 'a', level: 'discovery', evidenceRefs: ['discovery:a'] },
	]), /duplicate certification row/);
});

test('records sort evidence refs deterministically and reject duplicates', () => {
	const rec = capabilityRecord({ name: 'x', status: 'supported', evidenceRefs: ['z', 'a'] });
	assert.deepEqual(rec.evidenceRefs, ['a', 'z']);
	assert.throws(() => capabilityRecord({ name: 'x', status: 'supported', evidenceRefs: ['a', 'a'] }), /duplicates/);
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
	assert.deepEqual(legacyProviderRequirements({ id: 'java-spring', requiresCapabilities: ['resource.fetch'] }), [
		{ capability: 'resource.fetch', acceptedStatuses: ['supported'] },
	]);
});

test('legacy satisfier metadata is a hint and needs immutable evidence before it can satisfy next policy', () => {
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
		evidenceRef: 'sha256:openapi-example',
	});
	assert.equal(evaluateLegacyCommandPolicy({
		adapter: fastapi,
		command: 'contract emit',
		externalCapabilities: { 'api.operations': external },
	}).allowed, true);
});

test('wrong satisfier flags and non-evidence external records fail closed', () => {
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations', flag: 'something-else', evidenceRef: 'sha256:x',
	}), /openapi-file/);
	const adapter = { id: 'x', capabilities: { 'api.operations': false } };
	const fabricated = capabilityRecord({
		name: 'api.operations', status: 'supported', evidenceRefs: ['fake:1'], source: 'manual',
	});
	assert.throws(() => evaluateLegacyCommandPolicy({
		adapter, command: 'contract emit', externalCapabilities: { 'api.operations': fabricated },
	}), /external-satisfier/);
});

test('provider policy uses the provider own requirements instead of conflating them with command dispatch', () => {
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
	assert.equal(rows[0].certified, false);
	assert.equal(rows[0].provider.id, 'a');
	assert.equal(rows[1].provider, null);
	assert.ok(rows.every((x) => x.limitations.some((line) => /No discovery\/contract\/runtime-tested certification/.test(line))));
});


test('real shipped adapters project into an uncertified compatibility view without manual support-table edits', () => {
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
	const providers = Object.fromEntries(rows.map((row) => [row.adapterId, row.provider?.id ?? null]));
	assert.deepEqual(providers, {
		'generic-grep': null,
		'java-spring': 'java-spring',
		'javascript-express': null,
		'python-fastapi': 'python-fastapi',
		'ruby-rails': null,
		'typescript-express': 'typescript-express',
	});
});

test('real handles providers keep resource.fetch as a provider-level requirement', () => {
	for (const provider of PROVIDERS) {
		assert.deepEqual(legacyProviderRequirements(provider), [
			{ capability: 'resource.fetch', acceptedStatuses: ['supported'] },
		], provider.id);
	}
});

test('real FastAPI remains blocked for contract emit until explicit OpenAPI evidence is supplied', () => {
	const fastapi = ADAPTERS.find((adapter) => adapter.id === 'python-fastapi');
	assert.ok(fastapi);
	assert.equal(fastapi.capabilities['api.operations'], false);
	assert.equal(evaluateLegacyCommandPolicy({ adapter: fastapi, command: 'contract emit' }).allowed, false);
	const external = externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidenceRef: 'test:immutable-openapi-artifact',
	});
	assert.equal(evaluateLegacyCommandPolicy({
		adapter: fastapi,
		command: 'contract emit',
		externalCapabilities: { 'api.operations': external },
	}).allowed, true);
});


test('policy diagnostics are structured and keep missing distinct from unsupported', () => {
	const missing = evaluateCapabilityPolicy({ policyId: 'x', requirements: [{ capability: 'api.security.enforced' }] });
	assert.deepEqual(policyDiagnostics(missing).map((x) => x.code), ['CAPABILITY_MISSING']);
	const unsupported = capabilityRecord({ name: 'api.security.enforced', status: 'unsupported', reason: 'no enforcement evidence' });
	const rejected = evaluateCapabilityPolicy({
		policyId: 'x',
		capabilities: { 'api.security.enforced': unsupported },
		requirements: [{ capability: 'api.security.enforced' }],
	});
	assert.deepEqual(policyDiagnostics(rejected).map((x) => x.code), ['CAPABILITY_STATUS_REJECTED']);
});

test('policy explain is deterministic and never turns a blocked result into advice to bypass evidence', () => {
	const result = evaluateCapabilityPolicy({ policyId: 'emit', requirements: [{ capability: 'api.operations' }] });
	const text = renderPolicyExplain(result);
	assert.match(text, /^policy emit: blocked/);
	assert.match(text, /CAPABILITY_MISSING/);
	assert.match(text, /api\.operations/);
	assert.doesNotMatch(text, /force|ignore|bypass/i);
});

test('allowed policy explain is compact and contains no fabricated evidence', () => {
	const cap = capabilityRecord({ name: 'api.routes', status: 'supported', evidenceRefs: ['fixture:routes'] });
	const result = evaluateCapabilityPolicy({ policyId: 'scan', capabilities: { 'api.routes': cap }, requirements: [{ capability: 'api.routes' }] });
	assert.equal(renderPolicyExplain(result), 'policy scan: allowed');
	assert.deepEqual(policyDiagnostics(result), []);
});


test('discovery certification also requires evidence', () => {
	assert.throws(() => certificationRecord({ targetId: 'x', level: 'discovery' }), /discovery certification requires evidenceRefs/);
});

test('waiver scope must match the failure subject exactly', () => {
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
});

test('waiver failure codes reject duplicates', () => {
	assert.throws(() => evaluateWaiver({
		failureCode: 'quality.low-recall',
		subject: 'target:a',
		now: '2026-09-25T00:00:00Z',
		waiver: {
			scope: 'target:a', reason: 'x', approver: 'reviewer',
			expiresAt: '2026-10-01T00:00:00Z',
			failureCodes: ['quality.low-recall', 'quality.low-recall'],
		},
	}), /must not contain duplicates/);
});
