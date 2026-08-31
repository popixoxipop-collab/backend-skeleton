// D-field-dependency: CLI test suite for `bskel dependency declare|remove|list` and the
// `dependencies` gate. Reuses the widget module (WidgetController/WidgetDto) from
// test/_contract-fixture.mjs verbatim as the TARGET side; adds a second, independent
// "organization" module (OrganizationDto only -- no controller needed, since scoreModule() scores
// module_name against --terms alone, see scanners/index.mjs's collectEvidence()) as the SOURCE
// side, each disposed under its own feature id in the same repo, so a cross-feature dependency has
// two real resolvable resource types to point at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	run, runCapturingStderr, widgetControllerSource, widgetControllerPath, widgetDtoPath, widgetDtoSource,
} from './_contract-fixture.mjs';

function organizationDtoPath(root) {
	return path.join(root, 'src/main/java/com/example/domain/organization/presentation/dto/OrganizationDto.java');
}

function organizationDtoSource() {
	return `
package com.example.domain.organization.presentation.dto;

public record OrganizationDto(String organizationId, String taxRate) {
}
`;
}

function buildTwoFeatureFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-dependency-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	fs.mkdirSync(path.dirname(widgetControllerPath(root)), { recursive: true });
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource());
	fs.mkdirSync(path.dirname(widgetDtoPath(root)), { recursive: true });
	fs.writeFileSync(widgetDtoPath(root), widgetDtoSource());

	fs.mkdirSync(path.dirname(organizationDtoPath(root)), { recursive: true });
	fs.writeFileSync(organizationDtoPath(root), organizationDtoSource());

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: two-feature dependency fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-dependency-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

// 001-widget-management (module "widget") and 002-organization-management (module
// "organization") -- both disposed, so every test below starts from a state where the target and
// source resource types are already resolvable.
function initBothFeatures(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['feature', 'init', '--slug', 'organization-management'], root);
	run(['scan', '--feature', '002-organization-management', '--terms', 'organization'], root);
	run(['scan', 'disposition', '--feature', '002-organization-management', '--mode', 'reuse', '--note', 'x'], root);
}

function declareArgs({
	feature = '001-widget-management', resource = 'WidgetDto', field = 'name',
	sourceFeature = '002-organization-management', sourceResource = 'OrganizationDto', sourceField = 'taxRate',
	reason = 'name is derived from the organization tax rate', memo = null, json = false,
} = {}) {
	const args = [
		'dependency', 'declare',
		'--feature', feature, '--resource', resource, '--field', field,
		'--source-feature', sourceFeature, '--source-resource', sourceResource, '--source-field', sourceField,
	];
	if (reason !== null) args.push('--reason', reason);
	if (memo !== null) args.push('--memo', memo);
	if (json) args.push('--json');
	return args;
}

function removeArgs({
	feature = '001-widget-management', resource = 'WidgetDto', field = 'name',
	sourceFeature = '002-organization-management', sourceResource = 'OrganizationDto', sourceField = 'taxRate',
	reason = 'no longer needed', json = false,
} = {}) {
	const args = [
		'dependency', 'remove',
		'--feature', feature, '--resource', resource, '--field', field,
		'--source-feature', sourceFeature, '--source-resource', sourceResource, '--source-field', sourceField,
	];
	if (reason !== null) args.push('--reason', reason);
	if (json) args.push('--json');
	return args;
}

test('dependency declare requires --reason', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({ reason: null }), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /requires --reason/);
});

test('declare refuses an unknown target resource type, naming the known classes', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({ resource: 'DoesNotExist' }), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /no resource type "DoesNotExist"/);
	assert.match(result.stderr, /known classes:.*WidgetDto/);
});

test('declare refuses an unknown source resource type, naming the known classes', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({ sourceResource: 'DoesNotExist' }), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /no resource type "DoesNotExist"/);
	assert.match(result.stderr, /known classes:.*OrganizationDto/);
});

test('declare refuses a source feature with no scan report yet', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({ sourceFeature: '003-ghost-feature' }), root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /no brownfield-scan\.json for feature "003-ghost-feature"/);
});

test('a real cross-feature declare succeeds and passes the dependencies gate', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({ json: true }), root);
	assert.equal(result.code, 0);
	const out = JSON.parse(result.stdout);
	assert.equal(out.dependency.target.resourceType, 'WidgetDto');
	assert.equal(out.dependency.target.fieldName, 'name');
	assert.equal(out.dependency.source.feature, '002-organization-management');
	assert.equal(out.dependency.source.resourceType, 'OrganizationDto');
	assert.equal(out.dependency.source.fieldName, 'taxRate');
	assert.equal(out.gate.status, 'pass');

	const gate = run(['gate', 'require', 'dependencies', '--feature', '001-widget-management'], root);
	assert.equal(gate.code, 0);
});

test('dependency list --json reports the declared dependency resolved on both sides', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);

	const result = run(['dependency', 'list', '--feature', '001-widget-management', '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.dependencies.length, 1);
	const [dep] = report.dependencies;
	assert.equal(dep.target_resolved, true);
	assert.match(dep.target_file, /WidgetDto\.java$/);
	assert.equal(dep.source_resolved, true);
	assert.match(dep.source_file, /OrganizationDto\.java$/);
	assert.equal(report.gate.status, 'pass');
});

