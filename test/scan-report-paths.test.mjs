// D-scan-report-portable-paths: unit coverage for `hydrateScanReportFilePaths()`/
// `dehydrateScanReportFilePaths()`, plus the real portability regression test -- the actual bug's
// own reproduction, formalized. Found live: `bskel verify` against a real, already-committed
// feature branch (Team-IZ/Backend's `feat/handles-pilot-cohort`) returned FAIL from a second git
// worktree of the SAME branch, on files confirmed completely unmodified -- `contract` gate's
// `path.relative(root, item.file)` against a stale, committed ABSOLUTE `.file` (baked in from
// wherever `bskel scan` originally ran) produced a garbage multi-`../` key once `root` pointed
// somewhere else. This file locks in both the fix (`.file` is converted to repo-relative ONLY at
// the real disk-write boundary, `cmdScan` -- adapters themselves keep producing absolute `.file`,
// unchanged, since a real, widely-used pattern in this project's own test suite calls `runScan()`
// directly with no disk round-trip at all) and the specific real-world trigger (the same repo,
// checked out to a genuinely different absolute directory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hydrateScanReportFilePaths, dehydrateScanReportFilePaths } from '../lib/scan-report-paths.mjs';

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

test('hydrateScanReportFilePaths: a relative .file is joined against repoRoot', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [{ className: 'WidgetController', file: 'src/main/java/Widget.java' }], entities: [], enums: [], dtos: [] }] };
	const hydrated = hydrateScanReportFilePaths(report, '/repo');
	assert.equal(hydrated.related_modules[0].controllers[0].file, path.join('/repo', 'src/main/java/Widget.java'));
});

test('hydrateScanReportFilePaths: an already-absolute .file (legacy shape) passes through unchanged -- a correct no-op, not a bug', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [], entities: [{ className: 'Widget', file: '/some/other/worktree/Widget.java' }], enums: [], dtos: [] }] };
	const hydrated = hydrateScanReportFilePaths(report, '/repo');
	assert.equal(hydrated.related_modules[0].entities[0].file, '/some/other/worktree/Widget.java');
});

test('hydrateScanReportFilePaths: covers controllers/entities/enums/dtos, and a missing .file is left alone (never invented)', () => {
	const report = {
		related_modules: [{
			module: 'widget',
			controllers: [{ className: 'C', file: 'C.java' }],
			entities: [{ className: 'E', file: 'E.java' }],
			enums: [{ className: 'En', file: 'En.java' }],
			dtos: [{ className: 'D', file: 'D.java' }, { className: 'NoFile' }],
		}],
	};
	const hydrated = hydrateScanReportFilePaths(report, '/repo');
	assert.equal(hydrated.related_modules[0].controllers[0].file, path.join('/repo', 'C.java'));
	assert.equal(hydrated.related_modules[0].entities[0].file, path.join('/repo', 'E.java'));
	assert.equal(hydrated.related_modules[0].enums[0].file, path.join('/repo', 'En.java'));
	assert.equal(hydrated.related_modules[0].dtos[0].file, path.join('/repo', 'D.java'));
	assert.equal(hydrated.related_modules[0].dtos[1].file, undefined);
});

test('hydrateScanReportFilePaths: a null/empty report is a safe no-op (matches the existing readJsonIfExists "report may be null" contract every caller already handles)', () => {
	assert.equal(hydrateScanReportFilePaths(null, '/repo'), null);
	assert.deepEqual(hydrateScanReportFilePaths({}, '/repo'), {});
	assert.deepEqual(hydrateScanReportFilePaths({ related_modules: [] }, '/repo'), { related_modules: [] });
});

test('hydrateScanReportFilePaths: does not mutate its input -- the caller still holds an independently-usable original', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [{ className: 'C', file: 'C.java' }], entities: [], enums: [], dtos: [] }] };
	hydrateScanReportFilePaths(report, '/repo');
	assert.equal(report.related_modules[0].controllers[0].file, 'C.java', 'the original object must be untouched');
});

test('dehydrateScanReportFilePaths: an absolute .file under repoRoot becomes repo-relative', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [{ className: 'WidgetController', file: '/repo/src/main/java/Widget.java' }], entities: [], enums: [], dtos: [] }] };
	const dehydrated = dehydrateScanReportFilePaths(report, '/repo');
	assert.equal(dehydrated.related_modules[0].controllers[0].file, path.relative('/repo', '/repo/src/main/java/Widget.java'));
});

