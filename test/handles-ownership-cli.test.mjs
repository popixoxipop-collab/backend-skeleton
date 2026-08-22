// O2: end-to-end CLI tests for `bskel handles emit`'s conflict-safe generated-file ownership.
// See DECISIONS.md D-handles-ownership and test/handles-manifest.test.mjs (the pure-function
// version of this same decision tree). Fixture/helpers copied from test/handles-cli.test.mjs,
// which this file does not modify -- every test there must keep passing unmodified.
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
const RESOLVER_REL_PATH = 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java';
const MANIFEST_REL_PATH = '.sbf/handles-manifest.json';

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function readManifest(root) {
	return JSON.parse(fs.readFileSync(path.join(root, MANIFEST_REL_PATH), 'utf8'));
}

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-ownership-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-ownership-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughContract(root, featureId, slug) {
	run(['feature', 'init', '--slug', slug], root);
	run(['scan', '--feature', featureId, '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', featureId, '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', featureId], root);
}

function setupFirstFeature(root) {
	run(['preflight'], root);
	runWorkflowThroughContract(root, '001-widget-management', 'widget-management');
}

test('(a) first emit creates files and records a manifest entry per infra file + resolver, with correct owners', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const emitJson = JSON.parse(emit.stdout);
	assert.equal(emitJson.blocked, false);
	assert.equal(emitJson.conflicts.length, 0);

	const manifest = readManifest(root);
	assert.equal(manifest.schema, 'sbf.handles-manifest/1');
	const infraPaths = Object.keys(manifest.files).filter((p) => p.includes('global/handle/'));
	assert.equal(infraPaths.length, 10);
	for (const p of infraPaths) {
		assert.equal(manifest.files[p].kind, 'infra');
		assert.equal(manifest.files[p].owner, '_repo');
	}

	assert.ok(manifest.files[RESOLVER_REL_PATH]);
	assert.equal(manifest.files[RESOLVER_REL_PATH].kind, 'resolver');
	assert.equal(manifest.files[RESOLVER_REL_PATH].owner, '001-widget-management');
	assert.equal(manifest.files[RESOLVER_REL_PATH].resource_type, 'Widget');

	// generated_hash actually matches what's on disk right now.
	const diskContent = fs.readFileSync(path.join(root, RESOLVER_REL_PATH), 'utf8');
	const diskHash = createHash('sha256').update(diskContent).digest('hex');
	assert.equal(manifest.files[RESOLVER_REL_PATH].generated_hash, diskHash);
});

test('(b) re-emit with nothing touched is a no-op: nothing besides migration.sql is rewritten, manifest stays byte-identical', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);
	const before = fs.readFileSync(path.join(root, MANIFEST_REL_PATH), 'utf8');

	const emit2 = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit2.code, 0);
	const emit2Json = JSON.parse(emit2.stdout);
	assert.equal(emit2Json.conflicts.length, 0);
	const nonMigrationWrites = emit2Json.written.filter((w) => !w.endsWith('migration.sql'));
	assert.deepEqual(nonMigrationWrites, [], 'a true no-op re-emit must not rewrite any infra/resolver file');

	const after = fs.readFileSync(path.join(root, MANIFEST_REL_PATH), 'utf8');
	assert.equal(after, before, 'manifest must be byte-identical after a true no-op re-emit');
});

test('(c) a human-edited resolver blocks re-emit with exit 15, leaves the file byte-for-byte untouched, and does not pass the gate', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, RESOLVER_REL_PATH);
	const edited = `${fs.readFileSync(resolverPath, 'utf8')}\n\t// hand-completed patchField() would go here\n`;
	fs.writeFileSync(resolverPath, edited);

	const emit2 = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit2.code, 15);
	const emit2Json = JSON.parse(emit2.stdout);
	assert.equal(emit2Json.blocked, true);
	assert.equal(emit2Json.gate, null);
	assert.equal(emit2Json.conflicts.length, 1);
	assert.equal(emit2Json.conflicts[0].kind, 'resolver');
	assert.equal(emit2Json.conflicts[0].resourceType, 'Widget');

	assert.equal(fs.readFileSync(resolverPath, 'utf8'), edited, 'the edited file must be byte-for-byte untouched');
});

