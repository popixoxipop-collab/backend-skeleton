// Acceptance oracle from the plan's Phase 2 row: `bskel scan --terms organization` against the
// real Team-IZ-Backend repo must mechanically reproduce what the Spec Kit trial's agent found
// by luck -- OrganizationController's 10 operationIds and OrganizationStatus's 4 enum values.
// Skips itself (does not fail the suite) if that repo isn't present on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runScan } from '../scanners/index.mjs';
import { scanJavaSpring } from '../scanners/adapters/java-spring.mjs';

const TEAM_IZ_BACKEND = `${process.env.HOME}/Desktop/Team-IZ-Backend`;
const repoPresent = fs.existsSync(`${TEAM_IZ_BACKEND}/build.gradle`);

test('oracle: scanning Team-IZ-Backend for "organization" finds the real OrganizationController + OrganizationStatus', { skip: !repoPresent && 'Team-IZ-Backend not present on this machine' }, () => {
	const report = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['organization'] });

	assert.equal(report.adapter, 'java-spring');
	assert.equal(report.verdict, 'collision');

	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected an "organization" related module');

	const controller = orgModule.controllers.find((c) => c.className === 'OrganizationController');
	assert.ok(controller, 'expected OrganizationController to be found');

	const expectedOperationIds = [
		'findOrganizations', 'findPlatformSummary', 'checkNameAvailability', 'createOrganization',
		'findOrganization', 'findOrganizationCohorts', 'updateOrganization', 'deleteOrganization',
		'restoreOrganization', 'purgeOrganization',
	];
	assert.deepEqual(controller.operationIds, expectedOperationIds);
	assert.equal(controller.endpoints.length, 10);
	// Every endpoint's operationId must have been correlated with its mapping annotation --
	// this is the part a plain `grep -o operationId` (which is all the trial's agent had) can't
	// do: knowing WHICH verb+path each operationId actually belongs to.
	assert.ok(controller.endpoints.every((ep) => ep.operationId), 'every endpoint should have a correlated operationId');
	assert.equal(controller.basePath, '/organizations');

	const statusEnum = orgModule.enums.find((e) => e.name === 'OrganizationStatus');
	assert.ok(statusEnum, 'expected OrganizationStatus enum to be found');
	assert.deepEqual(statusEnum.constants, ['ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED']);
});

test('oracle detail: individual endpoint verb+path+operationId correlation is correct', { skip: !repoPresent && 'Team-IZ-Backend not present on this machine' }, () => {
	const result = scanJavaSpring(TEAM_IZ_BACKEND);
	const orgModule = result.modules.find((m) => m.module === 'organization');
	const controller = orgModule.controllers.find((c) => c.className === 'OrganizationController');

	const byOpId = Object.fromEntries(controller.endpoints.map((e) => [e.operationId, e]));
	assert.equal(byOpId.createOrganization.verb, 'POST');
	assert.equal(byOpId.createOrganization.path, '/organizations');
	assert.equal(byOpId.findOrganization.verb, 'GET');
	assert.equal(byOpId.findOrganization.path, '/organizations/{organizationId}');
	assert.equal(byOpId.restoreOrganization.verb, 'POST');
	assert.equal(byOpId.restoreOrganization.path, '/organizations/{organizationId}/restore');
	assert.equal(byOpId.deleteOrganization.verb, 'DELETE');
	assert.equal(byOpId.checkNameAvailability.path, '/organizations/name-availability');
});
