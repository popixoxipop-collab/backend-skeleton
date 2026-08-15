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

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-scan-cli-fixture-'));
	execFileSync('git', ['init', '--quiet'], { cwd: root });
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
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	return root;
}

test('scan -> blocked -> disposition -> unblocked, full CLI flow', () => {
	const root = buildFixtureRepo();

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

test('scan disposition --mode replace requires --breaking-approved', () => {
	const root = buildFixtureRepo();
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	const rejected = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'replace'], root);
	assert.equal(rejected.code, 14);
	const accepted = run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'replace', '--breaking-approved'], root);
	assert.equal(accepted.code, 0);
});

test('scan for an unrelated term on the same fixture is greenfield and auto-passes', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--feature', '002-completely-unrelated', '--terms', 'zzznonexistentzzz', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.verdict, 'greenfield');
	const gateResult = run(['gate', 'require', 'scan', '--feature', '002-completely-unrelated'], root);
	assert.equal(gateResult.code, 0);
});
