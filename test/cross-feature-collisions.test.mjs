// D-cross-feature-collision: pure unit tests for lib/cross-feature-collisions.mjs -- no git repo,
// no CLI, hand-built scan-report/contract/feature.json fixtures. Mirrors test/field-dependencies.
// test.mjs's own style (the closest existing precedent for this kind of repo-wide, hand-fixtured
// unit test).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	findCollisions, evaluateCrossFeatureFindings, waiverKey,
	loadCrossFeatureResolution, saveCrossFeatureResolution,
} from '../lib/cross-feature-collisions.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cross-feature-unit-'));
}

function writeFeature(root, featureId, { scanReport = null, contract = null } = {}) {
	const dir = path.join(root, 'specs', featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({
		schema: 'sbf.feature/1', feature_id: featureId,
		feature_uid: `00000000-0000-4000-8000-${featureId.slice(0, 3).padStart(12, '0')}`,
		created_at: '2026-08-31T00:00:00.000Z',
	}));
	if (scanReport) fs.writeFileSync(path.join(dir, 'brownfield-scan.json'), JSON.stringify(scanReport));
	if (contract) {
		fs.mkdirSync(path.join(dir, 'contracts'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'contracts', `${featureId}.schema.json`), JSON.stringify(contract));
	}
}

function scanReport(moduleName, { entities = [], dtos = [] } = {}) {
	return { disposition: { module: moduleName }, related_modules: [{ module: moduleName, entities, dtos }] };
}

test('findCollisions: a resourceType shared by two features is a high-confidence finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });

	const findings = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.deepEqual(findings[0], { signal: 'resource_type', identifier: 'Item', other_feature: '002-organization-management', confidence: 'high' });
});

test('findCollisions: no collision when resourceTypes genuinely differ', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: null, tableSource: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: null, tableSource: null }] }) });

	assert.deepEqual(findCollisions(root, '001-widget-management'), []);
});

test('findCollisions: a table match where BOTH sides are explicit is high confidence', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'shared_table', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'shared_table', tableSource: 'explicit' }] }) });

	const findings = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].signal, 'table');
	assert.equal(findings[0].confidence, 'high');
});

test('findCollisions: a table match where EITHER side is inferred (guessed) is medium confidence', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'item', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'item', tableSource: 'inferred' }] }) });

	const findings = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].confidence, 'medium');
});

test('findCollisions: table names are compared case-insensitively, matching computeDbDrift\'s own convention', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'Users', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'users', tableSource: 'explicit' }] }) });

	const findings = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].signal, 'table');
});

test('findCollisions: a class or entity with no table at all never produces a table finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { dtos: [{ className: 'WidgetDto', table: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { dtos: [{ className: 'OrganizationDto', table: null }] }) });

	assert.deepEqual(findCollisions(root, '001-widget-management'), []);
});

test('findCollisions: an operationId shared by two features\' own emitted contracts is high confidence', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', {
		scanReport: scanReport('widget'),
		contract: { operations: { createResource: {} } },
	});
	writeFeature(root, '002-organization-management', {
		scanReport: scanReport('organization'),
		contract: { operations: { createResource: {} } },
	});

	const findings = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.deepEqual(findings[0], { signal: 'operation_id', identifier: 'createResource', other_feature: '002-organization-management', confidence: 'high' });
});

test('findCollisions: operationId collision is not reported when the OTHER feature has no contract emitted yet', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget'), contract: { operations: { createResource: {} } } });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization') }); // no contract yet

	assert.deepEqual(findCollisions(root, '001-widget-management'), []);
});

test('findCollisions: never includes the queried feature itself', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });
	assert.deepEqual(findCollisions(root, '001-widget-management'), []);
});

