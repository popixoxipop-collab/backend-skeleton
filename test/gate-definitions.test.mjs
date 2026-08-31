// Pure unit tests for lib/gate-definitions.mjs -- no git repo, no CLI, no filesystem. This is
// the single declared source S1 introduces: bin/bskel.mjs (the write side) and lib/verify.mjs
// (the read side) both consume GATE_DEFINITIONS/GATE_NAMES instead of keeping their own
// hand-maintained lists. Test 2 below is the direct regression test for the class of bug that
// motivated this module: `stack` was registered as a writable gate but silently absent from
// lib/verify.mjs's old local GATE_SPECS, so `bskel verify` never even looked at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	GATE_DEFINITIONS, GATE_NAMES, SCOPE, VERIFY_POLICY, REPO_GATE_ID,
	getGateDefinition, requireGateDefinition, gateScopeId, gateInputs,
} from '../lib/gate-definitions.mjs';
import { isBlockingGateResult } from '../lib/verify.mjs';
import { EXIT } from '../lib/gates.mjs';

test('every gate definition has name/scope/verifyPolicy/recompute', () => {
	for (const name of GATE_NAMES) {
		const def = GATE_DEFINITIONS[name];
		assert.ok(def, `missing definition for "${name}"`);
		assert.equal(def.name, name);
		assert.ok(Object.values(SCOPE).includes(def.scope), `"${name}" has an invalid scope: ${def.scope}`);
		assert.ok(Object.values(VERIFY_POLICY).includes(def.verifyPolicy), `"${name}" has an invalid verifyPolicy: ${def.verifyPolicy}`);
		assert.equal(typeof def.recompute, 'function', `"${name}".recompute must be a function`);
	}
});

// The direct regression test: GATE_NAMES and GATE_DEFINITIONS' own key set must always agree.
// Before this module existed, the equivalent failure mode (a gate registered on the write side
// but missing from the read side) was only discoverable by noticing `bskel verify` silently
// never mentioned `stack`. Now it's a one-line assertion.
test('GATE_NAMES and GATE_DEFINITIONS have exactly the same gates', () => {
	assert.deepEqual([...GATE_NAMES].sort(), Object.keys(GATE_DEFINITIONS).sort());
});

test('gateScopeId: repo-scoped gates always resolve to REPO_GATE_ID, feature-scoped gates resolve to the given featureId', () => {
	assert.equal(gateScopeId('preflight', '001-whatever'), REPO_GATE_ID);
	assert.equal(gateScopeId('stack', '001-whatever'), REPO_GATE_ID);
	assert.equal(gateScopeId('preflight', null), REPO_GATE_ID);
	assert.equal(gateScopeId('scan', '001-widget-management'), '001-widget-management');
	assert.equal(gateScopeId('contract', '001-widget-management'), '001-widget-management');
	assert.equal(gateScopeId('handles', '001-widget-management'), '001-widget-management');
});

test('getGateDefinition returns null and requireGateDefinition throws for an unknown gate name', () => {
	assert.equal(getGateDefinition('bogus-gate'), null);
	assert.throws(() => requireGateDefinition('bogus-gate'), /unknown gate "bogus-gate"/);
	assert.throws(() => requireGateDefinition('bogus-gate'), /preflight, scan, cross_feature, contract, dependencies, handles, stack, conformance/);
});

// D-security-3-shaped defense: `constructor`/`__proto__`/`toString` must not resolve to
// something via the prototype chain the way a plain `{}[name]` lookup could -- getGateDefinition
// uses Object.hasOwn under the hood via GATE_DEFINITIONS being a plain frozen object with only
// the 5 real gate keys, so this just locks that in.
test('getGateDefinition rejects prototype-chain property names', () => {
	for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
		assert.equal(getGateDefinition(evil), null, `"${evil}" must not resolve to a real definition`);
	}
});

// The policy matrix isBlockingGateResult interprets. This is the ENTIRE behavioral difference
// between `required` and `required-when-present` -- get this matrix wrong and either optional
// gates block verify when they shouldn't, or a stale/awaiting_disposition gate stops blocking
// when it must not.
test('isBlockingGateResult policy matrix', () => {
	const REQUIRED = { verifyPolicy: VERIFY_POLICY.REQUIRED };
	const OPTIONAL = { verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT };
	const statuses = [
		{ code: EXIT.PASS, status: 'pass' },
		{ code: EXIT.NOT_PASSED, status: 'not_run' },
		{ code: EXIT.STALE, status: 'stale' },
		{ code: EXIT.AWAITING_DISPOSITION, status: 'awaiting_disposition' },
	];

	const expectedRequired = { pass: false, not_run: true, stale: true, awaiting_disposition: true };
	const expectedOptional = { pass: false, not_run: false, stale: true, awaiting_disposition: true };

	for (const result of statuses) {
		assert.equal(isBlockingGateResult(REQUIRED, result), expectedRequired[result.status], `required + ${result.status}`);
		assert.equal(isBlockingGateResult(OPTIONAL, result), expectedOptional[result.status], `required-when-present + ${result.status}`);
	}
});

