// Full CLI flow for Phase 3, offline (no dependency on Team-IZ-Backend): preflight -> feature
// init -> scan -> disposition -> contract emit -> contract validate -> contract tool-schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// A6: the harness below used to be defined inline here; it now lives in test/_contract-fixture.mjs
// so test/contract-export.test.mjs can drive the identical fixture instead of growing a second
// copy. Nothing about it changed in the move -- every test in this file is unmodified.
import {
	run, runCapturingStderr, widgetControllerSource, widgetControllerPath, buildFixtureRepo,
	initThroughScanDisposition, contractSchemaPath, contractResolutionPath, contractSnapshotPath,
	widgetOpenApiDoc, writeOpenApiFixture,
} from './_contract-fixture.mjs';

test('feature init -> scan -> disposition -> contract emit -> validate -> tool-schema, full flow', () => {
	const root = buildFixtureRepo();

	assert.equal(run(['preflight'], root).code, 0);

	const init = run(['feature', 'init', '--slug', 'widget-management'], root);
	assert.equal(init.code, 0);
	const featureRecord = JSON.parse(init.stdout);
	assert.equal(featureRecord.feature_id, '001-widget-management');
	assert.match(featureRecord.feature_uid, /^[0-9a-f-]{36}$/);

	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const contract = JSON.parse(emit.stdout);
	assert.equal(contract.operations.createWidget.body, true);
	assert.equal(contract.operations.findWidgets.body, false);
	assert.deepEqual(contract.operations.findWidget.pathParams.required, ['widgetId']);
	assert.equal(contract.completeness.status, 'complete');
	assert.equal(contract.warnings.length, 0);

	const envelopePath = path.join(root, 'envelope.json');
	fs.writeFileSync(envelopePath, JSON.stringify({
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureRecord.feature_uid,
		operation_id: 'createWidget', direction: 'request', payload: { pathParams: {}, body: { name: 'x' } },
	}));
	const validate = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(validate.code, 0);
	assert.equal(JSON.parse(validate.stdout).ok, true);

	const toolSchema = run(['contract', 'tool-schema', '--feature', '001-widget-management', '--operation', 'createWidget'], root);
	assert.equal(toolSchema.code, 0);
	assert.equal(JSON.parse(toolSchema.stdout).name, 'createWidget');
});

test('contract emit is blocked before preflight has run', () => {
	const root = buildFixtureRepo();
	const emit = run(['contract', 'emit', '--feature', '001-whatever'], root);
	assert.equal(emit.code, 2); // preflight gate: not_run
});

test('feature init requires preflight to have passed', () => {
	const root = buildFixtureRepo();
	const init = run(['feature', 'init', '--slug', 'x'], root);
	assert.equal(init.code, 2);
});

test('contract emit is blocked while the scan gate is awaiting_disposition', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	const emit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 3);
});

test('feature init auto-increments the NNN- prefix across multiple features', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const first = JSON.parse(run(['feature', 'init', '--slug', 'alpha'], root).stdout);
	const second = JSON.parse(run(['feature', 'init', '--slug', 'beta'], root).stdout);
	assert.equal(first.feature_id, '001-alpha');
	assert.equal(second.feature_id, '002-beta');
});

// A5 regression suite below. `coverage: 'partial'` fixture: 3 annotated endpoints (operations)
// + 2 unannotated (DELETE /widgets/{widgetId}, PATCH /widgets/{widgetId} -- both
// CONTRACT_UNMATCHED_ENDPOINT).

test('contract emit with a partial fixture blocks with exit 3, still writes the contract, and prints waive commands', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);

	const emit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 3);
	assert.match(emit.stderr, /bskel contract waive --feature 001-widget-management --code CONTRACT_UNMATCHED_ENDPOINT --subject "DELETE \/widgets\/\{widgetId\}"/);
	assert.match(emit.stderr, /or all 2 at once: bskel contract waive --feature 001-widget-management --code CONTRACT_UNMATCHED_ENDPOINT --all/);

	assert.ok(fs.existsSync(contractSchemaPath(root)), 'the contract file must still be written even when blocked');
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(contract.completeness.status, 'partial');
	assert.equal(contract.warnings.filter((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT').length, 2);
});

test('a blocked contract gate propagates downstream: gate require contract also exits 3', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const requireResult = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(requireResult.code, 3);
});

