// P3 (D-fixture-corpus): the exact-count/exact-shape oracles this file used to assert against
// the real Team-IZ-Backend now live in test/contract-fixture.test.mjs (a frozen, committed
// fixture). What's left here is smoke-tested against the REAL repo, when present, but only for
// drift-resistant INVARIANTS -- not exact operation counts, which move as Team-IZ-Backend's own
// development continues (the curriculum module's exact counts moved -- all three numbers -- just
// 4 days after the oracle version of this test was written; see DECISIONS.md's
// D-fixture-corpus). Full envelope-validation-logic coverage (structural rejection, duplicate
// operationId, no-matching-module, and everything downstream of A1/A2/A3's OpenAPI
// reconciliation) is already fully synthetic below this point and untouched by P3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildContract } from '../contracts/emit.mjs';
import { validateEnvelope, validateEnvelopeStructure, operationPayloadSchema } from '../contracts/validate.mjs';
import { runScan } from '../scanners/index.mjs';
import { indexOpenApiDocument, reconcileModule } from '../contracts/openapi.mjs';

// P1 (D-npm-packaging): matches contracts/validate.mjs's own fix -- `import.meta.dirname` needs
// Node >=20.11, portable `fileURLToPath` needs nothing newer than plain ESM.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEAM_IZ_BACKEND = `${process.env.HOME}/Desktop/Team-IZ-Backend`;
const repoPresent = fs.existsSync(`${TEAM_IZ_BACKEND}/build.gradle`);
const FEATURE_UID = '11111111-1111-4111-8111-111111111111';
const FEATURE_ID = '001-organization-management';

function buildRealContract() {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['organization'] });
	return buildContract({ featureId: FEATURE_ID, featureUid: FEATURE_UID, scanReport, module: 'organization' });
}

test('smoke (real Team-IZ-Backend, when present): createOrganization/findOrganizations/deleteOrganization verb+body shapes still hold', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	assert.equal(contract.operations.createOrganization.verb, 'POST');
	assert.equal(contract.operations.createOrganization.body, true, 'createOrganization takes @RequestBody CreateOrganizationRequest');
	assert.equal(contract.operations.findOrganizations.body, false, 'findOrganizations (bare @GetMapping) takes no body');
	assert.equal(contract.operations.deleteOrganization.body, true, 'deleteOrganization is DELETE but still takes @RequestBody DeleteOrganizationRequest -- verb alone would get this wrong');
	assert.deepEqual(contract.operations.findOrganization.pathParams.required, ['organizationId']);
	assert.match('e957347e-3794-4c71-92a8-cec75dec1c97', new RegExp(contract.operations.findOrganization.pathParams.properties.organizationId.pattern));
});

test('smoke (real Team-IZ-Backend, when present): envelope validation invariants -- valid passes; wrong feature_id/feature_uid, unknown op, missing path param, and a body on a bodyless op all fail', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const base = { sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID, operation_id: 'createOrganization', direction: 'request' };

	const valid = validateEnvelope({ ...base, payload: { pathParams: {}, body: { name: 'Test Org' } } }, contract);
	assert.equal(valid.ok, true, JSON.stringify(valid.errors));

	const wrongFeatureId = validateEnvelope({ ...base, feature_id: '999-not-this-feature', payload: { pathParams: {}, body: { name: 'Test' } } }, contract);
	assert.equal(wrongFeatureId.ok, false);
	assert.match(wrongFeatureId.errors.join(' '), /feature_id mismatch/);

	const wrongFeatureUid = validateEnvelope({ ...base, feature_uid: '22222222-2222-4222-8222-222222222222', payload: { pathParams: {}, body: {} } }, contract);
	assert.equal(wrongFeatureUid.ok, false);
	assert.match(wrongFeatureUid.errors.join(' '), /feature_uid mismatch/);

	const unknownOp = validateEnvelope({ ...base, operation_id: 'thisOperationDoesNotExist', payload: {} }, contract);
	assert.equal(unknownOp.ok, false);
	assert.match(unknownOp.errors.join(' '), /not defined in this feature's contract/);

	const missingParam = validateEnvelope({ ...base, operation_id: 'findOrganization', payload: { pathParams: {} } }, contract);
	assert.equal(missingParam.ok, false);
	assert.match(missingParam.errors.join(' '), /organizationId/);

	const bodyOnBodyless = validateEnvelope({ ...base, operation_id: 'findOrganizations', payload: { pathParams: {}, body: { sneaky: 'field' } } }, contract);
	assert.equal(bodyOnBodyless.ok, false);
});

test('envelope structural validation rejects an extra top-level field', () => {
	const result = validateEnvelopeStructure({
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'x', direction: 'request', payload: {}, extra_field: 'not allowed',
	});
	assert.equal(result.ok, false);
});

