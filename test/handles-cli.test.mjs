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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-cli-fixture-'));
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
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-cli-origin-'));
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

test('handles emit is blocked before the contract gate has passed', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const result = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 2);
});

test('handles plan finds the Widget entity, its fetch operation, and its service; emit writes compileable-shape Java', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const plan = run(['handles', 'plan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(plan.code, 0);
	const planJson = JSON.parse(plan.stdout);
	const widget = planJson.resources.find((r) => r.type === 'Widget');
	assert.ok(widget);
	assert.equal(widget.fetchOperation.operationId, 'findWidget');
	assert.equal(widget.requiredAuthority, 'SUPER_ADMIN');
	assert.equal(widget.willGenerateResolver, true);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const emitJson = JSON.parse(emit.stdout);
	assert.deepEqual(emitJson.resolverStubs, ['Widget']);
	assert.equal(emitJson.gate.status, 'pass');

	const resolverPath = path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java');
	assert.ok(fs.existsSync(resolverPath));
	const content = fs.readFileSync(resolverPath, 'utf8');
	assert.match(content, /class WidgetResolver implements ResourceResolver/);
	assert.match(content, /widgetService\.findWidget\(resourceUid\)/);
	assert.match(content, /return "SUPER_ADMIN";/);

	assert.ok(fs.existsSync(path.join(root, 'src/main/java/com/example/global/handle/HandleCodec.java')));
	assert.ok(fs.existsSync(path.join(root, 'specs/001-widget-management/handles/migration.sql')));

	const gateResult = run(['gate', 'require', 'handles', '--feature', '001-widget-management'], root);
	assert.equal(gateResult.code, 0);
});
