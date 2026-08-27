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
// this asserts. A9 adds a third (D-openapi-path-params): a path parameter's `pathParamsHeuristic`
// entry can legitimately DISAPPEAR across one round trip -- the export faithfully re-emits a
// heuristic-derived pathParams schema as a real Parameter Object with a `schema`, and re-importing
// it correctly treats a real, resolvable schema as source-confirmed, exactly as it should for any
// independent document (the self-import guard, not this function, is what distinguishes "really
// independent" from "our own unmodified export" -- once its markers are stripped, as here, there is
// no other signal left to withhold trust on, by this project's own established design). The
// underlying `pathParams` schema value itself is untouched either way; only its provenance label
// converges. Stripped from the comparison below for that reason, not because anything was lost.
function withoutPathParamsHeuristic(operations) {
	const out = {};
	for (const [operationId, op] of Object.entries(operations)) {
		const { pathParamsHeuristic, ...rest } = op;
		out[operationId] = rest;
	}
	return out;
}

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
	// marker(s) is the exact escape hatch its own error message names, and is what makes this
	// invariant observable at all. A8: also strips the per-operation `x-bskel-passthrough` marker
	// -- widened (D-openapi-per-status) to also fire for an operation whose only copied content is
	// per-status responses (createWidget, here), so `info.x-bskel-generated` alone is no longer
	// sufficient to disarm the guard for this fixture.
	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	for (const item of Object.values(exported.paths)) {
		for (const op of Object.values(item)) {
			if (op && typeof op === 'object') delete op['x-bskel-passthrough'];
		}
	}
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root).code, 0);
	const after = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));

	assert.deepEqual(withoutPathParamsHeuristic(after.operations), withoutPathParamsHeuristic(before.operations), 'every operation must survive the round trip unchanged, aside from pathParamsHeuristic converging (see comment above)');
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

test('--status-codes rejects an unknown mode (exit 14)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const bad = run(['contract', 'export', '--feature', FEATURE, '--status-codes', 'openapi30'], root);
	assert.equal(bad.code, 14);
	assert.match(bad.stderr, /--status-codes must be one of: range\|literal/);
});

// Real dogfooding-adjacent finding, A8 (D-openapi-per-status): `widgetOpenApiDoc({withResponses:
// true})`'s default fixture ALREADY uses literal status keys (201/400, not 2XX/default) in the
// SOURCE document -- once per-status passthrough is on by default, those real keys are what the
// export shows, regardless of --status-codes, since buildPerStatusResponses() is tried before the
// union path and does not consult the flag at all. This is the intended behavior: --status-codes
// only shapes the FALLBACK union rendering for an operation with no per-status source data.
test('--status-codes has no effect on an operation with real per-status source data -- the source\'s own codes win either way', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const range = exportedDoc(root);
	assert.deepEqual(Object.keys(range.doc.paths['/api/v0/widgets'].post.responses), ['201', '400'], 'the source document\'s own real status keys, copied verbatim');
	assert.equal(range.stderr.includes('stand-in'), false, 'a copied real status is never a stand-in');

	const literal = exportedDoc(root, ['--status-codes', 'literal']);
	assert.deepEqual(Object.keys(literal.doc.paths['/api/v0/widgets'].post.responses), ['201', '400'], '--status-codes literal must not override real per-status data');
	assert.equal(literal.stderr.includes('stand-in'), false, 'no operation took the union fallback path, so no stand-in note fires');
});

