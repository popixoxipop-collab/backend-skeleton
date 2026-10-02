import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { LEGACY_HTTP_ADAPTER_IDS, legacyHttpBaseline } from '../../adapters/http-legacy-next/baselines.mjs';
import { bridgeLegacyHttpScan } from '../../adapters/http-legacy-next/bridge.mjs';
import {
	LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
	compareLegacyHttpReports,
	compareLegacyHttpSemanticSnapshots,
	legacyHttpSemanticDigest,
	legacyHttpSemanticSnapshot,
} from '../../adapters/http-legacy-next/parity.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

// Every field the snapshot reads, populated with its own distinctive value, plus the fields it
// deliberately leaves out (`excluded`).
function fullReport() {
	return {
		schema: 'sbf.scan-report/2',
		adapter: 'java-spring',
		confidence: 'high',
		api_surface_source: 'source-annotations',
		verdict: 'inventory',
		path_prefix_signals: [{ kind: 'configurePathMatch', file: 'src/Api.java', prefix: '/api' }],
		related_modules: [{
			module: 'm1',
			controllers: [{
				className: 'C1',
				basePath: '/c1',
				file: '/checkout/C1.java',
				line: 2,
				operationIds: ['listX'],
				endpoints: [{
					method: 'list',
					path: '/c1/x',
					operationId: 'listX',
					file: '/checkout/C1.java',
					verb: 'GET',
					line: 3,
				}],
			}],
			entities: [{
				className: 'E1',
				table: 't1',
				tableSource: 'explicit',
				idField: 'id',
				idFieldType: 'UUID',
				idFieldIsUuid: true,
				file: '/checkout/E1.java',
				line: 4,
			}],
			enums: [{ name: 'En1', constants: ['A', 'B'], file: '/checkout/En1.java', line: 5 }],
			dtos: ['PlainDto', { className: 'D1', file: '/checkout/D1.java' }, { name: 'D2' }],
		}],
		files_read: ['src/C1.java'],
		terms: ['a-term'],
		rg_available: true,
		collisions: [],
		unknowns: ['an unknown'],
	};
}

const module0 = (r) => r.related_modules[0];
const controller0 = (r) => module0(r).controllers[0];
const endpoint0 = (r) => controller0(r).endpoints[0];
const entity0 = (r) => module0(r).entities[0];
const enum0 = (r) => module0(r).enums[0];
const dtos = (r) => module0(r).dtos;

const SNAPSHOT_FIELDS = [
	['adapter', (r) => { r.adapter = 'ruby-rails'; }],
	['confidence', (r) => { r.confidence = 'low'; }],
	['api_surface_source', (r) => { r.api_surface_source = 'other source'; }],
	['verdict', (r) => { r.verdict = 'greenfield'; }],
	['path_prefix_signals', (r) => { r.path_prefix_signals[0].prefix = '/v2'; }],
	['path_prefix_signals removed', (r) => { r.path_prefix_signals = []; }],
	['files_read', (r) => { r.files_read.push('src/Extra.java'); }],
	['module name', (r) => { module0(r).module = 'm2'; }],
	['module removed', (r) => { r.related_modules = []; }],
	['controllers removed', (r) => { module0(r).controllers = []; }],
	['controller className', (r) => { controller0(r).className = 'C2'; }],
	['controller basePath', (r) => { controller0(r).basePath = '/c2'; }],
	['controller file', (r) => { controller0(r).file = '/checkout/C2.java'; }],
	['endpoints removed', (r) => { controller0(r).endpoints = []; }],
	['endpoint method', (r) => { endpoint0(r).method = 'other'; }],
	['endpoint path', (r) => { endpoint0(r).path = '/c1/y'; }],
	['endpoint operationId', (r) => { endpoint0(r).operationId = 'other'; }],
	['endpoint file', (r) => { endpoint0(r).file = '/checkout/Other.java'; }],
	['entities removed', (r) => { module0(r).entities = []; }],
	['entity className', (r) => { entity0(r).className = 'E2'; }],
	['entity table', (r) => { entity0(r).table = 't2'; }],
	['entity idField', (r) => { entity0(r).idField = 'uid'; }],
	['entity idFieldType', (r) => { entity0(r).idFieldType = 'Long'; }],
	['entity idFieldIsUuid', (r) => { entity0(r).idFieldIsUuid = false; }],
	['entity file', (r) => { entity0(r).file = '/checkout/E2.java'; }],
	['enums removed', (r) => { module0(r).enums = []; }],
	['enum name', (r) => { enum0(r).name = 'En2'; }],
	['enum constants', (r) => { enum0(r).constants = ['A']; }],
	['enum file', (r) => { enum0(r).file = '/checkout/En2.java'; }],
	['dtos removed', (r) => { module0(r).dtos = []; }],
	['dto given as a string', (r) => { dtos(r)[0] = 'OtherDto'; }],
	['dto className', (r) => { dtos(r)[1].className = 'D9'; }],
	['dto file', (r) => { dtos(r)[1].file = '/checkout/D9.java'; }],
	['dto name used when className is absent', (r) => { dtos(r)[2].name = 'D9'; }],
];

