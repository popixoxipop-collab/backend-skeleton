// D-scanner-evidence (D3): direct unit tests of the evidence/tokenization/cap machinery in
// scanners/index.mjs, independent of any adapter -- hand-built module objects, the same style
// test/handles-plan.test.mjs already uses for its own scan-report-shaped fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scoreModule } from '../scanners/index.mjs';

test('tokenize: camelCase identifiers split on lower->upper boundaries', () => {
	assert.deepEqual(tokenize('OrganizationController'), ['organization', 'controller']);
});

test('tokenize: an uppercase run followed by a capitalized word splits before the last capital ("APIController" -> "API","Controller")', () => {
	assert.deepEqual(tokenize('APIController'), ['api', 'controller']);
});

test('tokenize: paths split on non-alphanumeric separators, and a camelCase path PARAMETER name (e.g. "{organizationId}") still splits on its own internal boundary', () => {
	assert.deepEqual(tokenize('/organizations/{organizationId}/members'), ['organizations', 'organization', 'id', 'members']);
});

test('tokenize: snake_case and kebab-case both split on the separator', () => {
	assert.deepEqual(tokenize('widget_management'), ['widget', 'management']);
	assert.deepEqual(tokenize('widget-management'), ['widget', 'management']);
});

test('tokenize: null/empty input returns an empty array, never throws', () => {
	assert.deepEqual(tokenize(null), []);
	assert.deepEqual(tokenize(''), []);
	assert.deepEqual(tokenize(undefined), []);
});

function mod(overrides = {}) {
	return { module: 'widget', controllers: [], entities: [], enums: [], ...overrides };
}

test('scoreModule: a single-token term matches a plural token (the real "organization" ~ "organizations" case the old substring matcher supported by accident)', () => {
	const { score, evidence } = scoreModule(mod({ module: 'organizations' }), ['organization']);
	assert.equal(score, 10);
	assert.equal(evidence[0].signal, 'module_name');
});

test('scoreModule: the old symmetric-substring false positive no longer matches -- a short term spanning from the tail of one word into the head of the next is not found', () => {
	// Old matcher: normalize("OrganizationManagement").includes(normalize("nman")) === true,
	// a spurious match spanning the boundary between "Organization" and "Management". Tokenized,
	// "nman" isn't a prefix of either "organization" or "management", so it no longer matches.
	const { score } = scoreModule(mod({ controllers: [{ className: 'OrganizationManagement', basePath: '', endpoints: [], file: 'X.java', line: 1 }] }), ['nman']);
	assert.equal(score, 0);
});

test('scoreModule: a short abbreviation term still matches as a token prefix ("org" matches the token "organization")', () => {
	const { score, evidence } = scoreModule(mod({ module: 'organization' }), ['org']);
	assert.equal(score, 10);
	assert.equal(evidence[0].term, 'org');
	assert.equal(evidence[0].value, 'organization');
});

test('scoreModule: evidence records file/line for controller-level and endpoint-level signals, null for the module-level signal', () => {
	const m = mod({
		controllers: [{
			className: 'WidgetController', basePath: '/widgets', file: 'Widget.java', line: 9,
			endpoints: [{ verb: 'GET', path: '/widgets/{id}', operationId: 'getWidget', line: 12 }],
		}],
	});
	const { evidence } = scoreModule(m, ['widget']);
	const bySignal = Object.fromEntries(evidence.map((e) => [e.signal, e]));
	assert.equal(bySignal.module_name.file, null);
	assert.equal(bySignal.module_name.line, null);
	assert.equal(bySignal.controller_class.file, 'Widget.java');
	assert.equal(bySignal.controller_class.line, 9);
	assert.equal(bySignal.endpoint_path.line, 12);
});

test('scoreModule: repeated-signal cap -- many endpoints matching the same term contribute at most CAP_PER_SIGNAL(5) endpoint_path evidence entries, not one per endpoint', () => {
	const endpoints = Array.from({ length: 50 }, (_, i) => ({ verb: 'GET', path: `/widgets/${i}`, operationId: null, line: i + 1 }));
	const m = mod({ controllers: [{ className: 'WidgetController', basePath: '/widgets', file: 'W.java', line: 1, endpoints }] });
	const { score, evidence, cappedSignals } = scoreModule(m, ['widget']);
	const pathEvidence = evidence.filter((e) => e.signal === 'endpoint_path');
	assert.equal(pathEvidence.length, 5, 'evidence array itself must stay bounded, not grow with endpoint count');
	assert.ok(cappedSignals.includes('endpoint_path'));
	// mod()'s default module name is itself "widget" (module_name:10) + controller_class(6) +
	// controller_path(5) + 5*endpoint_path(5) = 46; operationId is null on every endpoint here,
	// so endpoint_operation_id never fires at all.
	assert.equal(score, 10 + 6 + 5 + 5 * 5);
});

test('scoreModule: a report with 600 matching endpoints stays cheap to serialize -- the actual bug this cap was introduced to fix (a real report exceeded execFileSync\'s 1MB default buffer before capping moved to collection time)', () => {
	const endpoints = Array.from({ length: 600 }, (_, i) => ({ verb: 'GET', path: `/widgets/${i}`, operationId: `findWidget${i}`, line: i + 1 }));
	const m = mod({ controllers: [{ className: 'WidgetController', basePath: '/widgets', file: 'W.java', line: 1, endpoints }] });
	const { evidence } = scoreModule(m, ['widget']);
	const json = JSON.stringify(evidence);
	assert.ok(json.length < 10_000, `evidence for 600 endpoints must stay small (got ${json.length} bytes)`);
});

test('scoreModule: multiple matching terms against the same field produce one evidence entry per term', () => {
	const { evidence } = scoreModule(mod({ module: 'widget' }), ['widget', 'widg']);
	const moduleEvidence = evidence.filter((e) => e.signal === 'module_name');
	assert.equal(moduleEvidence.length, 2);
	assert.deepEqual(moduleEvidence.map((e) => e.term).sort(), ['widg', 'widget']);
});

test('scoreModule: evidence array is empty and score is 0 when nothing matches', () => {
	const { score, evidence } = scoreModule(mod({ module: 'widget' }), ['zzz']);
	assert.equal(score, 0);
	assert.deepEqual(evidence, []);
});