// D-security-1 regression, smoke-tested against the real repo when present -- the exhaustive
// version of this matrix (every evil id x every direction) now runs unconditionally in CI via
// test/contract-fixture.test.mjs; this is real-world confirmation the real contract's operations
// object has no surprising own-property that would make one of these ids accidentally resolve.
test('smoke (real Team-IZ-Backend, when present): operation_id shadowing Object.prototype members is rejected, not silently resolved', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	// "constructor", "toString", "hasOwnProperty", "valueOf" all match the envelope schema's
	// own operation_id pattern (letters+digits only), so they reach the contract-lookup layer
	// where the actual fix lives. "__proto__" is already rejected one layer earlier, by the
	// envelope's own structural pattern (it contains "_") -- still correctly rejected, just via
	// a different, equally valid error path; asserting that distinction here documents it.
	for (const evilId of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
		for (const direction of ['request', 'response', 'error']) {
			const envelope = {
				sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
				operation_id: evilId, direction, payload: {},
			};
			const result = validateEnvelope(envelope, contract);
			assert.equal(result.ok, false, `operation_id "${evilId}" (${direction}) must not validate`);
			assert.match(result.errors.join(' '), /not defined in this feature's contract/);
		}
	}

	const protoEnvelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: '__proto__', direction: 'request', payload: {},
	};
	assert.equal(validateEnvelope(protoEnvelope, contract).ok, false);
});

// D-security-2 regression, smoke-tested against the real repo when present (exhaustive coverage
// now lives in test/contract-fixture.test.mjs): a `urn:uuid:...`-prefixed value must not satisfy
// a UUID path param -- Spring's UUID path-variable converter expects the bare form, so a contract
// accepting the urn form would certify a request the real endpoint rejects.
test('smoke (real Team-IZ-Backend, when present): a urn:uuid: prefixed path param value is rejected, not accepted as a bare UUID', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganization', direction: 'request',
		payload: { pathParams: { organizationId: 'urn:uuid:e957347e-3794-4c71-92a8-cec75dec1c97' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
});

// A5: `buildContract` itself, not just the CLI (see test/contract-cli.test.mjs for the
// gate-blocking behavior). Synthetic scanReport -- duplicate operationId doesn't occur anywhere
// in the real Team-IZ-Backend repo (0/96), so there's no real fixture to reuse here.
test('duplicate operationId across two endpoints produces CONTRACT_DUPLICATE_OPERATION_ID and keeps the first', () => {
	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: null,
				endpoints: [
					{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidgetV1' },
					{ verb: 'GET', path: '/widgets/legacy/{widgetId}', operationId: 'findWidget', method: 'findWidgetV2' },
				],
			}],
			entities: [], enums: [], dtos: [],
		}],
	};
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget' });
	assert.equal(contract.completeness.status, 'partial');
	assert.equal(Object.keys(contract.operations).length, 1);
	assert.equal(contract.operations.findWidget.path, '/widgets/{widgetId}', 'first occurrence is kept');
	const dup = contract.warnings.find((w) => w.code === 'CONTRACT_DUPLICATE_OPERATION_ID');
	assert.ok(dup, 'must emit CONTRACT_DUPLICATE_OPERATION_ID');
	assert.equal(dup.subject, 'findWidget');
	assert.equal(dup.severity, 'error');
});

// A5: no matching module -- the exact shape that lets a contract silently end up with zero
// operations. CONTRACT_NO_MODULE explains why; CONTRACT_EMPTY states the (more important)
// consequence -- both fire together.
test('no matching module in the scan report produces CONTRACT_NO_MODULE + CONTRACT_EMPTY, status blocked', () => {
	const scanReport = { related_modules: [{ module: 'organization', controllers: [], entities: [], enums: [], dtos: [] }] };
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'nonexistent-module' });
	assert.equal(contract.completeness.status, 'blocked');
	assert.equal(contract.completeness.operation_count, 0);
	const codes = contract.warnings.map((w) => w.code);
	assert.ok(codes.includes('CONTRACT_NO_MODULE'));
	assert.ok(codes.includes('CONTRACT_EMPTY'));
});

// A5, real-oracle regression, invariant version (P3/D-fixture-corpus): Team-IZ-Backend's
// `codeanalysis` module (0 controllers) is the exact shape that motivated A5 -- pre-A5, this
// produced operations:0 AND warnings:0 (no signal at all) and the contract gate passed silently.
// "Zero controllers -> blocked+CONTRACT_EMPTY" has no exact-count component to begin with, so
// this one didn't need loosening -- kept as a real-world smoke test alongside its frozen
// equivalent in test/contract-fixture.test.mjs.
test('smoke (real Team-IZ-Backend, when present): codeanalysis module -- zero controllers -> blocked with CONTRACT_EMPTY, not a silent empty pass', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['codeanalysis'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'codeanalysis' });
	assert.equal(contract.completeness.status, 'blocked');
	assert.equal(contract.completeness.operation_count, 0);
	assert.equal(contract.warnings.length, 1);
	assert.equal(contract.warnings[0].code, 'CONTRACT_EMPTY');
});

