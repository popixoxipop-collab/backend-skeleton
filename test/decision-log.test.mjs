// D-decision-event-log: the decision log's own load-bearing properties -- anti-wildcard survival
// (the log records the EXACT subject a decision covered, never something a later, different
// change could be read as also covering), the migrate->waive downgrade leaving a trace, withdraw
// for contract waivers and impact dispositions, and the JSONL resilience contract (a corrupt line
// is skipped, not fatal -- mirroring lib/gate-export.mjs's readGateHistory()).
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	run, buildFixtureRepo, initThroughScanDisposition, contractResolutionPath,
	buildTwoFeatureFixtureRepo, initBothFeatures, organizationDtoPath, declareArgs,
} from './_contract-fixture.mjs';
import { decisionLogPath, readDecisionLog } from '../lib/decision-log.mjs';

function jsonOf(result) {
	return JSON.parse(result.stdout);
}

function mutateOrganizationDto(root, marker) {
	fs.writeFileSync(organizationDtoPath(root), `${fs.readFileSync(organizationDtoPath(root), 'utf8')}\n// ${marker}\n`);
}

// --- contract waivers ---

test('contract waiver: recording appends a "record" event, renewing appends a "renew" event, both carrying the exact {code, subject} -- never a flattened string', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'temporary', '--expires', '1d'], root);

	let events = readDecisionLog(root, '001-widget-management');
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, 'contract_waiver');
	assert.equal(events[0].action, 'record');
	assert.deepEqual(events[0].subject, { code: 'CONTRACT_UNMATCHED_ENDPOINT', subject: 'DELETE /widgets/{widgetId}' });

	const resolutionPath = contractResolutionPath(root);
	const resolution = JSON.parse(fs.readFileSync(resolutionPath, 'utf8'));
	resolution.waivers[0].expires_at = new Date(Date.now() - 1000).toISOString();
	fs.writeFileSync(resolutionPath, JSON.stringify(resolution, null, 2));

	run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'still needed', '--expires', '90d'], root);

	events = readDecisionLog(root, '001-widget-management');
	assert.equal(events.length, 2);
	assert.equal(events[1].action, 'renew');
	assert.equal(events[1].reason, 'still needed');
});

test('contract unwaive: removes the entry, re-blocks the gate, and appends a "withdraw" event with the real reason', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'temporary'], root);
	run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'PATCH /widgets/{widgetId}', '--reason', 'temporary'], root);
	assert.equal(run(['verify', '--feature', '001-widget-management', '--json'], root).code, 0);

	const unwaive = run(['contract', 'unwaive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'the endpoint really does need addressing now'], root);
	assert.equal(unwaive.code, 3, 'removing a waiver re-blocks the gate');

	const resolution = JSON.parse(fs.readFileSync(contractResolutionPath(root), 'utf8'));
	assert.equal(resolution.waivers.length, 1, 'only the PATCH waiver remains');
	assert.equal(resolution.waivers[0].subject, 'PATCH /widgets/{widgetId}');

	const events = readDecisionLog(root, '001-widget-management');
	const withdrawEvent = events.find((e) => e.action === 'withdraw');
	assert.ok(withdrawEvent);
	assert.equal(withdrawEvent.reason, 'the endpoint really does need addressing now');
	assert.deepEqual(withdrawEvent.subject, { code: 'CONTRACT_UNMATCHED_ENDPOINT', subject: 'DELETE /widgets/{widgetId}' });

	// DELETE is unwaived and blocking again (correct); PATCH is still separately waived. `verify`
	// reports its own generic "not everything passed" exit code (1) here, distinct from the
	// per-gate-command AWAITING_DISPOSITION (3) asserted above on the `unwaive` call itself --
	// unwaiving DELETE does not silently forgive it.
	assert.equal(run(['verify', '--feature', '001-widget-management', '--json'], root).code, 1);
});