// The union fallback (and --status-codes' effect on it) is still real and still tested here --
// exercised by making exactly the ERROR side unresolvable (an unsupported `discriminator`
// keyword), which is enough to make BOTH sides skip per-status (see D-openapi-per-status's
// fail-closed invariant: sourceResponses is written only when BOTH buckets are resolved-or-none)
// while the SUCCESS side still resolves and renders through the pre-A8 union path unchanged.
test('--status-codes shapes the union fallback for an operation with no per-status source data (one side unresolvable)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	doc.components.schemas.ErrorResponse = { type: 'object', discriminator: { propertyName: 'kind' } };
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.ok(contract.operations.createWidget.responseSchema, 'the success side must still resolve');
	assert.equal('errorSchema' in contract.operations.createWidget, false, 'the error side must genuinely fail to resolve for this test to mean anything');
	assert.equal('sourceResponses' in contract.operations.createWidget, false, 'per-status must skip entirely when either bucket is unresolved');

	const range = exportedDoc(root);
	assert.deepEqual(Object.keys(range.doc.paths['/api/v0/widgets'].post.responses), ['2XX'], 'only the resolved success side renders, via the union fallback');
	assert.equal(range.stderr.includes('stand-in'), false, 'range mode invents nothing, so it must not warn about a stand-in');

	const literal = exportedDoc(root, ['--status-codes', 'literal']);
	assert.deepEqual(Object.keys(literal.doc.paths['/api/v0/widgets'].post.responses), ['200']);
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

// A7: this claim is now source-conditioned, not universal (security/summary/tags DO appear when
// the source document carries them -- see the dedicated A7 section below). What is STILL a
// universal claim, and is what this test now actually pins: none of the four ever appear when the
// SOURCE document never carried them either (neither fixture below opts into the new
// withSecurity/withSummaryTags knobs), and `description` (the operation-level field, not the
// response-object one) is never emitted at all -- Phase 2, unbuilt.
test('security, summary, tags, description never appear when the source document did not carry them (or --descriptions was not passed)', () => {
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

// --- A7: source-backed OpenAPI field passthrough, export-side ------------------------------

test('A7: query/header/cookie parameters are merged onto the path-derived ones, security/summary/tags are emitted, components.securitySchemes carries only the referenced scheme', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withParameters: true, withSecurity: true, withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const { doc } = exportedDoc(root);
	const findWidgets = doc.paths['/api/v0/widgets'].get;
	// Path-derived parameters are gone here (findWidgets has no path params), so all 3 are the
	// copied ones, in addition to whatever this operation's own path template contributes.
	assert.deepEqual(findWidgets.parameters.map((p) => `${p.in}:${p.name}`).sort(), ['cookie:session', 'header:X-Trace-Id', 'query:q']);
	assert.deepEqual(findWidgets.security, [{ bearerAuth: [] }]);
	assert.equal(findWidgets.summary, 'list widgets');
	assert.deepEqual(findWidgets.tags, ['Widgets']);

	const findWidget = doc.paths['/api/v0/widgets/{widgetId}'].get;
	// findWidget's own path parameter (widgetId) coexists with its copied security/summary/tags --
	// no dedup collision since sourceParameters never carries an `in: 'path'` entry.
	assert.deepEqual(findWidget.parameters.map((p) => p.in), ['path']);
	assert.deepEqual(findWidget.security, [{ bearerAuth: [] }]);

	assert.deepEqual(doc.components, { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } });
});

test('A7: security:[] (a genuinely public endpoint) is emitted verbatim, and is distinguishable from an operation with no security at all', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSecurity: true, publicFindWidgets: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const { doc } = exportedDoc(root);
	assert.deepEqual(doc.paths['/api/v0/widgets'].get.security, [], 'findWidgets is genuinely public -- [] is a real positive claim from the source');
	assert.deepEqual(doc.paths['/api/v0/widgets'].post.security, [{ bearerAuth: [] }]);
});

test('A7: a security requirement naming an undeclared scheme drops security for that operation, and components.securitySchemes still carries no dangling reference', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSecurity: true, securityUnknownScheme: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_SECURITY_UNRESOLVED' && w.subject === 'createWidget'));

	const { doc } = exportedDoc(root);
	assert.equal('security' in doc.paths['/api/v0/widgets'].post, false, 'createWidget\'s security referenced an undeclared scheme -- dropped, not a dangling reference');
	assert.deepEqual(doc.paths['/api/v0/widgets/{widgetId}'].get.security, [{ bearerAuth: [] }], 'findWidget is unaffected -- its own security resolved cleanly');
});

