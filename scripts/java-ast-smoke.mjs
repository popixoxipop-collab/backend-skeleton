#!/usr/bin/env node
// A2 Phase 2 (D-java-ast-helper): the first automated, clean-checkout proof that the bundled
// JavaParser + Symbol Solver helper (handles/providers/java-spring/ast-helper/) actually builds
// and runs -- previously verified only by hand, on the development machine's own already-warm
// Gradle cache. Same dedicated-job shape as java-compile-smoke.mjs/java-integration-smoke.mjs
// (a real, heavier, network-touching check kept out of the fast `test` job's default `npm test`
// path -- see .github/workflows/ci.yml's java-ast job, which provisions a real JDK 17 via
// actions/setup-java the same way java-compile/java-integration already do).
//
// Proves the one concrete case this whole item exists to close: a fully-qualified
// `@jakarta.validation.constraints.NotNull` field, which patch-strategy.mjs's own literal
// `/@NotNull\b/` regex can never match, must surface as a real `handles plan --ast` disagreement
// -- while a plain `@NotNull` field (already correctly classified by regex) must not.
//
// Requires `java` on PATH (CI installs Temurin 17 via actions/setup-java, matching java-compile/
// java-integration). The committed Gradle wrapper (ast-helper/gradlew) downloads its own Gradle
// 9.5.1 distribution and JavaParser's own dependency from Maven Central on first use here -- a
// real network access, same as any other clean-checkout Gradle build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const FEATURE_ID = '001-widget-management';

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`java-ast-smoke: FAIL -- ${message}`);
	process.exit(1);
}

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-ast-smoke-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const base = 'com/example';
	const widgetDomain = path.join(root, 'src/main/java', base, 'domain/widget');
	fs.mkdirSync(path.join(widgetDomain, 'presentation/dto'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'domain'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'application'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src/main/java', base), { recursive: true });

	fs.writeFileSync(path.join(root, 'src/main/java', base, 'ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.security.access.prepost.PreAuthorize;
import com.example.domain.widget.presentation.dto.UpdateWidgetRequest;
import jakarta.validation.Valid;

@PreAuthorize("hasRole('SUPER_ADMIN')")
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }

	@Operation(operationId = "updateWidget")
	@PatchMapping("/{widgetId}")
	public String updateWidget(@PathVariable String widgetId, @Valid @RequestBody UpdateWidgetRequest request) { return "ok"; }
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
	Object updateWidget(java.util.UUID id, Object request);
}
`);
	// The one fixture this whole item exists for: a plain @NotNull field (regex already handles
	// this correctly) alongside a fully-qualified @jakarta.validation.constraints.NotNull field
	// (regex's own literal `/@NotNull\b/` can never match this form).
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'dto', 'UpdateWidgetRequest.java'), `
package com.example.domain.widget.presentation.dto;

import jakarta.validation.constraints.NotNull;

public record UpdateWidgetRequest(
		@NotNull String label,
		@jakarta.validation.constraints.NotNull String description
) {}
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: java-ast-smoke fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-ast-smoke-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return { root, bareOrigin };
}

console.log('java-ast-smoke: building the real AST helper (./gradlew build -x test, clean checkout)...');
const astHelperDir = path.join(REPO_ROOT, 'handles', 'providers', 'java-spring', 'ast-helper');
const gradlew = path.join(astHelperDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
try {
	execFileSync(gradlew, ['build', '-x', 'test', '--console=plain'], { cwd: astHelperDir, stdio: 'inherit' });
} catch (err) {
	fail(`the bundled AST helper did not build cleanly -- ${err.message}`);
}

console.log('java-ast-smoke: copying fixture to a scratch git repo...');
const { root: scratch, bareOrigin } = buildFixtureRepo();

console.log('java-ast-smoke: preflight -> feature init -> scan -> disposition -> contract emit -> handles plan --ast...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'widget-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'widget'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'reuse', '--note', 'java-ast-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

r = bskel(['contract', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`contract emit: ${r.stderr || r.stdout}`);

r = bskel(['handles', 'plan', '--feature', FEATURE_ID, '--ast', '--json'], scratch);
if (r.code !== 0) fail(`handles plan --ast: exit ${r.code}: ${r.stderr || r.stdout}`);

let plan;
try {
	plan = JSON.parse(r.stdout);
} catch {
	fail(`handles plan --ast produced no parseable JSON: ${r.stdout}`);
}

if (!Array.isArray(plan.ast_disagreements)) fail('expected a top-level ast_disagreements array in --json output');

const labelDisagreement = plan.ast_disagreements.find((d) => d.field === 'label');
if (labelDisagreement) fail(`a plain @NotNull field must not be reported as a disagreement -- got ${JSON.stringify(labelDisagreement)}`);

const descriptionDisagreement = plan.ast_disagreements.find((d) => d.field === 'description');
if (!descriptionDisagreement) fail('the fully-qualified @jakarta.validation.constraints.NotNull field is exactly the gap this item exists to close -- expected a disagreement, found none');
if (descriptionDisagreement.resourceType !== 'Widget') fail(`expected resourceType "Widget", got ${JSON.stringify(descriptionDisagreement)}`);
if (descriptionDisagreement.annotation !== 'jakarta.validation.constraints.NotNull') fail(`expected annotation "jakarta.validation.constraints.NotNull", got ${JSON.stringify(descriptionDisagreement)}`);
if (descriptionDisagreement.regexBucket !== 'null-means-unchanged') fail(`expected regexBucket "null-means-unchanged", got ${JSON.stringify(descriptionDisagreement)}`);

console.log('java-ast-smoke: PASS -- the real AST helper built cleanly and correctly resolved both the plain and fully-qualified @NotNull cases.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
