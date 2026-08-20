// P3 (D-fixture-corpus): the exact-count oracles this file used to assert now live in
// test/scan-fixture.test.mjs (a frozen, committed fixture, immune to a third party's ongoing
// development). What's left here is smoke-tested against the REAL Team-IZ-Backend repo, when
// present, but only for drift-resistant INVARIANTS that stay true no matter how many endpoints
// the real repo's owners add or remove -- not exact counts. This is deliberate, not a downgrade:
// the exact-count version of this test broke in the field 4 days after it was written (endpoints
// 8->10, operations 2->5, unmatched 6->5, all three numbers moved) purely from unrelated
// Team-IZ-Backend development, which is exactly the fragility class P3 exists to close. What this
// file still catches that a synthetic fixture cannot: a REAL bug in this codebase's own
// scanner/config, like the OperatorController basePath-affinity bug D-fixture-corpus's own
// synthetic fixture now also covers on every CI run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runScan } from '../scanners/index.mjs';

const TEAM_IZ_BACKEND = `${process.env.HOME}/Desktop/Team-IZ-Backend`;
const repoPresent = fs.existsSync(`${TEAM_IZ_BACKEND}/build.gradle`);

test('smoke (real Team-IZ-Backend, when present): "organization" scans as a collision with a real OrganizationController whose every endpoint has a correlated operationId', { skip: !repoPresent && 'Team-IZ-Backend not present on this machine' }, () => {
	const report = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['organization'] });

	assert.equal(report.adapter, 'java-spring');
	assert.equal(report.verdict, 'collision');

	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected an "organization" related module');

	const controller = orgModule.controllers.find((c) => c.className === 'OrganizationController');
	assert.ok(controller, 'expected OrganizationController to be found');
	assert.ok(controller.endpoints.length > 0, 'expected at least one endpoint');
	assert.ok(controller.endpoints.every((ep) => ep.operationId), 'every endpoint should have a correlated operationId');
	assert.equal(controller.basePath, '/organizations');
	// operationIds and endpoints must never disagree on cardinality -- if they do, the
	// "nearest preceding @Operation" correlation heuristic mis-attributed something.
	assert.equal(controller.operationIds.length, controller.endpoints.length);

	const statusEnum = orgModule.enums.find((e) => e.name === 'OrganizationStatus');
	assert.ok(statusEnum, 'expected OrganizationStatus enum to be found');
	assert.ok(statusEnum.constants.length > 0);
});

// A1 §7: the scanner's own global-path-prefix detector, run against the real defect it exists to
// flag -- Team-IZ-Backend's ApiPathConfig.java is exactly what caused every contract path to be
// wrong before --openapi-file (D-openapi-reconciliation). Frozen-fixture-equivalent coverage of
// the mechanism itself lives in test/scan-fixture.test.mjs; this is real-world confirmation the
// actual repo still has the signal this tool was built to detect.
test('smoke (real Team-IZ-Backend, when present): the real ApiPathConfig.java configurePathMatch prefix and springdoc.paths-to-match are still detected', { skip: !repoPresent && 'Team-IZ-Backend not present on this machine' }, () => {
	const report = runScan({ repoRoot: TEAM_IZ_BACKEND, terms: ['organization'] });
	const byKind = Object.fromEntries(report.path_prefix_signals.map((s) => [s.kind, s]));

	assert.ok(byKind.configurePathMatch, 'expected a configurePathMatch signal');
	assert.equal(byKind.configurePathMatch.prefix, '/api/v0');
	assert.match(byKind.configurePathMatch.file, /ApiPathConfig\.java$/);

	assert.ok(byKind['paths-to-match'], 'expected a springdoc.paths-to-match signal');

	assert.ok(
		report.unknowns.some((u) => u.includes('global path prefix') && u.includes('/api/v0')),
		'expected a human-readable warning in unknowns naming the detected prefix',
	);
});
