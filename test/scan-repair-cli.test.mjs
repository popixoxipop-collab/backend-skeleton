// D-scan-report-portable-paths: `bskel scan repair` -- a one-time, non-destructive migration for a
// committed brownfield-scan.json written before this fix (schema "sbf.scan-report/1", `.file`
// absolute). Deliberately NOT tested via a hand-rolled "old bskel" binary -- the real, simplest way
// to get an old-shape report is to run a real (post-fix) scan, then hand-mutate the resulting
// committed JSON back to the pre-fix shape (schema "/1", `.file` re-absolutized) -- exactly what a
// real repo checked out from before this fix would look like on disk, without needing to check out
// an old git revision of this CLI itself.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-repair-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const pkgDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation');
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, 'WidgetController.java'), `
package com.example.domain.widget.presentation;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import io.swagger.v3.oas.annotations.Operation;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() {
		return "ok";
	}
}
`);
	fs.writeFileSync(path.join(root, '.gitignore'), '.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-repair-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

// Real scan (post-fix, schema "/2", `.file` relative) -> hand-mutate back to the pre-fix shape
// (schema "/1", `.file` re-absolutized against `root`) -- simulates a real repo checked out from
// before this fix, without needing an old git revision of the CLI itself.
function downgradeToLegacyShape(root, featureId) {
	const reportPath = path.join(root, 'specs', featureId, 'brownfield-scan.json');
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	report.schema = 'sbf.scan-report/1';
	for (const mod of report.related_modules ?? []) {
		for (const key of ['controllers', 'entities', 'enums', 'dtos']) {
			for (const item of mod[key] ?? []) {
				if (item.file) item.file = path.join(root, item.file);
			}
		}
	}
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function setUpDisposedFeature(root) {
	assert.equal(run(['preflight'], root).code, 0);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 3, 'collision should block with AWAITING_DISPOSITION exit code (matches scan-cli.test.mjs\'s own real fixture behavior for this exact shape)');
	const disposition = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'test note'], root);
	assert.equal(disposition.code, 0, disposition.stderr);
	downgradeToLegacyShape(root, '001-widget-management');
}

test('happy path: repairs a legacy (schema /1, absolute .file) report to schema /2 with repo-relative .file, disposition byte-identical', () => {
	const root = buildFixtureRepo();
	setUpDisposedFeature(root);
	const reportPath = path.join(root, 'specs', '001-widget-management', 'brownfield-scan.json');
	const before = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	assert.equal(before.schema, 'sbf.scan-report/1');
	const beforeFile = before.related_modules[0].controllers[0].file;
	assert.ok(path.isAbsolute(beforeFile), 'legacy fixture should have an absolute .file to repair');

	const repair = run(['scan', 'repair', '--feature', '001-widget-management', '--json'], root);
	assert.equal(repair.code, 0, repair.stderr);
	const result = JSON.parse(repair.stdout);
	assert.equal(result.schema, 'sbf.scan-report/2');
	assert.equal(result.repaired, true);

	const after = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	assert.equal(after.schema, 'sbf.scan-report/2');
	const afterFile = after.related_modules[0].controllers[0].file;
	assert.ok(!path.isAbsolute(afterFile), 'repaired .file should be repo-relative');
	assert.equal(path.join(root, afterFile), beforeFile, 'repaired relative path must resolve to the same real file');

	// disposition (and everything else) untouched -- only `.file` strings and `schema` were mutated.
	assert.deepEqual(after.disposition, before.disposition);
	assert.equal(after.verdict, before.verdict);
	assert.equal(JSON.stringify(after.related_modules[0].controllers[0].className), JSON.stringify(before.related_modules[0].controllers[0].className));
});

