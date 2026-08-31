// D-cross-feature-collision: e2e CLI tests for the full gate/CLI mechanism -- formalizes the exact
// scenarios already proven manually against a live fixture (the xfc-cli-smoke3 script, run during
// implementation, not checked in): a real collision blocks `cross-feature-check`; a partially-waived
// one still blocks `handles emit`; a fully-waived one unblocks it; `handles plan` is deliberately
// unaffected (dryRun-only, same precedent test/dependency-cli.test.mjs-adjacent code already
// establishes for the `contract` gate); `bskel verify`/`bskel next` surface the new gate correctly
// via their own already-generic machinery, with zero changes needed to either command.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runCapturingStderr, buildTwoFeatureFixtureRepo, initBothFeatures } from './_contract-fixture.mjs';

// A real @Entity @Table(name="item") Java class under domain/<module>/persistence/Item.java --
// moduleOf() (scanners/adapters/java-spring.mjs) keys purely on the "domain/<x>/..." path segment,
// so this lands in whichever module's scan report the caller intends. Writing the SAME className +
// table to BOTH "widget" and "organization" manufactures a real, both-sides-explicit resource_type +
// table collision -- the exact real-world shape (two features that independently modeled the same
// domain concept) this whole feature exists to catch.
function writeCollidingItemEntity(root, moduleName) {
	const file = path.join(root, 'src/main/java/com/example/domain', moduleName, 'persistence/Item.java');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `
package com.example.domain.${moduleName}.persistence;

import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import jakarta.persistence.Id;

@Entity
@Table(name = "item")
public class Item {
	@Id
	private String id;
}
`);
	return file;
}

// buildTwoFeatureFixtureRepo()+initBothFeatures() FIRST (preflight runs once here, against a clean
// tree -- `bskel preflight` itself rejects a dirty working tree by default), THEN the colliding
// entity files are added (uncommitted is fine -- preflight is never re-invoked by any later
// command in this flow, only its already-passed gate state is re-checked), THEN each feature's own
// scan is re-run and re-disposed to pick up its module's new entity file. Same edit -> re-scan ->
// re-disposition sequence test/dependency-propagation-cli.test.mjs's own
// editWidgetAndReestablishSourceFeature() already establishes.
function buildCollisionFixture() {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);

	writeCollidingItemEntity(root, 'widget');
	writeCollidingItemEntity(root, 'organization');

	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	run(['scan', '--feature', '002-organization-management', '--terms', 'organization'], root);
	assert.equal(run(['scan', 'disposition', '--feature', '002-organization-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);

	return root;
}

test('cross-feature-check: no collision -- baseline two-feature fixture reports 0 findings and passes', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);

	const check = run(['scan', 'cross-feature-check', '--feature', '001-widget-management', '--json'], root);
	assert.equal(check.code, 0);
	const parsed = JSON.parse(check.stdout);
	assert.deepEqual(parsed.report.findings, []);
	assert.equal(parsed.gate.status, 'pass');
});

test('cross-feature-check: a shared className + table across two features reports both signals, high confidence, and blocks', () => {
	const root = buildCollisionFixture();

	const check = run(['scan', 'cross-feature-check', '--feature', '001-widget-management', '--json'], root);
	assert.equal(check.code, 3);
	const { report, gate } = JSON.parse(check.stdout);
	assert.equal(report.findings.length, 2);
	const bySignal = Object.fromEntries(report.findings.map((f) => [f.signal, f]));
	assert.deepEqual(bySignal.resource_type, { signal: 'resource_type', identifier: 'Item', other_feature: '002-organization-management', confidence: 'high' });
	assert.equal(bySignal.table.signal, 'table');
	assert.equal(bySignal.table.confidence, 'high');
	assert.equal(gate.status, 'awaiting_disposition');
});

test('cross-feature-check: findings are symmetric -- checking from the OTHER feature reports the same collision back', () => {
	const root = buildCollisionFixture();
	const check = run(['scan', 'cross-feature-check', '--feature', '002-organization-management', '--json'], root);
	assert.equal(check.code, 3);
	const { report } = JSON.parse(check.stdout);
	assert.equal(report.findings.length, 2);
	assert.ok(report.findings.every((f) => f.other_feature === '001-widget-management'));
});

test('scan cross-feature-waive: waiving an unknown finding is refused, naming the known ones', () => {
	const root = buildCollisionFixture();
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);

	const waive = run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'operation_id', '--identifier', 'nope', '--other-feature', '002-organization-management', '--reason', 'x'], root);
	assert.equal(waive.code, 14); // BAD_ARGS
	assert.match(waive.stderr, /no current finding matches/);
	assert.match(waive.stderr, /resource_type "Item"/);
});

