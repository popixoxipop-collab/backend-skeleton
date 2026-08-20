// End-to-end CLI test for `bskel scan` / `bskel scan disposition` against a tiny synthetic
// Spring Boot fixture (not the real Team-IZ-Backend repo -- that's covered by scan.test.mjs's
// oracle). Locks in the full collision -> blocked -> disposition -> unblocked flow manually
// verified against Team-IZ-Backend during Phase 2 development.
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

// Process-exit audit (post-A3): `manyEndpoints` (default 0, preserving every existing assertion
// byte-for-byte) opt-in adds N extra @GetMapping endpoints to WidgetController, used only by the
// large-scan-report regression test below -- a single controller with many endpoints keeps the
// fixture cheap to build (one file write) while still crossing the 64KB scan-report boundary that
// exposed the cmdScan pipe-truncation bug.
function manyEndpointsSource(count) {
	const methods = [];
	for (let i = 0; i < count; i++) {
		methods.push(`
	@Operation(operationId = "findWidget${i}")
	@GetMapping("/${i}")
	public String findWidget${i}() {
		return "ok";
	}`);
	}
	return methods.join('\n');
}

// A1 §7: `withGlobalPathPrefix` (default false, preserving every existing assertion byte-for-byte)
// opt-in adds a real WebMvcConfigurer.configurePathMatch + addPathPrefix and a springdoc
// paths-to-match, mirroring Team-IZ-Backend's actual ApiPathConfig.java/application.yaml shape.
function buildFixtureRepo({ withGlobalPathPrefix = false, manyEndpoints = 0 } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-cli-fixture-'));
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
${manyEndpoints > 0 ? manyEndpointsSource(manyEndpoints) : ''}
}
`);
	if (withGlobalPathPrefix) {
		const configDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'global', 'config');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, 'ApiPathConfig.java'), `
package com.example.global.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.HandlerTypePredicate;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class ApiPathConfig implements WebMvcConfigurer {

	@Override
	public void configurePathMatch(PathMatchConfigurer configurer) {
		configurer.addPathPrefix(
				"/api/v0",
				HandlerTypePredicate.forBasePackage("com.example.domain")
		);
	}
}
`);
		const resourcesDir = path.join(root, 'src', 'main', 'resources');
		fs.mkdirSync(resourcesDir, { recursive: true });
		fs.writeFileSync(path.join(resourcesDir, 'application.yaml'), `
