// Pure-function-shaped tests for stack/config-apply.mjs's planConfigApply() -- real filesystem
// fixtures (YAML parsing needs real files), but no CLI, no git repo. The yaml@2.9.0 round-trip
// behaviors here are captured as PERMANENT regression assertions, not just design-time notes -- a
// future `yaml` version bump that changes stringifier whitespace behavior must be caught here, not
// discovered live again (see D-patch-transactions in DECISIONS.md for the original live findings).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConfigApply } from '../stack/config-apply.mjs';

function writeFixtureRepo(content, { relPath = 'src/main/resources/application.yaml' } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-config-apply-fixture-'));
	const target = path.join(root, relPath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return { root, relPath };
}

// Mirrors the REAL stack/catalog/ngrok.yml's own config_check entry shape exactly, so these tests
// stay grounded in the actual catalog contract rather than an invented one.
function ngrokLikeEntry({ apply = { key_path: ['auth', 'login', 'allowed-origins'], value_template: '${AUTH_LOGIN_ALLOWED_ORIGINS:{{CURRENT}}}' } } = {}) {
	return {
		id: 'ngrok-like',
		static: {
			config_check: [
				{
					target: 'src/main/resources/application.yaml',
					externalized_pattern: '\\$\\{AUTH_LOGIN_ALLOWED_ORIGINS',
					note: 'test fixture',
					...(apply ? { apply } : {}),
				},
			],
		},
	};
}

test('planConfigApply: a legitimate single-key edit resolves cleanly with no collateral changes', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000  # dev only\nserver:\n  port: 8080\n');
	const plan = planConfigApply(root, ngrokLikeEntry(), relPath);
	assert.equal(plan.current_value, 'http://localhost:3000');
	assert.equal(plan.proposed_value, '${AUTH_LOGIN_ALLOWED_ORIGINS:http://localhost:3000}');
	assert.match(plan.renderedContent, /allowed-origins: \$\{AUTH_LOGIN_ALLOWED_ORIGINS:http:\/\/localhost:3000\}/);
	assert.match(plan.renderedContent, /server:\n {2}port: 8080/); // untouched sibling key survives verbatim
	assert.ok(new RegExp(plan.postcondition.pattern).test(plan.renderedContent));
});

// D-patch-transactions: yaml@2.9.0's Document API does NOT byte-for-byte round-trip a completely
// UNTOUCHED line elsewhere in the same file when ANY other key is edited via setIn() -- confirmed
// live before this module was written. This is the exact collateral-damage hazard the collateral-
// diff check exists to catch; without it, config_apply would silently ship cosmetic reformatting
// of a hand-tuned file, precisely the failure mode D-config-patch's own WHY was written to avoid.
test('planConfigApply: refuses when an UNRELATED line would be collaterally reformatted (yaml flow-collection spacing, confirmed live)', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000  # dev only\n  flow-list: [a, b, c]   \n');
	assert.throws(
		() => planConfigApply(root, ngrokLikeEntry(), relPath),
		/would also change line\(s\).*outside the target key/,
	);
});

test('planConfigApply: refuses when the total line count would change', () => {
	// A value_template that injects a literal newline is the simplest way to force a line-count
	// mismatch without hand-crafting a yaml edge case -- the refusal is about the COUNT, not why.
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\n');
	const entry = ngrokLikeEntry({ apply: { key_path: ['auth', 'login', 'allowed-origins'], value_template: '{{CURRENT}}\nEXTRA' } });
	assert.throws(() => planConfigApply(root, entry, relPath), /changes the file's total line count/);
});

test('planConfigApply: refuses when the catalog entry has no config_check for this target at all', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\n');
	const entry = { id: 'x', static: { config_check: [] } };
	assert.throws(() => planConfigApply(root, entry, relPath), /no config_check entry for target/);
});

test('planConfigApply: refuses when the config_check entry matches but declares no "apply" block -- names the manual note', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\n');
	const entry = ngrokLikeEntry({ apply: null });
	assert.throws(() => planConfigApply(root, entry, relPath), /no machine-applicable fix declared.*test fixture/);
});

test('planConfigApply: refuses when key_path does not resolve in the real file (catalog/file drift)', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    other-key: value\n');
	assert.throws(() => planConfigApply(root, ngrokLikeEntry(), relPath), /has no value at.*allowed-origins/);
});

test('planConfigApply: refuses when the target key resolves to a mapping or list, not a scalar', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins:\n      nested: true\n');
	assert.throws(() => planConfigApply(root, ngrokLikeEntry(), relPath), /is not a plain scalar/);
});

test('planConfigApply: refuses when the proposed edit would not satisfy externalized_pattern -- catches a misconfigured catalog apply block', () => {
	const { root, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\n');
	const entry = ngrokLikeEntry({ apply: { key_path: ['auth', 'login', 'allowed-origins'], value_template: '{{CURRENT}}' } }); // never adds the pattern
	assert.throws(() => planConfigApply(root, entry, relPath), /does not satisfy this catalog entry's own "externalized_pattern"/);
});

test('planConfigApply: refuses cleanly when the target file does not exist', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-config-apply-fixture-'));
	assert.throws(() => planConfigApply(root, ngrokLikeEntry(), 'src/main/resources/application.yaml'), /does not exist/);
});

test('planConfigApply: computes a real preimage region_hash that changes when the target line changes, but not when an unrelated line changes', () => {
	const { root: rootA, relPath } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\nserver:\n  port: 8080\n');
	const planA = planConfigApply(rootA, ngrokLikeEntry(), relPath);

	const { root: rootB } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:3000\nserver:\n  port: 9090\n', { relPath });
	const planB = planConfigApply(rootB, ngrokLikeEntry(), relPath);
	assert.equal(planA.preimage.region_hash, planB.preimage.region_hash, 'an unrelated field changing elsewhere must NOT change the target region hash');

	const { root: rootC } = writeFixtureRepo('auth:\n  login:\n    allowed-origins: http://localhost:4000\nserver:\n  port: 8080\n', { relPath });
	const planC = planConfigApply(rootC, ngrokLikeEntry(), relPath);
	assert.notEqual(planA.preimage.region_hash, planC.preimage.region_hash, 'the target value itself changing MUST change the region hash');
});
