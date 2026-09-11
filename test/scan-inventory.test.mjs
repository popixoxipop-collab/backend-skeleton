// D-zero-config-scan: direct unit tests for runScan()'s new zero-terms "inventory" branch,
// independent of any real adapter -- matching test/adapter-registry.test.mjs's own style of
// handing runScan() a plain in-memory `adapters` array (no filesystem, no CLI). CLI-level
// coverage (real fixture repo, real rg-missing PATH restriction) lives in test/scan-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../scanners/index.mjs';

// A minimal, always-detecting fixture adapter. `modules` is the raw scan() result this test
// controls directly -- no real filesystem, no rg.
function fixtureAdapter({ id = 'fixture', specificity = 50, modules = [] } = {}) {
	return {
		id, specificity, confidence: 'high',
		detect() { return true; },
		scan() { return { modules }; },
	};
}

function mod(overrides = {}) {
	return { module: 'widget', controllers: [], entities: [], enums: [], dtos: [], ...overrides };
}

test('runScan with terms:[] returns verdict "inventory", collisions:[], and every module present unscored', () => {
	const adapters = [fixtureAdapter({
		modules: [
			mod({ module: 'organization' }),
			mod({ module: 'widget', controllers: [{ className: 'WidgetController', basePath: '/widgets', endpoints: [], file: 'W.java', line: 1 }] }),
		],
	})];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });

	assert.equal(report.verdict, 'inventory');
	assert.deepEqual(report.collisions, []);
	assert.equal(report.related_modules.length, 2);
});

test('runScan inventory mode: each listed module genuinely OMITS score/evidence/capped_signals (not merely undefined)', () => {
	const adapters = [fixtureAdapter({ modules: [mod()] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	const [only] = report.related_modules;
	assert.equal(Object.hasOwn(only, 'score'), false);
	assert.equal(Object.hasOwn(only, 'evidence'), false);
	assert.equal(Object.hasOwn(only, 'capped_signals'), false);
	assert.deepEqual(Object.keys(only).sort(), ['controllers', 'dtos', 'entities', 'enums', 'module']);
});

test('runScan inventory mode: modules are sorted alphabetically by name, deterministically', () => {
	const adapters = [fixtureAdapter({ modules: [mod({ module: 'zebra' }), mod({ module: 'alpha' }), mod({ module: 'mango' })] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.deepEqual(report.related_modules.map((m) => m.module), ['alpha', 'mango', 'zebra']);
});

test('runScan inventory mode: the disclaimer is the FIRST unknowns entry, present in the returned object itself (not just rendered prose)', () => {
	const adapters = [fixtureAdapter({ modules: [mod()] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.match(report.unknowns[0], /unscored inventory of every module/);
	assert.match(report.unknowns[0], /no term-matching, relevance scoring, or collision\/greenfield classification/);
});

test('runScan inventory mode: zero modules detected -> no crash, related_modules:[]', () => {
	const adapters = [fixtureAdapter({ modules: [] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.equal(report.verdict, 'inventory');
	assert.deepEqual(report.related_modules, []);
});

test('runScan inventory mode: rg_available defaults to true and is always present on the report', () => {
	const adapters = [fixtureAdapter({ modules: [mod()] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters });
	assert.equal(report.rg_available, true);
});

test('runScan inventory mode: rg_available:false threads through and prepends an rg-missing unknowns entry', () => {
	const adapters = [fixtureAdapter({ modules: [mod()] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: [], adapters, rgAvailable: false });
	assert.equal(report.rg_available, false);
	assert.ok(report.unknowns.some((u) => u.includes('ripgrep')));
});

test('runScan scored path (terms non-empty) is completely unaffected -- verdict/score/evidence shape unchanged', () => {
	const adapters = [fixtureAdapter({ modules: [mod({ module: 'widgets' })] })];
	const report = runScan({ repoRoot: '/does/not/matter', terms: ['widget'], adapters });
	assert.notEqual(report.verdict, 'inventory');
	assert.ok(Object.hasOwn(report.related_modules[0], 'score'));
	assert.ok(Object.hasOwn(report.related_modules[0], 'evidence'));
});
