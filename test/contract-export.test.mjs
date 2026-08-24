// A6 (D-openapi-export): `bskel contract export` -- rendering an already-emitted, gate-passing
// contract as a standalone OpenAPI 3.1 document, plus the two importer fixes that direction forced
// (`2XX`/`4XX`/`5XX` range status keys, and `default` folded into the error side).
//
// Everything here goes through the REAL CLI against a real git repo, reusing
// test/_contract-fixture.mjs -- the same harness test/contract-cli.test.mjs drives, not a second
// copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
	run, runCapturingStderr, buildFixtureRepo, initThroughScanDisposition,
	contractSchemaPath, widgetControllerPath, widgetOpenApiDoc, writeOpenApiFixture,
} from './_contract-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_SCHEMA_PATH = path.join(__dirname, 'fixtures', 'openapi-3.1-meta-schema.json');
const FEATURE = '001-widget-management';

// The real, dated OpenAPI 3.1 meta-schema (`https://spec.openapis.org/oas/3.1/schema/2022-10-07`),
// vendored verbatim -- an exported document is checked against the ACTUAL specification, not
// against a hand-written approximation of it. test/ is excluded from package.json's `files`
// allowlist, so this fixture ships nowhere.
//
// ONE documented adaptation is applied before compiling, and it is a real Ajv limitation found by
// execution, not a convenience: Ajv 8.20.0 mis-resolves this schema's `{"$dynamicRef": "#meta"}`
// nodes. Instead of resolving to `$defs.schema` (which carries the matching
// `$dynamicAnchor: "meta"`), it applies the ENCLOSING subschema to the referenced value -- so a
// path parameter's own `schema` gets validated against the Parameter Object, and every real schema
// fails with "must have required property 'name'" / "must NOT have unevaluated properties".
// Reproduced against a 6-line synthetic schema of the same shape to confirm it is Ajv's behavior
// and not a usage error here. Rewriting those 4 nodes to a plain `$ref: '#/$defs/schema'` is
// exactly what the 2020-12 spec says a `$dynamicRef` degrades to when nothing in the dynamic scope
// overrides the anchor -- which is the case for a standalone 3.1 document (only the separate
// `schema-base` dialect variants override it). The vendored file itself stays byte-identical to the
// published one; the adaptation lives here, in one place, and is self-checked below.
function compileOpenApiMetaSchema() {
	const raw = JSON.parse(fs.readFileSync(META_SCHEMA_PATH, 'utf8'));
	let replacements = 0;
	const deDynamic = (node) => {
		if (Array.isArray(node)) return node.map(deDynamic);
		if (node === null || typeof node !== 'object') return node;
		if (node.$dynamicRef === '#meta' && Object.keys(node).length === 1) {
			replacements++;
			return { $ref: '#/$defs/schema' };
		}
		return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deDynamic(v)]));
	};
	const adapted = deDynamic(raw);
	assert.ok(replacements > 0, 'the $dynamicRef adaptation found nothing to rewrite -- the vendored meta-schema changed shape, re-check it before trusting any validation below');
	const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
	addFormats(ajv);
	return ajv.compile(adapted);
}

const validateOpenApi = compileOpenApiMetaSchema();

function assertValidOpenApi(doc, label) {
	const ok = validateOpenApi(doc);
	assert.ok(ok, `${label} must validate against the official OpenAPI 3.1 meta-schema:\n${JSON.stringify(validateOpenApi.errors, null, 2)}`);
}

function exportedDoc(root, extraArgs = []) {
	const result = runCapturingStderr(['contract', 'export', '--feature', FEATURE, ...extraArgs], root);
	assert.equal(result.code, 0, `export must succeed: ${result.stderr}`);
	return { doc: JSON.parse(result.stdout), stderr: result.stderr };
}