test('A7: query/header/cookie-parameters, security, summaries, tags are ANY-based derived omissions -- present when at least one operation lacks the field, absent only when every operation carries it', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	// Only findWidgets carries parameters/security/summary/tags; createWidget and findWidget do not.
	const doc = widgetOpenApiDoc({ withParameters: true });
	doc.paths['/api/v0/widgets'].get.security = [{ bearerAuth: [] }];
	doc.paths['/api/v0/widgets'].get.summary = 'list widgets';
	doc.paths['/api/v0/widgets'].get.tags = ['Widgets'];
	doc.components = { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } };
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const omitted = exportedDoc(root).doc.info['x-bskel-omitted'];
	for (const key of ['query-parameters', 'header-parameters', 'cookie-parameters', 'security', 'summaries', 'tags']) {
		assert.ok(omitted.includes(key), `${key} must be disclosed -- createWidget/findWidget carry none of it`);
	}
	// The always-on new structural entries, present regardless of what the contract carries.
	for (const key of ['path-parameter-schemas', 'vendor-extensions']) {
		assert.ok(omitted.includes(key));
	}

	// Now every operation carries all four -- none of the six should be in the omission list.
	const rootFull = buildFixtureRepo();
	initThroughScanDisposition(rootFull);
	const docFullFile = writeOpenApiFixture(rootFull, widgetOpenApiDoc({ withParameters: true, withSecurity: true, withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFullFile], rootFull).code, 0);
	const omittedFull = exportedDoc(rootFull).doc.info['x-bskel-omitted'];
	// findWidgets alone carries query/header/cookie -- createWidget/findWidget still don't, so
	// those three stay disclosed; security/summaries/tags are on EVERY operation in this fixture.
	for (const key of ['security', 'summaries', 'tags']) {
		assert.equal(omittedFull.includes(key), false, `${key} must NOT be disclosed -- every operation carries it`);
	}
	for (const key of ['query-parameters', 'header-parameters', 'cookie-parameters']) {
		assert.ok(omittedFull.includes(key), `${key} -- only findWidgets carries parameters, so this must still be disclosed`);
	}
});

test('A7: an operation carrying at least one passthrough field gets the x-bskel-passthrough marker; one that carries none does not', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	// widgetOpenApiDoc's withSummaryTags touches every declared operation -- strip it back off
	// findWidget specifically, so exactly one operation (of three) carries genuinely NO passthrough,
	// proving the marker is per-operation, not blanket.
	const doc = widgetOpenApiDoc({ withSummaryTags: true });
	delete doc.paths['/api/v0/widgets/{widgetId}'].get.summary;
	delete doc.paths['/api/v0/widgets/{widgetId}'].get.tags;
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const { doc: exported } = exportedDoc(root);
	assert.ok(exported.paths['/api/v0/widgets'].post['x-bskel-passthrough'], 'createWidget carries summary+tags -- must be marked');
	assert.match(exported.paths['/api/v0/widgets'].post['x-bskel-passthrough'].source_sha256, /^[0-9a-f]{12}$/);
	assert.equal('x-bskel-passthrough' in exported.paths['/api/v0/widgets/{widgetId}'].get, false, 'findWidget carries no passthrough -- must NOT be marked');
});

// --- A7: the self-import guard's second key material ----------------------------------------

test('A7 self-import guard: stripping ONLY info.x-bskel-generated is no longer sufficient for a passthrough-heavy export -- the operation-level markers still refuse it', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSecurity: true, withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);

	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	const reImport = run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root);
	assert.equal(reImport.code, 14, 'operation-level x-bskel-passthrough markers alone must still trigger the guard');
	assert.match(reImport.stderr, /generated by `bskel contract export`/);
});

test('A7 self-import guard: stripping info.x-bskel-generated AND every operation\'s x-bskel-passthrough marker is what actually disarms the guard', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSecurity: true, withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);

	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	for (const item of Object.values(exported.paths)) {
		for (const operation of Object.values(item)) {
			delete operation['x-bskel-passthrough'];
		}
	}
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root).code, 0);
});

// --- A7: round trip, extended to cover the new fields ----------------------------------------