test('refuses (fails closed) when a referenced file does not resolve under the current root, naming the exact file, rather than guessing', () => {
	const root = buildFixtureRepo();
	setUpDisposedFeature(root);
	const reportPath = path.join(root, 'specs', '001-widget-management', 'brownfield-scan.json');
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	const originalFile = report.related_modules[0].controllers[0].file;
	report.related_modules[0].controllers[0].file = path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation', 'DoesNotExist.java');
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

	const repair = run(['scan', 'repair', '--feature', '001-widget-management', '--json'], root);
	assert.equal(repair.code, 14, 'BAD_ARGS');
	assert.ok(repair.stderr.includes('DoesNotExist.java'), 'must name the exact unresolvable file');

	// refusal must not have written anything -- the report on disk is untouched.
	const stillOnDisk = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	assert.equal(stillOnDisk.schema, 'sbf.scan-report/1');
	assert.equal(stillOnDisk.related_modules[0].controllers[0].file, path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation', 'DoesNotExist.java'));
	void originalFile;
});

test('refuses on an already-repaired (schema /2) report -- idempotence guard, not a silent no-op', () => {
	const root = buildFixtureRepo();
	setUpDisposedFeature(root);
	const first = run(['scan', 'repair', '--feature', '001-widget-management', '--json'], root);
	assert.equal(first.code, 0);

	const second = run(['scan', 'repair', '--feature', '001-widget-management'], root);
	assert.equal(second.code, 14, 'BAD_ARGS');
	assert.ok(second.stderr.includes('already schema'));
});

test('contract emit is correctly blocked (fail closed, not a crash) against a legacy report, and succeeds once repaired', () => {
	const root = buildFixtureRepo();
	setUpDisposedFeature(root); // ends legacy-shape (schema /1)

	// The test fixture's own downgrade rewrites brownfield-scan.json's bytes directly (simulating
	// what an old bskel would have written), which -- unlike a real `git checkout` of an old
	// branch, which preserves file bytes exactly -- also invalidates the `scan` gate's own stored
	// token (its recompute hashes the report file too). Either way the real report is correctly
	// refused, not silently mishandled -- this asserts that, without pinning to whichever specific
	// gate fires first, which is an artifact of this simulation technique, not the real bug.
	const blockedEmit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.notEqual(blockedEmit.code, 0, 'a legacy-shape report must never silently produce a contract with wrong absolute paths baked in');

	const repair = run(['scan', 'repair', '--feature', '001-widget-management'], root);
	assert.equal(repair.code, 0, repair.stderr);
	// re-establish the scan gate against the now-repaired bytes (repair() only touches `.file`/
	// `schema`, not other gates' stored tokens) -- a real fresh checkout of an old branch would
	// never have had a LOCAL scan-gate token to begin with, so this has no real-world analogue;
	// it exists only to isolate this test to the actual claim: a repaired report works.
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'test note'], root).code, 0);

	const fixedEmit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(fixedEmit.code, 0, fixedEmit.stderr);
});

test('the contract gate goes stale on an absolute .file that no longer resolves correctly, and clears once it is repo-relative again -- the real bug this whole fix closes', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root).code, 3);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'test note'], root).code, 0);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0, 'contract gate should pass cleanly on the natural (schema /2, relative .file) shape');

	// Reproduce the real bug directly at the gate level: `contract` gate's staleness key is
	// path.relative(root, item.file) against the hydrated (re-absolutized) value -- a `.file`
	// that is WRONG for the current root (e.g. baked in from a different worktree/clone) produces
	// a garbage key that never matches what was stored when the gate last passed, on a file that
	// was never actually touched.
	const reportPath = path.join(root, 'specs', '001-widget-management', 'brownfield-scan.json');
	// captured as RAW BYTES, not re-serialized JSON -- `scan_report_hash` is a whole-file content
	// hash, so restoring "equivalent" JSON with different key order/whitespace would itself count
	// as a real change and mask the very thing this test isolates (the `.file` field's own effect).
	const originalBytes = fs.readFileSync(reportPath);
	const report = JSON.parse(originalBytes.toString('utf8'));
	const correctRelativeFile = report.related_modules[0].controllers[0].file;
	assert.ok(!path.isAbsolute(correctRelativeFile));
	report.related_modules[0].controllers[0].file = '/some/other/worktree/entirely/WidgetController.java';
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

	const staleRequire = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(staleRequire.code, 4, 'STALE -- reproduces the real bug on an unmodified file');

	// restore the EXACT original bytes -- the gate must recognize the file as genuinely
	// unmodified again, since nothing about it actually changed.
	fs.writeFileSync(reportPath, originalBytes);
	void correctRelativeFile;

	const fixedRequire = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(fixedRequire.code, 0, 'contract gate must be non-stale once .file is portable again, on a genuinely unmodified file');
});