test('contract waive resolves a partial contract: gate passes, resolution gets 1 entry, verify passes', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const waive = run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'out of scope for this feature'], root);
	assert.equal(waive.code, 3, 'DELETE waived but PATCH still unwaived -- still blocked');

	const resolution = JSON.parse(fs.readFileSync(contractResolutionPath(root), 'utf8'));
	assert.equal(resolution.waivers.length, 1);
	assert.equal(resolution.waivers[0].subject, 'DELETE /widgets/{widgetId}');

	const waiveSecond = run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'PATCH /widgets/{widgetId}', '--reason', 'out of scope for this feature'], root);
	assert.equal(waiveSecond.code, 0);

	const verify = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(JSON.parse(verify.stdout).pass, true);
});

test('waiving a subject that does not exist in the current contract fails, and writes no resolution file', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const waive = run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'GET /does-not-exist', '--reason', 'x'], root);
	assert.equal(waive.code, 14);
	assert.ok(!fs.existsSync(contractResolutionPath(root)));
});

test('waiving an unknown warning code fails with the known code list', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const waive = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_TYPO', '--all', '--reason', 'x'], root);
	assert.equal(waive.code, 14);
	assert.match(waive.stderr, /unknown contract warning code "CONTRACT_TYPO"/);
});

test('contract waive requires either --subject or --all', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const waive = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--reason', 'x'], root);
	assert.equal(waive.code, 14);
});

test('--all expands to individual resolution entries, not a wildcard', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const waive = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'accepted for now'], root);
	assert.equal(waive.code, 0);

	const resolution = JSON.parse(fs.readFileSync(contractResolutionPath(root), 'utf8'));
	assert.equal(resolution.waivers.length, 2, '--all must expand to one entry per current occurrence, not a single wildcard entry');
	const subjects = resolution.waivers.map((w) => w.subject).sort();
	assert.deepEqual(subjects, ['DELETE /widgets/{widgetId}', 'PATCH /widgets/{widgetId}']);
});

test('re-emitting after a waive does not change the resolution file (waiver is not re-derived from the artifact)', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'x'], root);

	const before = fs.readFileSync(contractResolutionPath(root), 'utf8');
	const reEmit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(reEmit.code, 0);
	const after = fs.readFileSync(contractResolutionPath(root), 'utf8');
	assert.equal(before, after);
});

// The most important test in this file: a waiver must never behave like a blanket "ignore this
// code forever" switch. Waiving the two CURRENT unmatched endpoints, then adding a THIRD one
// later, must leave the third one unwaived and blocking -- proving --all recorded specific
// subjects, not the code in general.
test('waiving all current unmatched endpoints does not cover a new one added later', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	const waiveAll = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'accepted for now'], root);
	assert.equal(waiveAll.code, 0);
	assert.equal(JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout).pass, true);

	// Regenerate the controller with a THIRD unannotated endpoint and commit it -- must commit,
	// not just write, or the dirty working tree blocks preflight re-verification (same pitfall
	// test/verify-cli.test.mjs's gradlew fixture already documents).
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource({
		includeDeleteWidget: true, includePatchWidget: true, includePutWidget: true,
	}));
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'add another unannotated endpoint'], { cwd: root });
	// The new commit moved HEAD (stales preflight) AND edited the widget module's own controller
	// (stales scan -- S2, D-gate-precision continued: scan's token now hashes its own real
	// per-file read-set, not head_sha, but this edit is squarely inside that read-set) --
	// contract emit's upstream gate checks would otherwise block on THOSE, not on completeness.
	// Re-run the full upstream chain, same as the initial setup.
	assert.equal(run(['preflight'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);

	const reEmit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(reEmit.code, 3, 'the new unannotated endpoint must not be silently covered by the old --all waive');
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	const putWarning = contract.warnings.find((w) => w.subject === 'PUT /widgets/{widgetId}');
	assert.ok(putWarning, 'must generate a fresh warning for the newly-added endpoint');
	assert.equal(JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout).pass, false);
});

