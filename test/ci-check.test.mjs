import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { selectCiFeatures, renderCiSummary, toSarif } from '../lib/ci-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try { return { code: 0, stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' }), stderr: '' }; }
	catch (err) { return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }; }
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-ci-check-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');
	const controller = path.join(root, 'src/main/java/com/example/domain/widget/presentation');
	fs.mkdirSync(controller, { recursive: true });
	fs.writeFileSync(path.join(controller, 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
@RestController @RequestMapping("/widgets")
public class WidgetController { @Operation(operationId = "findWidgets") @GetMapping public String findWidgets() { return "ok"; } }
`);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
	const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-ci-check-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: origin });
	execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'fixture'], root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	return root;
}

test('CI feature selection favors explicit input, selects scoped features, checks all for shared product code, and no-ops documentation-only diffs', () => {
	const active = [{ feature_id: '001-widget' }, { feature_id: '002-order' }];
	assert.deepEqual(selectCiFeatures({ activeFeatures: active, changed: ['src/main.js'], requestedFeatures: null }), { selectedFeatures: ['001-widget', '002-order'], selectionReason: 'shared_product_change_all_active' });
	assert.deepEqual(selectCiFeatures({ activeFeatures: active, changed: ['specs/002-order/contracts/x.json'], requestedFeatures: null }), { selectedFeatures: ['002-order'], selectionReason: 'feature_scoped_changes' });
	assert.deepEqual(selectCiFeatures({ activeFeatures: active, changed: ['README.md', 'SKILL.md', 'docs/ci.md'], requestedFeatures: null }), { selectedFeatures: [], selectionReason: 'documentation_only_or_no_active_feature_change' });
	assert.deepEqual(selectCiFeatures({ activeFeatures: active, changed: ['src/main.js'], requestedFeatures: ['002-order'] }), { selectedFeatures: ['002-order'], selectionReason: 'explicit_feature' });
});

test('ci check aggregates existing verification and next remediation, and writes deterministic summary plus SARIF locations', () => {
	const root = fixture();
	const pass = run(['ci', 'check', '--base', 'HEAD', '--feature', '001-widget-management', '--json'], root);
	assert.equal(pass.code, 0);
	assert.equal(JSON.parse(pass.stdout).outcome, 'pass');

	fs.rmSync(path.join(root, 'specs/001-widget-management/contracts/001-widget-management.schema.json'));
	const summary = path.join(root, 'summary.md');
	const sarif = path.join(root, 'results.sarif');
	const failed = run(['ci', 'check', '--base', 'HEAD', '--feature', '001-widget-management', '--summary-file', summary, '--sarif-file', sarif, '--json'], root);
	assert.equal(failed.code, 1);
	assert.equal(failed.stdout.trim().startsWith('{'), true, 'JSON mode must emit exactly one JSON document even on failure');
	const report = JSON.parse(failed.stdout);
	assert.equal(report.outcome, 'fail');
	assert.equal(report.features[0].remediation.command, 'bskel contract emit --feature 001-widget-management');
	assert.match(fs.readFileSync(summary, 'utf8'), /# backend-skeleton PR check/);
	const parsedSarif = JSON.parse(fs.readFileSync(sarif, 'utf8'));
	assert.equal(parsedSarif.version, '2.1.0');
	assert.ok(parsedSarif.runs[0].results.some((r) => r.locations[0].physicalLocation.artifactLocation.uri.includes('001-widget-management.schema.json')));
});

test('ci check reports unresolvable bases as actionable exit 14 JSON diagnostics', () => {
	const root = fixture();
	const result = run(['ci', 'check', '--base', 'missing-base', '--json'], root);
	assert.equal(result.code, 14);
	assert.equal(JSON.parse(result.stdout).reason, 'BAD_BASE');
	assert.match(result.stderr, /cannot resolve base ref/);
});

test('summary and SARIF render deterministically with one result per blocking issue', () => {
	const report = { outcome: 'fail', base: { requested: 'main', sha: 'a' }, merge_base: 'b', head: 'c', changed_file_count: 1, selection_reason: 'explicit_feature', selected_features: ['001-a'], features: [{ feature: '001-a', pass: false, remediation: { command: 'bskel contract emit --feature 001-a' } }], issues: [
		{ kind: 'artifact', feature: '001-a', name: 'contract', path: 'specs/001-a/contracts/001-a.schema.json', message: 'missing contract' },
	] };
	assert.equal(renderCiSummary(report), renderCiSummary(report));
	const sarif = toSarif(report);
	assert.equal(sarif.runs[0].results.length, 1);
	assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'specs/001-a/contracts/001-a.schema.json');
});

test('composite action manifest exposes supported inputs/outputs and uses fixed workflow-command text', () => {
	const actionPath = path.join(__dirname, '..', 'action.yml');
	const source = fs.readFileSync(actionPath, 'utf8');
	const action = YAML.parse(source);
	for (const input of ['base', 'feature', 'build', 'allow-skip-build', 'sarif']) assert.ok(action.inputs[input]);
	for (const output of ['result', 'sarif-file']) assert.ok(action.outputs[output]);
	assert.match(source, /npm ci --ignore-scripts --prefix "\$GITHUB_ACTION_PATH"/);
	assert.match(source, /\$GITHUB_STEP_SUMMARY/);
	assert.match(source, /EVENT_NAME/);
	assert.match(source, /RUNNER_ENVIRONMENT/);
	assert.match(source, /\[ "\$EVENT_NAME" = "pull_request" \].*\[ "\$RUNNER_ENVIRONMENT" = "self-hosted" \]/);
	assert.match(source, /::error title=backend-skeleton PR check::Blocking bskel issues found/);
	assert.doesNotMatch(source, /::error[^\n]*\$INPUT_FEATURE/);
});
