import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { legacyHttpBaseline } from '../../adapters/http-legacy-next/baselines.mjs';
import {
	bridgeLegacyHttpScan,
	snapshotLegacyHttpAdapter,
	summarizeLegacyHttpReport,
} from '../../adapters/http-legacy-next/bridge.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapterById = (id) => ADAPTERS.find((entry) => entry.id === id);

function report(id) {
	return runScan({ repoRoot: path.join(REPO_ROOT, legacyHttpBaseline(id).fixture), terms: [] });
}

test('T11-02 the adapter snapshot is a copy: editing it cannot reach the registry descriptor', () => {
	const adapter = adapterById('java-spring');
	const snapshot = snapshotLegacyHttpAdapter(adapter);
	assert.notEqual(snapshot.capabilities, adapter.capabilities);
	assert.deepEqual(snapshot.capabilities, adapter.capabilities);

	const before = structuredClone(adapter.capabilities);
	snapshot.capabilities['api.operations'] = !snapshot.capabilities['api.operations'];
	assert.deepEqual(adapter.capabilities, before);
});

test('T11-02 the bridge refuses anything that is not an sbf.adapter/2 descriptor object', () => {
	for (const bad of [null, undefined, 'java-spring', 42]) {
		assert.throws(() => snapshotLegacyHttpAdapter(bad), /requires an adapter descriptor object/, String(bad));
	}
	assert.throws(
		() => snapshotLegacyHttpAdapter({ ...adapterById('java-spring'), contract: 'sbf.adapter/3' }),
		/must still declare sbf\.adapter\/2/,
	);
	assert.throws(
		() => snapshotLegacyHttpAdapter({ ...adapterById('java-spring'), contract: undefined }),
		/must still declare sbf\.adapter\/2/,
	);
	assert.throws(
		() => snapshotLegacyHttpAdapter({ id: undefined, contract: 'sbf.adapter/2' }),
		/adapter "\(missing\)" is not one of T11's five legacy HTTP adapters/,
	);
});

test('T11-02 the bridge only accepts an sbf.scan-report/2 report and names a missing adapter', () => {
	const adapter = adapterById('python-fastapi');
	for (const bad of [null, undefined, {}, { schema: 'sbf.scan-report/1' }]) {
		assert.throws(
			() => bridgeLegacyHttpScan({ adapter, report: bad }),
			/T11 compatibility bridge only accepts sbf\.scan-report\/2 reports/,
			JSON.stringify(bad),
		);
	}
	assert.throws(
		() => bridgeLegacyHttpScan({ adapter, report: { schema: 'sbf.scan-report/2' } }),
		/scan report adapter "\(missing\)" does not match descriptor "python-fastapi"/,
	);
});

test('T11-02 summarizeLegacyHttpReport only accepts scan reports and tolerates absent sections', () => {
	for (const bad of [null, undefined, 'report', {}, { schema: 'sbf.scan-report/1' }]) {
		assert.throws(
			() => summarizeLegacyHttpReport(bad),
			/T11 compatibility bridge only accepts sbf\.scan-report\/2 reports/,
			JSON.stringify(bad),
		);
	}
	assert.deepEqual(summarizeLegacyHttpReport({ schema: 'sbf.scan-report/2' }), {
		modules: [],
		moduleCount: 0,
		controllerCount: 0,
		entityCount: 0,
		enumCount: 0,
		dtoCount: 0,
		endpointCount: 0,
		filesReadCount: 0,
	});
});

test('T11-02 the bridge copy of a report is detached in both directions', () => {
	const original = report('java-spring');
	const bridged = bridgeLegacyHttpScan({ adapter: adapterById('java-spring'), report: original });
	const moduleName = original.related_modules[0].module;
	const controllerCount = original.related_modules[0].controllers.length;
	assert.ok(controllerCount > 0);

	original.related_modules[0].module = 'edited-after-bridging';
	assert.equal(bridged.legacy_report.related_modules[0].module, moduleName);

	bridged.legacy_report.related_modules[0].controllers.length = 0;
	assert.equal(original.related_modules[0].controllers.length, controllerCount);
});