// A9: pathParamsHeuristic converges across this round trip too, same reasoning as the comment
// above the first round-trip test in this file (withoutPathParamsHeuristic()) -- this fixture's
// `widgetId` segment has no source-declared path-parameter schema either, so it is heuristic-
// derived in `before` and source-confirmed in `after`, with the underlying schema unchanged.
test('A7 round trip: a complete, fully-passthrough contract survives export -> re-import (all markers stripped) with source* fields intact', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withParameters: true, withSecurity: true, withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const before = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(before.completeness.status, 'complete');
	assert.ok(before.operations.findWidgets.sourceParameters);
	assert.ok(before.operations.createWidget.sourceSecurity);
	assert.ok(before.sourceSecuritySchemes);

	assert.equal(run(['contract', 'export', '--feature', FEATURE, '--out', 'exported.json'], root).code, 0);
	const exported = JSON.parse(fs.readFileSync(path.join(root, 'exported.json'), 'utf8'));
	delete exported.info['x-bskel-generated'];
	for (const item of Object.values(exported.paths)) {
		for (const operation of Object.values(item)) delete operation['x-bskel-passthrough'];
	}
	fs.writeFileSync(path.join(root, 'stripped.json'), JSON.stringify(exported, null, 2));

	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', 'stripped.json'], root).code, 0);
	const after = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.deepEqual(withoutPathParamsHeuristic(after.operations), withoutPathParamsHeuristic(before.operations), 'every operation, including the four source* fields, must survive the round trip unchanged, aside from pathParamsHeuristic converging (see the comment above the first round-trip test)');
	assert.deepEqual(after.sourceSecuritySchemes, before.sourceSecuritySchemes);
	assert.deepEqual(after.warnings, [], 're-importing an export of a complete contract must produce no new warnings');
});

// --- A7: mixed passthrough coverage -----------------------------------------------------------

test('A7: a waived partial contract with mixed passthrough coverage prints ONE stderr note (not per-operation), and info.x-bskel-generated.passthrough carries the exact per-operation map', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	// findWidget drifts (never gets passthrough); findWidgets/createWidget get real summary/tags.
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSummaryTags: true, driftFindWidget: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 3, 'a drift is an ERROR, awaiting disposition');
	assert.equal(run(['contract', 'waive', '--feature', FEATURE, '--code', 'CONTRACT_OPENAPI_DRIFT', '--all', '--reason', 'accepted for this test'], root).code, 0);
	assert.equal(run(['gate', 'require', 'contract', '--feature', FEATURE], root).code, 0);

	const { doc, stderr } = exportedDoc(root);
	assert.match(stderr, /1 of 3 operation\(s\) in this export carry no source-document passthrough/);
	assert.deepEqual(doc.info['x-bskel-generated'].passthrough, { createWidget: true, findWidgets: true, findWidget: false });
});

test('A7: a complete contract (100% passthrough coverage by construction) prints no mixed-coverage note', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withSummaryTags: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const { stderr } = exportedDoc(root);
	assert.equal(stderr.includes('carry no source-document passthrough'), false);
});

// --- A7: meta-schema validation of a full-passthrough export ----------------------------------

test('a full-passthrough export (parameters, security, summary, tags) still validates against the official 3.1 meta-schema', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withParameters: true, withSecurity: true, withSummaryTags: true, withRequestBodies: true, withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	assertValidOpenApi(exportedDoc(root).doc, 'a full-passthrough export');
});

// --- A8: per-status responses + non-JSON request media types (D-openapi-per-status) -----------

test('A8: a real per-status export (204 no-body, custom description, multipart request) validates against the official 3.1 meta-schema', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	doc.paths['/api/v0/widgets'].post.responses['204'] = { description: 'nothing to report' };
	doc.paths['/api/v0/widgets'].post.requestBody = {
		content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } },
	};
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const { doc: exported } = exportedDoc(root);
	const responses = exported.paths['/api/v0/widgets'].post.responses;
	assert.deepEqual(Object.keys(responses).sort(), ['201', '204', '400'], 'the source document\'s own real status keys, copied verbatim');
	assert.equal(responses['204'].description, 'nothing to report');
	assert.deepEqual(Object.keys(exported.paths['/api/v0/widgets'].post.requestBody.content), ['multipart/form-data']);
	assertValidOpenApi(exported, 'a real per-status + multipart export');
});