test('a blocked (zero-operation) contract cannot be waived, but gate force remains an escape hatch', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--module', 'nonexistent-module'], root);
	assert.equal(emit.code, 3);
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(contract.completeness.status, 'blocked');

	const waive = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_EMPTY', '--all', '--reason', 'x'], root);
	assert.equal(waive.code, 14);

	const force = run(['gate', 'force', 'contract', '--feature', '001-widget-management', '--reason', 'escape hatch test'], root);
	assert.equal(force.code, 0);
	assert.equal(JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout).pass, true);
});

// A1 regression suite below.

test('--openapi-file corrects every path to the real deployed prefix and writes a snapshot', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(emit.code, 0);
	assert.match(emit.stdout, /openapi: 3 path\(s\) corrected/);

	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	for (const op of Object.values(contract.operations)) {
		assert.ok(op.path.startsWith('/api/v0/'), `expected /api/v0/ prefix, got "${op.path}"`);
		assert.equal(op.provenance, 'scan+openapi');
	}
	assert.ok(fs.existsSync(contractSnapshotPath(root)));
	const snapshot = JSON.parse(fs.readFileSync(contractSnapshotPath(root), 'utf8'));
	assert.equal(snapshot.path_prefix.value, '/api/v0');
	assert.equal(snapshot.stats.matched, 3);
});

test('partial fixture: OpenAPI recovers the unmatched endpoints (adopted), no waive needed', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ includeDeleteWidget: true, includePatchWidget: true }));

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(emit.code, 0, 'no waive should be needed -- both previously-unmatched endpoints are adopted');
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(contract.completeness.status, 'complete');
	assert.equal(Object.keys(contract.operations).length, 5);
	assert.equal(contract.operations.deleteWidget.provenance, 'openapi');
	assert.equal(contract.operations.patchWidget.provenance, 'openapi');
});

test('a nonexistent --openapi-file, broken JSON, and an invalid --path-prefix all exit 14 without writing a contract or touching the gate', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);

	const missing = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', path.join(root, 'does-not-exist.json')], root);
	assert.equal(missing.code, 14);
	assert.ok(!fs.existsSync(contractSchemaPath(root)));

	const brokenFile = path.join(root, 'broken.json');
	fs.writeFileSync(brokenFile, '{not valid json');
	const broken = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', brokenFile], root);
	assert.equal(broken.code, 14);
	assert.ok(!fs.existsSync(contractSchemaPath(root)));

	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());
	const badPrefix = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--path-prefix', '/api/{v}'], root);
	assert.equal(badPrefix.code, 14);
	assert.ok(!fs.existsSync(contractSchemaPath(root)));

	const gateShow = run(['gate', 'show', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(gateShow.code, 0);
	assert.equal(JSON.parse(gateShow.stdout).record, null, 'the contract gate must never have been touched by any of the three failed emits above');
});

test('gate token: deleting the openapi snapshot after a corrected emit makes contract stale; restoring it passes again', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	const backup = fs.readFileSync(contractSnapshotPath(root), 'utf8');
	fs.rmSync(contractSnapshotPath(root));
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 4, 'deleting the snapshot must stale the gate');

	fs.writeFileSync(contractSnapshotPath(root), backup);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);
});

test('re-emitting without --openapi-file after a corrected emit leaves an existing snapshot untouched, with only a stderr note', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	const before = fs.readFileSync(contractSnapshotPath(root), 'utf8');

	const reEmit = runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(reEmit.code, 0);
	assert.match(reEmit.stderr, /snapshot from a previous run exists/);
	const after = fs.readFileSync(contractSnapshotPath(root), 'utf8');
	assert.equal(before, after, 'the snapshot must not be rewritten or deleted when --openapi-file is omitted');
});

test('re-emitting with the same OpenAPI document is idempotent in outcome (same prefix, same match counts, gate stays pass)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());

	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	const second = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(second.code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);
	const snapshot = JSON.parse(fs.readFileSync(contractSnapshotPath(root), 'utf8'));
	assert.equal(snapshot.stats.matched, 3);
	assert.equal(snapshot.path_prefix.value, '/api/v0');
});

// D-security-1-shaped regression, A1's added reachability: an operationId can now be adopted
// directly from an external OpenAPI document, not just from Java source under the repo owner's
// control -- confirms tool-schema's Object.hasOwn fix still rejects a prototype-chain lookup.
test('contract tool-schema --operation constructor is rejected, not resolved via the prototype chain', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	const result = run(['contract', 'tool-schema', '--feature', '001-widget-management', '--operation', 'constructor'], root);
	assert.equal(result.code, 2);
});

