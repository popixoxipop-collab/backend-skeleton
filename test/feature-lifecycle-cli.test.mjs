// D6 (D-feature-lifecycle): `feature list/show/rename/link/archive`, plus the `feature init`
// race fix. Fixture/`run()` conventions copied from test/contract-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-feature-lifecycle-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	const base = 'com/example';
	const widgetDomain = path.join(root, 'src/main/java', base, 'domain/widget');
	fs.mkdirSync(path.join(widgetDomain, 'presentation'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'domain'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'application'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src/main/java', base), { recursive: true });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');
	fs.writeFileSync(path.join(root, 'src/main/java', base, 'ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
@RestController
@RequestMapping("/widgets")
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-feature-lifecycle-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughHandlesEmit(root, featureId, slug) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', slug], root);
	run(['scan', '--feature', featureId, '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', featureId, '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', featureId], root);
	run(['scan', 'cross-feature-check', '--feature', featureId], root); // D-cross-feature-collision: single-feature fixture, always passes
	run(['handles', 'emit', '--feature', featureId], root);
}

// ===== feature init race fix =====

test('feature init: 20 real concurrent processes (same slug) all succeed with distinct feature_ids, and feature-index.json loses nothing', async () => {
	const root = buildFixtureRepo();
	execFileSync('node', [CLI, 'preflight'], { cwd: root });

	const N = 20;
	const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
		const child = spawn('node', [CLI, 'feature', 'init', '--slug', 'race-test'], { cwd: root });
		let stdout = '';
		child.stdout.on('data', (d) => { stdout += d; });
		child.on('exit', (code) => resolve({ code, stdout: stdout.trim() }));
	})));

	assert.ok(results.every((r) => r.code === 0), `expected all ${N} processes to succeed: ${JSON.stringify(results)}`);
	const featureIds = results.map((r) => JSON.parse(r.stdout).feature_id);
	assert.equal(new Set(featureIds).size, N, `expected ${N} distinct feature_ids, got: ${JSON.stringify(featureIds)}`);

	const specsDirs = fs.readdirSync(path.join(root, 'specs')).sort();
	assert.equal(specsDirs.length, N);

	const index = JSON.parse(fs.readFileSync(path.join(root, '.sbf', 'feature-index.json'), 'utf8'));
	const indexedIds = new Set(Object.values(index.by_uid).flat());
	assert.equal(indexedIds.size, N, 'feature-index.json must record every one of the N feature_ids, none lost to a lost-update race');
	assert.ok(specsDirs.every((id) => indexedIds.has(id)));
});

// ===== feature list / show =====

test('feature list: empty repo, then shows created features in feature_id order, archived hidden by default', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	assert.match(run(['feature', 'list'], root).stdout, /no features found/);

	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['feature', 'init', '--slug', 'another-thing'], root);
	const listed = JSON.parse(run(['feature', 'list', '--json'], root).stdout);
	assert.deepEqual(listed.map((f) => f.feature_id), ['001-widget-management', '002-another-thing']);

	run(['feature', 'archive', '002-another-thing', '--reason', 'superseded'], root);
	const afterArchive = JSON.parse(run(['feature', 'list', '--json'], root).stdout);
	assert.deepEqual(afterArchive.map((f) => f.feature_id), ['001-widget-management']);
	const withAll = JSON.parse(run(['feature', 'list', '--all', '--json'], root).stdout);
	assert.equal(withAll.length, 2);
	assert.equal(withAll.find((f) => f.feature_id === '002-another-thing').archived_reason, 'superseded');
});

test('feature show: known id reports identity fields + artifact existence; unknown id fails cleanly', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);

	const body = JSON.parse(run(['feature', 'show', '001-widget-management', '--json'], root).stdout);
	assert.equal(body.feature_id, '001-widget-management');
	assert.equal(body.artifacts.contract_emitted, false);
	assert.deepEqual(body.rename_history, ['001-widget-management']);

	const result = run(['feature', 'show', '999-nope'], root);
	assert.equal(result.code, 2);
});

// ===== feature rename =====

test('feature rename: full migration -- directory + .sbf state + history moved, old id cleanly fails everywhere, gate stays pass (not falsely stale)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughHandlesEmit(root, '001-widget-management', 'widget-management');
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	assert.equal(run(['feature', 'rename', '001-widget-management', '--to', 'widget-mgmt-v2'], root).code, 14, '--reason is required');

	const result = run(['feature', 'rename', '001-widget-management', '--to', 'widget-mgmt-v2', '--reason', 'typo in original slug', '--json'], root);
	assert.equal(result.code, 0);
	const renamed = JSON.parse(result.stdout);
	assert.equal(renamed.feature_id, '001-widget-mgmt-v2');

	assert.deepEqual(fs.readdirSync(path.join(root, 'specs')).sort(), ['001-widget-mgmt-v2']);
	assert.ok(fs.existsSync(path.join(root, '.sbf', '001-widget-mgmt-v2.json')));
	assert.ok(fs.existsSync(path.join(root, '.sbf', '001-widget-mgmt-v2.history.jsonl')));
	assert.ok(!fs.existsSync(path.join(root, '.sbf', '001-widget-management.json')));

	const newState = JSON.parse(fs.readFileSync(path.join(root, '.sbf', '001-widget-mgmt-v2.json'), 'utf8'));
	assert.equal(newState.feature_id, '001-widget-mgmt-v2');

	const manifest = JSON.parse(fs.readFileSync(path.join(root, '.sbf', 'handles-manifest.json'), 'utf8'));
	assert.ok(Object.values(manifest.files).some((f) => f.owner === '001-widget-mgmt-v2'));
	assert.ok(!Object.values(manifest.files).some((f) => f.owner === '001-widget-management'));

	// The gate must NOT go stale purely from the rename -- confirmed live during this item's own
	// grounding that an early draft rewrote contract/scan artifact CONTENT (their own feature_id
	// field), which silently invalidated the gate's content-hash token. Content here must stay
	// byte-identical; only filenames move.
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-mgmt-v2'], root).code, 0, 'the contract gate must still read as pass on the new id, not spuriously stale');

	// The old id is genuinely retired -- every other command fails cleanly against it.
	assert.equal(run(['feature', 'show', '001-widget-management'], root).code, 2);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 2);
});

