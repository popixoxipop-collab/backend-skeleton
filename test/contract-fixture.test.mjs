// P3 (D-fixture-corpus): a frozen, committed, portable replacement for the 13 tests that used to
// live only in test/contract.test.mjs gated behind `~/Desktop/Team-IZ-Backend` being present.
// Same fixture as test/scan-fixture.test.mjs (test/fixtures/java-spring/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildContract } from '../contracts/emit.mjs';
import { validateEnvelope } from '../contracts/validate.mjs';
import { runScan } from '../scanners/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'java-spring');
const FEATURE_UID = '11111111-1111-4111-8111-111111111111';
const FEATURE_ID = '001-organization-management';

function buildOrgContract() {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });
	return buildContract({ featureId: FEATURE_ID, featureUid: FEATURE_UID, scanReport, module: 'organization' });
}

// A2 Phase 1 (D-java-analyzer): confirmed live against the OLD detectRequestBody() before fixing
// it -- its non-greedy `([\s\S]*?)\)\s*\{` regex failed to match this method at ALL (the return
// type's `Map<String, Object>` generic has an internal space, the exact same root cause
// scanners/adapters/java-spring.mjs's GenericWithSpaceController fixture already pins for
// extractController()), which would have left `body` unresolved rather than correctly `false`.
test('detectRequestBody() no longer fails on a generic return type with an internal space (Map<String, Object>)', () => {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms: ['annotationstyles'] });
	const contract = buildContract({ featureId: FEATURE_ID, featureUid: FEATURE_UID, scanReport, module: 'annotationstyles' });
	assert.equal(contract.operations.genericWithSpace.body, false);
	assert.ok(!contract.warnings.some((w) => w.code === 'CONTRACT_BODY_UNKNOWN' && w.subject === 'GET /generic-space'));
});

test('buildContract seeds all 15 organization+operator operations with correct verb/path/body', () => {
	const contract = buildOrgContract();
	assert.equal(contract.operations.createOrganization.verb, 'POST');
	assert.equal(contract.operations.createOrganization.body, true, 'createOrganization takes @RequestBody CreateOrganizationRequest');
	assert.equal(contract.operations.findOrganizations.body, false, 'findOrganizations (bare @GetMapping) takes no body');
	assert.equal(contract.operations.deleteOrganization.body, true, 'deleteOrganization is DELETE but still takes @RequestBody DeleteOrganizationRequest -- verb alone would get this wrong');
	assert.deepEqual(contract.operations.findOrganization.pathParams.required, ['organizationId']);
	assert.match('e957347e-3794-4c71-92a8-cec75dec1c97', new RegExp(contract.operations.findOrganization.pathParams.properties.organizationId.pattern));
});

test('a correctly-shaped envelope for a real operation validates', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: { name: 'Test Org', dataRetentionDays: 90 } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('wrong feature_id fails even with an otherwise-valid payload', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: '999-not-this-feature', feature_uid: FEATURE_UID,
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: { name: 'Test' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /feature_id mismatch/);
});

test('wrong feature_uid fails even when feature_id matches (stale renamed-feature payload)', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: '22222222-2222-4222-8222-222222222222',
		operation_id: 'createOrganization', direction: 'request',
		payload: { pathParams: {}, body: {} },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /feature_uid mismatch/);
});

test('unknown operation_id fails with the list of valid ones', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'thisOperationDoesNotExist', direction: 'request', payload: {},
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /not defined in this feature's contract/);
});

test('missing a required path param fails', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganization', direction: 'request', payload: { pathParams: {} },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
	assert.match(result.errors.join(' '), /organizationId/);
});

test('a body on a known-bodyless operation fails (additionalProperties)', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganizations', direction: 'request',
		payload: { pathParams: {}, body: { sneaky: 'field' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
});

// D-security-1 regression: `contract.operations` is a plain object -- operation_id values that
// shadow Object.prototype members must never resolve to an inherited property.
test('operation_id shadowing Object.prototype members is rejected, not silently resolved', () => {
	const contract = buildOrgContract();
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

// D-security-2 regression: a `urn:uuid:...`-prefixed value must not satisfy a UUID path param.
test('a urn:uuid: prefixed path param value is rejected, not accepted as a bare UUID', () => {
	const contract = buildOrgContract();
	const envelope = {
		sbf: '1', feature_id: FEATURE_ID, feature_uid: FEATURE_UID,
		operation_id: 'findOrganization', direction: 'request',
		payload: { pathParams: { organizationId: 'urn:uuid:e957347e-3794-4c71-92a8-cec75dec1c97' } },
	};
	const result = validateEnvelope(envelope, contract);
	assert.equal(result.ok, false);
});

test('fixture codeanalysis module: zero controllers -> blocked with CONTRACT_EMPTY, not a silent empty pass', () => {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms: ['codeanalysis'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'codeanalysis' });
	assert.equal(contract.completeness.status, 'blocked');
	assert.equal(contract.completeness.operation_count, 0);
	assert.equal(contract.warnings.length, 1);
	assert.equal(contract.warnings[0].code, 'CONTRACT_EMPTY');
});

// Frozen counts this fixture owns outright (D2(iii)): unlike the old Team-IZ-Backend-gated
// version of this test, these numbers can never drift out from under this suite -- the module is
// committed, not live. 8 endpoints across two controllers, only 2 (findCurricula, findCurriculum)
// carry a correlated operationId.
test('fixture curriculum module: 8 endpoints, 2 operations, 6 unmatched -> partial', () => {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms: ['curriculum'] });
	const contract = buildContract({ featureId: '001-x', featureUid: 'x', scanReport, module: 'curriculum' });
	assert.equal(contract.completeness.status, 'partial');
	assert.equal(contract.completeness.endpoint_count, 8);
	assert.equal(contract.completeness.operation_count, 2);
	const unmatched = contract.warnings.filter((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT');
	assert.equal(unmatched.length, 6);
});

// Real dogfooding finding (Phase 3, Team-IZ/Backend, 2026-08-24): this fixture faithfully mirrors
// the real repo's `/api/v0` global prefix (application.yml's `paths-to-match` + ApiPathConfig's
// `addPathPrefix`), and `contract emit` -- not just `contract export` -- now catches paths that
// don't reflect it (CONTRACT_UNREFLECTED_PATH_PREFIX). Every operation here still resolves; only
// completeness/warnings changed, matching the real smoke test below.
test('fixture organization module: 15 operations, but partial due to the unreflected /api/v0 prefix', () => {
	const contract = buildOrgContract();
	assert.equal(contract.completeness.status, 'partial');
	assert.equal(contract.completeness.operation_count, 15);
	assert.equal(contract.warnings.length, 1);
	assert.equal(contract.warnings[0].code, 'CONTRACT_UNREFLECTED_PATH_PREFIX');
	assert.equal(contract.warnings[0].subject, '/api/v0');
});

test('an emitted contract validates against schemas/feature-contract.schema.json', () => {
	const contract = buildOrgContract();
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const ok = validate(contract);
	assert.equal(ok, true, JSON.stringify(validate.errors));
});