// A meta-schema-backed test is worth nothing if the compiled validator can only ever pass. Nine
// real, distinct defects an export could plausibly contain, each confirmed rejected -- so a later
// "the export is valid" assertion means something.
test('the vendored 3.1 meta-schema actually rejects real defects (self-verification of the checker itself)', () => {
	const base = {
		openapi: '3.1.0',
		info: { title: 't', version: '1' },
		paths: {
			'/w/{id}': {
				get: {
					operationId: 'findW',
					parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
					responses: { '2XX': { description: 'd', content: { 'application/json': { schema: { type: 'object' } } } } },
				},
				post: { operationId: 'createW', requestBody: { required: true, content: { 'application/json': {} } } },
			},
		},
	};
	assert.ok(validateOpenApi(base), `the baseline document must be valid: ${JSON.stringify(validateOpenApi.errors)}`);

	const mutations = {
		'an empty responses object (minProperties: 1)': (d) => { d.paths['/w/{id}'].get.responses = {}; },
		'a response with no description': (d) => { delete d.paths['/w/{id}'].get.responses['2XX'].description; },
		'a path parameter with no `required`': (d) => { delete d.paths['/w/{id}'].get.parameters[0].required; },
		'a path parameter with `required: false`': (d) => { d.paths['/w/{id}'].get.parameters[0].required = false; },
		'a path parameter with no schema': (d) => { delete d.paths['/w/{id}'].get.parameters[0].schema; },
		'a bogus status key': (d) => { d.paths['/w/{id}'].get.responses['299X'] = { description: 'x' }; },
		'a paths key not starting with /': (d) => { d.paths['w/nope'] = { get: {} }; },
		'a requestBody with no content': (d) => { d.paths['/w/{id}'].post.requestBody = { required: true }; },
		'an info object missing version': (d) => { delete d.info.version; },
	};
	for (const [label, mutate] of Object.entries(mutations)) {
		const bad = structuredClone(base);
		mutate(bad);
		assert.equal(validateOpenApi(bad), false, `the meta-schema must reject ${label}`);
	}

	// The control that motivates the whole "omit, never fabricate" rule: `security: []` is
	// perfectly LEGAL, which is exactly why a schema check can never be the thing that stops us
	// from emitting it. It is a positive claim that no authentication is required.
	const withEmptySecurity = structuredClone(base);
	withEmptySecurity.paths['/w/{id}'].get.security = [];
	assert.equal(validateOpenApi(withEmptySecurity), true, '`security: []` is spec-legal -- the reason it is never emitted is truthfulness, not validity');
});

test('an exported document validates against the official 3.1 meta-schema, for a bare contract and a fully schema-projected one', () => {
	const bare = buildFixtureRepo();
	initThroughScanDisposition(bare);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], bare).code, 0);
	assertValidOpenApi(exportedDoc(bare).doc, 'an export of a contract emitted with no --openapi-file');

	const rich = buildFixtureRepo();
	initThroughScanDisposition(rich);
	const docFile = writeOpenApiFixture(rich, widgetOpenApiDoc({ withRequestBodies: true, withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], rich).code, 0);
	assertValidOpenApi(exportedDoc(rich).doc, 'an export of a request/response/error-projected contract');
	assertValidOpenApi(exportedDoc(rich, ['--status-codes', 'literal']).doc, 'an export using literal status codes');
});

// The one narrow, provable round-trip invariant. Deliberately NOT "export then re-import is
// byte-identical for ANY contract": a `drift`/`missing`/`ambiguous` operation would be LAUNDERED by
// that round trip (see the self-import guard tests below), so the invariant only holds -- and is
// only worth asserting -- for a `complete` contract, where by construction no such entry exists.
//
// Note what "round trip" precisely means: convergence after one step, not identity with some
// hypothetical upstream document. A projected `format: 'uuid'` is rewritten to a bare-UUID
// `pattern` on import (D-security-2), and a multi-shape `anyOf` response union re-imports as one
// raw node rather than N -- both are stable from the FIRST emitted contract onward, which is what
// this asserts.
test('round trip: export -> re-import against the same scan report reproduces the contract\'s operations exactly', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true, withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const before = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(before.completeness.status, 'complete', 'the invariant is only claimed for a complete contract');
	const snapshotPath = path.join(root, `specs/${FEATURE}/contracts/${FEATURE}.openapi.snapshot.json`);
	const matchedBefore = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).stats.matched;

	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);
	// The self-import guard refuses an unmodified export outright (proven below); stripping the
	// marker is the exact escape hatch its own error message names, and is what makes this
	// invariant observable at all.
	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root).code, 0);
	const after = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));

	assert.deepEqual(after.operations, before.operations, 'every operation must survive the round trip unchanged');
	assert.deepEqual(after.warnings, [], 're-importing an export of a complete contract must produce no new warnings');
	assert.equal(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).stats.matched, matchedBefore);
});