test('contract unwaive on a non-existent waiver is refused, nothing written', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	const unwaive = run(['contract', 'unwaive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'x'], root);
	assert.equal(unwaive.code, 2); // NOT_PASSED / MISSING_ARTIFACT
	assert.equal(readDecisionLog(root, '001-widget-management').length, 0);
});

// --- impact dispositions: anti-wildcard at the LOG level, migrate->waive downgrade trace, withdraw ---

test('impact disposition: the decision log records the EXACT change_key a disposition covered -- a later, different change never appears to be covered by it', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);

	mutateOrganizationDto(root, 'change A');
	const checkA = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKeyA = checkA.report.changes[0].change_key;
	run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKeyA, '--downstream', '001-widget-management', '--mode', 'compatible', '--reason', 'additive only'], root);

	const events = readDecisionLog(root, '002-organization-management');
	assert.equal(events.length, 1);
	assert.equal(events[0].subject.change_key, changeKeyA);
	assert.notEqual(events[0].subject.change_key, undefined);
});

test('impact disposition: migrate downgraded to waive leaves BOTH events in the log -- the migrate obligation is not silently erased', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);

	mutateOrganizationDto(root, 'needs migration then gets waived instead');
	const check = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKey = check.report.changes[0].change_key;

	run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management',
		'--mode', 'migrate', '--tracked-by', 'ISSUE-412', '--reason', 'needs a real migration'], root);
	run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management',
		'--mode', 'waive', '--expires-days', '30', '--reason', 'changed my mind, accepting the risk instead'], root);

	const events = readDecisionLog(root, '002-organization-management');
	assert.equal(events.length, 2, 'both the migrate and the waive are recorded, even though only the waive survives in the resolution file');
	assert.equal(events[0].mode, 'migrate');
	assert.equal(events[0].tracked_by, 'ISSUE-412');
	assert.equal(events[1].mode, 'waive');
});

test('impact disposition --withdraw: removes the entry, re-blocks accept, and appends a "withdraw" event', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);

	mutateOrganizationDto(root, 'to be disposed then withdrawn');
	const check = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKey = check.report.changes[0].change_key;
	run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management', '--mode', 'compatible', '--reason', 'x'], root);
	assert.equal(run(['impact', 'accept', '--feature', '002-organization-management'], root).code, 0);

	const withdraw = run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management', '--withdraw', '--reason', 'reconsidered -- this DOES need review'], root);
	assert.equal(withdraw.code, 0);

	const events = readDecisionLog(root, '002-organization-management');
	const withdrawEvent = events.find((e) => e.action === 'withdraw');
	assert.ok(withdrawEvent);
	assert.equal(withdrawEvent.subject.change_key, changeKey);
	assert.equal(withdrawEvent.reason, 'reconsidered -- this DOES need review');
});

test('impact disposition --withdraw on a non-existent disposition is refused', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const withdraw = run(['impact', 'disposition', '--feature', '002-organization-management',
		'--change', 'operation_response_shape_changed:nope:deadbeef', '--downstream', '001-widget-management', '--withdraw', '--reason', 'x'], root);
	assert.equal(withdraw.code, 2);
});

// --- resilience: a corrupt line is skipped, not fatal ---

test('readDecisionLog: a corrupt JSON line and a schema-invalid line are both skipped with a warning, valid lines around them still read', () => {
	const root = buildFixtureRepo({ coverage: 'partial' });
	initThroughScanDisposition(root);
	run(['contract', 'emit', '--feature', '001-widget-management'], root);
	run(['contract', 'waive', '--feature', '001-widget-management',
		'--code', 'CONTRACT_UNMATCHED_ENDPOINT', '--subject', 'DELETE /widgets/{widgetId}', '--reason', 'x'], root);

	const file = decisionLogPath(root, '001-widget-management');
	const existing = fs.readFileSync(file, 'utf8');
	fs.appendFileSync(file, 'not valid json at all\n');
	fs.appendFileSync(file, `${JSON.stringify({ schema: 'sbf.decision-event/1', kind: 'contract_waiver' })}\n`); // missing required fields
	fs.appendFileSync(file, existing); // a second, valid copy of the original line

	const warnings = [];
	const events = readDecisionLog(root, '001-widget-management', { onWarning: (msg) => warnings.push(msg) });
	assert.equal(events.length, 2, 'the two valid lines are read; the corrupt and schema-invalid ones are skipped');
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /not valid JSON/);
	assert.match(warnings[1], /does not match schemas\/decision-event\.schema\.json/);
});