test('stack and handles are pinned to required-when-present (the D-verify commitment this module implements)', () => {
	assert.equal(GATE_DEFINITIONS.stack.verifyPolicy, VERIFY_POLICY.REQUIRED_WHEN_PRESENT);
	assert.equal(GATE_DEFINITIONS.handles.verifyPolicy, VERIFY_POLICY.REQUIRED_WHEN_PRESENT);
	assert.equal(GATE_DEFINITIONS.preflight.verifyPolicy, VERIFY_POLICY.REQUIRED);
	assert.equal(GATE_DEFINITIONS.scan.verifyPolicy, VERIFY_POLICY.REQUIRED);
	assert.equal(GATE_DEFINITIONS.contract.verifyPolicy, VERIFY_POLICY.REQUIRED);
});

test('recompute is deterministic for the same root/featureId', () => {
	const root = process.cwd();
	for (const name of GATE_NAMES) {
		const a = gateInputs(root, name, '001-widget-management');
		const b = gateInputs(root, name, '001-widget-management');
		assert.deepEqual(a, b, `"${name}".recompute must be deterministic for identical inputs`);
	}
});

// A5+A1: the contract gate's token must cover the resolution (waiver) file and the OpenAPI
// reconciliation snapshot too, not just the contract artifact itself -- otherwise
// deleting/editing either would leave the gate green.
// S2 (D-gate-precision, part 2): head_sha is gone -- replaced by scan_report_hash plus one
// module_file: key per file belonging to the disposed module. No real scan report exists for
// this made-up feature id in this repo's own checkout, so there's no module to narrow to.
test('contract gate recompute covers scan_report_hash, contract_hash, resolution_hash, and openapi_snapshot_hash', () => {
	const inputs = gateInputs(process.cwd(), 'contract', '001-widget-management');
	assert.deepEqual(Object.keys(inputs).sort(), ['contract_hash', 'openapi_snapshot_hash', 'resolution_hash', 'scan_report_hash']);
});

// S2 (d): the stack gate's inputs are now precisely enumerated (one hash per applied file), so
// head_sha -- a repo-wide "something, somewhere, moved" proxy -- was dropped as pure noise. With
// no .sbf/stack.json present (true for this repo's own checkout), the only input left is the
// record's own hash.
test('the stack gate recompute no longer covers head_sha -- only the files it actually knows about', () => {
	const inputs = gateInputs(process.cwd(), 'stack', null);
	assert.deepEqual(Object.keys(inputs), ['stack_record_hash']);
});

// D-preflight-freshness (S3): origin_tip_sha is ADDED alongside head_sha/default_branch, never
// instead of -- D-gate-precision (S2) already committed to keeping head_sha on this gate, and
// dropping it here would break the "a commit stales preflight too" assumption other tests depend
// on (see test/preflight.test.mjs and the contract/handles integration suites).
test('preflight gate recompute covers head_sha, default_branch, and origin_tip_sha', () => {
	const inputs = gateInputs(process.cwd(), 'preflight', null);
	assert.deepEqual(Object.keys(inputs).sort(), ['default_branch', 'head_sha', 'origin_tip_sha']);
});

// D-preflight-freshness (S3): the one gate with a `freshness` policy so far -- every other gate
// must NOT declare one, since lib/gates.mjs's checkFreshness() treats an absent `def.freshness`
// as "TTL not applicable to this gate" (see test/gates.test.mjs's "no freshness declaration"
// case). A gate silently picking up a TTL it was never designed for would be a real regression.
test('only preflight declares a freshness policy; every other gate has none', () => {
	assert.deepEqual(GATE_DEFINITIONS.preflight.freshness, { defaultMaxAgeMinutes: 30 });
	for (const name of GATE_NAMES) {
		if (name === 'preflight') continue;
		assert.equal(GATE_DEFINITIONS[name].freshness, undefined, `"${name}" must not declare a freshness policy`);
	}
});