// A5, real-oracle regression, rewritten as a drift-resistant invariant (P3/D-fixture-corpus): the
// exact counts here (endpoints 8/operations 2/unmatched 6) moved -- all three numbers -- 4 days
// after this test was originally written, purely from unrelated Team-IZ-Backend development. The
// frozen exact-count version now lives in test/contract-fixture.test.mjs; what's checked here is
// the shape that must hold regardless of how many endpoints Team-IZ-Backend's owners add: a
// genuinely partial module has strictly more endpoints than correlated operations, and every gap
// is accounted for by exactly one CONTRACT_UNMATCHED_ENDPOINT warning.
test('smoke (real Team-IZ-Backend, when present): curriculum module -- endpoint_count > operation_count, and every gap has exactly one CONTRACT_UNMATCHED_ENDPOINT warning', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['curriculum'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'curriculum' });
	assert.equal(contract.completeness.status, 'partial');
	assert.ok(contract.completeness.endpoint_count > contract.completeness.operation_count, 'a partial module must have strictly more endpoints than operations');
	const unmatched = contract.warnings.filter((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT');
	assert.equal(unmatched.length, contract.completeness.endpoint_count - contract.completeness.operation_count);
});

// A5, real-oracle regression: organization must stay `partial` with exactly the one, expected
// warning -- A5 must not turn an already-good contract into a false positive, and (real dogfooding
// finding, Phase 3, Team-IZ/Backend, 2026-08-24) this module's real ApiPathConfig.addPathPrefix
// global `/api/v0` prefix is genuinely unreflected in a scan-only contract (no --openapi-file), so
// asserting `complete`/zero-warnings here was itself the bug CONTRACT_UNREFLECTED_PATH_PREFIX was
// added to catch -- see contracts/completeness.mjs. No exact operation_count assertion (that
// number is free to grow as the real API grows).
test('smoke (real Team-IZ-Backend, when present): organization module is partial, with exactly the unreflected-/api/v0-prefix warning', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	assert.equal(contract.completeness.status, 'partial');
	assert.ok(contract.completeness.operation_count > 0);
	assert.equal(contract.warnings.length, 1);
	assert.equal(contract.warnings[0].code, 'CONTRACT_UNREFLECTED_PATH_PREFIX');
	assert.equal(contract.warnings[0].subject, '/api/v0');
});

// A5: promotes schemas/feature-contract.schema.json from an unreferenced document into a live
// regression guard -- confirmed via grep that nothing in the codebase loaded it before this test.
// Frozen-fixture-equivalent coverage lives in test/contract-fixture.test.mjs.
test('smoke (real Team-IZ-Backend, when present): an emitted contract validates against schemas/feature-contract.schema.json', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(contract);
	assert.equal(ok, true, JSON.stringify(validate.errors));
});

// A1: buildContract() + contracts/openapi.mjs integration. Helper builds a real Reconciliation
// (not a hand-rolled stand-in) by running the actual openapi.mjs functions against a synthetic
// scanReport + OpenAPI doc, so these tests exercise the real integration surface, not a mock of it.
// pathPrefix defaults to '/api/v0' (explicit, not inferred) since most of these fixtures are
// deliberately single-endpoint and have no anchor to infer a prefix from -- prefix INFERENCE
// itself is covered exhaustively in test/contract-openapi.test.mjs; this file's job is testing
// buildContract()'s reaction to each resolution kind, not re-deriving the prefix.
function reconcileFixture(scanReport, moduleName, doc, pathPrefix = '/api/v0') {
	const targetModule = scanReport.related_modules.find((m) => m.module === moduleName);
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	return reconcileModule({ index: indexed, module: targetModule, pathPrefix });
}

function widgetScanReport(endpoints) {
	return {
		adapter: 'java-spring',
		related_modules: [{
			module: 'widget',
			controllers: [{ className: 'WidgetController', basePath: '/widgets', file: null, endpoints }],
			entities: [], enums: [], dtos: [],
		}],
	};
}

test('openapi param omitted (or explicit null) produces byte-identical output to no reconciliation at all', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets', operationId: 'findWidgets', method: 'findWidgets' }]);
	const withoutParam = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget' });
	const explicitNull = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi: null });
	// generated_at is a timestamp -- strip before compare.
	const strip = (c) => { const { generated_at, ...rest } = c; return rest; };
	assert.deepEqual(strip(withoutParam), strip(explicitNull));
	assert.equal(withoutParam.operations.findWidgets.provenance, 'scan');
	assert.equal(withoutParam.source.provenance, 'scan');
});

test('matched: path is corrected to the OpenAPI value, provenance becomes scan+openapi, pathParams recomputed from the corrected path', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = { paths: { '/api/v0/widgets/{widgetId}': { get: { operationId: 'findWidget' } } } };
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.findWidget;
	assert.equal(op.path, '/api/v0/widgets/{widgetId}');
	assert.equal(op.provenance, 'scan+openapi');
	assert.deepEqual(op.pathParams.required, ['widgetId']);
	assert.equal(contract.source.provenance, 'scan+openapi');
	// CONTRACT_BODY_UNKNOWN still fires (fixture's controller.file is null) -- unrelated to path
	// correction, so only assert no OpenAPI-specific ERROR warning was raised.
	assert.ok(!contract.warnings.some((w) => w.code.startsWith('CONTRACT_OPENAPI_') && w.severity === 'error'));
});