// A2 regression suite below: request body JSON Schema projection, full CLI flow.

test('--openapi-file with request bodies: requestBodySchema reflects the real DTO shape, bodyless ops get no such key', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true }));

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0);
	const contract = JSON.parse(emit.stdout);
	assert.equal(contract.operations.createWidget.requestBodySchema.properties.name.maxLength, 10);
	assert.deepEqual(contract.operations.createWidget.requestBodySchema.required, ['name']);
	assert.equal('requestBodySchema' in contract.operations.findWidgets, false);
});

test('contract validate rejects a body exceeding maxLength (exit 1), accepts a valid one (exit 0)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true }));
	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const envelopePath = path.join(root, 'envelope.json');
	const baseEnvelope = { sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'request' };

	fs.writeFileSync(envelopePath, JSON.stringify({ ...baseEnvelope, payload: { pathParams: {}, body: { name: 'x'.repeat(50) } } }));
	const tooLong = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(tooLong.code, 1);
	assert.equal(JSON.parse(tooLong.stdout).ok, false);

	fs.writeFileSync(envelopePath, JSON.stringify({ ...baseEnvelope, payload: { pathParams: {}, body: { name: 'x' } } }));
	const ok = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(ok.code, 0);
	assert.equal(JSON.parse(ok.stdout).ok, true);
});

test('contract validate rejects a body missing a required field -- the identical envelope passes against a contract emitted WITHOUT --openapi-file', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	const envelopePath = path.join(root, 'envelope.json');
	const envelope = {
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'request',
		payload: { pathParams: {}, body: {} }, // missing required "name"
	};
	fs.writeFileSync(envelopePath, JSON.stringify(envelope));

	// Without --openapi-file: pre-A2 shallow {type:'object'} check -- an empty body passes.
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	const withoutSchema = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(withoutSchema.code, 0);
	assert.equal(JSON.parse(withoutSchema.stdout).ok, true);

	// With --openapi-file: the same envelope now fails, because the real DTO requires "name".
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	const withSchema = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(withSchema.code, 1);
	assert.equal(JSON.parse(withSchema.stdout).ok, false);
});

test('contract tool-schema exposes the real field shape, with zero $ref anywhere in the output', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const toolSchema = run(['contract', 'tool-schema', '--feature', '001-widget-management', '--operation', 'createWidget'], root);
	assert.equal(toolSchema.code, 0);
	const parsed = JSON.parse(toolSchema.stdout);
	assert.equal(parsed.input_schema.properties.body.properties.name.maxLength, 10);
	assert.equal(toolSchema.stdout.includes('$ref'), false);
});

test('an unsupported schema keyword: emit still exits 0 (WARN only), one CONTRACT_OPENAPI_SCHEMA_UNRESOLVED, and validate still accepts a plain object body', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true, unsupportedSchema: true }));

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0, 'a schema-projection failure must never block completeness');
	const contract = JSON.parse(emit.stdout);
	assert.equal('requestBodySchema' in contract.operations.createWidget, false);
	const unresolved = contract.warnings.filter((w) => w.code === 'CONTRACT_OPENAPI_SCHEMA_UNRESOLVED');
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].severity, 'warn');

	const gateShow = run(['gate', 'show', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(JSON.parse(gateShow.stdout).record.evidence.openapi.schema_unresolved, 1);

	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	const envelopePath = path.join(root, 'envelope.json');
	fs.writeFileSync(envelopePath, JSON.stringify({
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'request',
		payload: { pathParams: {}, body: { anything: 'goes' } },
	}));
	const validate = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(validate.code, 0, 'falls back to the pre-A2 bare-object check when the schema could not be projected');
});

test('gate token: hand-editing requestBodySchema in the contract file (without touching the snapshot) stales the gate; contract_hash alone covers it, no new token key', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	const inputs = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(JSON.parse(inputs.stdout).record.evidence.openapi.schema_projection.enabled, true);

	const contractPath = contractSchemaPath(root);
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	contract.operations.createWidget.requestBodySchema.properties.name.maxLength = 999999;
	fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 4, 'hand-editing the contract file must stale the gate -- contract_hash covers the new fields directly, no dedicated token key needed for them');

	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);
});