test('A8: a per-status entry with no description at all gets the honest stand-in string, which is spec-valid and never round-trips back in as real', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withResponses: true });
	delete doc.paths['/api/v0/widgets'].post.responses['201'].description;
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const { doc: exported } = exportedDoc(root);
	assert.match(exported.paths['/api/v0/widgets'].post.responses['201'].description, /documents this status.*gives no description/);
	assertValidOpenApi(exported, 'a per-status export with a synthesized description stand-in');
});

test('A8 follow-up (Codex review): a hand-edited schemaFrom that disagrees with its own status key is re-checked at export, never leaking the wrong union under the wrong status', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const contractPath = contractSchemaPath(root);
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	assert.equal(contract.operations.createWidget.sourceResponses['400'].schemaFrom, 'error', 'the fixture must produce the real, correct pairing before it is corrupted');
	// Hand-edit: falsely claim the 400 (error-class) status resolves from the SUCCESS union.
	contract.operations.createWidget.sourceResponses['400'].schemaFrom = 'response';
	fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
	assert.equal(run(['gate', 'force', 'contract', '--feature', FEATURE, '--reason', 'testing a hand-edited schemaFrom/status-key mismatch'], root).code, 0);

	const { doc: exported } = exportedDoc(root);
	const response400 = exported.paths['/api/v0/widgets'].post.responses['400'];
	assert.equal('content' in response400, false, 'no content leaks at all -- the mismatched claim is rejected and there is no other schema/mediaTypes to fall back on for this entry');
	assertValidOpenApi(exported, 'an export with a hand-edited schemaFrom/status-key mismatch, safely degraded');
});

test('A8: a non-JSON request media type whose schema fails to resolve raises CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED (WARN -- never blocks, same as its A7 siblings)', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets'].post.requestBody = {
		content: { 'multipart/form-data': { schema: { type: 'object', discriminator: { propertyName: 'kind' } } } },
	};
	const docFile = writeOpenApiFixture(root, doc);
	const emitted = run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root);
	assert.equal(emitted.code, 0, 'WARN severity never blocks the gate -- same invariant test/contract-completeness.test.mjs pins for the two A7 sibling codes');
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	const warning = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED');
	assert.ok(warning, 'the new code must actually fire');
	assert.equal(warning.subject, 'createWidget');
	assert.equal(warning.severity, 'warn');
	assert.equal(run(['gate', 'require', 'contract', '--feature', FEATURE], root).code, 0);
});

test('A8: per-status responses are ANY-based derived omissions -- absent when every operation resolves a real status, present when at least one lacks per-status data', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	// createWidget resolves real per-status data; findWidgets/findWidget have no responses documented
	// at all, so they lack it.
	const docFile = writeOpenApiFixture(root, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const mixed = exportedDoc(root).doc.info['x-bskel-omitted'];
	assert.ok(mixed.includes('per-status-responses'), 'findWidgets/findWidget have no per-status data at all');
});

// --- A9: source-backed path-parameter schemas (D-openapi-path-params) --------------------------

test('A9: an exported path parameter carries the real source schema, not the "/id$/i" heuristic guess, when the source declared one', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets/{widgetId}'].get.parameters = [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } }];
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);

	const { doc: exported } = exportedDoc(root);
	const widgetIdParam = exported.paths['/api/v0/widgets/{widgetId}'].get.parameters.find((p) => p.name === 'widgetId');
	assert.deepEqual(widgetIdParam.schema, { type: 'string' }, 'the real source schema, no UUID pattern invented');
	assertValidOpenApi(exported, 'an export with a source-backed path-parameter schema');
});