test('dehydrateScanReportFilePaths: an already-relative .file passes through unchanged -- a correct no-op', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [], entities: [{ className: 'Widget', file: 'src/main/java/Widget.java' }], enums: [], dtos: [] }] };
	const dehydrated = dehydrateScanReportFilePaths(report, '/repo');
	assert.equal(dehydrated.related_modules[0].entities[0].file, 'src/main/java/Widget.java');
});

test('dehydrateScanReportFilePaths: does not mutate its input, and round-trips losslessly through hydrateScanReportFilePaths', () => {
	const report = { related_modules: [{ module: 'widget', controllers: [{ className: 'C', file: '/repo/src/C.java' }], entities: [], enums: [], dtos: [] }] };
	const dehydrated = dehydrateScanReportFilePaths(report, '/repo');
	assert.equal(report.related_modules[0].controllers[0].file, '/repo/src/C.java', 'the original object must be untouched');
	const roundTripped = hydrateScanReportFilePaths(dehydrated, '/repo');
	assert.equal(roundTripped.related_modules[0].controllers[0].file, '/repo/src/C.java');
});

// The real bug's own reproduction: scan a fixture repo, then physically COPY the entire directory
// tree to a second, genuinely different absolute location (not just a second git worktree of the
// same clone -- the failure is about the absolute path baked into the committed JSON not matching
// wherever it's read from next, which a plain directory copy reproduces just as validly and far
// more cheaply than standing up a second real worktree).
function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-portability-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-portability-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return { root, bareOrigin };
}

function copyDirRecursive(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDirRecursive(s, d);
		else fs.copyFileSync(s, d);
	}
}

test('portability regression: a scan report checked out to a DIFFERENT absolute location still reports genuinely unmodified files as non-stale -- this is the real bug', () => {
	const { root: originalRoot } = buildFixtureRepo();
	assert.equal(run(['preflight'], originalRoot).code, 0);
	run(['feature', 'init', '--slug', 'widget-management'], originalRoot);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], originalRoot).code, 3);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'test note'], originalRoot).code, 0);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], originalRoot).code, 0);
	// real feature work commits specs/ (only .sbf/ is gitignored, matching the real convention
	// confirmed against a real committed feature branch) -- without this, the working tree is
	// genuinely dirty (untracked specs/ files) and `preflight` on the copy below would correctly,
	// but irrelevantly, refuse for an unrelated reason.
	execFileSync('git', ['add', '-A'], { cwd: originalRoot });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: real feature artifacts'], { cwd: originalRoot });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: originalRoot });

	// sanity: the committed report really is repo-relative now (the actual fix) -- if this ever
	// regresses back to absolute, the rest of this test would pass FOR THE WRONG REASON (the copy
	// below would coincidentally still resolve `.file` under its own new root only by accident of
	// `path.isAbsolute` never being true to begin with).
	const reportPath = path.join(originalRoot, 'specs', '001-widget-management', 'brownfield-scan.json');
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	assert.ok(!path.isAbsolute(report.related_modules[0].controllers[0].file), 'the committed report must be repo-relative, or this whole fix regressed');

	// a genuinely different absolute directory -- NOT a git worktree of the same clone, a real
	// physical copy, mirroring "a different developer's clone" or "a CI runner's own checkout"
	// more directly than a worktree would.
	const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-portability-COPY-'));
	fs.rmSync(copyRoot, { recursive: true, force: true });
	copyDirRecursive(originalRoot, copyRoot);
	assert.notEqual(copyRoot, originalRoot);

	// the copied checkout's own git remote still points at the original bare origin -- real
	// `preflight` needs this to succeed on the copy too.
	const preflight = run(['preflight'], copyRoot);
	assert.equal(preflight.code, 0, preflight.stderr);

	// the real assertion: every gate that reads `.file` reports non-stale from the NEW location,
	// on files nobody touched.
	const scanRequire = run(['gate', 'require', 'scan', '--feature', '001-widget-management'], copyRoot);
	assert.equal(scanRequire.code, 0, `scan gate: ${scanRequire.stderr}`);
	const contractRequire = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], copyRoot);
	assert.equal(contractRequire.code, 0, `contract gate: ${contractRequire.stderr} -- this is exactly the real bug (reproduced via D-scan-report-portable-paths) if it fails`);

	// and the real, previously-broken downstream commands work correctly from the new location too.
	const handlesPlan = run(['handles', 'emit', '--feature', '001-widget-management', '--check'], copyRoot);
	assert.notEqual(handlesPlan.code, 17, 'handles plan/emit should not be blocked by a missing/unreadable source file from the new location');
});
