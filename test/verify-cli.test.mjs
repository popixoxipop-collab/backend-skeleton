import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// `gradlew` option adds a fake, executable gradlew script BEFORE the fixture's initial commit
// (not appended afterward -- appending after the commit would leave the working tree dirty,
// and `bskel preflight` refuses to pass judgment on a dirty tree without --allow-dirty, which
// would block every test that needs preflight to actually PASS).
// `unmatchedEndpoint`: adds a method with its own `@Operation(summary=...)` but no operationId --
// produces a CONTRACT_UNMATCHED_ENDPOINT warning (completeness: partial). Giving it its own
// `@Operation(...)` (not omitting the annotation) matters: scanners/adapters/java-spring.mjs's
// operationId correlator walks backward to the nearest preceding `@Operation(` in the whole
// file, so a method with NO `@Operation` of its own would incorrectly inherit findWidgets'
// operationId instead of correlating to null.
function buildFixtureRepo({ gradlew, unmatchedEndpoint } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-verify-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const pkgDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation');
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() { return "ok"; }
${unmatchedEndpoint ? `
	@Operation(summary = "delete a widget")
	@DeleteMapping("/{widgetId}")
	public String deleteWidget(@PathVariable String widgetId) { return "ok"; }` : ''}
}
`);
	if (gradlew) {
		const script = gradlew === 'ok'
			? '#!/bin/sh\necho "BUILD SUCCESSFUL"\nexit 0\n'
			: '#!/bin/sh\necho "FAKE_COMPILE_ERROR: WidgetController.java:1: error: fixture-induced failure"\nexit 1\n';
		const gradlewPath = path.join(root, 'gradlew');
		fs.writeFileSync(gradlewPath, script);
		fs.chmodSync(gradlewPath, 0o755);
	}
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-verify-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughContract(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
}

test('verify FAILs cleanly before any workflow step has run', () => {
	const root = buildFixtureRepo();
	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, false);
	assert.equal(report.gates.find((g) => g.gate === 'preflight').code, 2);
	assert.equal(report.artifacts.find((a) => a.artifact === 'contract').exists, false);
});

test('verify PASSes once preflight, scan, and contract gates are satisfied; handles stays optional', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, true);
	const handlesGate = report.gates.find((g) => g.gate === 'handles');
	assert.equal(handlesGate.required, false);
	assert.equal(handlesGate.code, 2); // not_run, but doesn't block overall pass since it's optional
});

// S6 (D-verify-integrity): reproduces a real, live-confirmed bug -- `bskel verify --build` on a
// repo with no recognized build tool used to report an overall PASS even though the build
// assurance the user explicitly asked for never actually ran. An explicit --build now fails
// closed unless --allow-skip-build is also passed.
test('verify --build: an explicit --build with no recognized tool now FAILS verify unless --allow-skip-build is passed', () => {
	const root = buildFixtureRepo();
	// No gradlew/pom.xml/package.json in this fixture -> build check has nothing to run.
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const withoutOptOut = run(['verify', '--feature', '001-widget-management', '--build', '--json'], root);
	const reportWithoutOptOut = JSON.parse(withoutOptOut.stdout);
	assert.equal(reportWithoutOptOut.build.ran, false);
	assert.equal(reportWithoutOptOut.pass, false, 'an explicit --build request that never actually ran must not silently pass');
	assert.equal(withoutOptOut.code, 1);

	const withOptOut = run(['verify', '--feature', '001-widget-management', '--build', '--allow-skip-build', '--json'], root);
	const reportWithOptOut = JSON.parse(withOptOut.stdout);
	assert.equal(reportWithOptOut.build.ran, false);
	assert.equal(reportWithOptOut.pass, true, '--allow-skip-build is the explicit opt-out, and must actually work');
	assert.equal(withOptOut.code, 0);
});

// S6 (D-verify-integrity): reproduces a real, live-confirmed bug -- a failing build's most useful
// diagnostic text sometimes lands entirely on stderr (npm's own generic banner goes to stdout,
// the real fatal error to stderr); the old capture (`err.stdout` only) silently dropped it.
test('verify --build: a build failure whose real error is on stderr is captured, not silently dropped', () => {
	const root = buildFixtureRepo();
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
		name: 'stderr-repro',
		version: '1.0.0',
		scripts: { build: 'node -e "console.error(\'FATAL_STDERR_ONLY_MESSAGE\'); process.exit(1)"' },
	}));
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: add stderr-only build script'], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	const result = run(['verify', '--feature', '001-widget-management', '--build', '--json'], root);
	const report = JSON.parse(result.stdout);
	assert.equal(report.build.ran, true);
	assert.equal(report.build.ok, false);
	assert.match(report.build.message, /FATAL_STDERR_ONLY_MESSAGE/, 'the stderr-only diagnostic must actually be captured');
	assert.equal(report.pass, false);
});

// S6 regression: `stack` used to be entirely absent from lib/verify.mjs's local GATE_SPECS, so
// `bskel verify` never even looked at it -- this reproduces the exact shape the Codex "next
// enhancement item" review flagged (a `stack apply` pass being invisible to verify).
test('verify exposes the stack gate even when nothing has applied a stack choice', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, true);
	const stackGate = report.gates.find((g) => g.gate === 'stack');
	assert.ok(stackGate, 'the stack gate must appear in the verify report at all');
	assert.equal(stackGate.scope, 'repo');
	assert.equal(stackGate.policy, 'required-when-present');
	assert.equal(stackGate.status, 'not_run');
	assert.equal(stackGate.blocking, false);
});

test('verify reports stack:pass after a real stack apply, and overall pass stays true', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, true);
	const stackGate = report.gates.find((g) => g.gate === 'stack');
	assert.equal(stackGate.status, 'pass');
	assert.equal(stackGate.blocking, false);
});

// S6: `required-when-present` means "not_run doesn't block", NOT "once run, it stops mattering".
// A stack choice that was applied and then drifted (its record no longer matches what's on
// disk) must still fail the overall verdict.
test('a stale optional gate (stack) blocks the overall verify verdict, not just its own status', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);

	const stackRecordPath = path.join(root, '.sbf', 'stack.json');
	const original = fs.readFileSync(stackRecordPath, 'utf8');
	fs.writeFileSync(stackRecordPath, `${original}\n`); // any byte change is enough to go stale

	const staleResult = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(staleResult.code, 1);
	const staleReport = JSON.parse(staleResult.stdout);
	assert.equal(staleReport.pass, false);
	const staleStackGate = staleReport.gates.find((g) => g.gate === 'stack');
	assert.equal(staleStackGate.status, 'stale');
	assert.equal(staleStackGate.blocking, true);

	fs.writeFileSync(stackRecordPath, original);
	const restoredResult = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(JSON.parse(restoredResult.stdout).pass, true, 'restoring the original record must un-stale the gate');
});

// S6 regression: `checkArtifacts()` used to only add a `handles migration` check item when
// migration.sql already existed on disk, so `exists: false` could never happen -- a handles
// gate that passed and then had its migration.sql deleted was undetectable. `gate force` is
// used here (instead of a full Java fixture + `handles emit`) purely to make the handles gate
// "ran" cheaply; the real end-to-end path (via an actual `handles emit`) is covered separately
// in test/handles-cli.test.mjs.
test('a passed handles gate with a missing migration.sql fails verify (and the artifact item is created at all)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['gate', 'force', 'handles', '--feature', '001-widget-management', '--reason', 'test: simulate handles gate without a real migration.sql'], root);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, false);
	const migrationArtifact = report.artifacts.find((a) => a.artifact === 'handles migration');
	assert.ok(migrationArtifact, 'a "handles migration" artifact check must be created once the handles gate has run, even if the file was never written');
	assert.equal(migrationArtifact.exists, false);
	// The handles gate's own token doesn't cover migration.sql's content, so the gate itself
	// stays "pass" -- this artifact check is the only thing that notices the file is gone.
	assert.equal(report.gates.find((g) => g.gate === 'handles').status, 'pass (forced)');
});

test('gate require/force/show reject an unknown gate name, and no state file is created for it', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);

	const requireResult = run(['gate', 'require', 'bogus-gate'], root);
	assert.equal(requireResult.code, 14);
	assert.match(requireResult.stderr, /unknown gate "bogus-gate"/);
	assert.match(requireResult.stderr, /preflight, scan, contract, handles, stack/);

	const forceResult = run(['gate', 'force', 'bogus-gate', '--reason', 'x'], root);
	assert.equal(forceResult.code, 14);
	assert.match(forceResult.stderr, /unknown gate "bogus-gate"/);

	const showResult = run(['gate', 'show', 'bogus-gate'], root);
	assert.equal(showResult.code, 14);
	assert.match(showResult.stderr, /unknown gate "bogus-gate"/);

	assert.ok(!fs.existsSync(path.join(root, '.sbf', 'bogus-gate.json')), 'an unknown gate name must never create its own state file');
});

test('gate show <name> filters to that gate\'s own record; gate show with no name still dumps the whole state', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);

	const named = run(['gate', 'show', 'preflight'], root);
	assert.equal(named.code, 0);
	const namedJson = JSON.parse(named.stdout);
	assert.equal(namedJson.gate, 'preflight');
	assert.equal(namedJson.record.status, 'pass');

	const full = run(['gate', 'show'], root);
	assert.equal(full.code, 0);
	const fullJson = JSON.parse(full.stdout);
	assert.equal(fullJson.feature_id, '_repo');
	assert.equal(fullJson.gates.preflight.status, 'pass');
});

// A real (not skipped) build failure -- `verify --build` must surface it, not just report gate
// status. The fake gradlew is committed as part of the fixture (see buildFixtureRepo's doc
// comment) so the working tree stays clean for preflight.
test('verify --build: a real build failure is reported, with the compiler output attached', () => {
	const root = buildFixtureRepo({ gradlew: 'fail' });
	runWorkflowThroughContract(root);

	const result = run(['verify', '--feature', '001-widget-management', '--build', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, false);
	assert.equal(report.build.ran, true);
	assert.equal(report.build.ok, false);
	assert.equal(report.build.tool, 'gradle');
	assert.match(report.build.message, /FAKE_COMPILE_ERROR/);
});

test('verify --build: a real build success is reported', () => {
	const root = buildFixtureRepo({ gradlew: 'ok' });
	runWorkflowThroughContract(root);

	const result = run(['verify', '--feature', '001-widget-management', '--build', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, true);
	assert.equal(report.build.ran, true);
	assert.equal(report.build.ok, true);
	assert.equal(report.build.tool, 'gradle');
});

// A5 regression: a waiver lives in its own file precisely so it can drift independently of the
// contract artifact -- the `contract` gate's token covers resolution_hash (lib/gate-definitions.
// mjs), so deleting the resolution file that unblocked a partial contract must make the gate go
// stale, same as corrupting stack.json does for the `stack` gate above.
test('deleting a contract resolution (waiver) file after it unblocked the gate makes contract stale and fails verify', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	const emit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 3, 'sanity: the partial contract must block before waiving');

	const waive = run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'test'], root);
	assert.equal(waive.code, 0);
	assert.equal(JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout).pass, true);

	const resolutionFilePath = path.join(root, 'specs', '001-widget-management', 'contracts', '001-widget-management.resolution.json');
	const backup = fs.readFileSync(resolutionFilePath, 'utf8');
	fs.rmSync(resolutionFilePath);

	const afterDelete = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(afterDelete.code, 1);
	const report = JSON.parse(afterDelete.stdout);
	assert.equal(report.pass, false);
	const contractGate = report.gates.find((g) => g.gate === 'contract');
	assert.equal(contractGate.status, 'stale');
	// S2: end-to-end proof that a stale gate reports exactly which input changed, through the real
	// `verify --json` path -- not just contract's head_sha moving, specifically resolution_hash.
	assert.equal(contractGate.stale_reason, 'inputs_changed');
	assert.deepEqual(contractGate.changed_inputs, ['resolution_hash']);

	fs.writeFileSync(resolutionFilePath, backup);
	assert.equal(JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout).pass, true, 'restoring the original resolution file must un-stale the gate');
});

// S2: same scenario, non-JSON path -- the human-readable report must also name the changed input,
// not just print "stale".
test('the non-JSON verify report names the changed input on a stale gate', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management', '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'test'], root);

	fs.rmSync(path.join(root, 'specs', '001-widget-management', 'contracts', '001-widget-management.resolution.json'));

	const result = run(['verify', '--feature', '001-widget-management'], root);
	assert.match(result.stdout, /\[FAIL\] contract .*\(stale: resolution_hash\)/);
});

// S2 (c): a feature that never ran `handles emit` must not have another feature's manifest
// entries (or the repo-owned infra) show up in ITS verify report -- checkArtifacts()'s
// `!handlesRan && owned.length === 0` guard is what prevents this cross-feature bleed.
test('a feature that never ran handles emit gets no handles-manifest artifact items, even when another feature has entries', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);

	fs.mkdirSync(path.join(root, '.sbf'), { recursive: true });
	fs.writeFileSync(path.join(root, '.sbf', 'handles-manifest.json'), JSON.stringify({
		schema: 'sbf.handles-manifest/1',
		files: {
			'src/main/java/com/example/global/handle/HandleCodec.java': { kind: 'infra', ownership: 'repo', owner: '_repo', generated_hash: 'x' },
			'src/main/java/com/example/domain/other/infrastructure/OtherResolver.java': { kind: 'resolver', ownership: 'feature', owner: '002-other-feature', generated_hash: 'y' },
		},
	}));

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	const report = JSON.parse(result.stdout);
	const handlesArtifacts = report.artifacts.filter((a) => a.artifact === 'handles infra' || a.artifact === 'handles resolver');
	assert.deepEqual(handlesArtifacts, [], 'this feature never ran handles emit -- another feature\'s entries (and repo infra) must not appear in its report');
	// S6 (D-verify-integrity): checkResolverConflicts short-circuits on the same !handlesRan guard
	// -- must not crash or false-positive just because handle codegen was never run for this feature.
	assert.deepEqual(report.conflicts, []);
});

test('an unreadable handles manifest is reported as a finding, not thrown', () => {
	const root = buildFixtureRepo({ unmatchedEndpoint: true });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['gate', 'force', 'handles', '--feature', '001-widget-management', '--reason', 'test'], root);

	fs.mkdirSync(path.join(root, '.sbf'), { recursive: true });
	fs.writeFileSync(path.join(root, '.sbf', 'handles-manifest.json'), JSON.stringify({ schema: 'bogus/9', files: {} }));

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	assert.equal(result.stderr, '', 'must not crash with a stack trace');
	const report = JSON.parse(result.stdout);
	const unreadable = report.artifacts.find((a) => a.artifact === 'handles manifest (unreadable)');
	assert.ok(unreadable);
	assert.equal(unreadable.exists, false);
});
