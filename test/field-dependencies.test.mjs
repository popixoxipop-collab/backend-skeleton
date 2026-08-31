// D-field-dependency: pure unit tests for lib/field-dependencies.mjs -- no git repo, no CLI, hand-
// built scan-report fixtures. Covers resolveClassFile()'s 5 branches directly (the CLI-level
// behavior these branches drive is exercised end-to-end in test/dependency-cli.test.mjs) plus
// loadFieldDependencies/saveFieldDependencies's schema round-trip and dependencyKey()'s identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	dependenciesPath, loadFieldDependencies, saveFieldDependencies, dependencyKey, resolveClassFile,
	listDownstreamDependents,
} from '../lib/field-dependencies.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-field-dependencies-unit-'));
}

// D-dependency-propagation-notice: listDownstreamDependents() reads feature records via
// lib/featurelifecycle.mjs's listFeatures(), which requires a real, schema-valid feature.json --
// unlike writeScanReport() below, a hand-built minimal object won't do.
function writeFeatureRecord(root, featureId, uid) {
	const dir = path.join(root, 'specs', featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({
		schema: 'sbf.feature/1', feature_id: featureId, feature_uid: uid, created_at: '2026-08-31T00:00:00.000Z',
	}, null, 2));
}

function writeScanReport(root, featureId, report) {
	const dir = path.join(root, 'specs', featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'brownfield-scan.json'), JSON.stringify(report, null, 2));
}

test('resolveClassFile: no scan report at all -> no_scan_report', () => {
	const root = tmpRoot();
	const result = resolveClassFile(root, '001-widget-management', 'WidgetDto');
	assert.deepEqual(result, { file: null, reason: 'no_scan_report' });
});

test('resolveClassFile: a scan report with no disposition and no related_modules -> no_disposition', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', { schema: 'sbf.scan-report/1', related_modules: [] });
	const result = resolveClassFile(root, '001-widget-management', 'WidgetDto');
	assert.deepEqual(result, { file: null, reason: 'no_disposition' });
});

test('resolveClassFile: disposition names a module absent from related_modules -> module_not_found', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', {
		schema: 'sbf.scan-report/1',
		disposition: { mode: 'reuse', module: 'ghost-module' },
		related_modules: [{ module: 'widget', entities: [], dtos: [] }],
	});
	const result = resolveClassFile(root, '001-widget-management', 'WidgetDto');
	assert.deepEqual(result, { file: null, reason: 'module_not_found' });
});

test('resolveClassFile: module found, resource type absent from its entities/dtos -> class_not_found, naming known classes', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', {
		schema: 'sbf.scan-report/1',
		disposition: { mode: 'reuse', module: 'widget' },
		related_modules: [{
			module: 'widget',
			entities: [{ className: 'WidgetEntity', file: '/repo/WidgetEntity.java' }],
			dtos: [{ className: 'WidgetDto', file: '/repo/WidgetDto.java' }],
		}],
	});
	const result = resolveClassFile(root, '001-widget-management', 'DoesNotExist');
	assert.equal(result.file, null);
	assert.equal(result.reason, 'class_not_found');
	assert.deepEqual(result.knownClasses.sort(), ['WidgetDto', 'WidgetEntity']);
});

test('resolveClassFile: a real match in entities resolves to its file', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', {
		schema: 'sbf.scan-report/1',
		disposition: { mode: 'reuse', module: 'widget' },
		related_modules: [{
			module: 'widget',
			entities: [{ className: 'WidgetEntity', file: '/repo/WidgetEntity.java' }],
			dtos: [],
		}],
	});
	const result = resolveClassFile(root, '001-widget-management', 'WidgetEntity');
	assert.deepEqual(result, { file: '/repo/WidgetEntity.java', reason: null });
});

test('resolveClassFile: a real match in dtos resolves to its file', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', {
		schema: 'sbf.scan-report/1',
		disposition: { mode: 'reuse', module: 'widget' },
		related_modules: [{
			module: 'widget',
			entities: [],
			dtos: [{ className: 'WidgetDto', file: '/repo/WidgetDto.java' }],
		}],
	});
	const result = resolveClassFile(root, '001-widget-management', 'WidgetDto');
	assert.deepEqual(result, { file: '/repo/WidgetDto.java', reason: null });
});