test('adopted: operationId recovered from OpenAPI, provenance openapi, CONTRACT_OPENAPI_DERIVED_OPERATION_ID (WARN) emitted, no CONTRACT_UNMATCHED_ENDPOINT', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: null, method: 'createWidget' }]);
	const doc = { paths: { '/api/v0/widgets': { post: { operationId: 'createWidget' } } } };
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	assert.ok(contract.operations.createWidget);
	assert.equal(contract.operations.createWidget.provenance, 'openapi');
	// CONTRACT_BODY_UNKNOWN also fires (fixture's controller.file is null) -- unrelated, so find
	// the specific warning rather than asserting a total count.
	const derived = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_DERIVED_OPERATION_ID');
	assert.ok(derived);
	assert.equal(derived.severity, 'warn');
	assert.ok(!contract.warnings.some((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT'));
});

test('drift: ERROR warning emitted, operation keeps the scan value verbatim, provenance stays scan', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = { paths: { '/api/v0/widgets/{widgetId}': { post: { operationId: 'findWidget' } } } }; // verb drift
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.findWidget;
	assert.equal(op.path, '/widgets/{widgetId}', 'must keep the scan path, not silently adopt the conflicting OpenAPI value');
	assert.equal(op.verb, 'GET');
	assert.equal(op.provenance, 'scan');
	const drift = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_DRIFT');
	assert.ok(drift);
	assert.equal(drift.severity, 'error');
	assert.equal(drift.subject, 'findWidget');
});

test('missing: ERROR warning emitted, path left uncorrected', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = { paths: {} }; // operationId not in the document at all
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	assert.equal(contract.operations.findWidget.path, '/widgets/{widgetId}');
	const missing = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_MISSING_OPERATION');
	assert.ok(missing);
	assert.equal(missing.severity, 'error');
});

test('ambiguous: operation is NOT added, CONTRACT_OPENAPI_AMBIGUOUS replaces CONTRACT_UNMATCHED_ENDPOINT', () => {
	const scanReport = widgetScanReport([
		{ verb: 'GET', path: '/widgets', operationId: 'anchorOp', method: 'anchor' }, // anchor for prefix inference
		{ verb: 'GET', path: '/reports', operationId: null, method: 'findReports' },
	]);
	const doc = {
		paths: {
			'/api/v0/widgets': { get: { operationId: 'anchorOp' } },
			'/api/v0/reports': { get: { operationId: 'findReportsPrefixed' } },
			'/reports': { get: { operationId: 'findReportsBare' } },
		},
	};
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	assert.ok(!contract.operations.findReportsPrefixed);
	assert.ok(!contract.operations.findReportsBare);
	const ambiguous = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_AMBIGUOUS');
	assert.ok(ambiguous);
	assert.ok(!contract.warnings.some((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT' && w.subject === 'GET /reports'));
});

test('unresolved: falls through to CONTRACT_UNMATCHED_ENDPOINT with detail.openapi_attempted, subject unchanged from the non-OpenAPI shape', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/nothing', operationId: null, method: 'nothing' }]);
	const doc = { paths: {} };
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const unmatched = contract.warnings.find((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT');
	assert.ok(unmatched);
	assert.equal(unmatched.subject, 'GET /nothing', 'subject must stay exactly what it would be without OpenAPI (waiver key stability)');
	assert.equal(unmatched.detail.openapi_attempted, true);
	assert.ok(unmatched.detail.openapi_reason);
});

test('two scan endpoints adopting the same OpenAPI operation still hit the existing CONTRACT_DUPLICATE_OPERATION_ID guard', () => {
	const scanReport = widgetScanReport([
		{ verb: 'POST', path: '/widgets/a', operationId: null, method: 'createWidgetA' },
		{ verb: 'POST', path: '/widgets/b', operationId: null, method: 'createWidgetB' },
	]);
	// Both unmatched endpoints resolve (via forced --path-prefix) to the SAME single OpenAPI
	// operation -- contrived, but exercises the guard regardless of how the collision arises.
	const doc = { paths: { '/api/v0/widgets/a': { post: { operationId: 'createWidget' } } } };
	const targetModule = scanReport.related_modules[0];
	const indexed = indexOpenApiDocument(doc);
	// Manually force both endpoints to resolve to the same adopted operationId by pointing
	// pathPrefix such that only "a" resolves via the normal path -- instead, directly build a
	// byEndpoint map for this contrived case to keep the test deterministic and independent of
	// route-matching specifics tested elsewhere.
	const recon = reconcileModule({ index: indexed, module: targetModule, pathPrefix: '/api/v0' });
	recon.byEndpoint.set('0:1', { kind: 'adopted', operationId: 'createWidget', verb: 'POST', path: '/api/v0/widgets/a', scanVerb: 'POST', scanPath: '/widgets/b' });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi: recon });
	assert.equal(Object.keys(contract.operations).length, 1);
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_DUPLICATE_OPERATION_ID'));
});

// ===== A2: request body JSON Schema projection, buildContract() integration =====

const WIDGET_REQUEST_SCHEMA_DOC = (schemaOverride) => ({
	openapi: '3.1.0',
	components: { schemas: { CreateWidgetRequest: schemaOverride ?? { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 10 } } } } },
	paths: { '/api/v0/widgets': { post: {
		operationId: 'createWidget',
		requestBody: { required: true, content: { 'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } } } },
	} } },
});

test('matched + a resolvable request body: requestBodySchema attached, body stays true, other A1 fields unchanged', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_REQUEST_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.provenance, 'scan+openapi');
	assert.equal(op.path, '/api/v0/widgets');
	assert.deepEqual(op.requestBodySchema.required, ['name']);
	assert.equal(op.requestBodySchema.properties.name.maxLength, 10);
	assert.equal(op.requestBodyRequired, true);
});

