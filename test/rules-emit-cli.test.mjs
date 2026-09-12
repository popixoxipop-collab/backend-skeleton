// D-business-rules (R9): end-to-end CLI coverage for `bskel rules emit` (java-spring v1). Fixture
// builder mirrors test/observe-emit-cli.test.mjs's own conventions exactly -- rules emit needs
// real detectBasePackage() input the same way observe emit does, so this file cannot reuse
// test/_contract-fixture.mjs's buildFixtureRepo() (which deliberately has no *Application.java).
// Real-JVM proof that the generated code actually compiles and executes correctly lives in
// scripts/java-compile-smoke.mjs -- this file's job is cheap, always-run coverage of the WIRING:
// gating, output paths, idempotence, and unsupported-adapter refusal.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughRules(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['rules', 'check', '--feature', '001-widget-management'], root);
}

const RULES_DIR = 'src/main/java/com/example/global/rules';
const RULES_RESOURCE_PATH = 'src/main/resources/bskel/001-widget-management.rules.json';

test('rules emit is blocked before the rules gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	// deliberately skips `rules check`
	const result = run(['rules', 'emit', '--feature', '001-widget-management'], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /`rules` gate/);
	assert.match(result.stderr, /run `bskel rules check --feature 001-widget-management` first/);
});

test('rules emit writes the four infra templates plus the compiled rules.json', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);

	const result = run(['rules', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, false);
	assert.deepEqual(
		body.written.slice().sort(),
		[
			`${RULES_DIR}/RuleSetLoader.java`,
			`${RULES_DIR}/RuleCheck.java`,
			`${RULES_DIR}/EnforceRules.java`,
			`${RULES_DIR}/RuleEnforcementAspect.java`,
			RULES_RESOURCE_PATH,
		].sort(),
	);
	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		assert.ok(fs.existsSync(path.join(root, RULES_DIR, f)), `expected ${f} to exist`);
	}
	assert.ok(!fs.existsSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java')), 'rules emit must never write anything handles emit owns');
	assert.ok(!fs.existsSync(path.join(root, 'src/main/resources/bskel/001-widget-management.observed-schema.json')), 'rules emit must never write anything observe emit owns');

	const artifact = JSON.parse(fs.readFileSync(path.join(root, RULES_RESOURCE_PATH), 'utf8'));
	assert.equal(artifact.sbf_feature_rules, '1');
	assert.equal(artifact.feature_id, '001-widget-management');

	// The emitted resource is byte-identical to what `rules check` already wrote and validated --
	// deliberately one representation of these rules, never re-serialized on the way to the
	// classpath (see rules.mjs's own comment).
	const checked = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/rules/001-widget-management.rules.json'), 'utf8'));
	assert.deepEqual(artifact, checked);
});

test('the rejection/redaction/auto-wiring contract is documented on the generated EnforceRules/RuleEnforcementAspect javadoc', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);
	run(['rules', 'emit', '--feature', '001-widget-management'], root);

	const aspect = fs.readFileSync(path.join(root, RULES_DIR, 'RuleEnforcementAspect.java'), 'utf8');
	assert.match(aspect, /bskel\.rules\.mode/);
	assert.match(aspect, /default \{@code "observe"\}/);
	assert.match(aspect, /HTTP 400/);
	assert.match(aspect, /NEVER contains an observed/);

	const annotation = fs.readFileSync(path.join(root, RULES_DIR, 'EnforceRules.java'), 'utf8');
	assert.match(annotation, /Does not check TRANSITION rules/);
});

test('a second rules emit with nothing changed leaves every file unchanged (idempotent, matches handles/observe emit\'s own invariant)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);
	run(['rules', 'emit', '--feature', '001-widget-management'], root);
	const before = {};
	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		before[f] = fs.readFileSync(path.join(root, RULES_DIR, f), 'utf8');
	}

	const result = run(['rules', 'emit', '--feature', '001-widget-management', '--diff', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'unchanged' || (a.kind === 'spec' && a.action === 'unchanged')), `expected every action unchanged, got: ${JSON.stringify(body.actions)}`);

	for (const f of ['RuleSetLoader.java', 'RuleCheck.java', 'EnforceRules.java', 'RuleEnforcementAspect.java']) {
		assert.equal(fs.readFileSync(path.join(root, RULES_DIR, f), 'utf8'), before[f], `${f} must be byte-identical after a no-op re-emit`);
	}
});

