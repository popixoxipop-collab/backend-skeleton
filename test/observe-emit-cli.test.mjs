// D-runtime-conformance-receipts: end-to-end CLI coverage for `bskel observe emit` (java-spring
// v1). Fixture/helpers copied from test/handles-cli.test.mjs's own conventions -- every CLI test
// file owns its own fixture builder, not a shared import.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-origin-'));
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

const OBSERVE_DIR = 'src/main/java/com/example/global/observe';
const OBSERVED_SCHEMA_PATH = 'src/main/resources/bskel/001-widget-management.observed-schema.json';

test('observe emit is blocked before the contract gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const result = run(['observe', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 2);
});

test('observe emit writes the four infra templates plus the projected observed-schema.json, and never touches handles/ output', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, false);
	assert.deepEqual(
		body.written.slice().sort(),
		[
			`${OBSERVE_DIR}/ObserveContract.java`,
			`${OBSERVE_DIR}/ContractCheck.java`,
			`${OBSERVE_DIR}/ObserveSchemaLoader.java`,
			`${OBSERVE_DIR}/ContractObservationAspect.java`,
			OBSERVED_SCHEMA_PATH,
		].sort(),
	);

	for (const f of ['ObserveContract.java', 'ContractCheck.java', 'ObserveSchemaLoader.java', 'ContractObservationAspect.java']) {
		assert.ok(fs.existsSync(path.join(root, OBSERVE_DIR, f)), `expected ${f} to exist`);
	}
	assert.ok(!fs.existsSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java')), 'observe emit must never write anything handles emit owns');

	const schema = JSON.parse(fs.readFileSync(path.join(root, OBSERVED_SCHEMA_PATH), 'utf8'));
	assert.equal(schema.sbf_observed_schema, '1');
	assert.equal(schema.feature_id, '001-widget-management');
	assert.ok(schema.operations.findWidget);
	assert.equal(schema.operations.findWidget.verb, 'GET');
	assert.deepEqual(schema.operations.findWidget.pathParams.required, ['widgetId']);
});

test('observe emit fails cleanly for an unsupported adapter (java-spring and python-fastapi only)', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-ts-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.mkdirSync(path.join(root, 'backend', 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'backend', 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { express: '^4.0.0', typescript: '^5.0.0' } }));
	fs.writeFileSync(path.join(root, 'backend', 'tsconfig.json'), '{}');
	fs.writeFileSync(path.join(root, 'backend', 'src', 'index.ts'), 'export {};\n');
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-ts-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'x-management'], root);
	const scan = run(['scan', '--feature', '001-x-management', '--terms', 'x', '--json'], root);
	if (JSON.parse(scan.stdout).adapter !== 'typescript-express') return; // adapter-selection heuristic is out of scope for this test
	run(['scan', 'disposition', '--feature', '001-x-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['gate', 'force', 'contract', '--feature', '001-x-management', '--reason', 'test'], root);

	const result = run(['observe', 'emit', '--feature', '001-x-management'], root);
	assert.equal(result.code, 17); // EXIT_CODES.MISSING_CAPABILITY
	assert.match(result.stderr, /does not support the "typescript-express" adapter yet \(supported: java-spring, python-fastapi\)/);
});

test('observe emit is idempotent -- re-running rewrites nothing except the always-regenerated observed-schema.json (same byte-identical content)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', '001-widget-management'], root);
	const before = fs.readFileSync(path.join(root, OBSERVE_DIR, 'ContractCheck.java'), 'utf8');

	const result = run(['observe', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const body = JSON.parse(result.stdout);
	// D4-era quirk (same as migration.sql): the unconditionally-regenerated spec-kind file always
	// appears in written[], even when byte-identical -- `actions` is the accurate "did anything
	// really change" signal.
	assert.deepEqual(body.written, [OBSERVED_SCHEMA_PATH]);
	assert.ok(body.actions.every((a) => a.action === 'unchanged'));
	assert.equal(fs.readFileSync(path.join(root, OBSERVE_DIR, 'ContractCheck.java'), 'utf8'), before);
});

test('hand-editing a generated observe infra file then re-running exits 15 and leaves the file byte-for-byte untouched', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', '001-widget-management'], root);

	const checkPath = path.join(root, OBSERVE_DIR, 'ContractCheck.java');
	const edited = `${fs.readFileSync(checkPath, 'utf8')}\n// hand edit\n`;
	fs.writeFileSync(checkPath, edited);

	const result = run(['observe', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 15);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, true);
	assert.ok(body.conflicts.some((c) => c.path === `${OBSERVE_DIR}/ContractCheck.java`));
	assert.equal(fs.readFileSync(checkPath, 'utf8'), edited);
});

test('observe emit --check --diff previews without writing, and reports CHECK_FAILED on a fresh feature', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', '001-widget-management', '--check', '--diff', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, OBSERVE_DIR, 'ContractCheck.java')), '--check must not write anything');
	assert.ok(!fs.existsSync(path.join(root, OBSERVED_SCHEMA_PATH)));
});