test('(d) --force requires --reason, then overwrites a diverged resolver and records last_force in the manifest', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, RESOLVER_REL_PATH);
	fs.writeFileSync(resolverPath, `${fs.readFileSync(resolverPath, 'utf8')}\n// hand edit\n`);
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'hand edit resolver'], { cwd: root });
	// The commit above advances HEAD, which stales every gate in the preflight -> scan -> contract
	// chain `cmdHandlesEmit` requires (all their tokens cover head_sha) -- re-run the whole chain
	// (feature already exists, so skip `feature init`) so the --force/--reason checks below are
	// actually reached, not masked by an unrelated exit 4 (stale).
	assert.equal(run(['preflight'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const noReason = run(['handles', 'emit', '--feature', '001-widget-management', '--force'], root);
	assert.equal(noReason.code, 14);

	const forced = run(['handles', 'emit', '--feature', '001-widget-management', '--force', '--reason', 'intentional overwrite for test', '--json'], root);
	assert.equal(forced.code, 0);
	const content = fs.readFileSync(resolverPath, 'utf8');
	assert.doesNotMatch(content, /hand edit/);

	// Regression: found live against Team-IZ-Backend -- the CLI's "--force had no effect" note
	// used to key off `conflicts.length === 0`, which is ALSO true right after a successful force
	// resolves every conflict (they move out of `conflicts` once resolved), so a real, effectful
	// --force was misreported as a no-op. `forced` is the array that actually distinguishes them.
	const forcedJson = JSON.parse(forced.stdout);
	assert.deepEqual(forcedJson.forced, [RESOLVER_REL_PATH]);
	assert.ok(!forcedJson.notes.some((n) => n.includes('had no effect')), `expected no "had no effect" note, got: ${JSON.stringify(forcedJson.notes)}`);
	assert.ok(forcedJson.notes.some((n) => n.includes('overwrote 1 diverged file')), `expected an "overwrote" note, got: ${JSON.stringify(forcedJson.notes)}`);

	const manifest = readManifest(root);
	assert.equal(manifest.files[RESOLVER_REL_PATH].last_force.reason, 'intentional overwrite for test');
});

test('(d-1) --force with zero actual conflicts is a genuine no-op: 0 exit, "had no effect" note, empty forced array', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root); // nothing diverged yet

	const result = run(['handles', 'emit', '--feature', '001-widget-management', '--force', '--reason', 'just in case', '--json'], root);
	assert.equal(result.code, 0);
	const resultJson = JSON.parse(result.stdout);
	assert.deepEqual(resultJson.forced, []);
	assert.deepEqual(resultJson.conflicts, []);
	assert.ok(resultJson.notes.some((n) => n.includes('had no effect')), `expected a "had no effect" note, got: ${JSON.stringify(resultJson.notes)}`);
});

test('(d-2) --force refuses an uncommitted/untracked diverged file even with a reason -- overwrite must stay recoverable', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	const resolverPath = path.join(root, RESOLVER_REL_PATH);
	fs.writeFileSync(resolverPath, `${fs.readFileSync(resolverPath, 'utf8')}\n// uncommitted hand edit\n`);
	// deliberately NOT committed

	const forced = run(['handles', 'emit', '--feature', '001-widget-management', '--force', '--reason', 'try anyway'], root);
	assert.equal(forced.code, 15, 'a refused --force must still report as blocked, not silently succeed');
	assert.match(fs.readFileSync(resolverPath, 'utf8'), /uncommitted hand edit/, 'file must remain untouched when --force is refused for being uncommitted');
});

