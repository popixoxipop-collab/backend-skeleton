import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import {
	LEGACY_HTTP_ADAPTER_IDS,
	LEGACY_HTTP_BASELINES,
	legacyHttpBaseline,
} from '../../adapters/http-legacy-next/baselines.mjs';
import {
	LEGACY_HTTP_BRIDGE_SCHEMA,
	bridgeLegacyHttpScan,
	snapshotLegacyHttpAdapter,
	summarizeLegacyHttpReport,
} from '../../adapters/http-legacy-next/bridge.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function adapterById(id) {
	const adapter = ADAPTERS.find((candidate) => candidate.id === id);
	assert.ok(adapter, `expected shipped adapter "${id}"`);
	return adapter;
}

test('T11 baseline: five legacy HTTP adapters keep descriptor contracts and capability truth tables', () => {
	assert.deepEqual(
		LEGACY_HTTP_ADAPTER_IDS,
		['java-spring', 'ruby-rails', 'python-fastapi', 'typescript-express', 'javascript-express'],
	);
	for (const id of LEGACY_HTTP_ADAPTER_IDS) {
		const adapter = adapterById(id);
		const baseline = LEGACY_HTTP_BASELINES[id];
		assert.deepEqual(snapshotLegacyHttpAdapter(adapter), { ...baseline.descriptor, id });
	}
});

for (const id of LEGACY_HTTP_ADAPTER_IDS) {
	test(`T11 baseline: ${id} committed fixture inventory stays behaviorally pinned`, () => {
		const baseline = legacyHttpBaseline(id);
		const fixture = path.join(REPO_ROOT, baseline.fixture);
		const report = runScan({ repoRoot: fixture, terms: [] });

		assert.equal(report.schema, 'sbf.scan-report/2');
		assert.equal(report.adapter, id);
		assert.equal(report.confidence, baseline.descriptor.confidence);
		assert.equal(report.verdict, 'inventory');
		assert.deepEqual(summarizeLegacyHttpReport(report), baseline.inventory);
		assert.ok(report.files_read.every((file) => !path.isAbsolute(file)), 'legacy files_read stays repo-relative');
	});
}

test('T11-02 bridge is lossless: it wraps, but never rewrites, the legacy scan report', () => {
	for (const id of LEGACY_HTTP_ADAPTER_IDS) {
		const baseline = legacyHttpBaseline(id);
		const report = runScan({ repoRoot: path.join(REPO_ROOT, baseline.fixture), terms: [] });
		const bridged = bridgeLegacyHttpScan({ adapter: adapterById(id), report });

		assert.equal(bridged.schema, LEGACY_HTTP_BRIDGE_SCHEMA);
		assert.equal(bridged.mode, 'compatibility-only');
		assert.equal(bridged.source_scan_schema, 'sbf.scan-report/2');
		assert.deepEqual(bridged.legacy_report, report);
		assert.notEqual(bridged.legacy_report, report, 'bridge must snapshot rather than alias the caller object');
		assert.deepEqual(bridged.source_adapter, snapshotLegacyHttpAdapter(adapterById(id)));
	}
});

test('T11-02 bridge fails closed for adapter/report mismatch and non-T11 adapters', () => {
	const baseline = legacyHttpBaseline('python-fastapi');
	const report = runScan({ repoRoot: path.join(REPO_ROOT, baseline.fixture), terms: [] });
	assert.throws(
		() => bridgeLegacyHttpScan({ adapter: adapterById('java-spring'), report }),
		/does not match descriptor/,
	);
	assert.throws(
		() => snapshotLegacyHttpAdapter(adapterById('generic-grep')),
		/not one of T11's five legacy HTTP adapters/,
	);
	assert.throws(
		() => bridgeLegacyHttpScan({ adapter: adapterById('python-fastapi'), report: { ...report, schema: 'sbf.scan-report/99' } }),
		/only accepts sbf\.scan-report\/2/,
	);
});
