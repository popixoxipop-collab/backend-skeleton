// Oracle for gap #2 from the trial report (feature_id-keyed machine-readable contract): a
// payload can be provably right or wrong for a specific feature+operation, not just "valid
// JSON". Verified two ways: (1) unit-level against the real Team-IZ-Backend scan data (skipped
// if that repo isn't present), (2) full CLI flow against a synthetic fixture in contract-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
	assert.equal(contract.operations.findOrganization.pathParams.properties.organizationId.format, 'uuid');
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
