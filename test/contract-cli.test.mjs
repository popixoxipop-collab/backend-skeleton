// Full CLI flow for Phase 3, offline (no dependency on Team-IZ-Backend): preflight -> feature
// init -> scan -> disposition -> contract emit -> contract validate -> contract tool-schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// Unlike run(), captures stderr even on a successful (exit 0) run -- execFileSync only exposes
// stderr via its thrown error on non-zero exit, so a passing command that still writes an
// informational note to stderr (e.g. the "snapshot left as-is" note below) needs spawnSync
// instead, which always returns {stdout, stderr} regardless of exit code.
function runCapturingStderr(args, cwd) {
	const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// `includeDeleteWidget`/`includePatchWidget`/`includePutWidget` add mappings with an
// `@Operation(summary = ...)` but no `operationId` -- each becomes a CONTRACT_UNMATCHED_ENDPOINT
// warning. Matches the real Team-IZ-Backend shape (curriculum's controllers: every method has
// its own `@Operation(...)`, only some set `operationId`) rather than omitting `@Operation`
// entirely -- scanners/adapters/java-spring.mjs's operationId correlator walks backward to the
// NEAREST preceding `@Operation(` occurrence in the whole file, so a method with no `@Operation`
// annotation of its own incorrectly inherits an earlier method's operationId instead of
// correlating to null. Giving each method its own `@Operation(summary=...)` (no operationId)
// keeps that backward search landing on itself, correctly producing null. Kept as a standalone
// source-generator (not string-splicing an existing file) so test #19 (the "waiver invalidation"
// test) can regenerate the whole file with one more endpoint added, rather than doing fragile
// surgery on already-written Java source.
function widgetControllerSource({ includeDeleteWidget = false, includePatchWidget = false, includePutWidget = false } = {}) {
	const extra = [];
	if (includeDeleteWidget) extra.push(`
	@Operation(summary = "delete a widget")
	@DeleteMapping("/{widgetId}")
	public String deleteWidget(@PathVariable String widgetId) { return "ok"; }`);
	if (includePatchWidget) extra.push(`
	@Operation(summary = "patch a widget")
	@PatchMapping("/{widgetId}")
	public String patchWidget(@PathVariable String widgetId) { return "ok"; }`);
	if (includePutWidget) extra.push(`
	@Operation(summary = "replace a widget")
	@PutMapping("/{widgetId}")
	public String putWidget(@PathVariable String widgetId) { return "ok"; }`);
	return `
package com.example.domain.widget.presentation;

import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() { return "ok"; }

	@Operation(operationId = "createWidget")
	@PostMapping
	public String createWidget(@RequestBody Object request) { return "ok"; }

	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
${extra.join('\n')}
}
`;
}

function widgetControllerPath(root) {
	return path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation', 'WidgetController.java');
}

// `coverage: 'complete'` (default) -- 3/3 endpoints annotated, matches the pre-A5 fixture
// exactly. `coverage: 'partial'` adds 2 unannotated endpoints (DELETE, PATCH), producing
// completeness: partial with exactly 2 CONTRACT_UNMATCHED_ENDPOINT warnings.
function buildFixtureRepo({ coverage = 'complete' } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	fs.mkdirSync(path.dirname(widgetControllerPath(root)), { recursive: true });
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource({
		includeDeleteWidget: coverage === 'partial',
		includePatchWidget: coverage === 'partial',
	}));
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	// preflight requires a real "origin" to cross-check the default branch against.
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function initThroughScanDisposition(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
}

function contractSchemaPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.schema.json');
}

function contractResolutionPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.resolution.json');
}

function contractSnapshotPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.openapi.snapshot.json');
}

// Matches widgetControllerSource()'s endpoints, all under the real deployed `/api/v0` prefix --
// the exact shape the real Team-IZ-Backend defect looks like (ApiPathConfig.java's global
// addPathPrefix, invisible to source-annotation scanning).
function widgetOpenApiDoc({ includeDeleteWidget = false, includePatchWidget = false } = {}) {
	const paths = {
		'/api/v0/widgets': {
			get: { operationId: 'findWidgets' },
			post: { operationId: 'createWidget' },
		},
		'/api/v0/widgets/{widgetId}': {
			get: { operationId: 'findWidget' },
		},
	};
	if (includeDeleteWidget) paths['/api/v0/widgets/{widgetId}'].delete = { operationId: 'deleteWidget' };
	if (includePatchWidget) paths['/api/v0/widgets/{widgetId}'].patch = { operationId: 'patchWidget' };
	return { openapi: '3.1.0', info: { title: 'fixture', version: '1' }, paths };
}

function writeOpenApiFixture(root, doc) {
	const file = path.join(root, 'build', 'api-docs.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(doc));
	return file;
}

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
	// The new commit moved HEAD, which stales BOTH the preflight gate and the scan gate (their
	// tokens cover head_sha too) -- contract emit's upstream gate checks would otherwise block on
	// THOSE, not on completeness. Re-run the full upstream chain, same as the initial setup.
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
