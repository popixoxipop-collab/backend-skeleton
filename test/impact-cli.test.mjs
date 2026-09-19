// D-cross-feature-impact-graph: CLI test suite for `bskel impact check|accept|disposition|ack`.
// Reuses the same two-feature fixture (001-widget-management depends on 002-organization-
// management's OrganizationDto.taxRate) test/dependency-cli.test.mjs already exercises for
// `dependency declare` -- 002 is the UPSTREAM/source feature here, so ITS OWN `impact check` is
// what must see a change to a field 001 depends on and block ITS OWN `impact accept`.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	run, buildTwoFeatureFixtureRepo, initBothFeatures, organizationDtoPath, declareArgs,
} from './_contract-fixture.mjs';

function mutateOrganizationDto(root, marker) {
	fs.writeFileSync(organizationDtoPath(root), `${fs.readFileSync(organizationDtoPath(root), 'utf8')}\n// ${marker}\n`);
}

function jsonOf(result) {
	return JSON.parse(result.stdout);
}

test('impact accept with no downstream impact captures a baseline cleanly', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const result = run(['impact', 'accept', '--feature', '002-organization-management', '--json'], root);
	assert.equal(result.code, 0);
	assert.equal(jsonOf(result).baseline.feature_id, '002-organization-management');
});

test('impact check on the UPSTREAM feature sees a change to a field the DOWNSTREAM feature depends on', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs({}), root).code, 0);
	assert.equal(run(['impact', 'accept', '--feature', '002-organization-management'], root).code, 0);

	mutateOrganizationDto(root, 'first change');
	const check = run(['impact', 'check', '--feature', '002-organization-management', '--json'], root);
	const report = jsonOf(check).report;
	assert.equal(report.changes.length, 1);
	assert.equal(report.changes[0].kind, 'field_source_moved');
	assert.equal(report.outbound.length, 1);
	assert.equal(report.outbound[0].downstream_feature, '001-widget-management');
	assert.equal(report.outbound[0].confidence, 'proven');
	assert.equal(report.outbound[0].disposition, null);
});

test('impact accept refuses (exit 3) with an undisposed proven outbound impact', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);
	mutateOrganizationDto(root, 'undisposed change');
	const result = run(['impact', 'accept', '--feature', '002-organization-management'], root);
	assert.equal(result.code, 3);
});

// The headline property this whole item exists to prove: a disposition for one change can NEVER
// cover a LATER, DIFFERENT change to the same subject -- change_key embeds the new hash (IG3).
// If this test passes silently without the second `accept` blocking, the design has failed.
test('anti-rubber-stamp: a disposition for one change does not cover a later, different change to the same field', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);

	mutateOrganizationDto(root, 'change A');
	const checkA = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKeyA = checkA.report.changes[0].change_key;

	const disposition = run([
		'impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKeyA, '--downstream', '001-widget-management',
		'--mode', 'compatible', '--reason', 'purely additive, WidgetDto.name unaffected',
	], root);
	assert.equal(disposition.code, 0);

	const acceptA = run(['impact', 'accept', '--feature', '002-organization-management'], root);
	assert.equal(acceptA.code, 0, 'the disposed change must unblock accept');

	// A SECOND, DIFFERENT change to the exact same field.
	mutateOrganizationDto(root, 'change B -- genuinely different content');
	const checkB = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKeyB = checkB.report.changes[0].change_key;

	assert.notEqual(changeKeyB, changeKeyA, 'a different change must produce a different change_key');
	assert.equal(checkB.report.outbound[0].disposition, null, 'the OLD disposition must not cover the NEW change_key');

	const acceptB = run(['impact', 'accept', '--feature', '002-organization-management'], root);
	assert.equal(acceptB.code, 3, 'the second, undisposed change must block accept again -- this is the whole point of this item');
});

test('migrate mode requires --tracked-by', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);
	mutateOrganizationDto(root, 'needs migration');
	const check = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKey = check.report.changes[0].change_key;
	const result = run([
		'impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management', '--mode', 'migrate', '--reason', 'x',
	], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--mode migrate requires --tracked-by/);
});

// The two-sided handshake: `migrate` creates an INBOUND obligation on the downstream feature that
// only ITS OWN `impact ack` (not the upstream's own accept) can clear.
test('migrate creates an inbound obligation the downstream feature must ack, blocking its own impact gate until then', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);
	mutateOrganizationDto(root, 'requires downstream migration');
	const check = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKey = check.report.changes[0].change_key;

	const disposition = run([
		'impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management',
		'--mode', 'migrate', '--tracked-by', 'ISSUE-42', '--reason', 'WidgetDto.name must re-derive',
	], root);
	assert.equal(disposition.code, 0);
	assert.equal(run(['impact', 'accept', '--feature', '002-organization-management'], root).code, 0, 'a migrate disposition unblocks the UPSTREAM side immediately');

	const downstreamCheck = jsonOf(run(['impact', 'check', '--feature', '001-widget-management', '--json'], root));
	assert.equal(downstreamCheck.report.inbound.length, 1);
	assert.equal(downstreamCheck.report.inbound[0].upstream_feature, '002-organization-management');
	assert.equal(downstreamCheck.report.inbound[0].acknowledged, false);
	assert.equal(run(['impact', 'accept', '--feature', '001-widget-management'], root).code, 3, 'an unacknowledged inbound migration blocks the DOWNSTREAM side too');

	const ack = run([
		'impact', 'ack', '--feature', '001-widget-management', '--from', '002-organization-management',
		'--change', changeKey, '--reason', 'WidgetDto.name updated',
	], root);
	assert.equal(ack.code, 0);
	assert.equal(run(['impact', 'accept', '--feature', '001-widget-management'], root).code, 0);
});

test('waive mode requires --expires-days', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	run(['impact', 'accept', '--feature', '002-organization-management'], root);
	mutateOrganizationDto(root, 'temporarily accepted risk');
	const check = jsonOf(run(['impact', 'check', '--feature', '002-organization-management', '--json'], root));
	const changeKey = check.report.changes[0].change_key;
	const result = run([
		'impact', 'disposition', '--feature', '002-organization-management',
		'--change', changeKey, '--downstream', '001-widget-management', '--mode', 'waive', '--reason', 'x',
	], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--mode waive requires --expires-days/);
});

test('impact export --format graphify writes a real extraction with EXTRACTED confidence and no AMBIGUOUS edges', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	const result = run(['impact', 'export', '--format', 'graphify'], root);
	assert.equal(result.code, 0);
	const extraction = JSON.parse(result.stdout);
	assert.ok(extraction.nodes.length > 0);
	assert.ok(extraction.edges.some((e) => e.relation === 'derives_from'));
	for (const e of extraction.edges) assert.ok(['EXTRACTED', 'INFERRED'].includes(e.confidence), `no AMBIGUOUS edges ever: got "${e.confidence}"`);
	assert.equal(extraction.input_tokens, 0);
	assert.equal(extraction.output_tokens, 0);
});