test('A9: path-parameter schemas are an ANY-based derived omission -- absent when every path param on every operation is source-resolved, present when at least one still relies on the heuristic', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets/{widgetId}'].get.parameters = [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } }];
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0);
	const fullySourced = exportedDoc(root).doc.info['x-bskel-omitted'];
	assert.equal(fullySourced.includes('path-parameter-schemas'), false, 'the only path parameter in this fixture was source-resolved');

	const root2 = buildFixtureRepo();
	initThroughScanDisposition(root2);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root2).code, 0); // no --openapi-file at all -- widgetId stays heuristic-derived
	const heuristic = exportedDoc(root2).doc.info['x-bskel-omitted'];
	assert.ok(heuristic.includes('path-parameter-schemas'), 'findWidget\'s widgetId has no source document to resolve against');
});

// --- A10: opt-in operation-level description (D-openapi-description) ---------------------------

test('A10: --descriptions actually copies the real operation description into the exported document, verbatim', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets'].post.description = 'creates a widget for the current organization.';
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile, '--descriptions'], root).code, 0);
	const { doc: exported } = exportedDoc(root);
	assert.equal(exported.paths['/api/v0/widgets'].post.description, 'creates a widget for the current organization.');
	assertValidOpenApi(exported, 'an export with an opt-in operation-level description');
});

test('A10: without --descriptions, the real source description is never copied, even though the source document has one', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets'].post.description = 'creates a widget for the current organization.';
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0); // no --descriptions
	const { doc: exported } = exportedDoc(root);
	assert.equal('description' in exported.paths['/api/v0/widgets'].post, false);
});

test('A10: --descriptions without --openapi-file is refused (would be a silent no-op), same as a lone --path-prefix', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const result = run(['contract', 'emit', '--feature', FEATURE, '--descriptions'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--descriptions only applies when reconciling against a real OpenAPI document/);
});

test('A10: a source description exceeding the length cap raises CONTRACT_OPENAPI_DESCRIPTION_UNRESOLVED (WARN -- never blocks) and is not exported', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({});
	doc.paths['/api/v0/widgets'].post.description = 'x'.repeat(40001);
	const docFile = writeOpenApiFixture(root, doc);
	const emitted = run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile, '--descriptions'], root);
	assert.equal(emitted.code, 0, 'WARN severity never blocks the gate -- same invariant this file already pins for A7/A8\'s own new codes');
	const contract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	const warning = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_DESCRIPTION_UNRESOLVED');
	assert.ok(warning, 'the new code must actually fire');
	assert.equal(warning.subject, 'createWidget');
	assert.equal(warning.severity, 'warn');
	assert.equal('description' in exportedDoc(root).doc.paths['/api/v0/widgets'].post, false);
});

test('A10: operation-descriptions is an ANY-based derived omission -- present without the flag, present with the flag when the source has none, absent only when every operation is source-described', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const withoutFlag = writeOpenApiFixture(root, widgetOpenApiDoc({}));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', withoutFlag], root).code, 0);
	assert.ok(exportedDoc(root).doc.info['x-bskel-omitted'].includes('operation-descriptions'), 'the flag was never passed');

	const root2 = buildFixtureRepo();
	initThroughScanDisposition(root2);
	const doc2 = widgetOpenApiDoc({});
	// findWidgets/findWidget get a real description; createWidget does not -- a genuine mix.
	doc2.paths['/api/v0/widgets'].get.description = 'lists widgets.';
	doc2.paths['/api/v0/widgets/{widgetId}'].get.description = 'finds one widget.';
	const docFile2 = writeOpenApiFixture(root2, doc2);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile2, '--descriptions'], root2).code, 0);
	assert.ok(exportedDoc(root2).doc.info['x-bskel-omitted'].includes('operation-descriptions'), 'createWidget still has no description even with the flag on');

	const root3 = buildFixtureRepo();
	initThroughScanDisposition(root3);
	const doc3 = widgetOpenApiDoc({});
	for (const item of Object.values(doc3.paths)) {
		for (const operation of Object.values(item)) operation.description = 'every operation gets one here.';
	}
	const docFile3 = writeOpenApiFixture(root3, doc3);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile3, '--descriptions'], root3).code, 0);
	assert.equal(exportedDoc(root3).doc.info['x-bskel-omitted'].includes('operation-descriptions'), false, 'every operation is source-described with the flag on -- the case that would be impossible if the list were a fixed disclaimer');
});

