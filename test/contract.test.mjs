// Oracle for gap #2 from the trial report (feature_id-keyed machine-readable contract): a
// payload can be provably right or wrong for a specific feature+operation, not just "valid
// JSON". Verified two ways: (1) unit-level against the real Team-IZ-Backend scan data (skipped
// if that repo isn't present), (2) full CLI flow against a synthetic fixture in contract-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildContract } from '../contracts/emit.mjs';
import { validateEnvelope, validateEnvelopeStructure } from '../contracts/validate.mjs';
import { runScan } from '../scanners/index.mjs';

const TEAM_IZ_BACKEND = `${process.env.HOME}/Desktop/Team-IZ-Backend`;
const repoPresent = fs.existsSync(`${TEAM_IZ_BACKEND}/build.gradle`);
const FEATURE_UID = '11111111-1111-4111-8111-111111111111';
const FEATURE_ID = '001-organization-management';

function buildRealContract() {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['organization'] });
	return buildContract({ featureId: FEATURE_ID, featureUid: FEATURE_UID, scanReport, module: 'organization' });
}

test('buildContract seeds all 10 real OrganizationController operations with correct verb/path/body', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	assert.equal(contract.operations.createOrganization.verb, 'POST');
	assert.equal(contract.operations.createOrganization.body, true, 'createOrganization takes @RequestBody CreateOrganizationRequest');
	assert.equal(contract.operations.findOrganizations.body, false, 'findOrganizations (bare @GetMapping) takes no body');
	assert.equal(contract.operations.deleteOrganization.body, true, 'deleteOrganization is DELETE but still takes @RequestBody DeleteOrganizationRequest -- verb alone would get this wrong');
	assert.deepEqual(contract.operations.findOrganization.pathParams.required, ['organizationId']);
	assert.match('e957347e-3794-4c71-92a8-cec75dec1c97', new RegExp(contract.operations.findOrganization.pathParams.properties.organizationId.pattern));
});

test('a correctly-shaped envelope for a real operation validates', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: { name: 'Test Org', dataRetentionDays: 90 } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('wrong feature_id fails even with an otherwise-valid payload', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: '999-not-this-feature', feature_uid: FEATURE_UID,
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: { name: 'Test' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /feature_id mismatch/);
});

test('wrong feature_uid fails even when feature_id matches (stale renamed-feature payload)', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: '22222222-2222-4222-8222-222222222222',
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: {} },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /feature_uid mismatch/);
});

test('unknown operation_id fails with the list of valid ones', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'thisOperationDoesNotExist', direction: 'request', payload: {},
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /not defined in this feature's contract/);
});

test('missing a required path param fails', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganization', direction: 'request', payload: { pathParams: {} },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /organizationId/);
});

test('a body on a known-bodyless operation fails (additionalProperties)', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganizations', direction: 'request',
		payload: { pathParams: {}, body: { sneaky: 'field' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
});

test('envelope structural validation rejects an extra top-level field', () => {
	const result = validateEnvelopeStructure({
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'x', direction: 'request', payload: {}, extra_field: 'not allowed',
	});
	assert.equal(result.ok, false);
});

// D-security-1 regression: `contract.operations` is a plain object -- operation_id values that
// shadow Object.prototype members (constructor, toString, __proto__, hasOwnProperty, ...) must
// never resolve to an inherited property and be treated as a defined operation. Reproduces the
// exact bypass the Codex security review verified against this code before the fix.
test('operation_id shadowing Object.prototype members is rejected, not silently resolved', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
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

// D-security-2 regression: a `urn:uuid:...`-prefixed value must not satisfy a UUID path param --
// Spring's UUID path-variable converter expects the bare form, so a contract accepting the urn
// form would certify a request the real endpoint rejects.
test('a urn:uuid: prefixed path param value is rejected, not accepted as a bare UUID', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
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

// A5, real-oracle regression: Team-IZ-Backend's `codeanalysis` module (1 entity, 0 controllers)
// is the exact case that motivated A5 -- pre-A5, this produced operations:0 AND warnings:0 (no
// signal at all) and the contract gate passed silently. See D-contract-completeness in
// DECISIONS.md for the full before/after captured against this same module.
test('Team-IZ-Backend codeanalysis module: zero controllers -> blocked with CONTRACT_EMPTY, not a silent empty pass', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['codeanalysis'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'codeanalysis' });
	assert.equal(contract.completeness.status, 'blocked');
	assert.equal(contract.completeness.operation_count, 0);
	assert.equal(contract.warnings.length, 1);
	assert.equal(contract.warnings[0].code, 'CONTRACT_EMPTY');
});

// A5, real-oracle regression: Team-IZ-Backend's `curriculum` module -- 8 endpoints across two
// controllers, only 2 carry an operationId. Locks in the exact counts D-pressure-test's fresh
// agent encountered (and correctly refused to paper over) during Phase 6.
test('Team-IZ-Backend curriculum module: 8 endpoints, 2 operations, 6 unmatched -> partial', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const scanReport = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['curriculum'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'curriculum' });
	assert.equal(contract.completeness.status, 'partial');
	assert.equal(contract.completeness.endpoint_count, 8);
	assert.equal(contract.completeness.operation_count, 2);
	const unmatched = contract.warnings.filter((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT');
	assert.equal(unmatched.length, 6);
});

// A5, real-oracle regression: organization (15/15, no unmatched anywhere) must stay `complete`
// with zero warnings -- A5 must not turn an already-good contract into a false positive.
test('Team-IZ-Backend organization module stays complete with zero warnings', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	assert.equal(contract.completeness.status, 'complete');
	assert.equal(contract.completeness.operation_count, 15);
	assert.equal(contract.warnings.length, 0);
});

// A5: promotes schemas/feature-contract.schema.json from an unreferenced document into a live
// regression guard -- confirmed via grep that nothing in the codebase loaded it before this test.
test('an emitted contract validates against schemas/feature-contract.schema.json', { skip: !repoPresent && 'Team-IZ-Backend not present' }, () => {
	const contract = buildRealContract();
	const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(contract);
	assert.equal(ok, true, JSON.stringify(validate.errors));
});
