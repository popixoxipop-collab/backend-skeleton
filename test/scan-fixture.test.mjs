// P3 (D-fixture-corpus): a frozen, committed, portable replacement for the 3 tests that used to
// live only in test/scan.test.mjs gated behind `~/Desktop/Team-IZ-Backend` being present on this
// machine. Runs in CI (test/fixtures/java-spring/ needs no git, no build -- runScan() only needs
// build.gradle + src/main/java, scanned in place). Also covers a defect class the real oracle
// repo never happened to exercise (see AnnotationStyleController's file comment): CATALOG.md's A2
// ("a staged Java analyzer") is the item that would actually fix these; this file pins today's
// regex-scanner behavior as a known-limitation baseline for that future work, not a bug to fix here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { scanJavaSpring } from '../scanners/adapters/java-spring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'java-spring');

test('scanning the fixture for "organization" finds OrganizationController (10 ops) + OperatorController (5 ops)', () => {
	const report = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });

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
	assert.ok(controller.endpoints.every((ep) => ep.operationId), 'every endpoint should have a correlated operationId');
	assert.equal(controller.basePath, '/organizations');

	// The second controller in the same module -- basePath is a SUPERSET of OrganizationController's
	// ("/organizations/{organizationId}/operators" starts with "/organizations"), but its className
	// does not contain "Organization" -- the exact multi-controller shape that motivated
	// handles/providers/java-spring/plan.mjs's findFetchOperation() name-affinity fix.
	const operatorController = orgModule.controllers.find((c) => c.className === 'OperatorController');
	assert.ok(operatorController, 'expected OperatorController to be found');
	assert.equal(operatorController.endpoints.length, 5);
	assert.ok(operatorController.endpoints.every((ep) => ep.operationId));

	const statusEnum = orgModule.enums.find((e) => e.name === 'OrganizationStatus');
	assert.ok(statusEnum, 'expected OrganizationStatus enum to be found');
	assert.deepEqual(statusEnum.constants, ['ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED']);
});

test('the fixture\'s own global-path-prefix signals: configurePathMatch + springdoc.paths-to-match, no context-path', () => {
	const report = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });
	const byKind = Object.fromEntries(report.path_prefix_signals.map((s) => [s.kind, s]));

	assert.ok(byKind.configurePathMatch, 'expected a configurePathMatch signal');
	assert.equal(byKind.configurePathMatch.prefix, '/api/v0');
	assert.match(byKind.configurePathMatch.file, /ApiPathConfig\.java$/);

	assert.ok(byKind['paths-to-match'], 'expected a springdoc.paths-to-match signal');
	assert.equal(byKind['paths-to-match'].pattern, '/api/v0/**');

	assert.equal(byKind['context-path'], undefined, 'this fixture does not set server.servlet.context-path');

	assert.ok(
		report.unknowns.some((u) => u.includes('global path prefix') && u.includes('/api/v0')),
		'expected a human-readable warning in unknowns naming the detected prefix',
	);
});

test('individual endpoint verb+path+operationId correlation is correct, including the DELETE-with-body and nested-resource shapes', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
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

	const operatorController = orgModule.controllers.find((c) => c.className === 'OperatorController');
	const byOperatorOpId = Object.fromEntries(operatorController.endpoints.map((e) => [e.operationId, e]));
	assert.equal(byOperatorOpId.findOperator.path, '/organizations/{organizationId}/operators/{operatorId}');
});

// ===== known scanner limitations (A2's future before/after baseline), synthetic-only =====

test('a multi-line @Operation description that merely MENTIONS operationId = "..." as prose pollutes controller.operationIds, but does not corrupt real endpoint correlation', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'AnnotationStyleController');

	assert.ok(controller.operationIds.includes('notARealOperationId'), 'the phantom string from prose must appear in the whole-file operationIds grep');
	assert.equal(controller.endpoints.length, 1, 'only the one real, correctly-shaped endpoint in this file is detected');
	assert.equal(controller.endpoints[0].operationId, 'normalEndpoint', 'the real endpoint\'s own correlation must be unaffected by the phantom mention');
});

test('known limitation (A2): an annotation between the mapping annotation and "public" makes the whole endpoint invisible, not just its operationId', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'InterveningAnnotationController');
	assert.equal(controller.endpoints.length, 0);
});

test('known limitation (A2): a comment between the mapping annotation and "public" makes the whole endpoint invisible', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'CommentBeforeMethodController');
	assert.equal(controller.endpoints.length, 0);
});

test('known limitation (A2): a space inside a generic return type (Map<String, Object>) makes the whole endpoint invisible', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'GenericWithSpaceController');
	assert.equal(controller.endpoints.length, 0);
});

test('known limitation (A2): the mapping annotation and "public" on the same line makes the whole endpoint invisible', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'SameLineMappingController');
	assert.equal(controller.endpoints.length, 0);
});

test('known limitation (A2): @RequestMapping(method = RequestMethod.GET) is not supported at all (only the 5 verb-specific *Mapping annotations are)', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'RequestMappingStyleController');
	assert.equal(controller.endpoints.length, 0);
});
