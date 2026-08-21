// A3 (D-patch-strategy): end-to-end CLI coverage for `bskel handles patch approve` + the
// approval-gated codegen path in `handles emit` -- same fixture-repo pattern as
// test/handles-cli.test.mjs, extended with an UpdateWidgetRequest DTO + PATCH endpoint so this
// exercises the real approve -> emit -> generated-Java pipeline, not just the classifier in
// isolation (see test/patch-strategy.test.mjs for that).
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

function buildFixtureRepo({ updateServiceArgs = 'java.util.UUID id, UpdateWidgetRequest request' } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-approve-cli-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins {\n\tid 'org.springframework.boot' version '3.3.0'\n}\n");

	const base = 'com/example';
	const widgetDomain = path.join(root, 'src/main/java', base, 'domain/widget');
	fs.mkdirSync(path.join(widgetDomain, 'presentation', 'dto'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'domain'), { recursive: true });
	fs.mkdirSync(path.join(widgetDomain, 'application'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src/main/java', base), { recursive: true });

	fs.writeFileSync(path.join(root, 'src/main/java', base, 'ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.security.access.prepost.PreAuthorize;
import jakarta.validation.Valid;
import com.example.domain.widget.presentation.dto.UpdateWidgetRequest;

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
	fs.writeFileSync(path.join(widgetDomain, 'presentation', 'dto', 'UpdateWidgetRequest.java'), `
package com.example.domain.widget.presentation.dto;
import com.example.global.json.PatchField;
import jakarta.validation.constraints.NotNull;
public record UpdateWidgetRequest(
		PatchField<String> label,
		Integer capacity,
		@NotNull String ownerName
) {}
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
import com.example.domain.widget.presentation.dto.UpdateWidgetRequest;
public interface WidgetService {
	Object findWidget(java.util.UUID id);
	Object updateWidget(${updateServiceArgs});
}
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-approve-cli-origin-'));
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

test('handles plan reports the classified patchable fields for Widget (patch-wrapper + null-means-unchanged + fetch-merge-submit)', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const plan = run(['handles', 'plan', '--feature', '001-widget-management', '--json'], root);
	assert.equal(plan.code, 0);
	const widget = JSON.parse(plan.stdout).resources.find((r) => r.type === 'Widget');
	assert.equal(widget.updateServiceBlockedReason, null);
	assert.deepEqual(widget.patchable.map((f) => [f.field, f.bucket]), [
		['label', 'patch-wrapper'],
		['capacity', 'null-means-unchanged'],
		['ownerName', 'fetch-merge-submit'],
	]);
});

test('handles patch approve requires --reason', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const result = run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper'], root);
	assert.notEqual(result.code, 0);
});

test('handles patch approve rejects a strategy that does not match the current classification', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const result = run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'null-means-unchanged', '--reason', 'x'], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /currently classified "patch-wrapper"/);
});

test('handles patch approve rejects fetch-merge-submit outright -- it is never auto-generated regardless of approval', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const result = run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'ownerName', '--strategy', 'fetch-merge-submit', '--reason', 'x'], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /never auto-generated/);
});

test('handles emit: an unapproved codegen-eligible field stays an explanatory per-field stub, not real codegen', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	const emit = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 0);
	const content = fs.readFileSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java'), 'utf8');
	assert.match(content, /case "\/label" -> throw new UnsupportedOperationException\(/);
	assert.match(content, /not yet approved/);
	assert.doesNotMatch(content, /ObjectMapper/, 'no validation machinery should be imported when nothing is approved');
});

test('handles patch approve then handles emit: the approved field gets real codegen (Validator + ObjectMapper.convertValue + PatchField.of + the real service call), the unapproved one stays a stub', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);

	const approve = run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'trusted mapping'], root);
	assert.equal(approve.code, 0);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 0);
	const content = fs.readFileSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java'), 'utf8');

	assert.match(content, /case "\/label" -> \{/);
	assert.match(content, /String convertedValue = objectMapper\.convertValue\(value, String\.class\);/);
	assert.match(content, /new UpdateWidgetRequest\(PatchField\.of\(convertedValue\), null, null\)/);
	assert.match(content, /Set<ConstraintViolation<UpdateWidgetRequest>> violations = validator\.validate\(patch\);/);
	assert.match(content, /throw new ConstraintViolationException\(violations\);/);
	assert.match(content, /widgetService\.updateWidget\(resourceUid, patch\);/);
	assert.match(content, /import com\.fasterxml\.jackson\.databind\.ObjectMapper;/);
	assert.match(content, /import com\.example\.global\.json\.PatchField;/);

	assert.match(content, /case "\/capacity" -> throw new UnsupportedOperationException\(/, 'capacity was classified null-means-unchanged but never approved -- must stay a stub');

	const approvalsPath = path.join(root, 'specs/001-widget-management/handles/patch-approvals.json');
	assert.ok(fs.existsSync(approvalsPath));
	const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
	assert.deepEqual(approvals.approvals.map((a) => [a.resource, a.field, a.strategy]), [['Widget', 'label', 'patch-wrapper']]);
});

test('a service update method with the wrong argument count (same param-count safety check as D-security-8) blocks ALL codegen but keeps the classification visible in `handles plan`', () => {
	const root = buildFixtureRepo({ updateServiceArgs: 'java.util.UUID id, UpdateWidgetRequest request, java.util.UUID requesterId' });
	runWorkflowThroughContract(root);

	const plan = run(['handles', 'plan', '--feature', '001-widget-management', '--json'], root);
	const widget = JSON.parse(plan.stdout).resources.find((r) => r.type === 'Widget');
	assert.match(widget.updateServiceBlockedReason, /takes 3 argument\(s\)/);
	assert.equal(widget.patchable.length, 3, 'classification must survive even when codegen is blocked');

	const approveAttempt = run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'x'], root);
	assert.notEqual(approveAttempt.code, 0, 'approving a field on a codegen-blocked resource must be rejected up front');

	const emit = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 0);
	const content = fs.readFileSync(path.join(root, 'src/main/java/com/example/domain/widget/infrastructure/WidgetResolver.java'), 'utf8');
	assert.match(content, /case "\/label" -> throw new UnsupportedOperationException\(\s*"patchField not auto-generated for Widget\/label -- .*takes 3 argument\(s\)/);
});

test('re-approving the same {resource, field} replaces the prior entry rather than accumulating duplicates', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughContract(root);
	run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'first'], root);
	run(['handles', 'patch', 'approve', '--feature', '001-widget-management', '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'second, corrected'], root);

	const approvals = JSON.parse(fs.readFileSync(path.join(root, 'specs/001-widget-management/handles/patch-approvals.json'), 'utf8'));
	assert.equal(approvals.approvals.length, 1);
	assert.equal(approvals.approvals[0].reason, 'second, corrected');
});