test('(e) a second feature touching the same resource type takes over ownership with a WARN note, not a conflict', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	runWorkflowThroughContract(root, '002-widget-extras', 'widget-extras');
	const emit2 = run(['handles', 'emit', '--feature', '002-widget-extras', '--json'], root);
	assert.equal(emit2.code, 0);
	const emit2Json = JSON.parse(emit2.stdout);
	assert.equal(emit2Json.conflicts.length, 0, 'an untouched resolver owned by a different feature must NOT conflict -- this is the FEATURE_ID-baked-into-the-template hole caught during planning');
	assert.ok(
		emit2Json.notes.some((n) => n.includes('ownership transfer') && n.includes('001-widget-management') && n.includes('002-widget-extras')),
		`expected an ownership-transfer note, got: ${JSON.stringify(emit2Json.notes)}`,
	);

	const content = fs.readFileSync(path.join(root, RESOLVER_REL_PATH), 'utf8');
	assert.match(content, /for feature 002-widget-extras\./);

	const manifest = readManifest(root);
	assert.equal(manifest.files[RESOLVER_REL_PATH].owner, '002-widget-extras');
});

test('(f) a resolver whose plan flips willGenerateResolver to false becomes an orphan warning, never deleted or rewritten; --resource suppresses it', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);
	const resolverPath = path.join(root, RESOLVER_REL_PATH);
	const before = fs.readFileSync(resolverPath, 'utf8');

	// D-security-8: a 2-argument service method blocks resolver generation.
	const servicePath = path.join(root, 'src/main/java/com/example/domain/widget/application/WidgetService.java');
	fs.writeFileSync(servicePath, `
package com.example.domain.widget.application;
public interface WidgetService {
	Object findWidget(java.util.UUID orgId, java.util.UUID id);
}
`);

	const emit2 = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit2.code, 0);
	const emit2Json = JSON.parse(emit2.stdout);
	assert.ok(emit2Json.orphans.some((o) => o.resourceType === 'Widget'), `expected a Widget orphan warning, got: ${JSON.stringify(emit2Json.orphans)}`);
	assert.equal(fs.readFileSync(resolverPath, 'utf8'), before, 'orphaned resolver must be left byte-for-byte untouched');

	// Scoping to the same (now-orphaned) resource must suppress orphan reporting entirely --
	// otherwise every --resource-scoped run would falsely report everything outside its scope.
	const emit3 = run(['handles', 'emit', '--feature', '001-widget-management', '--resource', 'Widget', '--json'], root);
	assert.equal(emit3.code, 0);
	const emit3Json = JSON.parse(emit3.stdout);
	assert.equal(emit3Json.orphans.length, 0, 'orphan detection must be suppressed entirely when --resource narrows the run');
});

test('(g) deleting the manifest (fresh-checkout simulation) silently re-adopts untouched files, but still fails closed on a genuinely edited one', () => {
	const root = buildFixtureRepo();
	setupFirstFeature(root);
	run(['handles', 'emit', '--feature', '001-widget-management'], root);

	fs.rmSync(path.join(root, MANIFEST_REL_PATH));
	const emit2 = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit2.code, 0);
	const emit2Json = JSON.parse(emit2.stdout);
	assert.equal(emit2Json.conflicts.length, 0, 'untouched files must silently re-adopt, not conflict, when the manifest is missing');

	const manifest = readManifest(root);
	assert.equal(manifest.files[RESOLVER_REL_PATH].owner, '001-widget-management', "owner must be recovered from the file's own javadoc marker");

	// Sibling case: delete the manifest AND hand-edit the resolver -> must still fail closed.
	fs.rmSync(path.join(root, MANIFEST_REL_PATH));
	const resolverPath = path.join(root, RESOLVER_REL_PATH);
	fs.writeFileSync(resolverPath, `${fs.readFileSync(resolverPath, 'utf8')}\n// edited\n`);
	const emit3 = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit3.code, 15, 'the adoption path must still fail closed when the manifest is absent AND the file has genuinely diverged');
});
