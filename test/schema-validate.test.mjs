// S5 (D-persistence-integrity): lib/schema-validate.mjs is what closes the "9 schemas exist, none
// of the real persistence-boundary ones are ever loaded" gap -- these are direct unit tests of the
// validator itself (valid/invalid fixtures per schema), independent of any call site's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

test('state.schema.json: a minimal valid record passes, and the _repo sentinel feature_id is accepted', () => {
	const { ok } = validateAgainstSchema('state.schema.json', {
		schema: 'sbf.state/1', feature_id: '_repo', gates: {},
	});
	assert.equal(ok, true);
});

test('state.schema.json: a gate record with an unrecognized status ("not_run") is rejected -- that value is derived at read time, never written to disk', () => {
	const { ok, errors } = validateAgainstSchema('state.schema.json', {
		schema: 'sbf.state/1', feature_id: '001-widget-management',
		gates: { preflight: { status: 'not_run', token: `sha256:${'0'.repeat(64)}`, at: '2026-01-01T00:00:00.000Z' } },
	});
	assert.equal(ok, false);
	assert.ok(formatSchemaErrors(errors).some((e) => e.includes('status')));
});

test('scan-report.schema.json: a minimal valid report passes', () => {
	const { ok } = validateAgainstSchema('scan-report.schema.json', {
		schema: 'sbf.scan-report/1', terms: ['item'], adapter: 'java-spring', verdict: 'greenfield',
		related_modules: [], collisions: [], unknowns: [], files_read: [],
	});
	assert.equal(ok, true);
});

test('scan-report.schema.json: an unrecognized verdict is rejected', () => {
	const { ok } = validateAgainstSchema('scan-report.schema.json', {
		schema: 'sbf.scan-report/1', terms: [], adapter: 'java-spring', verdict: 'definitely-fine',
		related_modules: [], collisions: [], unknowns: [], files_read: [],
	});
	assert.equal(ok, false);
});

test('feature-contract.schema.json: a minimal valid contract passes', () => {
	const { ok } = validateAgainstSchema('feature-contract.schema.json', {
		sbf_contract: '7', feature_id: '001-widget-management', feature_uid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2',
		source: { adapter: 'java-spring', module: 'widgets', provenance: 'scan' },
		operations: {}, warnings: [], completeness: { status: 'complete', operation_count: 0, endpoint_count: 0 },
	});
	assert.equal(ok, true);
});

test('feature-contract.schema.json: a non-UUID feature_uid is rejected', () => {
	const { ok } = validateAgainstSchema('feature-contract.schema.json', {
		sbf_contract: '7', feature_id: '001-widget-management', feature_uid: 'not-a-uuid',
		source: { adapter: null, module: null, provenance: 'scan' },
		operations: {}, warnings: [], completeness: { status: 'complete', operation_count: 0, endpoint_count: 0 },
	});
	assert.equal(ok, false);
});

test('contract-resolution.schema.json: a minimal valid resolution passes', () => {
	const { ok } = validateAgainstSchema('contract-resolution.schema.json', {
		schema: 'sbf.contract-resolution/1', feature_id: '001-widget-management', waivers: [],
	});
	assert.equal(ok, true);
});

test('contract-resolution.schema.json: a waiver code not matching CONTRACT_* is rejected', () => {
	const { ok } = validateAgainstSchema('contract-resolution.schema.json', {
		schema: 'sbf.contract-resolution/1', feature_id: '001-widget-management',
		waivers: [{ code: 'SOMETHING_ELSE', subject: null, reason: 'because', at: '2026-01-01T00:00:00.000Z' }],
	});
	assert.equal(ok, false);
});