// --- the two importer fixes A6 forced, each a general capability gain -----------------------
//
// Both were confirmed to FAIL against the pre-fix regexes before being kept: with
// `/^2[0-9]{2}$/` + `/^[45][0-9]{2}$/` and no `default` handling, "2XX + 4XX" projects NEITHER
// schema and "200 + default" loses the error one -- silently, since "no matching status" is
// correctly not a failure anywhere in projectResponseSchemas.

function emitWithResponses(responses) {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	doc.paths['/api/v0/widgets'].post.responses = responses;
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	return JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8')).operations.createWidget;
}

const OK_RESPONSE = { content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetResponse' } } } };
const ERR_RESPONSE = { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

test('importer: OpenAPI range status keys (2XX/4XX/5XX) project response and error schemas', () => {
	for (const errorKey of ['4XX', '5XX']) {
		const op = emitWithResponses({ '2XX': OK_RESPONSE, [errorKey]: ERR_RESPONSE });
		assert.deepEqual(op.responseSchema.required, ['id'], `2XX must project alongside ${errorKey}`);
		assert.deepEqual(op.errorSchema.required, ['code'], `${errorKey} must project`);
	}
});

test('importer: `default` contributes to the ERROR side, and never to the success side', () => {
	const both = emitWithResponses({ 200: OK_RESPONSE, default: ERR_RESPONSE });
	assert.deepEqual(both.responseSchema.required, ['id']);
	assert.deepEqual(both.errorSchema.required, ['code'], '`default` must be readable as an error body');

	// The asymmetry, stated as a test rather than only as a comment: `default` means "every status
	// not otherwise listed", so folding it into SUCCESS would let an error shape satisfy success
	// validation. Folding it into ERROR only ever widens a union anyOf already tolerates.
	const onlyDefault = emitWithResponses({ default: ERR_RESPONSE });
	assert.equal('responseSchema' in onlyDefault, false, '`default` alone must NOT become a success schema');
	assert.deepEqual(onlyDefault.errorSchema.required, ['code']);
});

// --- the self-import guard -----------------------------------------------------------------

// Builds a contract carrying a real `drift` operation (findWidget's operationId sits on POST in the
// document while the scan found it on GET -- a verb conflict no path prefix can explain), waives
// the resulting ERROR so the gate passes, and returns the root.
function buildDriftedContract() {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ driftFindWidget: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 3, 'a drift is an ERROR, so the gate must await disposition');

	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'), 'the fixture must actually produce a drift');
	assert.equal(contract.operations.findWidget.path, '/widgets/{widgetId}', 'a drifted operation keeps the scan\'s own uncorrected path (no /api/v0) -- this is what makes it launderable');
	assert.equal(contract.operations.findWidgets.path, '/api/v0/widgets', 'the non-drifted operations WERE path-corrected, so the export mixes corrected and uncorrected paths');

	assert.equal(run(['contract', 'waive', '--feature', FEATURE, '--code', 'CONTRACT_OPENAPI_DRIFT', '--all', '--reason', 'accepted for this test'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', FEATURE], root).code, 0);
	return root;
}

test('self-import guard: feeding an export back into `contract emit --openapi-file` is refused', () => {
	const root = buildDriftedContract();
	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);

	const reImport = run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'exported.json'], root);
	assert.equal(reImport.code, 14, 'a bskel-generated document must be refused through the existing BAD_ARGS path');
	assert.match(reImport.stderr, /generated by `bskel contract export`/);
	assert.match(reImport.stderr, /independent oracle/);
	assert.match(reImport.stderr, /x-bskel-generated/, 'the message must name the exact escape hatch');

	// The refusal happened before anything was written: the contract on disk is untouched.
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'));
});

// Proves the guard is the thing actually preventing the laundering, not some other mechanism that
// would have caught it anyway: with the marker removed, the SAME document silently reclassifies the
// drifted operation as `matched` and the ERROR disappears entirely.
test('self-import guard is load-bearing: with the marker stripped, the same export launders a drift into `matched`', () => {
	const root = buildDriftedContract();
	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);

	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root).code, 0);
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'), false, 'the drift ERROR silently vanished -- exactly what the guard exists to prevent');
	assert.equal(contract.operations.findWidget.provenance, 'scan+openapi', 'the drifted operation now reads as reconciled against a real oracle, which it is not');
	assert.equal(contract.completeness.status, 'complete', 'a contract that was partial-with-a-drift now reads as complete');
});