const OUTSIDE_THE_SNAPSHOT = [
	['terms', (r) => { r.terms = ['another term']; }],
	['rg_available', (r) => { r.rg_available = false; }],
	['collisions', (r) => { r.collisions = [{ name: 'x' }]; }],
	['unknowns', (r) => { r.unknowns = ['something else']; }],
	['line numbers', (r) => {
		controller0(r).line = 90;
		endpoint0(r).line = 91;
		entity0(r).line = 92;
		enum0(r).line = 93;
	}],
];

test('T11-04 the snapshot digest and the report diff move with every snapshot field', () => {
	const base = fullReport();
	const baseDigest = legacyHttpSemanticDigest(base);
	for (const [label, change] of SNAPSHOT_FIELDS) {
		const changed = fullReport();
		change(changed);
		assert.notEqual(legacyHttpSemanticDigest(changed), baseDigest, label);
		const parity = compareLegacyHttpReports(base, changed);
		assert.equal(parity.equal, false, label);
		assert.ok(parity.diffs.length >= 1, label);
	}
});

test('T11-04 fields outside the snapshot do not move the digest or the report diff', () => {
	const base = fullReport();
	for (const [label, change] of OUTSIDE_THE_SNAPSHOT) {
		const changed = fullReport();
		change(changed);
		assert.equal(legacyHttpSemanticDigest(changed), legacyHttpSemanticDigest(base), label);
		assert.deepEqual(compareLegacyHttpReports(base, changed), { equal: true, diffs: [], truncated: false }, label);
	}
});

test('T11-04 the snapshot normalises absent parts to null or empty values', () => {
	assert.deepEqual(legacyHttpSemanticSnapshot({ schema: 'sbf.scan-report/2' }), {
		schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
		adapter: null,
		confidence: null,
		api_surface_source: null,
		verdict: null,
		path_prefix_signals: [],
		modules: [],
		files_read: [],
	});
	const sparse = { schema: 'sbf.scan-report/2', related_modules: [{ dtos: ['OnlyName', { name: 'N' }, {}] }, null] };
	assert.deepEqual(legacyHttpSemanticSnapshot(sparse).modules, [
		{
			module: null,
			controllers: [],
			entities: [],
			enums: [],
			dtos: [
				{ className: 'OnlyName', file: null },
				{ className: 'N', file: null },
				{ className: null, file: null },
			],
		},
		{ module: null, controllers: [], entities: [], enums: [], dtos: [] },
	]);
	for (const bad of [null, undefined, 'report', {}, { schema: 'sbf.scan-report/1' }]) {
		assert.throws(() => legacyHttpSemanticSnapshot(bad), /requires sbf\.scan-report\/2/, String(bad));
	}
});

test('T11-04 the snapshot is a copy: editing it cannot reach the report', () => {
	const original = fullReport();
	const before = structuredClone(original);
	const snapshot = legacyHttpSemanticSnapshot(original);
	snapshot.path_prefix_signals[0].prefix = '/edited';
	snapshot.files_read.push('edited');
	snapshot.modules[0].enums[0].constants.push('EDITED');
	assert.deepEqual(original, before);
});