// --- A11: field-level description/example passthrough (D-openapi-field-docs) -------------------
// Rides the SAME --descriptions flag as A10 -- no new flag, no sbf_contract bump, no new top-level
// contract field: description/example live inside the already-`{"type":"object"}`-typed schema
// blobs (requestBodySchema/responseSchema/etc.) export.mjs already copies through verbatim.

test('A11: --descriptions copies field-level description/example into the exported requestBody schema, verbatim, and the result still validates against the official 3.1 meta-schema', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withRequestBodies: true });
	doc.components.schemas.CreateWidgetRequest.properties.name.description = 'the widget name shown to customers.';
	doc.components.schemas.CreateWidgetRequest.properties.name.example = 'Blue Widget';
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile, '--descriptions'], root).code, 0);
	const { doc: exported } = exportedDoc(root);
	const nameSchema = exported.paths['/api/v0/widgets'].post.requestBody.content['application/json'].schema.properties.name;
	assert.equal(nameSchema.description, 'the widget name shown to customers.');
	assert.equal(nameSchema.example, 'Blue Widget');
	assertValidOpenApi(exported, 'an export with opt-in field-level description/example');
});

test('A11: without --descriptions, field-level description/example are never copied, even though the source document has them', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	const doc = widgetOpenApiDoc({ withRequestBodies: true });
	doc.components.schemas.CreateWidgetRequest.properties.name.description = 'the widget name shown to customers.';
	doc.components.schemas.CreateWidgetRequest.properties.name.example = 'Blue Widget';
	const docFile = writeOpenApiFixture(root, doc);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFile], root).code, 0); // no --descriptions
	const { doc: exported } = exportedDoc(root);
	const nameSchema = exported.paths['/api/v0/widgets'].post.requestBody.content['application/json'].schema.properties.name;
	assert.equal('description' in nameSchema, false);
	assert.equal('example' in nameSchema, false);
});

test('A11: field-descriptions is an ANY-based derived omission -- present without the flag, present with the flag when a schema field has none, absent only when every schema-bearing operation carries at least one field-level annotation', () => {
	const withoutFlag = buildFixtureRepo();
	initThroughScanDisposition(withoutFlag);
	const docNoFlag = writeOpenApiFixture(withoutFlag, widgetOpenApiDoc({ withResponses: true }));
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docNoFlag], withoutFlag).code, 0);
	assert.ok(exportedDoc(withoutFlag).doc.info['x-bskel-omitted'].includes('field-descriptions'), 'the flag was never passed');

	const partial = buildFixtureRepo();
	initThroughScanDisposition(partial);
	const docPartial = widgetOpenApiDoc({ withResponses: true });
	// createWidget's success schema gets a field annotation; its error schema and every other
	// operation's schemas do not -- a genuine mix.
	docPartial.components.schemas.WidgetResponse.properties.id.description = 'the widget id.';
	const docPartialFile = writeOpenApiFixture(partial, docPartial);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docPartialFile, '--descriptions'], partial).code, 0);
	assert.ok(exportedDoc(partial).doc.info['x-bskel-omitted'].includes('field-descriptions'), 'createWidget\'s errorSchema, and every other operation\'s response/error schemas, still have no field-level annotation even with the flag on');

	const full = buildFixtureRepo();
	initThroughScanDisposition(full);
	const docFull = widgetOpenApiDoc({ withResponses: true });
	docFull.components.schemas.WidgetResponse.properties.id.description = 'the widget id.';
	docFull.components.schemas.ErrorResponse.properties.code.example = 'NOT_FOUND';
	// Every operation (not just createWidget) needs a schema-bearing response for
	// field-descriptions to be checkable at all -- same construction fixture C above already uses.
	for (const item of Object.values(docFull.paths)) {
		for (const operation of Object.values(item)) operation.responses = { 200: OK_RESPONSE, 400: ERR_RESPONSE };
	}
	const docFullFile = writeOpenApiFixture(full, docFull);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--openapi-file', docFullFile, '--descriptions'], full).code, 0);
	assert.equal(exportedDoc(full).doc.info['x-bskel-omitted'].includes('field-descriptions'), false, 'every schema-bearing operation shares the same WidgetResponse/ErrorResponse components, both of which now carry a field-level annotation');
});