test('adopted + a resolvable request body: schema attached AND CONTRACT_OPENAPI_DERIVED_OPERATION_ID still fires', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: null, method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_REQUEST_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.provenance, 'openapi');
	assert.deepEqual(op.requestBodySchema.required, ['name']);
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DERIVED_OPERATION_ID'));
});

test('an unresolvable schema on a matched operation: no requestBodySchema key, CONTRACT_OPENAPI_SCHEMA_UNRESOLVED (WARN), completeness stays complete', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	// discriminator is not in inlineSchema's whitelist -- fails closed.
	const doc = WIDGET_REQUEST_SCHEMA_DOC({ type: 'object', discriminator: { propertyName: 'kind' } });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal('requestBodySchema' in op, false);
	assert.notEqual(op.body, false, 'body-presence flag is unaffected by schema-projection failure (fixture has no controller.file, so it reads "unknown", not the projection outcome)');
	const unresolved = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_SCHEMA_UNRESOLVED');
	assert.ok(unresolved);
	assert.equal(unresolved.severity, 'warn');
	assert.equal(unresolved.subject, 'createWidget');
	assert.match(unresolved.detail.reason, /unsupported-keyword:discriminator/);
	assert.equal(contract.completeness.status, 'complete', 'a WARN-severity code never demotes completeness');
});

test('openapi:null produces no requestBodySchema/requestBodyRequired keys anywhere -- extends the A1 byte-identity guarantee', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets', operationId: 'findWidgets', method: 'findWidgets' }]);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi: null });
	assert.equal('requestBodySchema' in contract.operations.findWidgets, false);
	assert.equal('requestBodyRequired' in contract.operations.findWidgets, false);
});

test('drift never gets a requestBodySchema, even though the doc entry has a perfectly resolvable one', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { X: { type: 'object' } } },
		paths: { '/api/v0/widgets/{widgetId}': { post: { // verb drift: doc says POST, scan says GET
			operationId: 'findWidget',
			requestBody: { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } },
		} } },
	};
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.findWidget;
	assert.equal('requestBodySchema' in op, false);
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'));
});

test('a contract with a projected requestBodySchema still validates against schemas/feature-contract.schema.json (v5)', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_REQUEST_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(contract);
	assert.equal(ok, true, JSON.stringify(validate.errors));
	assert.equal(contract.sbf_contract, '5'); // A7: sbf_contract "4" -> "5" (source* fields + sourceSecuritySchemes)
});

// ===== A3: response/error JSON Schema projection, buildContract() integration =====

const WIDGET_RESPONSE_SCHEMA_DOC = ({ successOverride, errorOverride } = {}) => ({
	openapi: '3.1.0',
	components: {
		schemas: {
			CreateWidgetRequest: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
			WidgetResponse: successOverride ?? { type: 'object', properties: { id: { type: 'string' } } },
			ErrorResponse: errorOverride ?? { type: 'object', properties: { code: { type: 'string' } } },
		},
	},
	paths: { '/api/v0/widgets': { post: {
		operationId: 'createWidget',
		requestBody: { required: true, content: { 'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } } } },
		responses: {
			'201': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/WidgetResponse' } } } },
			'400': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
		},
	} } },
});

test('matched + resolvable response + error: both keys attached, A1/A2 fields unchanged', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_RESPONSE_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.provenance, 'scan+openapi');
	assert.equal(op.path, '/api/v0/widgets');
	assert.deepEqual(op.requestBodySchema.required, ['name']); // A2 field still present, unaffected
	assert.equal(op.responseSchema.properties.id.type, 'string');
	assert.equal(op.errorSchema.properties.code.type, 'string');
});

test('adopted + resolvable response: keys present AND CONTRACT_OPENAPI_DERIVED_OPERATION_ID still fires', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: null, method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_RESPONSE_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.provenance, 'openapi');
	assert.equal(op.responseSchema.properties.id.type, 'string');
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DERIVED_OPERATION_ID'));
});

test('response projection fails, error projection succeeds: no responseSchema key, CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED (WARN), errorSchema still present, completeness stays complete', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = WIDGET_RESPONSE_SCHEMA_DOC({ successOverride: { type: 'object', discriminator: { propertyName: 'kind' } } });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal('responseSchema' in op, false);
	assert.equal(op.errorSchema.properties.code.type, 'string');
	const unresolved = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED');
	assert.ok(unresolved);
	assert.equal(unresolved.severity, 'warn');
	assert.equal(unresolved.subject, 'createWidget');
	assert.equal(contract.completeness.status, 'complete');
});

