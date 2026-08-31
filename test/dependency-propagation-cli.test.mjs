// D-dependency-propagation-notice: CLI test suite for the downstream-impact note printed by
// `contract emit`/`handles emit` when another feature's declared dependency on THIS feature's
// field(s) has gone stale. Reuses the two-feature widget/organization fixture from
// test/_contract-fixture.mjs, with roles REVERSED from test/dependency-cli.test.mjs's own default:
// here 002-organization-management is the DEPENDENT (its own dependencies.json points at 001, the
// widget feature with a real, fully-annotated controller that can cleanly complete `contract
// emit`/`handles plan`/`handles emit`) -- "organization" has no controller of its own and can't pass
// those end to end, so it would be the wrong side to test emit-time behavior FROM.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	run, runCapturingStderr,
	buildTwoFeatureFixtureRepo, initBothFeatures, widgetDtoPath, declareArgs, buildThirdModuleFixture,
} from './_contract-fixture.mjs';

// 002 declares that ITS OWN OrganizationDto.taxRate is derived from 001's WidgetDto.name -- the
// reverse of dependency-cli.test.mjs's own default shape, chosen so 001 (the fully-working
// controller+DTO feature) is the SOURCE side these tests emit from.
function declareOrgDependsOnWidget(root, overrides = {}) {
	return run(declareArgs({
		feature: '002-organization-management', resource: 'OrganizationDto', field: 'taxRate',
		sourceFeature: '001-widget-management', sourceResource: 'WidgetDto', sourceField: 'name',
		...overrides,
	}), root);
}

// Edits widgetDtoPath (uncommitted) and re-establishes 001's OWN scan/contract gates -- editing a
// file that's part of 001's own disposed module necessarily stales 001's own scan gate too (the
// scan gate hashes the whole adapter read-set, by design -- see D-gate-precision part 1), so a
// real re-scan/re-disposition is required before 001's contract/handles can be re-emitted at all.
// This does NOT re-declare 002's dependency -- 002's own `dependencies` gate is left stale on
// purpose, which is the condition every test in this file exists to observe.
function editWidgetAndReestablishSourceFeature(root) {
	fs.appendFileSync(widgetDtoPath(root), '\n// uncommitted edit to the SOURCE field\'s file\n');
	// scan exits 3 (awaiting_disposition) here, not 0 -- "widget" is a real related module (verdict
	// 'adjacent'), same as its first-ever scan in initBothFeatures(); the disposition step below is
	// what actually re-passes the gate.
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
}

test('contract emit for the SOURCE feature prints a downstream-impact note naming the stale dependent', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(declareOrgDependsOnWidget(root).code, 0);
	editWidgetAndReestablishSourceFeature(root);

	const emit = runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(emit.code, 0);
	assert.match(emit.stderr, /downstream impact: feature "002-organization-management"/);
	assert.match(emit.stderr, /OrganizationDto\.taxRate <- WidgetDto\.name/);
	// text-mode-only, matching every other note in cmdContractEmit -- must never appear in --json.
	const jsonEmit = run(['contract', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.doesNotMatch(jsonEmit.stdout, /downstream impact/);
});

test('handles plan + handles emit --json for the SOURCE feature includes the same note in postEmitNotes', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(declareOrgDependsOnWidget(root).code, 0);
	editWidgetAndReestablishSourceFeature(root);
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['handles', 'plan', '--feature', '001-widget-management'], root).code, 0);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	const parsed = JSON.parse(emit.stdout);
	assert.ok(
		parsed.postEmitNotes.some((n) => n.includes('downstream impact') && n.includes('002-organization-management')),
		`expected a downstream-impact note in postEmitNotes, got: ${JSON.stringify(parsed.postEmitNotes)}`,
	);
});

test('emitting the DEPENDENT feature itself prints no downstream-impact note -- it is not a source for anyone', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(declareOrgDependsOnWidget(root).code, 0);
	editWidgetAndReestablishSourceFeature(root);

	// 002's own contract has zero operations (organization has no controller in this fixture) --
	// it's expected to be blocked, which is irrelevant to what this test checks.
	const emit = runCapturingStderr(['contract', 'emit', '--feature', '002-organization-management'], root);
	assert.doesNotMatch(emit.stderr, /downstream impact/);
});

test('re-declaring the dependency against the new content closes the loop -- the note stops appearing', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(declareOrgDependsOnWidget(root).code, 0);
	editWidgetAndReestablishSourceFeature(root);
	assert.match(runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management'], root).stderr, /downstream impact/);

	assert.equal(declareOrgDependsOnWidget(root, { reason: 're-baseline after widget rename' }).code, 0);

	const after = runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.doesNotMatch(after.stderr, /downstream impact/);
});

// D-dependency-propagation-notice: the whole reason describeDownstreamImpact() cross-checks
// `changed_inputs` against a `source_field_file:<featureId>:` prefix instead of just trusting "the
// dependent's gate is stale" -- buildThirdModuleFixture() (test/_contract-fixture.mjs) adds a THIRD
// feature (003-product-management, a second, independent module) also depended on by 002, via a
// DIFFERENT target field. 002's `dependencies` gate is stale for BOTH reasons at once; emitting 001
// must surface only the widget-attributable entry, and emitting 003 must surface only the
// product-attributable entry.

test('attribution precision: a dependent stale for two unrelated reasons only surfaces the reason that matches the feature being emitted', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const productDtoPath = buildThirdModuleFixture(root);

	assert.equal(declareOrgDependsOnWidget(root).code, 0);
	assert.equal(run(declareArgs({
		feature: '002-organization-management', resource: 'OrganizationDto', field: 'organizationId',
		sourceFeature: '003-product-management', sourceResource: 'ProductDto', sourceField: 'productId',
		reason: 'organizationId mirrors the product catalog id',
	}), root).code, 0);

	// Both edits BEFORE either re-scan -- `scan`'s own gate hashes the WHOLE adapter read-set (not
	// narrowed per module, see D-gate-precision part 1), so editing productDtoPath AFTER
	// re-establishing 001's scan gate would immediately re-stale it again. Making both edits first,
	// then re-scanning/re-disposing each feature once, is the only ordering that leaves BOTH scan
	// gates passing at the same time.
	fs.appendFileSync(widgetDtoPath(root), '\n// uncommitted edit to the SOURCE field\'s file\n');
	fs.appendFileSync(productDtoPath, '\n// uncommitted edit to the OTHER source field\'s file\n');
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root); // exits 3, see buildThirdModuleFixture's comment
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	run(['scan', '--feature', '003-product-management', '--terms', 'product'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '003-product-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);

	const emit001 = runCapturingStderr(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.match(emit001.stderr, /OrganizationDto\.taxRate <- WidgetDto\.name/);
	assert.doesNotMatch(emit001.stderr, /ProductDto/);

	const emit003 = runCapturingStderr(['contract', 'emit', '--feature', '003-product-management'], root);
	assert.match(emit003.stderr, /OrganizationDto\.organizationId <- ProductDto\.productId/);
	assert.doesNotMatch(emit003.stderr, /WidgetDto/);
});
