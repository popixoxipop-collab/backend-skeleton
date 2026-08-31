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
} from '../lib/field-dependencies.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-field-dependencies-unit-'));
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
