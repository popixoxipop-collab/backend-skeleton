// Full CLI flow for Phase 3, offline (no dependency on Team-IZ-Backend): preflight -> feature
// init -> scan -> disposition -> contract emit -> contract validate -> contract tool-schema.
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const pkgDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation');
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, 'WidgetController.java'), `
package com.example.domain.widget.presentation;

import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() { return "ok"; }

	@Operation(operationId = "createWidget")
	@PostMapping
	public String createWidget(@RequestBody Object request) { return "ok"; }

	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	// preflight requires a real "origin" to cross-check the default branch against.
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('feature init -> scan -> disposition -> contract emit -> validate -> tool-schema, full flow', () => {
	const root = buildFixtureRepo();

	assert.equal(run(['preflight'], root).code, 0);

	const init = run(['feature', 'init', '--slug', 'widget-management'], root);
	assert.equal(init.code, 0);
	const featureRecord = JSON.parse(init.stdout);
	assert.equal(featureRecord.feature_id, '001-widget-management');
	assert.match(featureRecord.feature_uid, /^[0-9a-f-]{36}$/);

	assert.equal(run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root).code, 3);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);

	const emit = run(['contract', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const contract = JSON.parse(emit.stdout);
	assert.equal(contract.operations.createWidget.body, true);
	assert.equal(contract.operations.findWidgets.body, false);
	assert.deepEqual(contract.operations.findWidget.pathParams.required, ['widgetId']);

	const envelopePath = path.join(root, 'envelope.json');
	fs.writeFileSync(envelopePath, JSON.stringify({
		sbf: '1', feature_id: '001-widget-management', feature_uid: featureRecord.feature_uid,
		operation_id: 'createWidget', direction: 'request', payload: { pathParams: {}, body: { name: 'x' } },
	}));
	const validate = run(['contract', 'validate', '--feature', '001-widget-management', '--file', envelopePath], root);
	assert.equal(validate.code, 0);
	assert.equal(JSON.parse(validate.stdout).ok, true);

	const toolSchema = run(['contract', 'tool-schema', '--feature', '001-widget-management', '--operation', 'createWidget'], root);
	assert.equal(toolSchema.code, 0);
	assert.equal(JSON.parse(toolSchema.stdout).name, 'createWidget');
});

test('contract emit is blocked before preflight has run', () => {
	const root = buildFixtureRepo();
	const emit = run(['contract', 'emit', '--feature', '001-whatever'], root);
	assert.equal(emit.code, 2); // preflight gate: not_run
});

test('feature init requires preflight to have passed', () => {
	const root = buildFixtureRepo();
	const init = run(['feature', 'init', '--slug', 'x'], root);
	assert.equal(init.code, 2);
});

test('contract emit is blocked while the scan gate is awaiting_disposition', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	const emit = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 3);
});

test('feature init auto-increments the NNN- prefix across multiple features', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const first = JSON.parse(run(['feature', 'init', '--slug', 'alpha'], root).stdout);
	const second = JSON.parse(run(['feature', 'init', '--slug', 'beta'], root).stdout);
	assert.equal(first.feature_id, '001-alpha');
	assert.equal(second.feature_id, '002-beta');
});
