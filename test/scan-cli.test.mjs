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

// `env` (default undefined -- execFileSync then inherits process.env unchanged, so every existing
// call site is byte-for-byte unaffected) lets the rg-missing tests below run with a restricted
// PATH, same technique test/doctor-cli.test.mjs's own restricted-PATH tests already use.
function run(args, cwd, env) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env });
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

// S2 (D-gate-precision, continued): reproduces the exact live bug this item closes -- the scan
// gate's OLD token (head_sha only) was blind to an uncommitted content edit. Its NEW token hashes
// the adapter's own real read-set, so this must now go stale WITHOUT a commit.
test('scan gate goes stale from an uncommitted content edit to a real read-set file', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0);

	const controllerPath = path.join(root, 'src/main/java/com/example/domain/widget/presentation/WidgetController.java');
	fs.appendFileSync(controllerPath, '\n// uncommitted hand edit\n');

	const stale = run(['gate', 'require', 'scan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.equal(record.stale_reason, 'inputs_changed');
	assert.ok(record.changed_inputs.some((k) => k.startsWith('source_file:') && k.includes('WidgetController.java')));
});

// S2 (D-gate-precision, continued): the specific trap D-gate-precision's own rejected
// alternative (ii) already named -- a manifest re-hashed from the last scan's OWN persisted
// files_read list would never even LOOK at a brand-new file, since it wasn't in that list. The
// fix re-derives the read-set fresh via adapter.listReadSet() every time, which this proves.
test('scan gate goes stale when a brand-new java file appears, not just an edited one', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0);

	const newControllerPath = path.join(root, 'src/main/java/com/example/domain/other/presentation/OtherController.java');
	fs.mkdirSync(path.dirname(newControllerPath), { recursive: true });
	fs.writeFileSync(newControllerPath, `
package com.example.domain.other.presentation;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping(value = "/others")
public class OtherController {
	@GetMapping
	public String findOthers() { return "ok"; }
}
`);

	const stale = run(['gate', 'require', 'scan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.ok(record.changed_inputs.some((k) => k.startsWith('source_file:') && k.includes('OtherController.java')));
});

// S2 (D-gate-precision, continued): the other half of the same fix -- dropping head_sha means an
// UNRELATED commit (nothing the java-spring adapter's read-set even covers) no longer stales scan.
test('an unrelated commit (a non-Java file) no longer stales the scan gate', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0);

	fs.writeFileSync(path.join(root, 'README.md'), '# unrelated doc change\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'docs: unrelated'], { cwd: root });

	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0, 'an unrelated non-Java commit must not stale scan');
});

test('scan without --feature is ad-hoc: no files written, no gate touched', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget'], root);
	assert.equal(scan.code, 0);
	assert.ok(!fs.existsSync(path.join(root, 'specs')), 'ad-hoc scan must not write specs/');
	assert.ok(!fs.existsSync(path.join(root, '.sbf')), 'ad-hoc scan must not write .sbf/');
});

// D-zero-config-scan: the true zero-flag case -- neither --terms nor --feature. Was a deterministic
// exit 14 before this item; now a real "inventory" report, still ad-hoc (no files/gate touched).
test('bskel scan with ZERO flags succeeds, lists every module unscored, verdict "inventory", still writes nothing', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan'], root);
	assert.equal(scan.code, 0, `expected zero-flag scan to succeed: ${scan.stdout}`);
	assert.match(scan.stdout, /## Modules found/);
	assert.match(scan.stdout, /`widget`/);
	assert.match(scan.stdout, /unscored inventory/);
	assert.ok(!fs.existsSync(path.join(root, 'specs')), 'zero-flag scan must not write specs/');
	assert.ok(!fs.existsSync(path.join(root, '.sbf')), 'zero-flag scan must not write .sbf/');

	const json = run(['scan', '--json'], root);
	const report = JSON.parse(json.stdout);
	assert.equal(report.verdict, 'inventory');
	assert.equal(report.collisions.length, 0);
	assert.ok(report.related_modules.some((m) => m.module === 'widget'));
	for (const mod of report.related_modules) {
		assert.equal(Object.hasOwn(mod, 'score'), false, 'inventory-mode modules must genuinely omit score, not set it to 0/undefined');
		assert.equal(Object.hasOwn(mod, 'evidence'), false);
		assert.equal(Object.hasOwn(mod, 'capped_signals'), false);
	}
});

test('an explicit but empty --terms (or a --feature slug deriving zero words) still fails BAD_ARGS -- only the true zero-flag case became the new inventory mode', () => {
	const root = buildFixtureRepo();
	const emptyTerms = run(['scan', '--terms', ''], root);
	assert.equal(emptyTerms.code, 14);
	assert.match(emptyTerms.stderr, /resolved to no real search term/);

	const emptyTermsEquals = run(['scan', '--terms='], root);
	assert.equal(emptyTermsEquals.code, 14);
});

// D-zero-config-scan: without `rg`, every real adapter silently detects nothing (degrades to
// generic-grep) -- `rg_available:false` + an unknowns entry must make this distinguishable from a
// genuinely-unrecognized repo, rather than looking identical to it. Restricted-PATH technique
// copied from test/doctor-cli.test.mjs's own rg/gh-missing tests.
test('bskel scan reports rg_available:false and a clear warning when ripgrep is not on PATH, instead of silently looking unrecognized', () => {
	const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
	const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-restricted-path-'));
	fs.symlinkSync(gitPath, path.join(tmpBin, 'git'));
	// Deliberately no `rg` symlink -- this PATH cannot possibly find it, real machine install or not.
	fs.symlinkSync(process.execPath, path.join(tmpBin, 'node'));

	const root = buildFixtureRepo();
	const scan = run(['scan', '--json'], root, { ...process.env, PATH: tmpBin });
	assert.equal(scan.code, 0, `scan must still succeed without rg, just degraded: ${scan.stdout}`);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.rg_available, false);
	assert.ok(report.unknowns.some((u) => u.includes('ripgrep')), 'expected an rg-missing entry in unknowns');
	// The real Spring fixture (a build.gradle + a real @RestController) degrades to generic-grep
	// with zero matches when rg is absent -- exactly the failure mode the rg_available field exists
	// to make distinguishable from a genuinely-unrecognized repo.
	assert.equal(report.adapter, 'generic-grep');
});

test('bskel scan --terms widget (the scored path) ALSO reports rg_available:false when rg is missing -- not just the zero-flag inventory path', () => {
	const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
	const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-restricted-path-2-'));
	fs.symlinkSync(gitPath, path.join(tmpBin, 'git'));
	fs.symlinkSync(process.execPath, path.join(tmpBin, 'node'));

	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget', '--json'], root, { ...process.env, PATH: tmpBin });
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.rg_available, false);
	assert.ok(report.unknowns.some((u) => u.includes('ripgrep')));
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