test('resolveClassFile: no explicit disposition.module falls back to related_modules[0].module', () => {
	const root = tmpRoot();
	writeScanReport(root, '001-widget-management', {
		schema: 'sbf.scan-report/1',
		related_modules: [{
			module: 'widget',
			entities: [],
			dtos: [{ className: 'WidgetDto', file: '/repo/WidgetDto.java' }],
		}],
	});
	const result = resolveClassFile(root, '001-widget-management', 'WidgetDto');
	assert.deepEqual(result, { file: '/repo/WidgetDto.java', reason: null });
});

test('loadFieldDependencies returns an empty, well-shaped document when dependencies.json does not exist', () => {
	const root = tmpRoot();
	const doc = loadFieldDependencies(root, '001-widget-management');
	assert.deepEqual(doc, { schema: 'sbf.field-dependency/1', feature_id: '001-widget-management', dependencies: [] });
});

test('saveFieldDependencies + loadFieldDependencies round-trip a valid document', () => {
	const root = tmpRoot();
	const doc = {
		schema: 'sbf.field-dependency/1',
		feature_id: '001-widget-management',
		dependencies: [{
			target: { resourceType: 'WidgetDto', fieldName: 'name' },
			source: { feature: '002-organization-management', resourceType: 'OrganizationDto', fieldName: 'taxRate' },
			reason: 'derived from org tax rate',
			at: '2026-08-31T00:00:00.000Z',
		}],
	};
	saveFieldDependencies(root, '001-widget-management', doc);
	assert.ok(fs.existsSync(dependenciesPath(root, '001-widget-management')));
	assert.deepEqual(loadFieldDependencies(root, '001-widget-management'), doc);
});

test('saveFieldDependencies refuses a document that violates the schema (e.g. missing reason)', () => {
	const root = tmpRoot();
	const invalid = {
		schema: 'sbf.field-dependency/1',
		feature_id: '001-widget-management',
		dependencies: [{
			target: { resourceType: 'WidgetDto', fieldName: 'name' },
			source: { feature: '002-organization-management', resourceType: 'OrganizationDto', fieldName: 'taxRate' },
			at: '2026-08-31T00:00:00.000Z',
			// reason deliberately omitted -- required by the schema
		}],
	};
	assert.throws(() => saveFieldDependencies(root, '001-widget-management', invalid), /refusing to write invalid field dependencies/);
	assert.equal(fs.existsSync(dependenciesPath(root, '001-widget-management')), false, 'an invalid document must never reach disk');
});

test('loadFieldDependencies throws on a hand-corrupted (schema-invalid) dependencies.json already on disk', () => {
	const root = tmpRoot();
	const dir = path.dirname(dependenciesPath(root, '001-widget-management'));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(dependenciesPath(root, '001-widget-management'), JSON.stringify({ schema: 'sbf.field-dependency/1' }));
	assert.throws(() => loadFieldDependencies(root, '001-widget-management'), /does not match schemas\/field-dependency\.schema\.json/);
});

test('dependencyKey: identical target+source produce the same key regardless of object identity', () => {
	const a = {
		target: { resourceType: 'WidgetDto', fieldName: 'name' },
		source: { feature: '002-organization-management', resourceType: 'OrganizationDto', fieldName: 'taxRate' },
	};
	const b = {
		target: { resourceType: 'WidgetDto', fieldName: 'name' },
		source: { feature: '002-organization-management', resourceType: 'OrganizationDto', fieldName: 'taxRate' },
	};
	assert.equal(dependencyKey(a), dependencyKey(b));
});

test('dependencyKey: differs when any one of the 5 addressing fields differs', () => {
	const base = {
		target: { resourceType: 'WidgetDto', fieldName: 'name' },
		source: { feature: '002-organization-management', resourceType: 'OrganizationDto', fieldName: 'taxRate' },
	};
	const variants = [
		{ ...base, target: { ...base.target, resourceType: 'Other' } },
		{ ...base, target: { ...base.target, fieldName: 'other' } },
		{ ...base, source: { ...base.source, feature: '003-other-feature' } },
		{ ...base, source: { ...base.source, resourceType: 'Other' } },
		{ ...base, source: { ...base.source, fieldName: 'other' } },
	];
	const baseKey = dependencyKey(base);
	for (const v of variants) assert.notEqual(dependencyKey(v), baseKey);
});

