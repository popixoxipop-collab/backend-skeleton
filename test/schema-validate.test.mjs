// S5 (D-persistence-integrity): lib/schema-validate.mjs is what closes the "9 schemas exist, none
// of the real persistence-boundary ones are ever loaded" gap -- these are direct unit tests of the
// validator itself (valid/invalid fixtures per schema), independent of any call site's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
		schema: 'sbf.scan-report/2', terms: ['item'], adapter: 'java-spring', verdict: 'greenfield',
		related_modules: [], collisions: [], unknowns: [], files_read: [],
	});
	assert.equal(ok, true);
});

test('scan-report.schema.json: an unrecognized verdict is rejected', () => {
	const { ok } = validateAgainstSchema('scan-report.schema.json', {
		schema: 'sbf.scan-report/2', terms: [], adapter: 'java-spring', verdict: 'definitely-fine',
		related_modules: [], collisions: [], unknowns: [], files_read: [],
	});
	assert.equal(ok, false);
});

// D-zero-config-scan: the new zero-terms "inventory" verdict is a real, accepted value -- and a
// related_modules entry with no `score` (the new shape that mode produces) is valid too, since
// `required` was relaxed from ["module", "score"] to ["module"].
test('scan-report.schema.json: verdict "inventory" is accepted, and a related_modules entry may omit score/evidence/capped_signals', () => {
	const { ok, errors } = validateAgainstSchema('scan-report.schema.json', {
		schema: 'sbf.scan-report/2', terms: [], adapter: 'java-spring', verdict: 'inventory', rg_available: true,
		related_modules: [{ module: 'widgets', controllers: [], entities: [], enums: [], dtos: [] }],
		collisions: [], unknowns: [], files_read: [],
	});
	assert.equal(ok, true, ok ? '' : JSON.stringify(errors));
});

test('feature-contract.schema.json: a minimal valid contract passes', () => {
	const { ok } = validateAgainstSchema('feature-contract.schema.json', {
		sbf_contract: '9', feature_id: '001-widget-management', feature_uid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2',
		source: { adapter: 'java-spring', module: 'widgets', provenance: 'scan' },
		operations: {}, warnings: [], completeness: { status: 'complete', operation_count: 0, endpoint_count: 0 },
	});
	assert.equal(ok, true);
});

