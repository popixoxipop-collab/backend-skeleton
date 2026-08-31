// D-runtime-conformance-receipts: end-to-end CLI coverage for `bskel observe import`. Fixture
// copied from test/observe-emit-cli.test.mjs's own conventions. Receipts are constructed by hand
// here (not produced by a real running Java app -- that's covered by the javac syntax check + CI's
// real compile/integration jobs) since this file's own job is the IMPORT side's own logic: noise
// vs. corruption handling, feature-identity rejection, contract_ref bucketing, report/gate output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-import-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const base = 'com/example';
	const widgetDomain = path.join(root, 'src/main/java', base, 'domain/widget');
	fs.mkdirSync(path.join(widgetDomain, 'presentation'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'domain'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'application'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src/main/java', base), { recursive: true });

	fs.writeFileSync(path.join(root, 'src/main/java', base, 'ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.security.access.prepost.PreAuthorize;

@PreAuthorize("hasRole('SUPER_ADMIN')")
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);
	fs.writeFileSync(path.join(widgetDomain, 'domain', 'Widget.java'), `
package com.example.domain.widget.domain;
import jakarta.persistence.*;
@Entity
@Table(name = "widget")
public class Widget {
	@Id
	private java.util.UUID widgetId;
}
`);
	fs.writeFileSync(path.join(widgetDomain, 'application', 'WidgetService.java'), `
package com.example.domain.widget.application;
public interface WidgetService {
	Object findWidget(java.util.UUID id);
}
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-import-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

const FEATURE_ID = '001-widget-management';

function runWorkflowThroughContract(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', FEATURE_ID, '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', FEATURE_ID], root);
}

function contractHash(root) {
	const content = fs.readFileSync(path.join(root, 'specs', FEATURE_ID, 'contracts', `${FEATURE_ID}.schema.json`), 'utf8');
	return createHash('sha256').update(content).digest('hex');
}

function featureUid(root) {
	const contract = JSON.parse(fs.readFileSync(path.join(root, 'specs', FEATURE_ID, 'contracts', `${FEATURE_ID}.schema.json`), 'utf8'));
	return contract.feature_uid;
}

function makeReceipt(root, overrides = {}) {
	return {
		feature_id: FEATURE_ID,
		feature_uid: featureUid(root),
		operation_id: 'findWidget',
		contract_ref: contractHash(root),
		verb: 'GET',
		status: 200,
		recorded_at: new Date().toISOString(),
		violations: [],
		...overrides,
	};
}

function writeReceipts(root, lines) {
	const receiptsPath = path.join(root, 'receipts.jsonl');
	fs.writeFileSync(receiptsPath, `${lines.join('\n')}\n`);
	return receiptsPath;
}

test('observe import is blocked before the contract gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const receiptsPath = writeReceipts(root, [JSON.stringify({ feature_id: FEATURE_ID, feature_uid: '00000000-0000-0000-0000-000000000000', operation_id: 'findWidget', contract_ref: 'x', verb: 'GET', recorded_at: new Date().toISOString(), violations: [] })]);
	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath], root);
	assert.equal(result.code, 2);
});

test('observe import fails cleanly when --receipts points at a nonexistent file', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', path.join(root, 'nope.jsonl')], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /no readable file/);
});

test('a well-formed receipts file is imported: report written, counts match, conformance gate passes', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root)),
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'does not match the required pattern' }] })),
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.report.counts.receipt_lines, 2);
	assert.equal(body.report.counts.matched, 2);
	assert.equal(body.report.counts.stale_contract_ref, 0);
	assert.equal(body.report.counts.violations, 1);
	assert.equal(body.report.counts.noise_lines, 0);
	assert.equal(body.gate.status, 'pass');

	const reportPath = path.join(root, 'specs', FEATURE_ID, 'observe', `${FEATURE_ID}.conformance-report.json`);
	assert.ok(fs.existsSync(reportPath));
	const persisted = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	assert.equal(persisted.counts.matched, 2);

	const gateResult = run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root);
	assert.equal(gateResult.code, 0);
});

test('non-JSON lines are counted as noise and do not fail the import -- a log pipeline is not perfectly scoped to just the receipts logger', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		'2026-08-29 12:00:00 INFO some unrelated log line',
		JSON.stringify(makeReceipt(root)),
		'not json either',
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.report.counts.noise_lines, 2);
	assert.equal(body.report.counts.receipt_lines, 1);
});

test('a line that IS valid JSON but fails the receipt schema is real corruption -- aborts the whole import, writes nothing', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root)),
		JSON.stringify({ feature_id: FEATURE_ID }), // missing every other required field
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /not a valid receipt/);
	assert.ok(!fs.existsSync(path.join(root, 'specs', FEATURE_ID, 'observe')), 'a corrupted receipts file must not partially land');
	assert.equal(run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root).code, 2, 'the conformance gate must still read as not-run');
});

test('a receipt for the WRONG feature aborts the whole import, never partially lands', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root)),
		JSON.stringify(makeReceipt(root, { feature_id: '002-other-feature', feature_uid: '11111111-1111-1111-1111-111111111111' })),
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /is for feature "002-other-feature"/);
	assert.ok(!fs.existsSync(path.join(root, 'specs', FEATURE_ID, 'observe')));
});

test('a receipt whose contract_ref is stale (from before the last re-emit) is bucketed separately, not treated as an error', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { contract_ref: 'deadbeef'.repeat(8) })),
		JSON.stringify(makeReceipt(root)),
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.report.counts.matched, 1);
	assert.equal(body.report.counts.stale_contract_ref, 1);
	assert.equal(body.gate.status, 'pass', 'a stale receipt in the mix must not block the import -- a collection window realistically straddles a re-emit');
});

test('re-importing after the contract changes stales the conformance gate (contract_hash moved)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [JSON.stringify(makeReceipt(root))]);
	run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath], root);
	assert.equal(run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root).code, 0);

	// A real, narrow, contract-affecting change -- unlike the D-resolver-policy-split reproduction
	// (a @PreAuthorize role, which the CONTRACT schema does not encode at all), the conformance
	// gate's own token is the contract's content hash, so the change has to be something
	// contract emit actually projects: the path itself.
	const controllerPath = path.join(root, 'src/main/java/com/example/domain/widget/presentation/WidgetController.java');
	fs.writeFileSync(controllerPath, fs.readFileSync(controllerPath, 'utf8').replace('"/{widgetId}"', '"/{widgetId}/detail"'));
	run(['scan', '--feature', FEATURE_ID, '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'reuse', '--note', 'role change'], root);
	run(['contract', 'emit', '--feature', FEATURE_ID], root);

	const staleResult = run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root);
	assert.equal(staleResult.code, 4, 'the conformance gate must go stale once the contract it was evidence FOR has moved');
});

// D-runtime-conformance-receipts (Continued): --fail-on-violation, the v1.1 policy layer the
// original item's own EXIT section named as deliberately deferred. Default behavior (no flag) stays
// evidence-first -- the tests above already prove that; these cover the opt-in stricter path.

test('--fail-on-violation with real violations sends the conformance gate to awaiting_disposition, not a silent pass', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'does not match the required pattern' }] })),
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation', '--json'], root);
	assert.equal(result.code, 3, 'AWAITING_DISPOSITION, matching every other gate that lands there');
	const body = JSON.parse(result.stdout);
	assert.equal(body.gate.status, 'awaiting_disposition');

	// The `blocked: ...` note is text-mode only, matching `cmdContractEmit`'s own identical
	// precedent (--json is "one execution, one JSON document", no stderr side-channel) -- a
	// SEPARATE, non-JSON run against a fresh receipts import proves the note's own text.
	const textResult = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation'], root);
	assert.match(textResult.stderr, /blocked: 1 violation\(s\) found \(--fail-on-violation\)/);
	assert.match(textResult.stderr, /bskel gate force conformance --feature 001-widget-management --reason/);

	const gateResult = run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root);
	assert.equal(gateResult.code, 3);
});

test('the exact same violating receipts WITHOUT --fail-on-violation still pass -- the default is unchanged', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'does not match the required pattern' }] })),
	]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).gate.status, 'pass');
});

test('--fail-on-violation with ZERO violations still passes -- the flag only matters when there is something to block on', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [JSON.stringify(makeReceipt(root))]);

	const result = run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).gate.status, 'pass');
});

test('an awaiting_disposition conformance gate correctly fails bskel verify overall, and the report shows the violation count inline', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'x' }, { pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'y' }] })),
	]);
	run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation'], root);

	const verifyJson = run(['verify', '--feature', FEATURE_ID, '--json'], root);
	assert.equal(verifyJson.code, 1, 'bskel verify\'s own generic gatesOk/blocking machinery must flip overall FAIL, with zero conformance-specific code in cmdVerify itself');
	const verifyBody = JSON.parse(verifyJson.stdout);
	assert.equal(verifyBody.pass, false);
	const conformanceGate = verifyBody.gates.find((g) => g.gate === 'conformance');
	assert.equal(conformanceGate.blocking, true);

	const verifyText = run(['verify', '--feature', FEATURE_ID], root);
	assert.match(verifyText.stdout, /\[FAIL\] conformance .*\(2 violation\(s\), 1\/1 matched\)/);
});

test('bskel gate force conformance -- the ALREADY-GENERIC command, no new CLI verb -- resolves an awaiting_disposition conformance gate back to a real pass', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'x' }] })),
	]);
	run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation'], root);
	assert.equal(run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root).code, 3);

	const forceResult = run(['gate', 'force', 'conformance', '--feature', FEATURE_ID, '--reason', 'reviewed, accepted for now'], root);
	assert.equal(forceResult.code, 0, forceResult.stderr);

	assert.equal(run(['gate', 'require', 'conformance', '--feature', FEATURE_ID], root).code, 0);
	assert.equal(run(['verify', '--feature', FEATURE_ID, '--json'], root).code, 0);
});

test('bskel next recommends the real, already-generic gate-force command for a stuck conformance gate', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const receiptsPath = writeReceipts(root, [
		JSON.stringify(makeReceipt(root, { violations: [{ pointer: '/pathParams/widgetId', keyword: 'pattern', message: 'x' }] })),
	]);
	run(['observe', 'import', '--feature', FEATURE_ID, '--receipts', receiptsPath, '--fail-on-violation'], root);

	const nextResult = run(['next', '--feature', FEATURE_ID, '--json'], root);
	assert.equal(nextResult.code, 0, nextResult.stderr);
	const nextBody = JSON.parse(nextResult.stdout);
	assert.deepEqual(nextBody.blocked_by, ['conformance']);
	assert.equal(nextBody.next_actions[0].command, `bskel gate force conformance --feature ${FEATURE_ID} --reason "..."`);
	assert.equal(nextBody.next_actions[0].mutating, true);
});