// --- refusal paths --------------------------------------------------------------------------

test('export requires the contract gate: not_run exits 2, awaiting_disposition exits 3, stale exits 4', () => {
	const notRun = buildFixtureRepo();
	initThroughScanDisposition(notRun);
	const before = run(['contract', 'export', '--feature', FEATURE], notRun);
	assert.equal(before.code, 2);
	assert.match(before.stderr, /`contract` gate for 001-widget-management is not_run/);

	const awaiting = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(awaiting);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], awaiting).code, 3);
	const blockedByWarnings = run(['contract', 'export', '--feature', FEATURE], awaiting);
	assert.equal(blockedByWarnings.code, 3);
	assert.match(blockedByWarnings.stderr, /contract waive/, 'an awaiting gate must point at waive/force, not at re-emitting');

	const stale = buildFixtureRepo();
	initThroughScanDisposition(stale);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], stale).code, 0);
	assert.equal(run(['contract', 'export', '--feature', FEATURE], stale).code, 0);
	fs.appendFileSync(widgetControllerPath(stale), '\n// uncommitted edit to the disposed module\n');
	assert.equal(run(['contract', 'export', '--feature', FEATURE], stale).code, 4);
});

test('a waived partial contract IS exportable -- the same bar `handles emit` already accepts', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 3);
	assert.equal(run(['contract', 'waive', '--feature', FEATURE, '--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--all', '--reason', 'known gap'], root).code, 0);

	const { doc } = exportedDoc(root);
	assert.equal(doc.info['x-bskel-generated'].completeness, 'partial', 'the export must disclose that it came from a partial contract');
	assert.equal(Object.keys(doc.paths).length, 2);
});

test('a blocked (zero-operation) contract is refused even when its gate was force-passed, and writes nothing', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--module', 'nonexistent-module'], root).code, 3);
	assert.equal(run(['gate', 'force', 'contract', '--feature', FEATURE, '--reason', 'no HTTP surface'], root).code, 0);

	const refused = run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root);
	assert.equal(refused.code, 14, 'same exit code `contract waive` already uses to refuse a blocked contract');
	assert.match(refused.stderr, /zero operations/);
	assert.equal(fs.existsSync(path.join(root, 'exported.json')), false, 'nothing may be written on a refusal');
});

