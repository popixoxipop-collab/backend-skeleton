// Regression test for a real bug found while testing against Team-IZ-Backend: the "organization"
// module has TWO controllers (OrganizationController AND OperatorController, the latter's base
// path also starting with /organizations/{organizationId}/...). The first version of
// findFetchOperation used controllers[0]'s basePath for every entity, which for a module where
// the unrelated controller happens to come first in scan order would either find nothing or
// (in a differently-shaped module) match the wrong controller's endpoint entirely. Fixed by
// requiring the controller's own basePath AND a class-name affinity check with the entity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planHandles } from '../handles/plan.mjs';

function fixtureScanReport() {
	return {
		related_modules: [
			{
				module: 'organization',
				controllers: [
					// Deliberately listed FIRST, and its own basePath is a superset of
					// OrganizationController's -- reproduces the exact shape that broke the
					// original (single shared basePath) implementation.
					{
						className: 'OperatorController',
						basePath: '/organizations/{organizationId}/operators',
						file: null,
						endpoints: [
							{ verb: 'GET', path: '/organizations/{organizationId}/operators', operationId: 'findOperators', method: 'findOperators' },
						],
					},
					{
						className: 'OrganizationController',
						basePath: '/organizations',
						file: null,
						endpoints: [
							{ verb: 'GET', path: '/organizations', operationId: 'findOrganizations', method: 'findOrganizations' },
							{ verb: 'GET', path: '/organizations/{organizationId}', operationId: 'findOrganization', method: 'findOrganization' },
							{ verb: 'POST', path: '/organizations', operationId: 'createOrganization', method: 'createOrganization' },
						],
					},
				],
				entities: [
					{ className: 'Organization', table: 'organization', idField: 'orgId', file: null },
					{ className: 'OrganizationPolicy', table: 'organization_policy', idField: 'policyId', file: null },
				],
				enums: [],
				dtos: [],
			},
		],
	};
}

test('picks the correct controller\'s fetch endpoint when the module has multiple controllers', () => {
	const scanReport = fixtureScanReport();
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: null });

	const org = plan.resources.find((r) => r.type === 'Organization');
	assert.ok(org.fetchOperation, 'Organization should find a fetch operation');
	assert.equal(org.fetchOperation.operationId, 'findOrganization');
	assert.equal(org.fetchOperation.path, '/organizations/{organizationId}');
	assert.equal(org.fetchOperation.controllerClassName, 'OrganizationController');

	const policy = plan.resources.find((r) => r.type === 'OrganizationPolicy');
	assert.equal(policy.fetchOperation, null, 'OrganizationPolicy has no matching controller -- must not fall back to an unrelated one');
});

test('does not mistake OperatorController\'s list endpoint for a single-resource fetch', () => {
	const scanReport = fixtureScanReport();
	// If the bug regressed, Organization's fetchOperation could resolve to something under
	// OperatorController's basePath instead of OrganizationController's.
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: ['Organization'] });
	const org = plan.resources[0];
	assert.notEqual(org.fetchOperation.controllerClassName, 'OperatorController');
});

test('resolver is only planned to generate when both a fetch operation AND a matching service file exist', () => {
	const scanReport = fixtureScanReport();
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	fs.mkdirSync(path.join(javaSrcRoot, 'domain', 'organization', 'application'), { recursive: true });
	fs.writeFileSync(path.join(javaSrcRoot, 'domain', 'organization', 'application', 'OrganizationService.java'), '// fixture\n');
	// deliberately do NOT create OrganizationPolicyService.java

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'organization', resourceFilter: null });
	const org = plan.resources.find((r) => r.type === 'Organization');
	const policy = plan.resources.find((r) => r.type === 'OrganizationPolicy');

	assert.equal(org.willGenerateResolver, true);
	assert.equal(policy.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('OrganizationPolicyService')));
});

test('--resource filter narrows to the named entities only', () => {
	const scanReport = fixtureScanReport();
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: ['Organization'] });
	assert.equal(plan.resources.length, 1);
	assert.equal(plan.resources[0].type, 'Organization');
});