// Renaming preserves the source feature's own NNN prefix (only the slug changes), so two
// DIFFERENT features (necessarily different NNNs, minted by feature init) can never collide via
// rename -- the only genuinely reachable collision is a feature reusing one of its OWN retired
// ids from an earlier rename. Confirmed live during this item's own grounding before writing
// this assertion: a same-NNN "collide with an unrelated existing feature" scenario is not a real
// reachable case, so this test does not attempt one.
test('feature rename: renaming back to one of its own RETIRED ids is rejected before any mutation', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'another-thing'], root);

	assert.equal(run(['feature', 'rename', '001-another-thing', '--to', 'widget-mgmt-v2', '--reason', 'first rename'], root).code, 0);
	const collideRetired = run(['feature', 'rename', '001-widget-mgmt-v2', '--to', 'another-thing', '--reason', 'reuse a retired id'], root);
	assert.equal(collideRetired.code, 14);
	assert.ok(fs.existsSync(path.join(root, 'specs', '001-widget-mgmt-v2')), 'the failed rename must not have touched the current directory');
});

test('feature rename: a collision failure does not leave the feature-index lock behind (the very next lifecycle command must not hang)', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'another-thing'], root);
	assert.equal(run(['feature', 'rename', '001-another-thing', '--to', 'widget-mgmt-v2', '--reason', 'first rename'], root).code, 0);

	const failed = run(['feature', 'rename', '001-widget-mgmt-v2', '--to', 'another-thing', '--reason', 'reuse a retired id'], root);
	assert.equal(failed.code, 14);
	assert.ok(!fs.existsSync(path.join(root, '.sbf', '.locks', 'feature-index.lock')), 'the lock must be released even when the locked callback fails');

	// A second lifecycle command right after must succeed immediately, not hang waiting on a
	// stale lock -- this is the actual regression this item's own grounding found live: an
	// earlier draft called fail() (process.exit()) from inside withLockSync()'s callback, which
	// skips lib/lock.mjs's own `finally` cleanup and hangs every subsequent call.
	const next = run(['feature', 'archive', '001-widget-mgmt-v2', '--reason', 'cleanup'], root);
	assert.equal(next.code, 0);
});

// ===== feature link =====

test('feature link: index-only -- both features\' specs/.sbf/ files stay completely untouched', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['feature', 'init', '--slug', 'another-thing'], root);

	assert.equal(run(['feature', 'link', '001-widget-management', '002-another-thing'], root).code, 14, '--reason is required');
	assert.equal(run(['feature', 'link', '001-widget-management', '001-widget-management'], root).code, 14, 'two different ids are required');

	const before = fs.readFileSync(path.join(root, 'specs', '002-another-thing', 'feature.json'), 'utf8');
	const result = run(['feature', 'link', '001-widget-management', '002-another-thing', '--reason', 'these are the same feature', '--json'], root);
	assert.equal(result.code, 0);
	assert.equal(JSON.parse(result.stdout).merged_into['002-another-thing'], '001-widget-management');
	assert.equal(fs.readFileSync(path.join(root, 'specs', '002-another-thing', 'feature.json'), 'utf8'), before, 'link must not touch the aliased feature\'s own files');

	const shown = JSON.parse(run(['feature', 'show', '002-another-thing', '--json'], root).stdout);
	assert.equal(shown.merged_into, '001-widget-management');
});

// ===== feature archive =====

test('feature archive: soft-delete only -- no filesystem move, still fully usable when targeted explicitly', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);

	assert.equal(run(['feature', 'archive', '001-widget-management'], root).code, 14, '--reason is required');

	const result = run(['feature', 'archive', '001-widget-management', '--reason', 'superseded', '--json'], root);
	assert.equal(result.code, 0);
	assert.ok(JSON.parse(result.stdout).archived_at);
	assert.ok(fs.existsSync(path.join(root, 'specs', '001-widget-management', 'feature.json')), 'archive must not move anything');

	// Still fully usable when targeted explicitly (soft-delete, not a real removal) -- the full
	// scan -> disposition -> contract gate sequence still works normally on an archived feature.
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
});