test('error projection fails, response projection succeeds (symmetric to the previous test)', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = WIDGET_RESPONSE_SCHEMA_DOC({ errorOverride: { type: 'object', discriminator: { propertyName: 'kind' } } });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal('errorSchema' in op, false);
	assert.equal(op.responseSchema.properties.id.type, 'string');
	const unresolved = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED');
	assert.ok(unresolved);
	assert.equal(unresolved.severity, 'warn');
	assert.equal(contract.completeness.status, 'complete');
});

test('request-body AND response projection both fail on the same operation: exactly 2 warnings, 2 different codes, same subject -- the direct proof separate codes were the right call', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = {
		openapi: '3.1.0',
		components: {
			schemas: {
				BadRequest: { type: 'object', discriminator: { propertyName: 'kind' } },
				BadResponse: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
			},
		},
		paths: { '/api/v0/widgets': { post: {
			operationId: 'createWidget',
			requestBody: { required: true, content: { 'application/json': { schema: { '$ref': '#/components/schemas/BadRequest' } } } },
			responses: { '201': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/BadResponse' } } } } },
		} } },
	};
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const unresolvedWarnings = contract.warnings.filter((w) => w.code.endsWith('_SCHEMA_UNRESOLVED'));
	assert.equal(unresolvedWarnings.length, 2);
	const codes = unresolvedWarnings.map((w) => w.code).sort();
	assert.deepEqual(codes, ['CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED', 'CONTRACT_OPENAPI_SCHEMA_UNRESOLVED']);
	assert.ok(unresolvedWarnings.every((w) => w.subject === 'createWidget'));
});

test('openapi:null produces no responseSchema/errorSchema keys anywhere -- extends the A1/A2 byte-identity guarantee', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets', operationId: 'findWidgets', method: 'findWidgets' }]);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi: null });
	assert.equal('responseSchema' in contract.operations.findWidgets, false);
	assert.equal('errorSchema' in contract.operations.findWidgets, false);
});

test('drift never gets responseSchema/errorSchema, even though the doc entry has perfectly resolvable ones', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { X: { type: 'object' } } },
		paths: { '/api/v0/widgets/{widgetId}': { post: { // verb drift: doc says POST, scan says GET
			operationId: 'findWidget',
			responses: { '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } } },
		} } },
	};
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.findWidget;
	assert.equal('responseSchema' in op, false);
	assert.equal('errorSchema' in op, false);
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'));
});

test('a contract carrying all four projected fields (request+response+error) still validates against schemas/feature-contract.schema.json (v5)', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_RESPONSE_SCHEMA_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(contract);
	assert.equal(ok, true, JSON.stringify(validate.errors));
});

// ===== A7: source-backed OpenAPI field passthrough, buildContract() integration =====

const WIDGET_PASSTHROUGH_DOC = (operationOverride) => ({
	openapi: '3.1.0',
	components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
	paths: { '/api/v0/widgets': { post: {
		operationId: 'createWidget',
		parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
		security: [{ bearerAuth: [] }],
		summary: 'create a widget',
		tags: ['Widgets'],
		...operationOverride,
	} } },
});

test('matched + a full passthrough operation: all four source* fields land on the operation, sourceSecuritySchemes lands on the contract root', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_PASSTHROUGH_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.sourceParameters.length, 1);
	assert.equal(op.sourceParameters[0].name, 'q');
	assert.deepEqual(op.sourceSecurity, [{ bearerAuth: [] }]);
	assert.equal(op.sourceSummary, 'create a widget');
	assert.deepEqual(op.sourceTags, ['Widgets']);
	assert.deepEqual(contract.sourceSecuritySchemes, { bearerAuth: { type: 'http', scheme: 'bearer' } });
	assert.ok(!contract.warnings.some((w) => w.code.startsWith('CONTRACT_OPENAPI_') && w.code.endsWith('_UNRESOLVED')));
});

test('adopted + a full passthrough operation: source* fields present AND CONTRACT_OPENAPI_DERIVED_OPERATION_ID still fires', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: null, method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_PASSTHROUGH_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal(op.sourceSummary, 'create a widget');
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DERIVED_OPERATION_ID'));
});

test('a parameter that could not be copied raises CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED (WARN), completeness stays complete', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = WIDGET_PASSTHROUGH_DOC({ parameters: [{ '$ref': '#/components/parameters/Bad' }] });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal('sourceParameters' in op, false);
	const w = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED');
	assert.ok(w);
	assert.equal(w.severity, 'warn');
	assert.equal(w.subject, 'createWidget');
	assert.match(w.message, /ref-parameter/);
	assert.equal(contract.completeness.status, 'complete');
});