// A real javascript-express-detected repo, not a synthetic one: reuses the committed
// test/fixtures/javascript-express/ tree, matching test/javascript-express-cli.test.mjs's own
// buildFixtureRepo() exactly -- javascript-express (G6) ships no codegen provider at all, so this
// stays the one adapter `rules emit` can never support, unlike python-fastapi/typescript-express
// which were "not yet" gaps this same test file already closed twice.
function buildJavaScriptFixtureRepo() {
	const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'javascript-express');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-js-'));
	fs.cpSync(FIXTURE_SRC, root, { recursive: true });
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rules-emit-js-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('rules emit refuses an adapter with no codegen provider at all, naming all three that ARE supported', () => {
	const root = buildJavaScriptFixtureRepo();
	const FEATURE_ID = '001-user-management';
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'user-management'], root);
	run(['scan', '--feature', FEATURE_ID, '--terms', 'user'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'test'], root);
	// D-cli-contract convention: openapi.json written AFTER preflight, not before -- an untracked
	// file at repo root would otherwise make preflight's own dirty-tree check fail.
	// javascript-express's scanned operationId is always null (`api.operations: false`, G6), so
	// --openapi-file is required for contract emit -- same reasoning python/typescript needed it.
	const openApiPath = path.join(root, 'openapi.json');
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/api/user/{userUid}': { get: { operationId: 'user-getUser', responses: {} } } },
	}));
	run(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'user', '--openapi-file', openApiPath, '--path-prefix', '/api'], root);
	// The two other real routes (list, PATCH :userUid) have no corresponding OpenAPI operation
	// above, so contract emit reports them CONTRACT_UNMATCHED_ENDPOINT and stops at
	// awaiting_disposition -- waived here since this test's only concern is reaching a PASSED
	// contract gate, not a complete one.
	const waiveResult = run(['contract', 'waive', '--feature', FEATURE_ID, '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'test'], root);
	assert.equal(waiveResult.code, 0, `contract waive: ${waiveResult.stderr ?? ''}`);
	const checkResult = run(['rules', 'check', '--feature', FEATURE_ID], root);
	assert.equal(checkResult.code, 0, `rules check: ${checkResult.stderr ?? ''}`);

	const result = run(['rules', 'emit', '--feature', FEATURE_ID], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /does not support the "javascript-express" adapter yet \(supported: java-spring, python-fastapi, typescript-express\)/);
});

// ---- R5/Phase 3: derived fields --------------------------------------------------------------

test('R5: rules emit writes a complete, compiling <Resource>Rules.java for a derived field, and names it in postEmitNotes', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root); // no derived rule yet -- writes an empty rules.yaml-less artifact via `rules check` above
	fs.writeFileSync(path.join(root, 'specs', '001-widget-management', 'rules.yaml'), `schema: sbf.feature-rules-source/1
rules:
  - id: order-total
    kind: derived
    resource: Order
    field: total
    expr:
      op: sub
      args:
        - op: mul
          args: [{ ref: price }, { ref: quantity }]
        - { ref: discount }
`);
	assert.equal(run(['rules', 'check', '--feature', '001-widget-management'], root).code, 0);

	const result = run(['rules', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.ok(body.written.includes(`${RULES_DIR}/OrderRules.java`), `expected OrderRules.java in ${JSON.stringify(body.written)}`);
	assert.match(body.postEmitNotes.join('\n'), /derived field\(s\) compiled to OrderRules/);
	assert.match(body.postEmitNotes.join('\n'), /NOTHING calls them/);

	const source = fs.readFileSync(path.join(root, RULES_DIR, 'OrderRules.java'), 'utf8');
	assert.match(source, /public final class OrderRules/);
	assert.match(source, /public static double computeTotal\(double price, double quantity, double discount\)/);
	assert.match(source, /return \(\(price \* quantity\) - discount\);/);
});

test('R5: a second rules emit with the derived rule unchanged leaves OrderRules.java byte-identical', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughRules(root);
	fs.writeFileSync(path.join(root, 'specs', '001-widget-management', 'rules.yaml'), `schema: sbf.feature-rules-source/1
rules:
  - id: order-total
    kind: derived
    resource: Order
    field: total
    expr: { op: mul, args: [{ ref: price }, { ref: quantity }] }
`);
	run(['rules', 'check', '--feature', '001-widget-management'], root);
	run(['rules', 'emit', '--feature', '001-widget-management'], root);
	const before = fs.readFileSync(path.join(root, RULES_DIR, 'OrderRules.java'), 'utf8');
	run(['rules', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(fs.readFileSync(path.join(root, RULES_DIR, 'OrderRules.java'), 'utf8'), before);
});