test('T11-04 every kind of difference is reported with its path, kind and both values', () => {
	const at = (changes) => compareLegacyHttpSemanticSnapshots(
		{ schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA, n: 1, flag: true, text: 'a', nothing: null, list: [1, 2], nested: { a: 1 } },
		{ schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA, n: 1, flag: true, text: 'a', nothing: null, list: [1, 2], nested: { a: 1 }, ...changes },
	).diffs;

	assert.deepEqual(at({ n: 2 }), [{ path: 'n', kind: 'value', expected: 1, actual: 2 }]);
	assert.deepEqual(at({ flag: false }), [{ path: 'flag', kind: 'value', expected: true, actual: false }]);
	assert.deepEqual(at({ text: 'b' }), [{ path: 'text', kind: 'value', expected: 'a', actual: 'b' }]);
	assert.deepEqual(at({ nothing: 'x' }), [{ path: 'nothing', kind: 'value', expected: null, actual: 'x' }]);
	assert.deepEqual(at({ list: [1] }), [{ path: 'list', kind: 'array-length', expected: 2, actual: 1 }]);
	assert.deepEqual(at({ list: [1, 3] }), [{ path: 'list[1]', kind: 'value', expected: 2, actual: 3 }]);
	assert.deepEqual(at({ list: { 0: 1 } }), [{ path: 'list', kind: 'type', expected: [1, 2], actual: { 0: 1 } }]);
	assert.deepEqual(at({ nested: 7 }), [{ path: 'nested', kind: 'type', expected: { a: 1 }, actual: 7 }]);
	assert.deepEqual(at({ nested: { a: 1, b: 2 } }), [{ path: 'nested.b', kind: 'unexpected', expected: undefined, actual: 2 }]);
	assert.deepEqual(at({ nested: {} }), [{ path: 'nested.a', kind: 'missing', expected: 1, actual: undefined }]);
});

test('T11-04 differences are listed in key order, not insertion order', () => {
	const parity = compareLegacyHttpSemanticSnapshots({ b: 1, a: 1, c: 1 }, { c: 2, b: 2, a: 2 });
	assert.deepEqual(parity.diffs.map((diff) => diff.path), ['a', 'b', 'c']);
});

test('T11-04 the digest ignores object key order and nothing else', () => {
	const snapshot = legacyHttpSemanticSnapshot(fullReport());
	const reversed = (value) => {
		if (Array.isArray(value)) return value.map(reversed);
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed(value[key])]));
		}
		return value;
	};
	const digest = legacyHttpSemanticDigest(snapshot);

	assert.match(digest, /^[0-9a-f]{64}$/);
	assert.notDeepEqual(Object.keys(reversed(snapshot)), Object.keys(snapshot));
	assert.equal(legacyHttpSemanticDigest(reversed(snapshot)), digest);
	assert.equal(legacyHttpSemanticDigest(fullReport()), digest, 'a report digests as its own snapshot');

	const reordered = structuredClone(snapshot);
	reordered.files_read = ['b', 'a'];
	snapshot.files_read = ['a', 'b'];
	assert.notEqual(legacyHttpSemanticDigest(reordered), legacyHttpSemanticDigest(snapshot), 'array order is significant');

	for (const bad of [null, undefined, {}, { schema: 'something-else' }, 'text']) {
		assert.throws(() => legacyHttpSemanticDigest(bad), /requires a semantic snapshot or sbf\.scan-report\/2/, String(bad));
	}
});

test('T11-04 maxDiffs accepts exactly the integers 1 through 1000', () => {
	const snapshot = legacyHttpSemanticSnapshot(fullReport());
	for (const ok of [1, 100, 1000]) {
		assert.equal(compareLegacyHttpSemanticSnapshots(snapshot, snapshot, { maxDiffs: ok }).equal, true, String(ok));
	}
	for (const bad of [0, -1, 1001, 100000, 1.5, '5', Number.NaN, null]) {
		assert.throws(() => compareLegacyHttpSemanticSnapshots(snapshot, snapshot, { maxDiffs: bad }), /maxDiffs/, String(bad));
	}
	assert.throws(() => compareLegacyHttpReports(fullReport(), fullReport(), { maxDiffs: 0 }), /maxDiffs/);
});

// A scan report names its files by absolute path and does not say which directory it scanned, so a
// snapshot only becomes location-independent when the caller passes that directory as `root`.
function checkoutOf(id, dir) {
	fs.cpSync(path.join(REPO_ROOT, legacyHttpBaseline(id).fixture), dir, { recursive: true });
	return { root: dir, report: runScan({ repoRoot: dir, terms: [] }) };
}

function scratchDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't11-parity-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function snapshotFiles(snapshot) {
	return snapshot.modules.flatMap((m) => [
		...m.controllers.flatMap((c) => [c.file, ...c.endpoints.map((e) => e.file)]),
		...[...m.entities, ...m.enums, ...m.dtos].map((item) => item.file),
	]);
}

const moveReport = (value, from, to) => JSON.parse(JSON.stringify(value).replaceAll(`"${from}/`, `"${to}/`));
const relativeToCheckout = (snapshot) => JSON.parse(JSON.stringify(snapshot).replaceAll('"/checkout/', '"'));
const CHECKOUT = { expectedRoot: '/checkout', actualRoot: '/checkout' };