test('--status-codes rejects an unknown mode (exit 14) and `literal` emits 200 plus a one-time stand-in note', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const bad = run(['contract', 'export', '--feature', FEATURE, '--status-codes', 'openapi30'], root);
	assert.equal(bad.code, 14);
	assert.match(bad.stderr, /--status-codes must be one of: range\|literal/);

	const range = exportedDoc(root);
	assert.deepEqual(Object.keys(range.doc.paths['/api/v0/widgets'].post.responses), ['2XX', 'default']);
	assert.equal(range.stderr.includes('stand-in'), false, 'range mode invents nothing, so it must not warn about a stand-in');

	const literal = exportedDoc(root, ['--status-codes', 'literal']);
	assert.deepEqual(Object.keys(literal.doc.paths['/api/v0/widgets'].post.responses), ['200', 'default']);
	assert.match(literal.stderr, /bskel-chosen stand-in/);
	assert.equal(literal.stderr.split('bskel-chosen stand-in').length - 1, 1, 'the note must be printed once for the document, not once per operation');
});

// --- the path-prefix refusal ----------------------------------------------------------------

test('a scanned global path-prefix signal the contract does not reflect refuses the export, and --allow-unprefixed overrides it', () => {
	const root = buildFixtureRepo({ contextPath: '/api/v0' });
	initThroughScanDisposition(root);
	const report = JSON.parse(fs.readFileSync(path.join(root, `specs/${FEATURE}/brownfield-scan.json`), 'utf8'));
	assert.ok(report.path_prefix_signals.some((s) => s.kind === 'context-path' && s.prefix === '/api/v0'), 'the fixture must actually produce a prefix signal');

	// Real dogfooding finding (Phase 3, Team-IZ/Backend, 2026-08-24): `contract emit` itself now
	// also catches an unaddressed prefix signal (CONTRACT_UNREFLECTED_PATH_PREFIX), not just
	// `contract export` -- every path is missing the prefix the scan just found, so the contract
	// gate does not pass without a waiver, and `contract export` (which requires a passed gate)
	// never even reaches its own guard here.
	const emitted = run(['contract', 'emit', '--feature', FEATURE], root);
	assert.equal(emitted.code, 3);
	assert.match(emitted.stderr, /CONTRACT_UNREFLECTED_PATH_PREFIX/);
	const blockedByGate = run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root);
	assert.notEqual(blockedByGate.code, 0);
	assert.equal(fs.existsSync(path.join(root, 'exported.json')), false);

	// Waiving the completeness warning lets the gate pass -- but `contract export`'s OWN
	// independent guard (contracts/export.mjs's unreflectedPathPrefixes()) does not trust an
	// upstream waiver and must still refuse. Defense in depth: a human saying "this doesn't block
	// completeness" is not the same as saying "publish these exact paths to a client generator".
	assert.equal(run(['contract', 'waive', '--feature', FEATURE, '--code', 'CONTRACT_UNREFLECTED_PATH_PREFIX', '--subject', '/api/v0', '--reason', 'test'], root).code, 0);

	const refused = run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root);
	assert.equal(refused.code, 14);
	assert.match(refused.stderr, /global path-prefix signal \(\/api\/v0\)/);
	assert.match(refused.stderr, /context-path: src\/main\/resources\/application\.yml/, 'the refusal must name the exact evidence file');
	assert.equal(fs.existsSync(path.join(root, 'exported.json')), false);

	const overridden = run(['contract', 'export', '--feature', FEATURE, '--allow-unprefixed'], root);
	assert.equal(overridden.code, 0);
	assert.deepEqual(Object.keys(JSON.parse(overridden.stdout).paths).sort(), ['/widgets', '/widgets/{widgetId}']);
});

test('the same repo exports without --allow-unprefixed once the contract\'s paths actually reflect the prefix', () => {
	const root = buildFixtureRepo({ contextPath: '/api/v0' });
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc());
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const { doc } = exportedDoc(root);
	assert.deepEqual(Object.keys(doc.paths).sort(), ['/api/v0/widgets', '/api/v0/widgets/{widgetId}']);
});

// --- what the document says, and what it deliberately never says ----------------------------