test('editing the source file (uncommitted) stales the dependencies gate, naming the source_field_file key', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);
	assert.equal(run(['gate', 'require', 'dependencies', '--feature', '001-widget-management'], root).code, 0);

	fs.appendFileSync(organizationDtoPath(root), '\n// uncommitted edit to the SOURCE field\'s file\n');

	const stale = run(['gate', 'require', 'dependencies', '--feature', '001-widget-management', '--json'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.ok(record.changed_inputs.some((k) => k.startsWith('source_field_file:') && k.includes('OrganizationDto')));
});

// D-gate-precision (Part 1): `scan`'s own recompute() hashes the CONTENT of every file in the
// adapter's whole-repo listReadSet(), by design (any Java file anywhere is a potential new
// collision candidate) -- so editing/deleting organizationDtoPath() directly would ALSO stale
// feature 001's own `scan` gate, which sits ahead of `dependencies` in GATE_NAMES and would mask
// exactly what these two tests need to isolate. Editing the SOURCE feature's own persisted
// brownfield-scan.json instead (removing the OrganizationDto entry from its module's `dtos`, the
// same shape a real re-scan after a rename/delete would produce) changes only
// resolveClassFile(root, '002-organization-management', 'OrganizationDto')'s result -- it never
// touches any `.java` file's content, so feature 001's own scan/contract gates stay exactly as they
// were.
function removeOrganizationDtoFromScanReport(root) {
	const reportPath = path.join(root, 'specs/002-organization-management/brownfield-scan.json');
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	const mod = report.related_modules.find((m) => m.module === 'organization');
	mod.dtos = mod.dtos.filter((d) => d.className !== 'OrganizationDto');
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

test('the source class disappearing from its own scan report makes the dependency token an unresolved sentinel, not a bare null', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);
	assert.equal(run(['gate', 'require', 'dependencies', '--feature', '001-widget-management'], root).code, 0);

	removeOrganizationDtoFromScanReport(root);

	const stale = run(['gate', 'require', 'dependencies', '--feature', '001-widget-management', '--json'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.ok(record.changed_inputs.some((k) => k.startsWith('source_field_file:') && k.includes('OrganizationDto')));

	const list = JSON.parse(run(['dependency', 'list', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(list.dependencies[0].source_resolved, false);
	assert.equal(list.dependencies[0].source_unresolved_reason, 'class_not_found');
});

// The direct regression test for the plan's own named latent bug: lib/workflow.mjs's
// ESTABLISH_COMMAND map had no entry for `dependencies` (or `conformance`), so `bskel next` on a
// stale REQUIRED_WHEN_PRESENT dependencies gate called `ESTABLISH_COMMAND.dependencies(featureId)`
// as `undefined(...)` and crashed with a raw TypeError instead of printing a clean next-action.
// feature 001's own scan+contract gates must both be genuinely passing first -- otherwise `next`
// would legitimately report one of THOSE (they sit ahead of `dependencies` in GATE_NAMES) and never
// reach the code path this test exists to exercise.
test('bskel next does not crash on a stale dependencies gate -- it prints the real re-declare command', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(declareArgs(), root).code, 0);
	assert.equal(run(['gate', 'require', 'dependencies', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root).code, 0);

	removeOrganizationDtoFromScanReport(root); // makes the dependencies gate stale AND the dependency unresolvable at once

	const next = runCapturingStderr(['next', '--feature', '001-widget-management'], root);
	assert.equal(next.code, 0, `bskel next must not crash: ${next.stderr}`);
	assert.doesNotMatch(next.stderr, /TypeError/);
	assert.match(next.stdout, /bskel dependency declare/);
});

test('dependency remove requires --reason', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);
	const result = run(removeArgs({ reason: null }), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /requires --reason/);
});

test('dependency remove refuses an unknown tuple, naming the currently-declared dependencies', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);
	const result = run(removeArgs({ field: 'widgetId' }), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /no declared dependency matches/);
	assert.match(result.stderr, /currently declared:.*WidgetDto\.name/);
});

test('dependency remove succeeds and re-passes the gate with the entry gone', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);

	const result = run(removeArgs({ json: true }), root);
	assert.equal(result.code, 0);
	const out = JSON.parse(result.stdout);
	assert.equal(out.removed, true);
	assert.equal(out.gate.status, 'pass');

	const list = JSON.parse(run(['dependency', 'list', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(list.dependencies.length, 0);
});

test('re-declaring an identical tuple replaces it in place rather than duplicating', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs({ reason: 'first reason' }), root).code, 0);
	assert.equal(run(declareArgs({ reason: 'revised reason' }), root).code, 0);

	const list = JSON.parse(run(['dependency', 'list', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(list.dependencies.length, 1);
	assert.equal(list.dependencies[0].reason, 'revised reason');
});

test('a same-feature dependency (target and source resource types in the same feature) succeeds', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({
		feature: '001-widget-management', resource: 'WidgetDto', field: 'name',
		sourceFeature: '001-widget-management', sourceResource: 'WidgetDto', sourceField: 'widgetId',
		json: true,
	}), root);
	assert.equal(result.code, 0);
	const out = JSON.parse(result.stdout);
	assert.equal(out.dependency.source.feature, '001-widget-management');
	assert.equal(out.gate.status, 'pass');
});

test('declare refuses a self-reference (identical resource+field on both sides)', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(declareArgs({
		feature: '001-widget-management', resource: 'WidgetDto', field: 'name',
		sourceFeature: '001-widget-management', sourceResource: 'WidgetDto', sourceField: 'name',
	}), root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /cannot depend on itself/);
});

test('memo round-trips through list --json when provided, and is omitted when not', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs({ memo: 'target side should reformat, not source' }), root).code, 0);

	const list = JSON.parse(run(['dependency', 'list', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(list.dependencies[0].memo, 'target side should reformat, not source');
});
