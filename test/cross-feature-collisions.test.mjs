// D-cross-feature-collision: pure unit tests for lib/cross-feature-collisions.mjs -- no git repo,
// no CLI, hand-built scan-report/contract/feature.json fixtures. Mirrors test/field-dependencies.
// test.mjs's own style (the closest existing precedent for this kind of repo-wide, hand-fixtured
// unit test).
//
// D-cross-feature-fk-inference: findCollisions() now returns {findings, fk_check, unknowns}
// (a superset of the old bare array) -- every pre-existing test below destructures `.findings`
// instead of using the return value directly. None of these tests pass `liveDbSchema` or a
// persisted `db_schema`, so they also double as the mandatory no-regression proof: the existing
// resource_type/table/operation_id findings and blocking behavior stay byte-identical, `fk_check`
// lands at {mode: 'unavailable', schema: null, source_feature: null}, and `unknowns` carries
// exactly the one explanatory note -- never a silent gap.
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

function scanReport(moduleName, { entities = [], dtos = [], dbSchema = null } = {}) {
	return {
		disposition: { module: moduleName },
		related_modules: [{ module: moduleName, entities, dtos }],
		...(dbSchema ? { db_schema: { migrations: { tool: 'none', files: [], tables: [] }, live: dbSchema } } : {}),
	};
}

// D-cross-feature-fk-inference: a live-schema fixture, same shape introspectWithClient() returns.
function liveSchema(tables) {
	return { schema: 'public', tables, schema_hash: 'fake-hash' };
}

test('findCollisions: a resourceType shared by two features is a high-confidence finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });

	const { findings, fk_check, unknowns } = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.deepEqual(findings[0], { signal: 'resource_type', identifier: 'Item', other_feature: '002-organization-management', confidence: 'high' });
	assert.deepEqual(fk_check, { mode: 'unavailable', schema: null, source_feature: null });
	assert.equal(unknowns.length, 1);
});

test('findCollisions: no collision when resourceTypes genuinely differ', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: null, tableSource: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: null, tableSource: null }] }) });

	assert.deepEqual(findCollisions(root, '001-widget-management').findings, []);
});

test('findCollisions: a table match where BOTH sides are explicit is high confidence', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'shared_table', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'shared_table', tableSource: 'explicit' }] }) });

	const { findings } = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].signal, 'table');
	assert.equal(findings[0].confidence, 'high');
});

test('findCollisions: a table match where EITHER side is inferred (guessed) is medium confidence', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'item', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'item', tableSource: 'inferred' }] }) });

	const { findings } = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].confidence, 'medium');
});

test('findCollisions: table names are compared case-insensitively, matching computeDbDrift\'s own convention', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Widget', table: 'Users', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'users', tableSource: 'explicit' }] }) });

	const { findings } = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].signal, 'table');
});

test('findCollisions: a class or entity with no table at all never produces a table finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { dtos: [{ className: 'WidgetDto', table: null }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { dtos: [{ className: 'OrganizationDto', table: null }] }) });

	assert.deepEqual(findCollisions(root, '001-widget-management').findings, []);
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

	const { findings } = findCollisions(root, '001-widget-management');
	assert.equal(findings.length, 1);
	assert.deepEqual(findings[0], { signal: 'operation_id', identifier: 'createResource', other_feature: '002-organization-management', confidence: 'high' });
});

test('findCollisions: operationId collision is not reported when the OTHER feature has no contract emitted yet', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget'), contract: { operations: { createResource: {} } } });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization') }); // no contract yet

	assert.deepEqual(findCollisions(root, '001-widget-management').findings, []);
});

test('findCollisions: never includes the queried feature itself', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Item', table: null, tableSource: null }] }) });
	assert.deepEqual(findCollisions(root, '001-widget-management').findings, []);
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

	assert.deepEqual(findCollisions(root, '001-widget-management').findings, []);
});

// D-cross-feature-fk-inference: findCollisions()'s new 4th signal, live DB FK correlation.

test('findCollisions: a live FK edge where the child/parent tables belong to two different features is a db_foreign_key finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Order', table: 'orders', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'organizations', tableSource: 'explicit' }] }) });

	const liveDbSchema = { migrations: { tool: 'none', files: [], tables: [] }, live: liveSchema([
		{ name: 'orders', foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }] },
		{ name: 'organizations', foreign_keys: [] },
	]) };

	const { findings, fk_check } = findCollisions(root, '001-widget-management', { liveDbSchema });
	assert.equal(fk_check.mode, 'live');
	const fk = findings.find((f) => f.signal === 'db_foreign_key');
	assert.deepEqual(fk, {
		signal: 'db_foreign_key', identifier: 'orders.org_id -> organizations.id',
		other_feature: '002-organization-management', confidence: 'high', direction: 'references',
	});
});