test('security, summary, description and tags never appear on any operation, for any fixture', () => {
	const cases = [
		() => {
			const root = buildFixtureRepo();
			initThroughScanDisposition(root);
			run(['contract', 'emit', '--feature', FEATURE], root);
			return root;
		},
		() => {
			const root = buildFixtureRepo();
			initThroughScanDisposition(root);
			const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withRequestBodies: true, withResponses: true }));
			run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root);
			return root;
		},
	];
	for (const build of cases) {
		const { doc } = exportedDoc(build());
		for (const [route, item] of Object.entries(doc.paths)) {
			for (const [verb, operation] of Object.entries(item)) {
				for (const forbidden of ['security', 'summary', 'description', 'tags']) {
					assert.equal(forbidden in operation, false, `${verb.toUpperCase()} ${route} must not carry "${forbidden}"`);
				}
			}
		}
		// Also asserted over the raw text: `security` must not appear anywhere outside the prose
		// disclosure in info.description / info.x-bskel-omitted.
		assert.equal(JSON.stringify(doc.paths).includes('"security"'), false, 'no security key anywhere under paths');
	}
});

test('x-bskel-omitted is derived from the contract, not hardcoded', () => {
	// Fixture A: only createWidget has response/error schemas, and only it takes a body (which IS
	// projected) -- so the response/error entries appear and the request-body one does not.
	const partialSchemas = buildFixtureRepo();
	initThroughScanDisposition(partialSchemas);
	const docA = writeOpenApiFixture(partialSchemas, widgetOpenApiDoc({ withRequestBodies: true, withResponses: true }));
	run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docA], partialSchemas);
	const omittedA = exportedDoc(partialSchemas).doc.info['x-bskel-omitted'];
	assert.ok(omittedA.includes('response-schemas'));
	assert.ok(omittedA.includes('error-schemas'));
	assert.equal(omittedA.includes('request-body-schemas'), false, 'createWidget is the only body-bearing operation and its schema IS projected');

	// Fixture B: no --openapi-file at all, so createWidget takes a body with no projected schema.
	const noSchemas = buildFixtureRepo();
	initThroughScanDisposition(noSchemas);
	run(['contract', 'emit', '--feature', FEATURE], noSchemas);
	const omittedB = exportedDoc(noSchemas).doc.info['x-bskel-omitted'];
	assert.ok(omittedB.includes('request-body-schemas'), 'a body with no known shape must be disclosed');

	// Fixture C: EVERY operation documents a response and an error, so neither entry appears --
	// the case that would be impossible if the list were a fixed disclaimer.
	const allSchemas = buildFixtureRepo();
	initThroughScanDisposition(allSchemas);
	const docC = widgetOpenApiDoc({ withResponses: true });
	for (const item of Object.values(docC.paths)) {
		for (const operation of Object.values(item)) {
			operation.responses = { 200: OK_RESPONSE, 400: ERR_RESPONSE };
		}
	}
	const docCFile = writeOpenApiFixture(allSchemas, docC);
	run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docCFile], allSchemas);
	const omittedC = exportedDoc(allSchemas).doc.info['x-bskel-omitted'];
	assert.equal(omittedC.includes('response-schemas'), false);
	assert.equal(omittedC.includes('error-schemas'), false);

	// The structural entries are present in all three, and the prose disclosure lists them too.
	for (const omitted of [omittedA, omittedB, omittedC]) {
		for (const key of ['query-parameters', 'header-parameters', 'security', 'summaries', 'tags', 'non-json-media-types', 'per-status-responses', 'descriptions']) {
			assert.ok(omitted.includes(key), `every export must disclose "${key}"`);
		}
	}
	assert.match(exportedDoc(noSchemas).doc.info.description, /query-parameters/);
});

test('an operation that takes a body of unknown shape gets a JSON media-type entry with no schema, never a fabricated one', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', FEATURE], root);

	const { doc } = exportedDoc(root);
	const body = doc.paths['/widgets'].post.requestBody;
	assert.equal(body.required, true, 'the scan positively found a @RequestBody');
	assert.deepEqual(body.content['application/json'], {}, 'no schema may be invented for a body whose shape the contract does not know');
	assert.equal('requestBody' in doc.paths['/widgets'].get, false, 'a known-bodyless operation gets no requestBody at all');
});