test('an OpenAPI 3.0 document: emit exits 0, zero CONTRACT_OPENAPI_SCHEMA_UNRESOLVED warnings, one stderr note, schema_projection.enabled is false', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true, openapiVersion: '3.0.1' }));

	const emit = runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0);
	const contract = JSON.parse(emit.stdout);
	assert.equal(contract.warnings.filter((w) => w.code === 'CONTRACT_OPENAPI_SCHEMA_UNRESOLVED').length, 0);
	assert.match(emit.stderr, /declares version "3\.0\.1"/);

	const gateShow = run(['gate', 'show', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(JSON.parse(gateShow.stdout).record.evidence.openapi.schema_projection.enabled, false);
});

// A3 regression suite below: response/error JSON Schema projection, full CLI flow.

test('--openapi-file with responses: responseSchema/errorSchema reflect the real DTO shapes, an operation with no documented responses gets neither key', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0);
	const contract = JSON.parse(emit.stdout);
	assert.equal(contract.operations.createWidget.responseSchema.required[0], 'id');
	assert.equal(contract.operations.createWidget.errorSchema.required[0], 'code');
	assert.equal('responseSchema' in contract.operations.findWidgets, false);
	assert.equal('errorSchema' in contract.operations.findWidgets, false);
});

test('contract validate, direction:"response": a body missing a required field exits 1, a valid one exits 0', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const envelopePath = path.join(root, 'envelope.json');
	const base = { sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'response' };

	fs.writeFileSync(envelopePath, JSON.stringify({ ...base, payload: { body: {} } }));
	const missing = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(missing.code, 1);
	assert.equal(JSON.parse(missing.stdout).ok, false);

	fs.writeFileSync(envelopePath, JSON.stringify({ ...base, payload: { body: { id: 'w-1' } } }));
	const ok = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(ok.code, 0);
	assert.equal(JSON.parse(ok.stdout).ok, true);
});

test('the identical response envelope passes against a contract emitted WITHOUT --openapi-file (before/after contrast)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	const envelopePath = path.join(root, 'envelope.json');
	const envelope = {
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'response',
		payload: { body: {} }, // missing "id" -- would fail once a responseSchema is projected
	};
	fs.writeFileSync(envelopePath, JSON.stringify(envelope));

	run(['contract', 'emit', '--feature', '001-widget-management'], root); // no --openapi-file
	const withoutSchema = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(withoutSchema.code, 0);
	assert.equal(JSON.parse(withoutSchema.stdout).ok, true);

	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	const withSchema = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(withSchema.code, 1);
	assert.equal(JSON.parse(withSchema.stdout).ok, false);
});

test('contract validate, direction:"error": an ErrorResponse-shaped body passes, one missing "code" exits 1', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const envelopePath = path.join(root, 'envelope.json');
	const base = { sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'error' };

	fs.writeFileSync(envelopePath, JSON.stringify({ ...base, payload: { body: { code: 'WIDGET_NOT_FOUND' } } }));
	const ok = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(ok.code, 0);
	assert.equal(JSON.parse(ok.stdout).ok, true);

	fs.writeFileSync(envelopePath, JSON.stringify({ ...base, payload: { body: {} } }));
	const missing = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(missing.code, 1);
	assert.equal(JSON.parse(missing.stdout).ok, false);
});

test('an unsupported response schema: emit still exits 0 (WARN only), one CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED, evidence reflects it, and validate still accepts anything for that direction', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true, unsupportedResponseSchema: true }));

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0, 'a schema-projection failure must never block completeness');
	const contract = JSON.parse(emit.stdout);
	assert.equal('responseSchema' in contract.operations.createWidget, false);
	assert.equal(contract.operations.createWidget.errorSchema.required[0], 'code', 'error projection is unaffected by the response-side failure');
	const unresolved = contract.warnings.filter((w) => w.code === 'CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED');
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].severity, 'warn');

	const gateShow = run(['gate', 'show', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(JSON.parse(gateShow.stdout).record.evidence.openapi.response_schema_unresolved, 1);

	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	const envelopePath = path.join(root, 'envelope.json');
	fs.writeFileSync(envelopePath, JSON.stringify({
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'response',
		payload: { anything: 'goes -- unconstrained fallback' },
	}));
	const validate = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(validate.code, 0, 'falls back to unconstrained when the schema could not be projected');
});

