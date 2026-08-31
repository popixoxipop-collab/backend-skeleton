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
	// D-resolver-policy-split: the live-derived/security-relevant values no longer live in this
	// file -- Resolver.java only delegates to the companion Policy class.
	assert.match(content, /WidgetResolverPolicy\.requiredAuthority\(\)/);

	const policyPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolverPolicy.java');
	assert.ok(fs.existsSync(policyPath));
	const policyContent = fs.readFileSync(policyPath, 'utf8');
	assert.match(policyContent, /class WidgetResolverPolicy/);
	assert.match(policyContent, /return "SUPER_ADMIN";/);

	assert.ok(fs.existsSync(path.join(root, 'src/main/java/com/example/global/handle/HandleCodec.java')));
	assert.ok(fs.existsSync(path.join(root, 'specs/001-widget-management/handles/migration.sql')));

	const gateResult = run(['gate', 'require', 'handles', '--feature', '001-widget-management'], root);
	assert.equal(gateResult.code, 0);
});

// D-security-9 regression, updated by O3 (D-handle-registry-enforcement): HandleController.java's
// recover() must cross-check the decoded resourceType against the HandleRegistry row for the
// PARENT RESOURCE's derived handleUid (and reject a revoked one), not look up snapshots by
// handleUid alone. Reproduces via static content assertions on the emitted file -- there's no JVM
// in this test suite to actually run the generated code against, but the fixed shape of the
// source is directly checkable, and the pre-fix shape (registry consulted only for contractRef,
// without any equality check against decoded.type()) is exactly what these assertions would have
// failed against.
//
// O3 found live (a real integration-test failure, not assumed) that the ORIGINAL D-security-9
// shape -- requiring an EXACT match on kind/pointer, not just type -- made a fresh resource's very
// first field-level (kind=f) PATCH structurally impossible once registry enforcement (part 2)
// existed: HandleAspect only ever auto-registers the WHOLE-RESOURCE (kind=r) row, never a
// field-specific one, so an exact-match lookup could never find it. The corrected design always
// looks up the PARENT resource's row (kind=r, pointer=null) regardless of the requested handle's
// own kind/pointer -- resourceType is still exactly cross-checked (the real D-security-9
// protection), but kind/pointer are not, since every real registration is resource-level.
test('handles emit writes a recover() that validates the PARENT resource\'s registry row before returning a snapshot', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, 'src/main/java/com/example/global/handle/HandleController.java');
	const content = fs.readFileSync(controllerPath, 'utf8');

	// recover() calls the shared requireRegisteredOrThrow() helper BEFORE the snapshot query, and
	// actually uses its result (registry.getHandleUid()) so it can gate access.
	const recoverIdx = content.indexOf('public ResponseEntity<?> recover(');
	const registryCallIdx = content.indexOf('requireRegisteredOrThrow(decoded)', recoverIdx);
	const snapshotQueryIdx = content.indexOf('handleSnapshotRepository.findByHandleUidOrderByRecordedAtDesc(handleUid)', recoverIdx);
	assert.ok(registryCallIdx >= 0 && registryCallIdx > recoverIdx, 'recover() must call requireRegisteredOrThrow(decoded)');
	assert.ok(snapshotQueryIdx >= 0);
	assert.ok(registryCallIdx < snapshotQueryIdx, 'registry must be validated before snapshots are fetched');

	// requireRegisteredOrThrow() itself: looks up the PARENT resource's derived handle_uid
	// (kind="r", pointer=null -- NOT decoded.kind()/decoded.pointer()), cross-checks resourceType,
	// and rejects a revoked row.
	assert.match(content, /HandleCodec\.deriveHandleUid\("r", decoded\.type\(\), decoded\.uuid\(\), null\)/);
	assert.match(content, /getResourceType\(\)\.equals\(decoded\.type\(\)\)/);
	assert.match(content, /!r\.isRevoked\(\)/);
	// The exact-match kind/pointer checks were the ORIGINAL D-security-9 shape -- deliberately
	// gone now, confirming the fix actually took (not just that the new checks were added
	// alongside the old, stricter-than-necessary ones).
	assert.ok(!content.includes('getKind().equals(decoded.kind())'), 'the exact-kind cross-check must be gone -- every real registration is resource-level (kind=r), so requiring it would 404 every field handle');
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