springdoc:
  paths-to-match: /api/v0/**
`);
	}
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	// `bskel scan --feature` requires the `preflight` gate to have passed (see
	// requirePreflightPassed in bin/bskel.mjs), which needs a real "origin" to cross-check the
	// default branch against.
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('scan -> blocked -> disposition -> unblocked, full CLI flow', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);

	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 3, 'collision should block with AWAITING_DISPOSITION exit code');
	const report = JSON.parse(scan.stdout);
	assert.equal(report.verdict, 'collision');
	assert.ok(report.related_modules.some((m) => m.module === 'widget'));

	const blockedRequire = run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root);
	assert.equal(blockedRequire.code, 3);

	const disposition = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'test note'], root);
	assert.equal(disposition.code, 0);

	const passedRequire = run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root);
	assert.equal(passedRequire.code, 0);

	assert.ok(fs.existsSync(path.join(root, 'specs/001-widget-management/plan-constraints.md')));
	const constraints = fs.readFileSync(path.join(root, 'specs/001-widget-management/plan-constraints.md'), 'utf8');
	assert.match(constraints, /MUST NOT create new entities\/controllers\/endpoints/);
});

test('scan without --feature is ad-hoc: no files written, no gate touched', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget'], root);
	assert.equal(scan.code, 0);
	assert.ok(!fs.existsSync(path.join(root, 'specs')), 'ad-hoc scan must not write specs/');
	assert.ok(!fs.existsSync(path.join(root, '.sbf')), 'ad-hoc scan must not write .sbf/');
});

// Process-exit audit (post-A3): the same pipe-truncation bug class found in cmdContractEmit also
// lived in both of cmdScan's exit points -- console.log(JSON.stringify(report)) immediately
// followed by process.exit(). Reproduced live during Team-IZ-Backend verification: `scan --terms
// a --json` (a deliberately broad term matching 16 real modules) produced a correct 177583-byte
// report that a piped capture truncated at exactly 65536 bytes. Fixed by setting process.exitCode
// instead of calling process.exit() at both cmdScan exit points. This fixture forces a >64KB
// report with one controller carrying many endpoints, exercising the ad-hoc (no --feature) exit.
test('regression: a >64KB ad-hoc scan --json report is not truncated when captured via execFileSync (pipe-buffer-sized cutoff bug)', () => {
	const root = buildFixtureRepo({ manyEndpoints: 600 });
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 0);
	assert.ok(scan.stdout.length > 65536, `fixture must actually exceed the 64KB boundary that exposed the bug (got ${scan.stdout.length} bytes)`);
	assert.doesNotThrow(() => JSON.parse(scan.stdout), 'output must be complete, valid JSON -- not truncated mid-write');
	const report = JSON.parse(scan.stdout);
	assert.ok(report.related_modules.some((m) => m.module === 'widget'));
	// The ad-hoc exit is a guard clause (needs `return;`, not just `exitCode =`) -- if that
	// `return` were ever dropped, execution would fall through into the --feature write path below.
	assert.ok(!fs.existsSync(path.join(root, 'specs')), 'ad-hoc scan must not write specs/ (guard-clause fallthrough check)');
	assert.ok(!fs.existsSync(path.join(root, '.sbf')), 'ad-hoc scan must not write .sbf/ (guard-clause fallthrough check)');
});

// Same bug, the other cmdScan exit point: the `--feature` tail exit (after scan/disposition/gate
// logic). Uses a matching term so the many-endpoint module is actually included in
// related_modules (an unrelated term would score 0 and stay small regardless of endpoint count) --
// that makes the verdict 'collision' (AWAITING_DISPOSITION), same as the full-flow test above.
test('regression: a >64KB --feature scan --json report is not truncated when captured via execFileSync (pipe-buffer-sized cutoff bug)', () => {
	const root = buildFixtureRepo({ manyEndpoints: 600 });
	assert.equal(run(['preflight'], root).code, 0);
	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 3, 'collision should block with AWAITING_DISPOSITION exit code');
	assert.ok(scan.stdout.length > 65536, `fixture must actually exceed the 64KB boundary that exposed the bug (got ${scan.stdout.length} bytes)`);
	assert.doesNotThrow(() => JSON.parse(scan.stdout), 'output must be complete, valid JSON -- not truncated mid-write');
	const report = JSON.parse(scan.stdout);
	assert.equal(report.verdict, 'collision');
});

test('scan disposition --mode replace requires --breaking-approved', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	const rejected = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'replace'], root);
	assert.equal(rejected.code, 14);
	const accepted = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'replace', '--breaking-approved'], root);
	assert.equal(accepted.code, 0);
});

// D-security-3 regression: `gate require/force/show` must reject a `--feature` that isn't
// either the repo-scoped sentinel or a real feature_id -- reproduces the exact traversal shape
// (writing/reading a state file outside .sbf/) the Codex security review verified before the fix.
test('gate require/force/show reject path-traversal-shaped --feature values', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const outsideMarker = path.join(root, '..', 'evil.json');
	fs.rmSync(outsideMarker, { force: true });

	for (const evil of ['../../evil', '..', '/etc/passwd', '001-fine/../../evil']) {
		const req = run(['gate', 'require', 'scan', '--feature', evil], root);
		assert.equal(req.code, 14, `gate require --feature "${evil}" must be rejected`);

		const force = run(['gate', 'force', 'scan', '--feature', evil, '--reason', 'test'], root);
		assert.equal(force.code, 14, `gate force --feature "${evil}" must be rejected`);
		assert.ok(!fs.existsSync(outsideMarker), `gate force --feature "${evil}" must not write outside .sbf/`);

		const show = run(['gate', 'show', '--feature', evil], root);
		assert.equal(show.code, 14, `gate show --feature "${evil}" must be rejected`);
	}

	// Sanity: the sentinel and a real feature_id still work after the validation was added.
	assert.equal(run(['gate', 'show'], root).code, 0);
});

test('scan for an unrelated term on the same fixture is greenfield and auto-passes', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const scan = run(['scan', '--feature', '002-completely-unrelated', '--terms', 'zzznonexistentzzz', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.verdict, 'greenfield');
	const gateResult = run(['gate', 'require', 'scan', '--feature', '002-completely-unrelated'], root);
	assert.equal(gateResult.code, 0);
});

// A1 §7 regression suite below: the scanner's own global-path-prefix detector.

test('a fixture with no WebMvcConfigurer/application.yaml reports zero path_prefix_signals (regression: opt-in default is inert)', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.deepEqual(report.path_prefix_signals, []);
	assert.ok(!report.unknowns.some((u) => u.includes('global path prefix')));
});

test('a fixture with ApiPathConfig.java + springdoc.paths-to-match: both signals detected, and the markdown output warns with --openapi-file guidance', () => {
	const root = buildFixtureRepo({ withGlobalPathPrefix: true });
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	const byKind = Object.fromEntries(report.path_prefix_signals.map((s) => [s.kind, s]));
	assert.equal(byKind.configurePathMatch.prefix, '/api/v0');
	assert.match(byKind.configurePathMatch.file, /ApiPathConfig\.java$/);
	assert.equal(byKind['paths-to-match'].pattern, '/api/v0/**');

	const markdown = run(['scan', '--terms', 'widget'], root);
	assert.match(markdown.stdout, /global path prefix/);
	assert.match(markdown.stdout, /--openapi-file/);
	assert.match(markdown.stdout, /D-openapi-reconciliation/);
});

test('api_surface_source no longer makes the unverified "no committed openapi spec found" claim', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.api_surface_source.includes('no committed openapi spec found'), false);
	assert.match(report.api_surface_source, /does not check for a committed OpenAPI document/);
});

// D-scanner-evidence (D3)
test('scan explain <module>: human output groups evidence by signal, weight subtotals reconcile with the module score', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	const explain = run(['scan', 'explain', 'widget', '--feature', '001-widget-management'], root);
	assert.equal(explain.code, 0);
	assert.match(explain.stdout, /# scan explain: `widget` \(score: \d+\)/);
	assert.match(explain.stdout, /## module_name/);
});

test('scan explain <module> --json: returns the exact related_modules entry, including evidence/capped_signals', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	const explain = run(['scan', 'explain', 'widget', '--feature', '001-widget-management', '--json'], root);
	assert.equal(explain.code, 0);
	const mod = JSON.parse(explain.stdout);
	assert.equal(mod.module, 'widget');
	assert.ok(Array.isArray(mod.evidence) && mod.evidence.length > 0);
	assert.ok(Array.isArray(mod.capped_signals));
	assert.equal(mod.score, mod.evidence.reduce((sum, e) => sum + e.weight, 0), 'score must reconcile exactly with the sum of evidence weights');
});

test('scan explain <unknown-module>: fails cleanly naming the known modules, does not crash', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	const explain = run(['scan', 'explain', 'does-not-exist', '--feature', '001-widget-management'], root);
	assert.equal(explain.code, 2);
	assert.match(explain.stderr, /no module "does-not-exist"/);
	assert.match(explain.stderr, /known modules: widget/);
});

test('scan explain with no positional module argument fails with BAD_ARGS, not a crash', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	const explain = run(['scan', 'explain', '--feature', '001-widget-management'], root);
	assert.equal(explain.code, 14);
});