test('gate token: hand-editing responseSchema in the contract file stales the gate; re-emitting restores it -- no new token key needed', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	const contractPath = contractSchemaPath(root);
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	contract.operations.createWidget.responseSchema.properties.id.type = 'integer';
	fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 4, 'hand-editing the contract file must stale the gate -- contract_hash covers responseSchema directly');

	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);
});

test('snapshot markers: response_schema and error_schema both record "resolved"', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const snapshot = JSON.parse(fs.readFileSync(contractSnapshotPath(root), 'utf8'));
	assert.equal(snapshot.operations.createWidget.response_schema, 'resolved');
	assert.equal(snapshot.operations.createWidget.error_schema, 'resolved');
});

// A3 real-world find: `contract emit --json` writing a large contract to a PIPE (not a file or a
// TTY) could be truncated -- process.exit() was called immediately after console.log(), and Node
// does not guarantee a large async pipe write completes before a forced exit. Found live during
// Team-IZ-Backend verification: organization's real contract (>64KB once response/error schemas
// are projected) came back truncated at exactly 65536 bytes when captured via a subshell, while
// the identical command redirected to a file wrote its full, correct length. Fixed by setting
// process.exitCode instead of calling process.exit() in cmdContractEmit. This fixture
// synthesizes a >64KB contract without needing many endpoints -- one operation with 400
// long-`pattern` properties is enough to cross the boundary reliably.
test('regression: a >64KB --json contract output is not truncated when captured via execFileSync (pipe-buffer-sized cutoff bug)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	const bigProperties = {};
	for (let i = 0; i < 400; i++) {
		bigProperties[`field${i}`] = { type: 'string', pattern: `^${'a'.repeat(280)}$` };
	}
	doc.components.schemas.WidgetResponse = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...bigProperties } };
	const docFile = writeOpenApiFixture(root, doc);

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile, '--json'], root);
	assert.equal(emit.code, 0);
	assert.ok(emit.stdout.length > 65536, `fixture must actually exceed the 64KB boundary that exposed the bug (got ${emit.stdout.length} bytes)`);
	assert.doesNotThrow(() => JSON.parse(emit.stdout), 'output must be complete, valid JSON -- not truncated mid-write');
	const contract = JSON.parse(emit.stdout);
	assert.equal(Object.keys(contract.operations.createWidget.responseSchema.properties).length, 401);
});

// Process-exit audit (post-A3): the same pipe-truncation bug class in cmdContractEmit also lived
// in cmdContractValidate -- a validation failure against a schema-rich contract can produce a
// very large ajv `errors` array under allErrors:true. Reproduced live during Team-IZ-Backend
// verification: 5000 wrong-typed array elements against the real registerTrainees contract
// produced a correct 243926-byte result that a piped capture truncated at exactly 65536 bytes.
// Fixed by setting process.exitCode instead of calling process.exit() in cmdContractValidate.
// This fixture forces the same ajv allErrors blowup with a synthetic array-typed request field.
test('regression: a >64KB contract-validate error output is not truncated when captured via execFileSync (pipe-buffer-sized cutoff bug)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withRequestBodies: true });
	doc.components.schemas.CreateWidgetRequest = {
		type: 'object',
		required: ['name', 'tags'],
		properties: {
			name: { type: 'string' },
			tags: { type: 'array', items: { type: 'string' } },
		},
	};
	const docFile = writeOpenApiFixture(root, doc);
	run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docFile], root);

	const featureUid = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/feature.json'), 'utf8')).feature_uid;
	const envelopePath = path.join(root, 'envelope.json');
	const badTags = Array.from({ length: 5000 }, (_, i) => i); // wrong type: number, not string -- one ajv error per element
	fs.writeFileSync(envelopePath, JSON.stringify({
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureUid, operation_id: 'createWidget', direction: 'request',
		payload: { pathParams: {}, body: { name: 'x', tags: badTags } },
	}));

	const validate = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(validate.code, 1);
	assert.ok(validate.stdout.length > 65536, `fixture must actually exceed the 64KB boundary that exposed the bug (got ${validate.stdout.length} bytes)`);
	assert.doesNotThrow(() => JSON.parse(validate.stdout), 'output must be complete, valid JSON -- not truncated mid-write');
	const result = JSON.parse(validate.stdout);
	assert.equal(result.ok, false);
	assert.equal(result.errors.length, 5000);
});