// --- A7: loadContract()'s friendly sbf_contract mismatch message -------------------------------

// loadContract()'s pre-check is exercised through an UNGATED command (`contract tool-schema`, not
// `contract export`) deliberately: `contract export` requires the `contract` gate to have PASSED
// first, and hand-editing the on-disk contract's `sbf_contract` field changes its bytes, which
// would make the gate's own `contract_hash` go STALE and refuse at that earlier check (exit 4) --
// a real mechanism, but the wrong one to exercise here. `contract tool-schema`/`contract validate`
// call loadContract() directly with no gate check, which is the actual real-world path an upgraded
// bskel hits: the on-disk file is untouched (still v4-shaped) and its gate token still matches it.
test('an on-disk contract from an older bskel (sbf_contract "4") gets a friendly re-emit message from `contract tool-schema`, not a raw ajv dump', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const contractPath = contractSchemaPath(root);
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	contract.sbf_contract = '4';
	fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

	const result = run(['contract', 'tool-schema', '--feature', FEATURE, '--operation', 'createWidget'], root);
	assert.equal(result.code, 2, 'loadContract()\'s INVALID_ARTIFACT failures share exit NOT_PASSED(2), same as MISSING_ARTIFACT');
	assert.match(result.stderr, /emitted by an older bskel \(sbf_contract "4", expected "8"\)/);
	assert.match(result.stderr, /re-run `bskel contract emit --feature 001-widget-management`/);
	assert.equal(result.stderr.includes('does not match schemas/feature-contract.schema.json'), false, 'the friendly message must replace the raw ajv dump for this specific, common case');
});

test('a contract with a genuinely INVALID shape (not just an old sbf_contract) still gets the raw ajv dump, unaffected by the new pre-check', () => {
	const root = buildFixtureRepo();
	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const contractPath = contractSchemaPath(root);
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	delete contract.completeness; // a required field, genuinely malformed, sbf_contract itself untouched
	fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

	const result = run(['contract', 'tool-schema', '--feature', FEATURE, '--operation', 'createWidget'], root);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /does not match schemas\/feature-contract\.schema\.json/);
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
	// A8: every operation in fixture C has a resolvable 200 AND 400 -- 100% per-status coverage by
	// construction (see D-openapi-per-status), so `per-status-responses` must NOT be omitted here,
	// the exact case that would be impossible if the list were a fixed disclaimer.
	assert.equal(omittedC.includes('per-status-responses'), false);

	// Genuinely structural (never conditional on any fixture's content) entries are present in all
	// three, and the prose disclosure lists them too.
	for (const omitted of [omittedA, omittedB, omittedC]) {
		for (const key of ['query-parameters', 'header-parameters', 'security', 'summaries', 'tags', 'non-json-response-schemas', 'response-headers', 'path-parameter-schemas', 'vendor-extensions', 'field-descriptions', 'operation-descriptions']) {
			assert.ok(omitted.includes(key), `every export must disclose "${key}"`);
		}
	}
	// A8: `per-status-responses` IS derived (fixture C proves it above), so it's asserted separately
	// only for A/B, which each have at least one operation with no per-status source data.
	assert.ok(omittedA.includes('per-status-responses'));
	assert.ok(omittedB.includes('per-status-responses'));
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
	// A8: widgetOpenApiDoc({withResponses:true})'s default success key is the literal "201" (not a
	// range key) -- per-status passthrough now copies it verbatim, so that is the real key here.
	assert.equal(Object.keys(JSON.parse(exported.stdout).paths['/api/v0/widgets'].post.responses['201'].content['application/json'].schema.properties).length, 401);
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