test('T11-04 without a root, the same fixture bytes in two directories compare unequal, and only by file location', (t) => {
	const tmp = scratchDir(t);
	for (const id of LEGACY_HTTP_ADAPTER_IDS) {
		const first = checkoutOf(id, path.join(tmp, 'first', id));
		const second = checkoutOf(id, path.join(tmp, 'second', 'deeper', id));
		const parity = compareLegacyHttpReports(first.report, second.report, { maxDiffs: 1000 });
		assert.equal(parity.equal, false, id);
		assert.equal(parity.truncated, false, id);
		assert.ok(parity.diffs.length > 0 && parity.diffs.every((diff) => diff.path.endsWith('.file')), id);
		assert.notEqual(legacyHttpSemanticDigest(first.report), legacyHttpSemanticDigest(second.report), id);
	}
});

test('T11-04 with a root, the same fixture bytes in two directories give one digest and equal parity for all five adapters', (t) => {
	const tmp = scratchDir(t);
	for (const id of LEGACY_HTTP_ADAPTER_IDS) {
		const first = checkoutOf(id, path.join(tmp, 'first', id));
		const second = checkoutOf(id, path.join(tmp, 'second', 'deeper', 'still', id));
		const parity = compareLegacyHttpReports(first.report, second.report, {
			expectedRoot: first.root,
			actualRoot: second.root,
		});
		assert.deepEqual(parity, { equal: true, diffs: [], truncated: false }, id);

		const digest = legacyHttpSemanticDigest(first.report, { root: first.root });
		assert.equal(legacyHttpSemanticDigest(second.report, { root: second.root }), digest, id);

		const inPlaceRoot = path.join(REPO_ROOT, legacyHttpBaseline(id).fixture);
		const inPlace = runScan({ repoRoot: inPlaceRoot, terms: [] });
		assert.equal(legacyHttpSemanticDigest(inPlace, { root: inPlaceRoot }), digest, `${id}: the checked-in fixture gives the same digest`);

		const snapshot = legacyHttpSemanticSnapshot(first.report, { root: first.root });
		const files = snapshotFiles(snapshot).filter((file) => file !== null);
		assert.ok(files.length > 0, id);
		for (const file of files) {
			assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), `${id}: ${file}`);
		}
		assert.ok(!JSON.stringify(snapshot).includes(first.root), `${id}: the snapshot does not carry the checkout path`);
	}
});

test('T11-04 with a root, every file becomes a forward-slash path below the root and nothing else changes', () => {
	const expected = relativeToCheckout(legacyHttpSemanticSnapshot(fullReport()));
	assert.deepEqual(snapshotFiles(expected).filter(Boolean).sort(), ['C1.java', 'C1.java', 'D1.java', 'E1.java', 'En1.java']);
	for (const root of ['/checkout', '/checkout/', '/checkout//', '/checkout/./sub/..']) {
		assert.deepEqual(legacyHttpSemanticSnapshot(fullReport(), { root }), expected, root);
	}

	const nested = fullReport();
	controller0(nested).file = '/checkout/src/main/java/C1.java';
	assert.equal(legacyHttpSemanticSnapshot(nested, { root: '/checkout' }).modules[0].controllers[0].file, 'src/main/java/C1.java');
});

test('T11-04 a relative root and relative files are resolved against the working directory, as the scanner does', () => {
	const expected = relativeToCheckout(legacyHttpSemanticSnapshot(fullReport()));
	const below = moveReport(fullReport(), '/checkout', 'some-checkout');
	assert.deepEqual(legacyHttpSemanticSnapshot(below, { root: 'some-checkout' }), expected);
	assert.deepEqual(legacyHttpSemanticSnapshot(below, { root: './some-checkout/' }), expected);

	const elsewhere = moveReport(fullReport(), '/checkout', 'elsewhere');
	assert.throws(() => legacyHttpSemanticSnapshot(elsewhere, { root: 'some-checkout' }), /is not under root "some-checkout"/);
});

const FILE_SLOTS = [
	['controller', (r) => controller0(r)],
	['endpoint', (r) => endpoint0(r)],
	['entity', (r) => entity0(r)],
	['enum', (r) => enum0(r)],
	['dto', (r) => dtos(r)[1]],
];

const NOT_BELOW_THE_ROOT = [
	['another directory', '/elsewhere/X.java'],
	['a sibling whose name starts with the root name', '/checkout-old/X.java'],
	['a path that climbs out of the root', '/checkout/../escape/X.java'],
	['the root itself', '/checkout'],
	['the parent of the root', '/'],
];