test('x-bskel-generated.contract_sha256 equals the contract file\'s own sha256 (the same value the contract gate hashes)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', FEATURE], root);

	const { doc } = exportedDoc(root);
	const onDisk = createHash('sha256').update(fs.readFileSync(contractSchemaPath(root))).digest('hex');
	assert.equal(doc.info['x-bskel-generated'].contract_sha256, onDisk);
	assert.equal(doc.info.version, onDisk.slice(0, 12), 'info.version is a content identifier, not an invented API semver');
	assert.match(doc.info['x-bskel-generated'].exported_by, /^bskel \d+\.\d+\.\d+/);
});

test('--out writes the document to disk and reports it; --json swaps the human summary for an envelope', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', FEATURE], root);

	const human = run(['contract', 'export', '--feature', FEATURE, '--out', 'openapi/widget.json'], root);
	assert.equal(human.code, 0);
	assert.match(human.stdout, /wrote openapi\/widget\.json -- OpenAPI 3\.1\.0, 3 operation\(s\)/);
	assertValidOpenApi(JSON.parse(fs.readFileSync(path.join(root, 'openapi', 'widget.json'), 'utf8')), 'the --out document');

	const machine = run(['contract', 'export', '--feature', FEATURE, '--out', 'openapi/widget.json', '--json'], root);
	assert.equal(machine.code, 0);
	const envelope = JSON.parse(machine.stdout);
	assert.equal(envelope.schema, 'sbf.contract-export/1');
	assert.equal(envelope.operation_count, 3);
	assert.equal(envelope.status_codes, 'range');

	// Re-exporting the same contract is byte-identical -- no timestamps, no churn (D-artifact-determinism).
	const first = fs.readFileSync(path.join(root, 'openapi', 'widget.json'), 'utf8');
	run(['contract', 'export', '--feature', FEATURE, '--out', 'openapi/widget.json'], root);
	assert.equal(fs.readFileSync(path.join(root, 'openapi', 'widget.json'), 'utf8'), first);
});

// D-process-exit-audit: the same pipe-truncation bug class as cmdContractEmit's own >64KB --json
// output. An exported document is routinely LARGER than the contract it came from (every projected
// schema is reproduced verbatim plus the prose disclosure), so this exit path had to use
// process.exitCode, not process.exit(), from the start.
test('regression: a >64KB exported document is not truncated when captured via execFileSync', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	const bigProperties = {};
	for (let i = 0; i < 400; i++) {
		bigProperties[`field${i}`] = { type: 'string', pattern: `^${'a'.repeat(280)}$` };
	}
	doc.components.schemas.WidgetResponse = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...bigProperties } };
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const exported = run(['contract', 'export', '--feature', FEATURE], root);
	assert.equal(exported.code, 0);
	assert.ok(exported.stdout.length > 65536, `fixture must actually exceed the 64KB boundary that exposed the bug (got ${exported.stdout.length} bytes)`);
	assert.doesNotThrow(() => JSON.parse(exported.stdout), 'output must be complete, valid JSON -- not truncated mid-write');
	assert.equal(Object.keys(JSON.parse(exported.stdout).paths['/api/v0/widgets'].post.responses['2XX'].content['application/json'].schema.properties).length, 401);
});

test('--help works without --feature, and an unknown flag is rejected with the usage line', () => {
	const root = buildFixtureRepo();
	const help = execFileSync('node', [path.join(__dirname, '..', 'bin', 'bskel.mjs'), 'contract', 'export', '--help'], { cwd: root, encoding: 'utf8' });
	assert.match(help, /usage: bskel contract export --feature <id>/);
	assert.match(help, /--allow-unprefixed/);

	const unknown = run(['contract', 'export', '--feature', FEATURE, '--nope'], root);
	assert.equal(unknown.code, 14);
	assert.match(unknown.stderr, /usage: bskel contract export/);
});