// O5 (D-resolver-authorization-action-aware): before this item, patch() called
// resolver.requiredAuthority() -- the SAME value fetch()/recover() use, silently reusing the
// fetch endpoint's own role for PATCH too. Static content assertions on the emitted files, same
// style as the D-security-9/D-security-10 regressions above -- this is a codegen-value-selection
// bug, fully provable without a JVM.
test('handles emit writes a patch() that checks the PATCH-specific authority, not the fetch one', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const controllerPath = path.join(root, 'src/main/java/com/example/global/handle/HandleController.java');
	const controllerContent = fs.readFileSync(controllerPath, 'utf8');
	const patchIdx = controllerContent.indexOf('public ResponseEntity<Void> patch(');
	const fetchIdx = controllerContent.indexOf('public ResponseEntity<Object> fetch(');
	const recoverIdx = controllerContent.indexOf('public ResponseEntity<?> recover(');
	assert.ok(patchIdx >= 0 && fetchIdx >= 0 && recoverIdx >= 0);
	// fetch() is declared before patch() is before recover() in the template -- slice each method
	// up to the START of the next one, not a fixed char count (the D-security-10/-9 explanatory
	// comments inside these methods are long enough to push the real code past a short window).
	assert.match(controllerContent.slice(fetchIdx, patchIdx), /requireAuthority\(resolver\.requiredAuthority\(\)\)/, 'fetch() must keep using the fetch/recover authority');
	assert.match(controllerContent.slice(patchIdx, recoverIdx), /requireAuthority\(resolver\.requiredAuthorityForPatch\(\)\)/, 'patch() must use the patch-specific authority');
	assert.match(controllerContent.slice(recoverIdx), /requireAuthority\(resolver\.requiredAuthority\(\)\)/, 'recover() must keep using the fetch/recover authority (it is conceptually a read, not a write)');

	// ResourceResolver interface: both accessor methods present.
	const resolverPath = path.join(root, 'src/main/java/com/example/global/handle/ResourceResolver.java');
	const resolverContent = fs.readFileSync(resolverPath, 'utf8');
	assert.match(resolverContent, /String requiredAuthority\(\);/);
	assert.match(resolverContent, /String requiredAuthorityForPatch\(\);/);

	// The generated per-resource resolver stub implements both, delegating to the companion
	// ResolverPolicy class (D-resolver-policy-split) where the two are genuinely separate
	// generated values (not the same template var rendered twice).
	const widgetResolverPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java');
	const widgetResolverContent = fs.readFileSync(widgetResolverPath, 'utf8');
	assert.match(widgetResolverContent, /public String requiredAuthority\(\)\s*\{\s*return WidgetResolverPolicy\.requiredAuthority\(\);/);
	assert.match(widgetResolverContent, /public String requiredAuthorityForPatch\(\)\s*\{\s*return WidgetResolverPolicy\.requiredAuthorityForPatch\(\);/);

	const widgetPolicyPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolverPolicy.java');
	const widgetPolicyContent = fs.readFileSync(widgetPolicyPath, 'utf8');
	assert.match(widgetPolicyContent, /static String requiredAuthority\(\)\s*\{\s*return "SUPER_ADMIN";/);
	assert.match(widgetPolicyContent, /static String requiredAuthorityForPatch\(\)\s*\{\s*return "TODO_ROLE";/, 'no PATCH endpoint exists on this fixture controller, so the patch authority must fail closed independently of the fetch one');
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
	// S6 (D-verify-integrity): the SAME edit is exactly what classifyFile() reports as a
	// `conflict` action (it cannot distinguish "hand-finished" from "corrupted" -- only that disk
	// content matches neither the manifest's recorded hash nor a fresh re-render) -- surfaced in
	// the report for visibility, but deliberately non-blocking, which `report.pass === true` above
	// already proves.
	assert.ok(report.conflicts.length > 0, 'the hand-finished resolver should surface as a conflict finding');
	assert.ok(report.conflicts.some((c) => c.path.endsWith('WidgetResolver.java')));
});

// S2 (D-gate-precision, continued): the exact interaction that broke first when this item was
// implemented -- a generated resolver lives INSIDE the same src/main/java tree the java-spring
// adapter globs for the `scan` gate's own read-set, so without excluding O2's generated-file
// registry, `handles emit` writing its own output would look identical to a human adding a real
// new controller, staling `scan` on every single `handles emit` run. This is what caught that bug
// live (this test, plus the hand-finishing one above, both failed before the fix).
test('running handles emit does not stale the scan gate (generated files are excluded from its read-set)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0);

	assert.equal(run(['handles', 'emit', '--feature', '001-widget-management'], root).code, 0);

	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0, 'handles emit writing generated Java under src/main/java must not stale scan');
});

// O6: detectBasePackage() used to silently pick files[0] on ANY multi-*Application.java repo --
// unverified by any test until now (this exact gap Explore found). Two genuinely different
// packages must fail loudly and name every candidate; two files sharing the SAME package (a real
// multi-module-monorepo shape) is not actual ambiguity and must still work.
test('handles plan fails clearly when *Application.java files declare genuinely different packages', () => {
	const root = buildFixtureRepo();
	const secondAppDir = path.join(root, 'src/main/java/com/other');
	fs.mkdirSync(secondAppDir, { recursive: true });
	fs.writeFileSync(path.join(secondAppDir, 'OtherApplication.java'), 'package com.other;\npublic class OtherApplication {}\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'add a second, differently-packaged application root'], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	runWorkflowThroughContract(root);
	const result = run(['handles', 'plan', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /ambiguous base package/);
	assert.match(result.stderr, /ExampleApplication\.java/);
	assert.match(result.stderr, /OtherApplication\.java/);
});

test('handles plan still works when multiple *Application.java files share the same package (multi-module shape, not real ambiguity)', () => {
	const root = buildFixtureRepo();
	const secondAppDir = path.join(root, 'src/main/java/com/example/othermodule');
	fs.mkdirSync(secondAppDir, { recursive: true });
	fs.writeFileSync(path.join(secondAppDir, 'OtherModuleApplication.java'), 'package com.example;\npublic class OtherModuleApplication {}\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'add a second application root in the same package'], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	runWorkflowThroughContract(root);
	const result = run(['handles', 'plan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const plan = JSON.parse(result.stdout);
	assert.ok(plan.resources.find((r) => r.type === 'Widget'));
});

// O3 follow-up (D-handle-registry-enforcement, "Continued"): the bootstrapping-trap warning --
// the fixture's real WidgetService.java (above) carries no @RecordHandleSnapshot, so turning
// enforcement on should warn specifically about Widget, naming the service file.
test('handles emit --enforce-registry on warns per-resource when @RecordHandleSnapshot is absent from the resource\'s own service file', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--enforce-registry', 'on', '--json'], root);
	assert.equal(emit.code, 0, emit.stderr);
	const emitJson = JSON.parse(emit.stdout);
	assert.ok(emitJson.postEmitNotes.some((n) => n.startsWith('Widget:') && n.includes('no @RecordHandleSnapshot(...)') && n.includes('WidgetService.java')));
});

test('handles emit --enforce-registry on does not warn once @RecordHandleSnapshot is applied to the resource\'s own service file', () => {
	const root = buildFixtureRepo();
	const servicePath = path.join(root, 'src/main/java/com/example/domain/widget/application/WidgetService.java');
	fs.writeFileSync(servicePath, `
package com.example.domain.widget.application;
public interface WidgetService {
	Object findWidget(java.util.UUID id);

	@RecordHandleSnapshot(resourceType = "Widget", operationId = "createWidget", resourceUidParam = 0)
	Object createWidget(java.util.UUID id);
}
`);
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'apply @RecordHandleSnapshot to WidgetService'], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	runWorkflowThroughContract(root);
	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--enforce-registry', 'on', '--json'], root);
	assert.equal(emit.code, 0, emit.stderr);
	const emitJson = JSON.parse(emit.stdout);
	assert.ok(!emitJson.postEmitNotes.some((n) => n.includes('no @RecordHandleSnapshot')));
});

test('handles emit without --enforce-registry (the default, off) never emits a per-resource registration warning', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0, emit.stderr);
	const emitJson = JSON.parse(emit.stdout);
	assert.ok(!emitJson.postEmitNotes.some((n) => n.includes('no @RecordHandleSnapshot')));
});