test('T11-04 a scan report file that is not strictly below the root fails closed wherever the report carries one', () => {
	for (const [slot, pick] of FILE_SLOTS) {
		for (const [what, file] of NOT_BELOW_THE_ROOT) {
			const bad = fullReport();
			pick(bad).file = file;
			const label = `${slot}: ${what}`;
			assert.throws(() => legacyHttpSemanticSnapshot(bad, { root: '/checkout' }), /is not under root "\/checkout"/, label);
			assert.throws(() => legacyHttpSemanticDigest(bad, { root: '/checkout' }), /is not under root/, label);
			assert.throws(() => compareLegacyHttpReports(fullReport(), bad, CHECKOUT), /is not under root/, label);
			assert.throws(() => compareLegacyHttpReports(bad, fullReport(), CHECKOUT), /is not under root/, label);
		}
	}
	for (const bad of [5, {}, true]) {
		const report = fullReport();
		controller0(report).file = bad;
		assert.throws(() => legacyHttpSemanticSnapshot(report, { root: '/checkout' }), TypeError, String(bad));
	}
});

test('T11-04 the root must be a non-empty string, and only a scan report can be given one', () => {
	for (const bad of ['', 5, null, {}, ['/checkout'], true]) {
		assert.throws(() => legacyHttpSemanticSnapshot(fullReport(), { root: bad }), /root must be a non-empty string/, String(bad));
		assert.throws(() => legacyHttpSemanticDigest(fullReport(), { root: bad }), /root must be a non-empty string/, String(bad));
	}
	assert.throws(
		() => legacyHttpSemanticDigest(legacyHttpSemanticSnapshot(fullReport()), { root: '/checkout' }),
		/root only applies to a scan report/,
	);
	for (const one of [{ expectedRoot: '/checkout' }, { actualRoot: '/checkout' }]) {
		assert.throws(() => compareLegacyHttpReports(fullReport(), fullReport(), one), /expectedRoot and actualRoot must be given together/, JSON.stringify(one));
	}
});

test('T11-04 with a root, the digest and the comparison still move with every snapshot field and ignore the rest', () => {
	const base = fullReport();
	const baseDigest = legacyHttpSemanticDigest(base, { root: '/checkout' });
	for (const [label, change] of SNAPSHOT_FIELDS) {
		const changed = fullReport();
		change(changed);
		assert.notEqual(legacyHttpSemanticDigest(changed, { root: '/checkout' }), baseDigest, label);
		assert.equal(compareLegacyHttpReports(base, changed, CHECKOUT).equal, false, label);
	}
	for (const [label, change] of OUTSIDE_THE_SNAPSHOT) {
		const changed = fullReport();
		change(changed);
		assert.equal(legacyHttpSemanticDigest(changed, { root: '/checkout' }), baseDigest, label);
		assert.deepEqual(compareLegacyHttpReports(base, changed, CHECKOUT), { equal: true, diffs: [], truncated: false }, label);
	}
});

test('T11-04 with a root, the same bytes at a different place below each root differ at that file, and maxDiffs still applies', () => {
	const elsewhere = moveReport(fullReport(), '/checkout', '/elsewhere/deeper');
	assert.deepEqual(
		compareLegacyHttpReports(fullReport(), elsewhere, { expectedRoot: '/checkout', actualRoot: '/elsewhere/deeper' }),
		{ equal: true, diffs: [], truncated: false },
	);

	controller0(elsewhere).file = '/elsewhere/deeper/sub/C1.java';
	endpoint0(elsewhere).file = '/elsewhere/deeper/sub/C1.java';
	const roots = { expectedRoot: '/checkout', actualRoot: '/elsewhere/deeper' };
	assert.deepEqual(compareLegacyHttpReports(fullReport(), elsewhere, roots).diffs, [
		{ path: 'modules[0].controllers[0].endpoints[0].file', kind: 'value', expected: 'C1.java', actual: 'sub/C1.java' },
		{ path: 'modules[0].controllers[0].file', kind: 'value', expected: 'C1.java', actual: 'sub/C1.java' },
	]);

	const capped = compareLegacyHttpReports(fullReport(), elsewhere, { ...roots, maxDiffs: 1 });
	assert.equal(capped.diffs.length, 1);
	assert.equal(capped.truncated, true);
	assert.throws(() => compareLegacyHttpReports(fullReport(), elsewhere, { ...roots, maxDiffs: 0 }), /maxDiffs/);
});