test('scan cross-feature-waive: waiving only ONE of two findings leaves the gate awaiting disposition', () => {
	const root = buildCollisionFixture();
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);

	const waive = run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'resource_type', '--identifier', 'Item', '--other-feature', '002-organization-management', '--reason', 'intentional shared naming, different domains', '--json'], root);
	assert.equal(waive.code, 3);
	assert.equal(JSON.parse(waive.stdout).gate.status, 'awaiting_disposition');
});

test('scan cross-feature-waive: waiving BOTH findings passes the gate', () => {
	const root = buildCollisionFixture();
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);
	run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'resource_type', '--identifier', 'Item', '--other-feature', '002-organization-management', '--reason', 'x'], root);

	const waive2 = run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'table', '--identifier', 'item', '--other-feature', '002-organization-management', '--reason', 'x', '--json'], root);
	assert.equal(waive2.code, 0);
	assert.equal(JSON.parse(waive2.stdout).gate.status, 'pass');
});

test('handles plan is unaffected by an unresolved cross-feature collision -- it never writes (dryRun-only), same precedent as the contract-gate check it also skips', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	// cross-feature-check deliberately NOT run here -- proving `handles plan` doesn't require it either.
	assert.equal(run(['handles', 'plan', '--feature', '001-widget-management'], root).code, 0);
});

test('handles emit is blocked (cross_feature not_run) even though contract already passed', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const emit = runCapturingStderr(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 2); // NOT_PASSED (not_run)
	assert.match(emit.stderr, /`cross_feature` gate for 001-widget-management is not_run/);
	assert.match(emit.stderr, /bskel scan cross-feature-check --feature 001-widget-management/);
});

test('handles emit stays blocked (awaiting_disposition) after cross-feature-check finds the real collision', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	assert.equal(run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root).code, 3);

	const emit = runCapturingStderr(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 3); // AWAITING_DISPOSITION
	assert.match(emit.stderr, /`cross_feature` gate for 001-widget-management is awaiting_disposition/);
	assert.match(emit.stderr, /scan cross-feature-waive/);
});

test('handles emit stays blocked after only ONE of two findings is waived (per-item disposition, not all-or-nothing)', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);
	run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'resource_type', '--identifier', 'Item', '--other-feature', '002-organization-management', '--reason', 'x'], root);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 3);
});

test('handles emit succeeds once BOTH findings are waived, and bskel verify then shows cross_feature passing', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);
	run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'resource_type', '--identifier', 'Item', '--other-feature', '002-organization-management', '--reason', 'x'], root);
	run(['scan', 'cross-feature-waive', '--feature', '001-widget-management', '--signal', 'table', '--identifier', 'item', '--other-feature', '002-organization-management', '--reason', 'x'], root);

	const emit = run(['handles', 'emit', '--feature', '001-widget-management', '--json'], root);
	assert.equal(emit.code, 0);
	assert.ok(JSON.parse(emit.stdout).written.length > 0);

	const verify = run(['verify', '--feature', '001-widget-management', '--json'], root);
	const crossFeatureGate = JSON.parse(verify.stdout).gates.find((g) => g.gate === 'cross_feature');
	assert.equal(crossFeatureGate.status, 'pass');
});

// `cross_feature` not_run is deliberately NOT treated as blocking by the GENERIC next/verify
// machinery (isBlockingGateResult's own established rule: "not_run on a required-when-present gate
// isn't blocking", same precedent already governing `dependencies`/`conformance` -- a feature that
// never touches handles shouldn't be nagged to run a check it may never need). The real mandatory
// enforcement lives ONLY in `cmdHandlesEmit`'s own hard requireNamedGate check (proven by the
// "handles emit is blocked" tests above) -- `next` staying quiet here, recommending plain `verify`,
// is the correct, intended behavior, not a gap.
test('bskel next stays quiet about the not-yet-run cross_feature gate when nothing else blocks -- enforcement lives in `handles emit`, not the generic next/verify machinery', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);

	const next = run(['next', '--feature', '001-widget-management', '--json'], root);
	const parsed = JSON.parse(next.stdout);
	assert.deepEqual(parsed.blocked_by, []);
	assert.equal(parsed.next_actions[0].command, 'bskel verify --feature 001-widget-management');
});

test('bskel next recommends waiving or forcing the gate once a real collision is found', () => {
	const root = buildCollisionFixture();
	assert.equal(run(['contract', 'emit', '--feature', '001-widget-management'], root).code, 0);
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root);

	const next = run(['next', '--feature', '001-widget-management', '--json'], root);
	const parsed = JSON.parse(next.stdout);
	assert.ok(parsed.next_actions.some((a) => a.command.includes('scan cross-feature-waive') && a.command.includes('gate force cross_feature')));
});