test('security naming an undeclared scheme raises CONTRACT_OPENAPI_SECURITY_UNRESOLVED (WARN), completeness stays complete', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = WIDGET_PASSTHROUGH_DOC({ security: [{ ghostScheme: [] }] });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.createWidget;
	assert.equal('sourceSecurity' in op, false);
	const w = contract.warnings.find((w) => w.code === 'CONTRACT_OPENAPI_SECURITY_UNRESOLVED');
	assert.ok(w);
	assert.equal(w.severity, 'warn');
	assert.equal(w.subject, 'createWidget');
	assert.match(w.message, /unknown-scheme/);
	assert.equal(contract.completeness.status, 'complete');
	assert.equal('sourceSecuritySchemes' in contract, false, 'nothing was actually referenced by a COPIED requirement');
});

test('a parameter AND a security failure on the SAME operation: two warnings, two different codes, same subject -- proves the codes are genuinely separate', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const doc = WIDGET_PASSTHROUGH_DOC({ parameters: [{ '$ref': '#/components/parameters/Bad' }], security: [{ ghostScheme: [] }] });
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const unresolved = contract.warnings.filter((w) => w.code === 'CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED' || w.code === 'CONTRACT_OPENAPI_SECURITY_UNRESOLVED');
	assert.equal(unresolved.length, 2);
	assert.deepEqual(unresolved.map((w) => w.code).sort(), ['CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED', 'CONTRACT_OPENAPI_SECURITY_UNRESOLVED']);
	assert.ok(unresolved.every((w) => w.subject === 'createWidget'));
});

test('drift never gets any of the four source* fields, even with a perfectly copyable set in the doc', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }]);
	const doc = {
		openapi: '3.1.0',
		components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
		paths: { '/api/v0/widgets/{widgetId}': { post: { // verb drift: doc says POST, scan says GET
			operationId: 'findWidget',
			parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
			security: [{ bearerAuth: [] }],
			summary: 'x', tags: ['y'],
		} } },
	};
	const openapi = reconcileFixture(scanReport, 'widget', doc);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	const op = contract.operations.findWidget;
	for (const key of ['sourceParameters', 'sourceSecurity', 'sourceSummary', 'sourceTags']) {
		assert.equal(key in op, false, `drift must not carry ${key}`);
	}
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_DRIFT'));
});

test('openapi:null produces none of the four source* fields, nor sourceSecuritySchemes at the root -- extends the byte-identity guarantee', () => {
	const scanReport = widgetScanReport([{ verb: 'GET', path: '/widgets', operationId: 'findWidgets', method: 'findWidgets' }]);
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi: null });
	for (const key of ['sourceParameters', 'sourceSecurity', 'sourceSummary', 'sourceTags']) {
		assert.equal(key in contract.operations.findWidgets, false);
	}
	assert.equal('sourceSecuritySchemes' in contract, false);
});

test('sbf_contract is "5", and a full passthrough contract validates against schemas/feature-contract.schema.json', () => {
	const scanReport = widgetScanReport([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
	const openapi = reconcileFixture(scanReport, 'widget', WIDGET_PASSTHROUGH_DOC());
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'widget', openapi });
	assert.equal(contract.sbf_contract, '5');
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

// ===== A2: operationPayloadSchema() / envelope validation with a projected requestBodySchema =====

const WIDGET_FEATURE_UID = '22222222-2222-4222-8222-222222222222';

function widgetContract(op) {
	return {
		feature_id: '001-x', feature_uid: WIDGET_FEATURE_UID,
		operations: { createWidget: op },
		warnings: [], completeness: { status: 'complete', operation_count: 1, endpoint_count: 1 },
	};
}

test('operationPayloadSchema: requestBodySchema present + body:true -> properties.body IS that schema, body required', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: true, provenance: 'scan+openapi',
		requestBodySchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
		requestBodyRequired: true,
	};
	const schema = operationPayloadSchema(op);
	assert.deepEqual(schema.properties.body, op.requestBodySchema);
	assert.ok(schema.required.includes('body'));
});

test('operationPayloadSchema: body:false + a requestBodySchema present -> byte-identical to pre-A2 (body still absent)', () => {
	const op = {
		verb: 'DELETE', path: '/widgets/{id}', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: false, provenance: 'scan+openapi',
		requestBodySchema: { type: 'object', properties: { confirmName: { type: 'string' } } },
	};
	const schema = operationPayloadSchema(op);
	assert.equal('body' in schema.properties, false);
	assert.deepEqual(schema.required, ['pathParams']);
});

test('operationPayloadSchema: no requestBodySchema -> deep-equals pre-A2 output for all three body values', () => {
	const base = { verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] }, provenance: 'scan' };
	for (const bodyValue of [true, false, 'unknown']) {
		const schema = operationPayloadSchema({ ...base, body: bodyValue });
		if (bodyValue === false) {
			assert.equal('body' in schema.properties, false);
		} else {
			assert.deepEqual(schema.properties.body, { type: 'object' });
		}
		assert.equal(schema.required.includes('body'), bodyValue === true);
	}
});