test('feature-contract.schema.json: a non-UUID feature_uid is rejected', () => {
	const { ok } = validateAgainstSchema('feature-contract.schema.json', {
		sbf_contract: '8', feature_id: '001-widget-management', feature_uid: 'not-a-uuid',
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

test('oracle-manifest.schema.json: the committed pinned corpus validates, including every Wave A adapter entry', () => {
	const manifest = JSON.parse(fs.readFileSync(new URL('./fixtures/oracle-manifest.json', import.meta.url), 'utf8'));
	const { ok, errors } = validateAgainstSchema('oracle-manifest.schema.json', manifest);
	assert.equal(ok, true, formatSchemaErrors(errors).join('\n'));
});

test('oracle-manifest.schema.json: an adapter id outside the shipped registry enum is rejected', () => {
	const { ok } = validateAgainstSchema('oracle-manifest.schema.json', {
		contract: 'sbf.oracle-manifest/1',
		adapters: {
			'not-a-real-adapter': [{
				id: 'bad', owner: 'example', repo: 'example', ref: '0'.repeat(40),
				path: null, terms: ['x'], note: 'must fail schema validation',
			}],
		},
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

// D-java-source-splice (JS8): the pinned regression for the JSON Schema trap -- `rollback` is a
// SIBLING object (not a per-kind allOf/if-then branch), so `compile_after_rollback` had to be
// added to the BASE `rollback` object. This test pins that it validates for java-source-splice's
// own rollback record AND that pre-existing config-apply/ddl-apply rollback records (which never
// carry that field) still validate completely unchanged.
const MINIMAL_JAVA_SPLICE_TARGET = Object.freeze({
	file: 'src/main/java/com/example/Widget.java',
	source_root: 'src/main/java',
	line_terminator: '\n',
	edits: [{
		op: 'replace-field-initializer',
		locator: { type_fqn: 'com.example.Widget', member_kind: 'field', member_name: 'x' },
		replacement: '1',
		region_hash: 'a'.repeat(64),
		signature_hash: 'b'.repeat(64),
		located: { start: 0, end: 1, begin_line: 1, end_line: 1 },
	}],
});

function minimalPatchTransaction(kind, overrides = {}) {
	const base = {
		schema: 'sbf.patch-transaction/1',
		transaction_id: `pt-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
		feature_id: '001-widget-management',
		kind,
		status: 'proposed',
		created_at: '2026-01-01T00:00:00.000Z',
		preimage: { region_hash: 'x'.repeat(64), file_hash: 'y'.repeat(64) },
		proposed_value: 'x',
	};
	if (kind === 'config-apply') {
		return { ...base, source: { choice: 'ngrok' }, target: { file: 'a.yaml', key_path: ['a'] }, postcondition: { kind: 'regex-match', pattern: '.*' }, ...overrides };
	}
	if (kind === 'ddl-apply') {
		return { ...base, source: { database_url_env: 'DB', schema: 'public' }, target: { database_url_env: 'DB', schema: 'public', sql_text: 'CREATE TABLE t (id uuid);' }, postcondition: { kind: 'db-schema-diff', schema: 'public', expected_tables: [] }, ...overrides };
	}
	return { ...base, source: { request_file: 'splice.json' }, target: MINIMAL_JAVA_SPLICE_TARGET, postcondition: { kind: 'java-compiles', build_tool: 'gradle', build_command: './gradlew compileJava' }, ...overrides };
}

test('patch-transaction.schema.json: a minimal java-source-splice record validates', () => {
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', minimalPatchTransaction('java-source-splice'));
	assert.equal(ok, true, JSON.stringify(errors));
});

test('patch-transaction.schema.json: a pre-existing config-apply record (no compile_after_rollback) still validates unchanged after the java-source-splice schema addition', () => {
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', minimalPatchTransaction('config-apply', {
		status: 'rolled_back',
		rollback: { reason: 'because', at: '2026-01-01T00:00:00.000Z' },
	}));
	assert.equal(ok, true, JSON.stringify(errors));
});

test('patch-transaction.schema.json: a pre-existing ddl-apply record (no compile_after_rollback) still validates unchanged', () => {
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', minimalPatchTransaction('ddl-apply', {
		status: 'applied',
		apply: { at: '2026-01-01T00:00:00.000Z', postimage_schema_hash: 'z'.repeat(64), executed_statements: ['CREATE TABLE t (id uuid);'] },
	}));
	assert.equal(ok, true, JSON.stringify(errors));
});

test('patch-transaction.schema.json: a java-source-splice rollback record carrying compile_after_rollback validates (the JS8 trap, pinned)', () => {
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', minimalPatchTransaction('java-source-splice', {
		status: 'rolled_back',
		apply: { at: '2026-01-01T00:00:00.000Z', postimage_file_hash: 'z'.repeat(64), build_tool: 'gradle' },
		rollback: { reason: 'because', at: '2026-01-01T00:00:00.000Z', compile_after_rollback: 'ok' },
	}));
	assert.equal(ok, true, JSON.stringify(errors));
});

test('patch-transaction.schema.json: compile_after_rollback rejects a value outside "ok"/"failed"', () => {
	const { ok } = validateAgainstSchema('patch-transaction.schema.json', minimalPatchTransaction('java-source-splice', {
		status: 'rolled_back',
		apply: { at: '2026-01-01T00:00:00.000Z', postimage_file_hash: 'z'.repeat(64), build_tool: 'gradle' },
		rollback: { reason: 'because', at: '2026-01-01T00:00:00.000Z', compile_after_rollback: 'maybe' },
	}));
	assert.equal(ok, false);
});