// D-dependency-propagation-notice
function fieldDependencyDoc(featureId, target, source) {
	return {
		schema: 'sbf.field-dependency/1',
		feature_id: featureId,
		dependencies: [{ target, source, reason: 'unit test fixture', at: '2026-08-31T00:00:00.000Z' }],
	};
}

test('listDownstreamDependents: returns the one OTHER feature that declares a dependency on this featureId, excludes an unrelated third feature', () => {
	const root = tmpRoot();
	writeFeatureRecord(root, '001-source-feature', '11111111-1111-4111-8111-111111111111');
	writeFeatureRecord(root, '002-dependent-feature', '22222222-2222-4222-8222-222222222222');
	writeFeatureRecord(root, '003-unrelated-feature', '33333333-3333-4333-8333-333333333333');

	saveFieldDependencies(root, '002-dependent-feature', fieldDependencyDoc(
		'002-dependent-feature',
		{ resourceType: 'InvoiceLine', fieldName: 'totalWithTax' },
		{ feature: '001-source-feature', resourceType: 'Organization', fieldName: 'taxRate' },
	));
	// 003 declares a dependency on something else entirely -- must never be attributed to 001.
	saveFieldDependencies(root, '003-unrelated-feature', fieldDependencyDoc(
		'003-unrelated-feature',
		{ resourceType: 'Whatever', fieldName: 'x' },
		{ feature: '002-dependent-feature', resourceType: 'InvoiceLine', fieldName: 'totalWithTax' },
	));

	const result = listDownstreamDependents(root, '001-source-feature');
	assert.equal(result.length, 1);
	assert.equal(result[0].dependentFeature, '002-dependent-feature');
	assert.equal(result[0].dep.source.feature, '001-source-feature');
	assert.equal(result[0].dep.target.resourceType, 'InvoiceLine');
});

test('listDownstreamDependents: never includes the queried feature itself, even if it points at its own field', () => {
	const root = tmpRoot();
	writeFeatureRecord(root, '001-self-feature', '11111111-1111-4111-8111-111111111111');
	saveFieldDependencies(root, '001-self-feature', fieldDependencyDoc(
		'001-self-feature',
		{ resourceType: 'WidgetDto', fieldName: 'name' },
		{ feature: '001-self-feature', resourceType: 'WidgetDto', fieldName: 'widgetId' },
	));
	assert.deepEqual(listDownstreamDependents(root, '001-self-feature'), []);
});

test('listDownstreamDependents: returns an empty array when no feature depends on it', () => {
	const root = tmpRoot();
	writeFeatureRecord(root, '001-lonely-feature', '11111111-1111-4111-8111-111111111111');
	writeFeatureRecord(root, '002-other-feature', '22222222-2222-4222-8222-222222222222');
	assert.deepEqual(listDownstreamDependents(root, '001-lonely-feature'), []);
});

test('listDownstreamDependents: excludes an archived dependent feature', () => {
	const root = tmpRoot();
	writeFeatureRecord(root, '001-source-feature', '11111111-1111-4111-8111-111111111111');
	const dir = path.join(root, 'specs', '002-archived-dependent');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({
		schema: 'sbf.feature/1', feature_id: '002-archived-dependent', feature_uid: '22222222-2222-4222-8222-222222222222',
		created_at: '2026-08-01T00:00:00.000Z', archived_at: '2026-08-15T00:00:00.000Z', archived_reason: 'superseded',
	}, null, 2));
	saveFieldDependencies(root, '002-archived-dependent', fieldDependencyDoc(
		'002-archived-dependent',
		{ resourceType: 'InvoiceLine', fieldName: 'totalWithTax' },
		{ feature: '001-source-feature', resourceType: 'Organization', fieldName: 'taxRate' },
	));
	assert.deepEqual(listDownstreamDependents(root, '001-source-feature'), []);
});