test('findCollisions: db_foreign_key direction is referenced_by when THIS feature owns the parent side', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Organization', table: 'organizations', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-order-management', { scanReport: scanReport('order', { entities: [{ className: 'Order', table: 'orders', tableSource: 'explicit' }] }) });

	const liveDbSchema = { migrations: { tool: 'none', files: [], tables: [] }, live: liveSchema([
		{ name: 'orders', foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }] },
		{ name: 'organizations', foreign_keys: [] },
	]) };

	const { findings } = findCollisions(root, '001-widget-management', { liveDbSchema });
	const fk = findings.find((f) => f.signal === 'db_foreign_key');
	assert.equal(fk.direction, 'referenced_by');
	assert.equal(fk.other_feature, '002-order-management');
});

test('findCollisions: db_foreign_key confidence is medium when either side\'s table name was inferred, not annotated', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Order', table: 'orders', tableSource: 'inferred' }] }) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'organizations', tableSource: 'explicit' }] }) });

	const liveDbSchema = { migrations: { tool: 'none', files: [], tables: [] }, live: liveSchema([
		{ name: 'orders', foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }] },
	]) };

	const { findings } = findCollisions(root, '001-widget-management', { liveDbSchema });
	const fk = findings.find((f) => f.signal === 'db_foreign_key');
	assert.equal(fk.confidence, 'medium');
});

test('findCollisions: a self-referencing or same-feature-owned FK edge produces no db_foreign_key finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', {
		entities: [
			{ className: 'Order', table: 'orders', tableSource: 'explicit' },
			{ className: 'OrderLine', table: 'order_lines', tableSource: 'explicit' },
		],
	}) });
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [] }) });

	const liveDbSchema = { migrations: { tool: 'none', files: [], tables: [] }, live: liveSchema([
		{ name: 'order_lines', foreign_keys: [{ column: 'order_id', references_table: 'orders', references_column: 'id' }] },
		{ name: 'orders', foreign_keys: [] },
	]) };

	const { findings } = findCollisions(root, '001-widget-management', { liveDbSchema });
	assert.equal(findings.filter((f) => f.signal === 'db_foreign_key').length, 0);
});

test('findCollisions: an FK edge whose other side matches no active feature is reported in unknowns, not as a finding', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Order', table: 'orders', tableSource: 'explicit' }] }) });

	const liveDbSchema = { migrations: { tool: 'none', files: [], tables: [] }, live: liveSchema([
		{ name: 'orders', foreign_keys: [{ column: 'legacy_owner_id', references_table: 'legacy_owners', references_column: 'id' }] },
	]) };

	const { findings, unknowns } = findCollisions(root, '001-widget-management', { liveDbSchema });
	assert.equal(findings.filter((f) => f.signal === 'db_foreign_key').length, 0);
	assert.equal(unknowns.length, 1);
	assert.match(unknowns[0], /legacy_owners.*not declared by any active feature/);
});

test('findCollisions: fk_check falls back to this feature\'s OWN persisted db_schema.live when no liveDbSchema is passed', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', {
		scanReport: scanReport('widget', {
			entities: [{ className: 'Order', table: 'orders', tableSource: 'explicit' }],
			dbSchema: liveSchema([{ name: 'orders', foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }] }]),
		}),
	});
	writeFeature(root, '002-organization-management', { scanReport: scanReport('organization', { entities: [{ className: 'Organization', table: 'organizations', tableSource: 'explicit' }] }) });

	const { findings, fk_check } = findCollisions(root, '001-widget-management');
	assert.deepEqual(fk_check, { mode: 'persisted', schema: 'public', source_feature: '001-widget-management' });
	assert.ok(findings.some((f) => f.signal === 'db_foreign_key'));
});

test('findCollisions: fk_check falls back to another active feature\'s persisted snapshot, deterministically, when THIS feature has none', () => {
	const root = tmpRoot();
	writeFeature(root, '001-widget-management', { scanReport: scanReport('widget', { entities: [{ className: 'Order', table: 'orders', tableSource: 'explicit' }] }) });
	writeFeature(root, '002-organization-management', {
		scanReport: scanReport('organization', {
			entities: [{ className: 'Organization', table: 'organizations', tableSource: 'explicit' }],
			dbSchema: liveSchema([{ name: 'orders', foreign_keys: [{ column: 'org_id', references_table: 'organizations', references_column: 'id' }] }]),
		}),
	});

	const { fk_check } = findCollisions(root, '001-widget-management');
	assert.deepEqual(fk_check, { mode: 'persisted', schema: 'public', source_feature: '002-organization-management' });
});

test('findCollisions: waiving a db_foreign_key finding round-trips through evaluateCrossFeatureFindings/waiverKey correctly', () => {
	const finding = { signal: 'db_foreign_key', identifier: 'orders.org_id -> organizations.id', other_feature: '002-x', confidence: 'high', direction: 'references' };
	assert.equal(evaluateCrossFeatureFindings([finding], { waivers: [] }).blocking, true);
	const waived = evaluateCrossFeatureFindings([finding], { waivers: [{ ...finding, reason: 'known, intentional', at: 'x' }] });
	assert.equal(waived.blocking, false);
	assert.equal(waived.waived.length, 1);
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