// S2 (D-gate-precision, part 2): a two-module fixture, self-contained (not buildFixtureRepo(),
// which only ever has one controller) -- `--terms widget,other` makes BOTH modules score > 0 so
// both land in related_modules, a real disposition choice between two real candidates, not a
// synthetic one.
function otherControllerSource() {
	return `
package com.example.domain.other.presentation;

import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;

@RestController
@RequestMapping(value = "/others")
public class OtherController {

	@Operation(operationId = "findOthers")
	@GetMapping
	public String findOthers() { return "ok"; }
}
`;
}

function buildTwoModuleFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-two-module-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	fs.mkdirSync(path.dirname(widgetControllerPath(root)), { recursive: true });
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource());
	const otherControllerPath = path.join(root, 'src/main/java/com/example/domain/other/presentation/OtherController.java');
	fs.mkdirSync(path.dirname(otherControllerPath), { recursive: true });
	fs.writeFileSync(otherControllerPath, otherControllerSource());

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: two-module fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-two-module-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return { root, otherControllerPath };
}

test('scan disposition --module <name> persists the choice, and rejects an unknown module naming the real ones', () => {
	const { root } = buildTwoModuleFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget,other'], root);

	const unknown = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--module', 'does-not-exist', '--note', 'x'], root);
	assert.equal(unknown.code, 14);
	assert.match(unknown.stderr, /is not one of this scan report's related_modules.*known modules:.*widget/);

	const ok = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--module', 'other', '--note', 'x'], root);
	assert.equal(ok.code, 0);
	const report = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/brownfield-scan.json'), 'utf8'));
	assert.equal(report.disposition.module, 'other');
});

test('scan disposition with no --module defaults to the same module selectModule() would also pick', () => {
	const { root } = buildTwoModuleFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget,other'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);

	const report = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/brownfield-scan.json'), 'utf8'));
	assert.equal(report.disposition.module, report.related_modules[0].module, 'must match selectModule()\'s own default: the top-scored module');
});

// S2 (D-gate-precision, part 2): the actual narrowing proof -- editing a file belonging to a
// DIFFERENT module that was ALSO scanned and ALSO scored (a real disposition candidate, not
// merely unmatched-and-therefore-trivially-excluded) must not stale `contract` for the feature
// disposed onto the OTHER module. Confirmed against the OLD (head_sha) design this would have
// failed: any commit anywhere staled every feature's contract gate.
test('editing a different (non-disposed) module\'s controller does not stale the contract gate', () => {
	const { root, otherControllerPath } = buildTwoModuleFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget,other'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--module', 'widget', '--note', 'x'], root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	fs.appendFileSync(otherControllerPath, '\n// uncommitted edit to a DIFFERENT module\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'edit other module'], { cwd: root });

	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0, 'a committed edit to a module this feature did NOT dispose onto must not stale contract');
});

// The flip side: editing the DISPOSED module's own controller (uncommitted) DOES stale contract,
// naming the module_file: key -- proves the narrowing is real tracking, not just "never stales".
test('editing the disposed module\'s own controller stales the contract gate, naming the module_file key', () => {
	const { root } = buildTwoModuleFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget,other'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--module', 'widget', '--note', 'x'], root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	fs.appendFileSync(widgetControllerPath(root), '\n// uncommitted edit to the DISPOSED module\n');

	const stale = run(['gate', 'require', 'contract', '--feature', '001-widget-management', '--json'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.ok(record.changed_inputs.some((k) => k.startsWith('module_file:') && k.includes('WidgetController.java')));
});

// An unrelated commit (nothing in either module) must not stale contract either -- the other
// half of the same narrowing.
test('an unrelated commit does not stale the contract gate', () => {
	const { root } = buildTwoModuleFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget,other'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--module', 'widget', '--note', 'x'], root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	fs.writeFileSync(path.join(root, 'README.md'), '# unrelated\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'docs: unrelated'], { cwd: root });

	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);
});