test('stack-record.schema.json: a minimal valid record passes', () => {
	const { ok } = validateAgainstSchema('stack-record.schema.json', {
		schema: 'sbf.stack/1', choice: 'ngrok', applied_files: ['.env.example'], env_example_keys: ['NGROK_AUTHTOKEN'], at: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(ok, true);
});

test('stack-record.schema.json: an applied_files entry that is not a string is rejected', () => {
	const { ok } = validateAgainstSchema('stack-record.schema.json', {
		schema: 'sbf.stack/1', choice: 'ngrok', applied_files: [42], env_example_keys: [], at: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(ok, false);
});

test('gate-event.schema.json: a minimal valid event passes', () => {
	const { ok } = validateAgainstSchema('gate-event.schema.json', {
		schema: 'sbf.gate-event/1', event: 'pass', gate: 'preflight', at: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(ok, true);
});

test('gate-event.schema.json: an unrecognized event type is rejected', () => {
	const { ok } = validateAgainstSchema('gate-event.schema.json', {
		schema: 'sbf.gate-event/1', event: 'stale', gate: 'preflight', at: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(ok, false);
});

test('feature.schema.json: a minimal valid feature record passes', () => {
	const { ok } = validateAgainstSchema('feature.schema.json', {
		schema: 'sbf.feature/1', feature_id: '001-widget-management', feature_uid: '11111111-1111-4111-8111-111111111111', created_at: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(ok, true);
});

test('feature.schema.json: archived_at with a non-UUID feature_uid is rejected', () => {
	const { ok } = validateAgainstSchema('feature.schema.json', {
		schema: 'sbf.feature/1', feature_id: '001-widget-management', feature_uid: 'not-a-uuid', created_at: '2026-01-01T00:00:00.000Z',
		archived_at: '2026-01-02T00:00:00.000Z', archived_reason: 'superseded',
	});
	assert.equal(ok, false);
});

test('feature-index.schema.json: by_uid with a multi-entry array (rename history) passes', () => {
	const { ok } = validateAgainstSchema('feature-index.schema.json', {
		schema: 'sbf.feature-index/1',
		by_uid: { '11111111-1111-4111-8111-111111111111': ['001-old-slug', '001-new-slug'] },
	});
	assert.equal(ok, true);
});

test('feature-index.schema.json: by_uid with an empty array is rejected (minItems: 1)', () => {
	const { ok } = validateAgainstSchema('feature-index.schema.json', {
		schema: 'sbf.feature-index/1',
		by_uid: { '11111111-1111-4111-8111-111111111111': [] },
	});
	assert.equal(ok, false);
});

test('feature-index.schema.json: merged_into is validated too', () => {
	const { ok } = validateAgainstSchema('feature-index.schema.json', {
		schema: 'sbf.feature-index/1',
		by_uid: {},
		merged_into: { '002-alias': 'not a valid feature id' },
	});
	assert.equal(ok, false);
});

test('patch-approvals.schema.json: a minimal valid approvals record passes', () => {
	const { ok } = validateAgainstSchema('patch-approvals.schema.json', {
		schema: 'sbf.patch-approvals/1', feature_id: '001-widget-management',
		approvals: [{ resource: 'Widget', field: 'label', strategy: 'patch-wrapper', reason: 'because', at: '2026-01-01T00:00:00.000Z' }],
	});
	assert.equal(ok, true);
});

test('patch-approvals.schema.json: a strategy outside {patch-wrapper, null-means-unchanged} is rejected (fetch-merge-submit/unsupported are never auto-generated)', () => {
	const { ok } = validateAgainstSchema('patch-approvals.schema.json', {
		schema: 'sbf.patch-approvals/1', feature_id: '001-widget-management',
		approvals: [{ resource: 'Widget', field: 'ownerName', strategy: 'fetch-merge-submit', reason: 'because', at: '2026-01-01T00:00:00.000Z' }],
	});
	assert.equal(ok, false);
});

test('formatSchemaErrors: renders ajv errors as "path message" strings, "(root)" when instancePath is empty', () => {
	const { errors } = validateAgainstSchema('state.schema.json', { schema: 'sbf.state/1' });
	const formatted = formatSchemaErrors(errors);
	assert.ok(formatted.length > 0);
	assert.ok(formatted.every((e) => typeof e === 'string'));
	assert.ok(formatted.some((e) => e.startsWith('(root)') || e.includes('feature_id') || e.includes('gates')));
});