test('end-to-end: a body missing a required field, and one violating maxLength, both fail against a projected schema (both used to pass)', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: true, provenance: 'scan+openapi',
		requestBodySchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 5 } } },
		requestBodyRequired: true,
	};
	const contract = widgetContract(op);
	const envelopeBase = { sbf: '1', feature_id: '001-x', feature_uid: WIDGET_FEATURE_UID, operation_id: 'createWidget', direction: 'request' };

	const missingRequired = validateEnvelope({ ...envelopeBase, payload: { pathParams: {}, body: {} } }, contract);
	assert.equal(missingRequired.ok, false);

	const tooLong = validateEnvelope({ ...envelopeBase, payload: { pathParams: {}, body: { name: 'way too long' } } }, contract);
	assert.equal(tooLong.ok, false);

	const valid = validateEnvelope({ ...envelopeBase, payload: { pathParams: {}, body: { name: 'ok' } } }, contract);
	assert.equal(valid.ok, true, JSON.stringify(valid.errors));
});

test('a hand-edited, uncompilable requestBodySchema returns {ok:false, errors}, not a thrown exception', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: true, provenance: 'scan+openapi',
		requestBodySchema: { type: 'object', properties: { name: { pattern: '(' } } }, // invalid regex, ajv.compile throws
	};
	const contract = widgetContract(op);
	const envelope = {
		sbf: '1', feature_id: '001-x', feature_uid: WIDGET_FEATURE_UID, operation_id: 'createWidget', direction: 'request',
		payload: { pathParams: {}, body: { name: 'x' } },
	};
	assert.doesNotThrow(() => {
		const result = validateEnvelope(envelope, contract);
		assert.equal(result.ok, false);
		assert.ok(result.errors.length > 0);
	});
});

// ===== A3: operationPayloadSchema(direction) / response+error envelope validation =====

test('operationPayloadSchema(op, direction) matrix: response/error/request/no-schema/unknown-direction', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: true, provenance: 'scan+openapi',
		requestBodySchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
		responseSchema: { type: 'object', properties: { id: { type: 'string' } } },
		errorSchema: { type: 'object', properties: { code: { type: 'string' } } },
	};
	const responseSchema = operationPayloadSchema(op, 'response');
	assert.deepEqual(responseSchema, { type: 'object', additionalProperties: false, properties: { body: op.responseSchema }, required: ['body'] });

	const errorSchema = operationPayloadSchema(op, 'error');
	assert.deepEqual(errorSchema, { type: 'object', additionalProperties: false, properties: { body: op.errorSchema }, required: ['body'] });

	const requestSchema = operationPayloadSchema(op, 'request');
	assert.deepEqual(requestSchema.properties.body, op.requestBodySchema);

	const noResponseSchema = operationPayloadSchema({ ...op, responseSchema: undefined }, 'response');
	assert.equal(noResponseSchema, null);

	assert.equal(operationPayloadSchema(op, 'bogus-direction'), null);
});

test('end-to-end: direction:"response" with a missing required field fails (used to pass before A3), a valid one passes; direction:"error" symmetric; an operation with no projected schema stays unconstrained', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: true, provenance: 'scan+openapi',
		responseSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
		errorSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
	};
	const contract = widgetContract(op);
	const base = { sbf: '1', feature_id: '001-x', feature_uid: WIDGET_FEATURE_UID, operation_id: 'createWidget' };

	const missingId = validateEnvelope({ ...base, direction: 'response', payload: { body: {} } }, contract);
	assert.equal(missingId.ok, false);

	const validResponse = validateEnvelope({ ...base, direction: 'response', payload: { body: { id: 'x' } } }, contract);
	assert.equal(validResponse.ok, true, JSON.stringify(validResponse.errors));

	const validError = validateEnvelope({ ...base, direction: 'error', payload: { body: { code: 'NOT_FOUND' } } }, contract);
	assert.equal(validError.ok, true, JSON.stringify(validError.errors));

	const missingCode = validateEnvelope({ ...base, direction: 'error', payload: { body: {} } }, contract);
	assert.equal(missingCode.ok, false);

	// An operation with no responseSchema at all stays unconstrained -- anything passes, same as
	// every direction behaved before A2/A3.
	const noSchemaContract = widgetContract({ verb: 'GET', path: '/widgets', pathParams: op.pathParams, body: false, provenance: 'scan' });
	const anything = validateEnvelope({ ...base, direction: 'response', payload: { anything: 'goes', body: 'not even wrapped' } }, noSchemaContract);
	assert.equal(anything.ok, true, JSON.stringify(anything.errors));
});

test('a hand-edited, uncompilable responseSchema returns {ok:false, errors}, not a thrown exception', () => {
	const op = {
		verb: 'POST', path: '/widgets', pathParams: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		body: false, provenance: 'scan+openapi',
		responseSchema: { type: 'object', properties: { id: { pattern: '(' } } }, // invalid regex, ajv.compile throws
	};
	const contract = widgetContract(op);
	const envelope = {
		sbf: '1', feature_id: '001-x', feature_uid: WIDGET_FEATURE_UID, operation_id: 'createWidget', direction: 'response',
		payload: { body: { id: 'x' } },
	};
	assert.doesNotThrow(() => {
		const result = validateEnvelope(envelope, contract);
		assert.equal(result.ok, false);
		assert.ok(result.errors.length > 0);
	});
});