test('findCollisions: excludes an archived other feature', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });
	const otherDir = path.join(root, 'specs', '002-archived-feature');
	fs.mkdirSync(otherDir, { recursive: true });
	fs.writeFileSync(path.join(otherDir, 'feature.json'), JSON.stringify({
		schema: 'sbf.feature/1', feature_id: '002-archived-feature', feature_uid: '00000000-0000-4000-8000-000000000000',
		created_at: '2026-08-01T00:00:00.000Z', archived_at: '2026-08-15T00:00:00.000Z', archived_reason: 'superseded',
	}));
	fs.writeFileSync(path.join(otherDir, 'brownfield-scan.json'), JSON.stringify(scanReport('archived', { entities: [{ className: 'Item', table: null, tableSource: null }] })));

	assert.deepEqual(findCollisions(root, '001-widget-management'), []);
});

test('evaluateCrossFeatureFindings: a high-confidence finding blocks; waiving it un-blocks', () => {
	const findings = [{ signal: 'resource_type', identifier: 'Item', other_feature: '002-x', confidence: 'high' }];
	const noWaivers = { waivers: [] };
	assert.equal(evaluateCrossFeatureFindings(findings, noWaivers).blocking, true);

	const withWaiver = { waivers: [{ signal: 'resource_type', identifier: 'Item', other_feature: '002-x', reason: 'x', at: 'x' }] };
	const evaluated = evaluateCrossFeatureFindings(findings, withWaiver);
	assert.equal(evaluated.blocking, false);
	assert.equal(evaluated.waived.length, 1);
});

test('evaluateCrossFeatureFindings: a medium-confidence finding never blocks, waived or not', () => {
	const findings = [{ signal: 'table', identifier: 'item', other_feature: '002-x', confidence: 'medium' }];
	assert.equal(evaluateCrossFeatureFindings(findings, { waivers: [] }).blocking, false);
});

test('evaluateCrossFeatureFindings: a waiver for a finding that no longer exists is reported as stale, not silently kept as covering something', () => {
	const findings = [];
	const resolution = { waivers: [{ signal: 'resource_type', identifier: 'Item', other_feature: '002-x', reason: 'x', at: 'x' }] };
	const evaluated = evaluateCrossFeatureFindings(findings, resolution);
	assert.equal(evaluated.staleWaivers.length, 1);
	assert.equal(evaluated.blocking, false);
});

test('waiverKey: identical signal+identifier+other_feature produce the same key regardless of object identity', () => {
	const a = { signal: 'resource_type', identifier: 'Item', other_feature: '002-x' };
	const b = { signal: 'resource_type', identifier: 'Item', other_feature: '002-x' };
	assert.equal(waiverKey(a), waiverKey(b));
});

test('waiverKey: differs when any one of the 3 addressing fields differs', () => {
	const base = { signal: 'resource_type', identifier: 'Item', other_feature: '002-x' };
	const baseKey = waiverKey(base);
	assert.notEqual(waiverKey({ ...base, signal: 'table' }), baseKey);
	assert.notEqual(waiverKey({ ...base, identifier: 'Other' }), baseKey);
	assert.notEqual(waiverKey({ ...base, other_feature: '003-y' }), baseKey);
});

test('loadCrossFeatureResolution returns an empty, well-shaped document when the file does not exist', () => {
	const root = tmpRoot();
	const doc = loadCrossFeatureResolution(root, '001-widget-management');
	assert.deepEqual(doc, { schema: 'sbf.cross-feature-resolution/1', feature_id: '001-widget-management', waivers: [] });
});

test('saveCrossFeatureResolution refuses a document that violates the schema (e.g. missing reason)', () => {
	const root = tmpRoot();
	const invalid = {
		schema: 'sbf.cross-feature-resolution/1', feature_id: '001-widget-management',
		waivers: [{ signal: 'resource_type', identifier: 'Item', other_feature: '002-x', at: 'x' }], // reason omitted
	};
	assert.throws(() => saveCrossFeatureResolution(root, '001-widget-management', invalid), /refusing to write an invalid cross-feature resolution/);
});
