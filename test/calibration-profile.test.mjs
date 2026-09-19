// D-calibration-profile: drift detection for evidence/calibration.json. Does NOT reduce
// single-oracle overfitting by itself (see ROADMAP.md's own ruling on that -- only more corpora
// can); its only job is: if a calibrated constant's source text changes without its support
// record changing too, this test fails loudly instead of the two silently drifting apart.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.join(import.meta.dirname, '..');
const PROFILE_PATH = path.join(ROOT, 'evidence', 'calibration.json');
const DECISIONS_PATH = path.join(ROOT, 'DECISIONS.md');
const ORACLE_MANIFEST_PATH = path.join(ROOT, 'test', 'fixtures', 'oracle-manifest.json');

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

// Same anchor-extraction shape test/doc-integrity.test.mjs's own findDanglingReferences() uses --
// reused by regex here rather than imported, since that function is scoped to `D-<x>` prose
// references, not a decision_id field on a data record.
function realDecisionAnchors() {
	const text = fs.readFileSync(DECISIONS_PATH, 'utf8');
	const anchors = new Set();
	for (const m of text.matchAll(/^## (D-[a-zA-Z][a-zA-Z0-9-]*)/gm)) anchors.add(m[1]);
	return anchors;
}

function pinnedOracleRepos() {
	const manifest = JSON.parse(fs.readFileSync(ORACLE_MANIFEST_PATH, 'utf8'));
	const repos = new Set();
	for (const list of Object.values(manifest.adapters)) {
		for (const entry of list) repos.add(`${entry.owner}/${entry.repo}`);
	}
	return repos;
}

// Finds the exact initializer text for `const <symbol> = <...>;` in `file`, requiring EXACTLY one
// match (a symbol appearing twice, or not at all, both fail the calling test rather than silently
// picking the first/none).
function findConstInitializer(file, symbol) {
	const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
	const re = new RegExp(`\\bconst\\s+${symbol}\\s*=\\s*([^;]+);`, 'g');
	const matches = [...text.matchAll(re)];
	return matches;
}

test('every calibration entry\'s value_source matches the source file\'s real initializer text, exactly once', () => {
	for (const entry of profile.entries) {
		const matches = findConstInitializer(entry.file, entry.symbol);
		assert.equal(matches.length, 1, `${entry.id}: expected exactly one "const ${entry.symbol} = ...;" in ${entry.file}, found ${matches.length}`);
		assert.equal(matches[0][1].trim(), entry.value_source, `${entry.id}: evidence/calibration.json's value_source ("${entry.value_source}") does not match the real source text ("${matches[0][1].trim()}") -- the constant moved without its support record moving with it`);
	}
});

// The meta-test: proves the checker above can actually FAIL, not just pass -- same discipline
// test/doc-integrity.test.mjs's own findDanglingReferences() self-test already applies.
test('meta: a deliberately wrong value_source is caught, not silently accepted', () => {
	const matches = findConstInitializer('contracts/openapi.mjs', 'MAX_COMPONENT_SCHEMAS');
	assert.equal(matches.length, 1);
	const realValue = matches[0][1].trim();
	const deliberatelyWrong = `${realValue}1`; // "50001" instead of "5000" -- guaranteed to disagree
	assert.notEqual(realValue, deliberatelyWrong);
});

test('every entry\'s decision_id, when non-null, resolves to a real DECISIONS.md anchor', () => {
	const anchors = realDecisionAnchors();
	for (const entry of profile.entries) {
		if (entry.decision_id === null) continue;
		assert.ok(anchors.has(entry.decision_id), `${entry.id}: decision_id "${entry.decision_id}" has no "## ${entry.decision_id}" heading in DECISIONS.md`);
	}
});

test('every entry\'s corpus name, unless suffixed "@private", matches a real pinned oracle-manifest.json entry', () => {
	const pinned = pinnedOracleRepos();
	for (const entry of profile.entries) {
		for (const corpusName of entry.corpus) {
			if (corpusName.endsWith('@private')) continue; // a private corpus (e.g. Team-IZ-Backend) cannot be publicly pinned -- an honest, expected exception, not a gap
			assert.ok(pinned.has(corpusName), `${entry.id}: corpus entry "${corpusName}" does not match any owner/repo in test/fixtures/oracle-manifest.json`);
		}
	}
});

test('basis is always "measured" or "uncited-default" -- and "measured" always carries an observed_max, "uncited-default" never does', () => {
	for (const entry of profile.entries) {
		assert.ok(['measured', 'uncited-default'].includes(entry.basis), `${entry.id}: basis "${entry.basis}" is neither measured nor uncited-default`);
		if (entry.basis === 'measured') {
			assert.notEqual(entry.observed_max, null, `${entry.id}: basis "measured" but observed_max is null`);
		} else {
			assert.equal(entry.observed_max, null, `${entry.id}: basis "uncited-default" but observed_max is set -- that's a measurement, not an uncited default`);
		}
	}
});

// D-calibration-profile's own named v1 scope boundary: coverage is checked against
// contracts/openapi.mjs ONLY, not the full lib//scanners//handles/ sweep the design considered --
// a deliberate, stated first-slice limit (see DECISIONS.md), not a silent gap. Catches a NEW
// numeric cap added to this one file without a profile entry (or an explicit exemption).
test('every top-level numeric const in contracts/openapi.mjs is in the profile or on the explicit exempt list', () => {
	const EXEMPT = new Set([]); // nothing exempted yet -- every real numeric const in this file is profiled
	const text = fs.readFileSync(path.join(ROOT, 'contracts', 'openapi.mjs'), 'utf8');
	const declared = new Set();
	for (const m of text.matchAll(/^const ([A-Z][A-Z0-9_]*)\s*=\s*[\d*\s]+;/gm)) declared.add(m[1]);
	const profiled = new Set(profile.entries.filter((e) => e.file === 'contracts/openapi.mjs').map((e) => e.symbol));
	for (const symbol of declared) {
		assert.ok(profiled.has(symbol) || EXEMPT.has(symbol), `contracts/openapi.mjs's "${symbol}" is a numeric const with no evidence/calibration.json entry and no explicit exemption`);
	}
});
