import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { ADAPTERS } from '../scanners/registry.mjs';
import { LEGACY_HTTP_ADAPTER_IDS, legacyHttpBaseline } from '../scanners/adapters/_t11-baselines.mjs';
import { bridgeLegacyHttpScan } from '../scanners/adapters/_t11-bridge.mjs';
import {
	compareLegacyHttpReports,
	compareLegacyHttpSemanticSnapshots,
	legacyHttpSemanticSnapshot,
} from '../scanners/adapters/_t11-parity.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = (id) => ADAPTERS.find((entry) => entry.id === id);

function report(id) {
	const baseline = legacyHttpBaseline(id);
	return runScan({ repoRoot: path.join(REPO_ROOT, baseline.fixture), terms: [] });
}

test('T11-04 pre-freeze parity: every legacy bridge round-trip preserves the semantic snapshot', () => {
	for (const id of LEGACY_HTTP_ADAPTER_IDS) {
		const original = report(id);
		const bridge = bridgeLegacyHttpScan({ adapter: adapter(id), report: original });
		const parity = compareLegacyHttpReports(original, bridge.legacy_report);
		assert.deepEqual(parity, { equal: true, diffs: [], truncated: false }, id);
	}
});

test('T11-04 parity catches endpoint path + operation identity drift at precise paths', () => {
	const original = legacyHttpSemanticSnapshot(report('java-spring'));
	const changed = structuredClone(original);
	const moduleIndex = changed.modules.findIndex((m) => m.module === 'organization');
	const controllerIndex = changed.modules[moduleIndex].controllers.findIndex((c) => c.className === 'OrganizationController');
	const endpointIndex = changed.modules[moduleIndex].controllers[controllerIndex].endpoints.findIndex((e) => e.operationId === 'findOrganization');
	const endpoint = changed.modules[moduleIndex].controllers[controllerIndex].endpoints[endpointIndex];
	endpoint.path = '/organizations/{WRONG}';
	endpoint.operationId = 'wrongOperation';

	const parity = compareLegacyHttpSemanticSnapshots(original, changed);
	assert.equal(parity.equal, false);
	assert.equal(parity.diffs.length, 2);
	assert.ok(parity.diffs.some((d) => d.path.endsWith(`modules[${moduleIndex}].controllers[${controllerIndex}].endpoints[${endpointIndex}].path`) && d.kind === 'value'));
	assert.ok(parity.diffs.some((d) => d.path.endsWith(`modules[${moduleIndex}].controllers[${controllerIndex}].endpoints[${endpointIndex}].operationId`) && d.kind === 'value'));
});

test('T11-04 parity catches persistence-key drift without widening JS Express capability semantics', () => {
	const original = legacyHttpSemanticSnapshot(report('typescript-express'));
	const changed = structuredClone(original);
	changed.modules[0].entities[0].idField = 'wrong_id';

	const parity = compareLegacyHttpSemanticSnapshots(original, changed);
	assert.equal(parity.equal, false);
	assert.deepEqual(parity.diffs.map((d) => d.path), ['modules[0].entities[0].idField']);

	const jsSnapshot = legacyHttpSemanticSnapshot(report('javascript-express'));
	assert.ok(jsSnapshot.modules.every((m) => m.entities.length === 0), 'T11 parity must not invent ORM entities for plain JS Express');
});

test('T11-04 parity catches read-set drift and module-order drift instead of sorting it away', () => {
	const original = legacyHttpSemanticSnapshot(report('ruby-rails'));
	const changed = structuredClone(original);
	changed.files_read.pop();
	changed.modules.reverse();

	const parity = compareLegacyHttpSemanticSnapshots(original, changed);
	assert.equal(parity.equal, false);
	assert.ok(parity.diffs.some((d) => d.path === 'files_read' && d.kind === 'array-length'));
	assert.ok(parity.diffs.some((d) => d.path === 'modules[0].module'));
});

test('T11-04 parity is bounded and rejects invalid maxDiffs', () => {
	const original = legacyHttpSemanticSnapshot(report('python-fastapi'));
	const changed = structuredClone(original);
	changed.adapter = 'wrong';
	changed.confidence = 'low';
	changed.verdict = 'greenfield';

	const parity = compareLegacyHttpSemanticSnapshots(original, changed, { maxDiffs: 2 });
	assert.equal(parity.equal, false);
	assert.equal(parity.diffs.length, 2);
	assert.equal(parity.truncated, true);
	assert.throws(() => compareLegacyHttpSemanticSnapshots(original, changed, { maxDiffs: 0 }), /maxDiffs/);
});
