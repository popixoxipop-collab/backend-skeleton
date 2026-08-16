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

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-cli-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-cli-origin-'));
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

test('handles emit is blocked before the contract gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const result = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 2);
});

test('handles plan finds the Widget entity, its fetch operation, and its service; emit writes compileable-shape Java', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const plan = run(['handles', 'plan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(plan.code, 0);
	const planJson = JSON.parse(plan.stdout);
	const widget = planJson.resources.find((r) => r.type === 'Widget');
	assert.ok(widget);
	assert.equal(widget.fetchOperation.operationId, 'findWidget');
	assert.equal(widget.requiredAuthority, 'SUPER_ADMIN');
	assert.equal(widget.willGenerateResolver, true);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const emitJson = JSON.parse(emit.stdout);
	assert.deepEqual(emitJson.resolverStubs, ['Widget']);
	assert.equal(emitJson.gate.status, 'pass');

	const resolverPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java');
	assert.ok(fs.existsSync(resolverPath));
	const content = fs.readFileSync(resolverPath, 'utf8');
	assert.match(content, /class WidgetResolver implements ResourceResolver/);
	assert.match(content, /widgetService\.findWidget\(resourceUid\)/);
	assert.match(content, /return "SUPER_ADMIN";/);

	assert.ok(fs.existsSync(path.join(root, 'src/main/java/com/example/global/handle/HandleCodec.java')));
	assert.ok(fs.existsSync(path.join(root, 'specs/001-widget-management/handles/migration.sql')));

	const gateResult = run(['gate', 'require', 'handles', '--feature', '001-widget-management'], root);
	assert.equal(gateResult.code, 0);
});

// D-security-9 regression: HandleController.java's recover() must cross-check the decoded
// type/kind/pointer against the HandleRegistry row for the derived handleUid (and reject a
// revoked one), not look up snapshots by handleUid alone. Reproduces via static content
// assertions on the emitted file -- there's no JVM in this test suite to actually run the
// generated code against, but the fixed shape of the source is directly checkable, and the
// pre-fix shape (registry consulted only for contractRef, without any equality check against
// decoded.type()/kind()/pointer()) is exactly what these assertions would have failed against.
test('handles emit writes a recover() that validates the registry row before returning a snapshot', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, 'src/main/java/com/example/global/handle/HandleController.java');
	const content = fs.readFileSync(controllerPath, 'utf8');

	// The registry lookup must happen BEFORE the snapshot query, and must actually be assigned
	// (not discarded) so it can gate access.
	const registryLookupIdx = content.indexOf('handleRegistryRepository.findById(handleUid)');
	const snapshotQueryIdx = content.indexOf('handleSnapshotRepository.findByHandleUidOrderByRecordedAtDesc(handleUid)');
	assert.ok(registryLookupIdx >= 0, 'must look up the HandleRegistry row for this handleUid');
	assert.ok(snapshotQueryIdx >= 0);
	assert.ok(registryLookupIdx < snapshotQueryIdx, 'registry must be validated before snapshots are fetched');

	// The three fields a type-confused handle could disagree on, each checked.
	assert.match(content, /getResourceType\(\)\.equals\(decoded\.type\(\)\)/);
	assert.match(content, /getKind\(\)\.equals\(decoded\.kind\(\)\)/);
	assert.match(content, /Objects\.equals\(r\.getPointer\(\), decoded\.pointer\(\)\)/);
	// A revoked handle must not be recoverable.
	assert.match(content, /!r\.isRevoked\(\)/);
});

// D-security-10 regression: patch() must check kind == "f" explicitly, not infer "this is a
// field handle" purely from pointer-presence -- HandleCodec.decode() doesn't itself enforce that
// only kind=f carries a pointer (that's an encode-side check), so a hand-crafted token of a
// different kind with a pointer appended must still be rejected here.
test('handles emit writes a patch() that checks handle kind explicitly, not just pointer presence', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, 'src/main/java/com/example/global/handle/HandleController.java');
	const content = fs.readFileSync(controllerPath, 'utf8');
	assert.match(content, /!decoded\.kind\(\)\.equals\("f"\) \|\| decoded\.pointer\(\) == null/);
});

// S6 regression, real end-to-end path (as opposed to the lighter `gate force`-based version in
// test/verify-cli.test.mjs): the `handles` gate's token (lib/gate-definitions.mjs) covers only
// head_sha + the contract's hash -- NOT migration.sql's own content -- so deleting an emitted
// migration.sql leaves the handles gate reporting "pass" forever. The artifact check in
// lib/verify.mjs's checkArtifacts() is the only thing that can still notice.
test('deleting an emitted migration.sql fails verify, even though the handles gate itself still reports pass', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const beforeDelete = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(JSON.parse(beforeDelete.stdout).pass, true, 'sanity check: verify passes right after emit');

	fs.rmSync(path.join(root, 'specs/001-widget-management/handles/migration.sql'));

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, false);
	const migrationArtifact = report.artifacts.find((a) => a.artifact === 'handles migration');
	assert.ok(migrationArtifact);
	assert.equal(migrationArtifact.exists, false);
	assert.equal(report.gates.find((g) => g.gate === 'handles').status, 'pass', 'the gate token does not cover migration.sql, so it stays pass -- the artifact check is the only defense');
});

// S2 (c): same gap as the migration.sql case above, but for the generated Java itself -- O2's
// handles-manifest.json tracks every file `handles emit` wrote, and checkArtifacts() now checks
// each one still exists, closing the one case S6 didn't (S6 only covered migration.sql).
test('deleting an emitted resolver fails verify, even though the handles gate itself still reports pass', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java');
	fs.rmSync(resolverPath);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, false);
	const resolverArtifact = report.artifacts.find((a) => a.artifact === 'handles resolver' && a.path.endsWith('WidgetResolver.java'));
	assert.ok(resolverArtifact);
	assert.equal(resolverArtifact.exists, false);
	assert.equal(report.gates.find((g) => g.gate === 'handles').status, 'pass', 'the gate token does not hash generated content -- the artifact check is the only defense');
});

test('deleting a shared global/handle infra file fails verify', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	fs.rmSync(path.join(root, 'src/main/java/com/example/global/handle/HandleCodec.java'));

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 1);
	const report = JSON.parse(result.stdout);
	const infraArtifact = report.artifacts.find((a) => a.artifact === 'handles infra' && a.path.endsWith('HandleCodec.java'));
	assert.ok(infraArtifact);
	assert.equal(infraArtifact.exists, false);
});

// S2 (c), the deliberate flip side of the two tests above -- this is the test that would fail
// loudly if someone later "improves" the handles gate by hashing generated CONTENT into its
// token, which is precisely the trap D-handles-ownership and D-gate-precision both warn against:
// patchField() is meant to be hand-finished, and that must never make the gate or verify unhappy.
test('hand-finishing patchField() in a generated resolver does NOT stale the handles gate or fail verify', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java');
	const edited = fs.readFileSync(resolverPath, 'utf8').replace(
		'throw new UnsupportedOperationException',
		'// hand-completed: routes through widgetService\'s real update method\n\t\tif (true) return;\n\t\tthrow new UnsupportedOperationException',
	);
	fs.writeFileSync(resolverPath, edited);

	const result = run(['verify', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.pass, true);
	assert.equal(report.gates.find((g) => g.gate === 'handles').status, 'pass');
	const resolverArtifact = report.artifacts.find((a) => a.artifact === 'handles resolver' && a.path.endsWith('WidgetResolver.java'));
	assert.equal(resolverArtifact.exists, true, 'existence-only check: the file is still there, its content is not re-examined');
});
