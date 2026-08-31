// D-patch-transactions: end-to-end CLI coverage for Slice 1 (config_check -> config_apply),
// against the REAL, unmodified `stack/catalog/ngrok.yml` catalog entry (no synthetic catalog
// needed -- D-config-patch's own EXIT already named this exact case) and a real Spring
// `application.yaml`-shaped fixture. Formalizes the same sequence already proven manually during
// implementation (propose -> approve -> a simulated TOCTOU hand-edit correctly refuses apply ->
// apply succeeds -> the real, untouched `stack apply` now reports already-externalized ->
// rollback restores the file byte-identical -> `bskel verify` reflects the gate at every stage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

const APPLICATION_YAML_REL = 'src/main/resources/application.yaml';
const ORIGINAL_APPLICATION_YAML = 'auth:\n  login:\n    allowed-origins: http://localhost:3000  # dev only\nserver:\n  port: 8080\n';

function buildFixtureRepo({ applicationYaml = ORIGINAL_APPLICATION_YAML } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-config-apply-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');
	fs.mkdirSync(path.join(root, 'src/main/java/com/example'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/main/java/com/example/ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');
	fs.mkdirSync(path.dirname(path.join(root, APPLICATION_YAML_REL)), { recursive: true });
	fs.writeFileSync(path.join(root, APPLICATION_YAML_REL), applicationYaml);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-config-apply-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function initFeature(root) {
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['feature', 'init', '--slug', 'widget-management'], root).code, 0);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root); // greenfield -> exit 0
	assert.equal(run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
}

function targetContent(root) {
	return fs.readFileSync(path.join(root, APPLICATION_YAML_REL), 'utf8');
}

test('e2e: stack apply reports needs-manual-patch before any transaction exists', () => {
	const root = buildFixtureRepo();
	initFeature(root);
	const plan = JSON.parse(run(['stack', 'apply', '--choice', 'ngrok', '--json'], root).stdout);
	assert.equal(plan.configChecks[0].status, 'needs-manual-patch');
});

test('e2e: patch propose writes a real transaction with a matching preimage, and touches no real file', () => {
	const root = buildFixtureRepo();
	initFeature(root);
	const propose = run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root);
	assert.equal(propose.code, 0);
	const txn = JSON.parse(propose.stdout);
	assert.equal(txn.status, 'proposed');
	assert.equal(txn.current_value, 'http://localhost:3000');
	assert.equal(txn.proposed_value, '${AUTH_LOGIN_ALLOWED_ORIGINS:http://localhost:3000}');
	assert.equal(targetContent(root), ORIGINAL_APPLICATION_YAML, 'propose alone must never write the real target file');
});

test('e2e: patch approve refuses without --reason', () => {
	const root = buildFixtureRepo();
	initFeature(root);
	const txn = JSON.parse(run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root).stdout);
	const approve = run(['patch', 'approve', '--feature', '001-widget-management', '--transaction', txn.transaction_id], root);
	assert.equal(approve.code, 14); // BAD_ARGS
	assert.match(approve.stderr, /requires --reason/);
});

test('e2e: a real hand-edit between approve and apply (TOCTOU) correctly refuses apply and leaves the file exactly as the human left it', () => {
	const root = buildFixtureRepo();
	initFeature(root);
	const txn = JSON.parse(run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root).stdout);
	assert.equal(run(['patch', 'approve', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'x'], root).code, 0);

	const handEdited = ORIGINAL_APPLICATION_YAML.replace('3000', '9999');
	fs.writeFileSync(path.join(root, APPLICATION_YAML_REL), handEdited);

	const apply = run(['patch', 'apply', '--feature', '001-widget-management', '--transaction', txn.transaction_id], root);
	assert.equal(apply.code, 14);
	assert.match(apply.stderr, /re-propose it against the current content/);
	assert.equal(targetContent(root), handEdited, 'a refused apply must never touch the file');
});

test('e2e: full propose -> approve -> apply -> real stack-apply re-check -> rollback (byte-identical) -> gate status at each stage', () => {
	const root = buildFixtureRepo();
	initFeature(root);

	// not_run before propose
	const beforeStatus = JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(beforeStatus.gates.find((g) => g.gate === 'patch_transactions').status, 'not_run');

	const txn = JSON.parse(run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root).stdout);
	assert.equal(run(['patch', 'approve', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'externalize for ngrok'], root).code, 0);

	const apply = run(['patch', 'apply', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--json'], root);
	assert.equal(apply.code, 0);
	const applyBody = JSON.parse(apply.stdout);
	assert.equal(applyBody.transaction.status, 'applied');
	assert.equal(applyBody.gate.status, 'pass');
	assert.match(targetContent(root), /allowed-origins: \$\{AUTH_LOGIN_ALLOWED_ORIGINS:http:\/\/localhost:3000\}/);
	assert.match(targetContent(root), /port: 8080/, 'an unrelated key must survive the edit untouched');

	// The real, completely unmodified stack apply now reports already-externalized -- proving the
	// postcondition holds through the EXISTING mechanism, not just this feature's own claim.
	const recheck = JSON.parse(run(['stack', 'apply', '--choice', 'ngrok', '--json'], root).stdout);
	assert.equal(recheck.configChecks[0].status, 'already-externalized');

	// pass after apply
	const afterApplyStatus = JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(afterApplyStatus.gates.find((g) => g.gate === 'patch_transactions').status, 'pass');

	const rollback = run(['patch', 'rollback', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'test cleanup', '--json'], root);
	assert.equal(rollback.code, 0);
	const rollbackBody = JSON.parse(rollback.stdout);
	assert.equal(rollbackBody.transaction.status, 'rolled_back');
	assert.equal(rollbackBody.gate.status, 'pass');
	assert.equal(targetContent(root), ORIGINAL_APPLICATION_YAML, 'rollback must restore the file byte-identical to the original');

	// pass again (smaller input set) after rollback -- not stale, not awaiting_disposition
	const afterRollbackStatus = JSON.parse(run(['verify', '--feature', '001-widget-management', '--json'], root).stdout);
	assert.equal(afterRollbackStatus.gates.find((g) => g.gate === 'patch_transactions').status, 'pass');

	const recheckAgain = JSON.parse(run(['stack', 'apply', '--choice', 'ngrok', '--json'], root).stdout);
	assert.equal(recheckAgain.configChecks[0].status, 'needs-manual-patch');
});

test('e2e: rolling back an already-rolled-back transaction is refused', () => {
	const root = buildFixtureRepo();
	initFeature(root);
	const txn = JSON.parse(run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root).stdout);
	run(['patch', 'approve', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'x'], root);
	run(['patch', 'apply', '--feature', '001-widget-management', '--transaction', txn.transaction_id], root);
	assert.equal(run(['patch', 'rollback', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'x'], root).code, 0);

	const secondRollback = run(['patch', 'rollback', '--feature', '001-widget-management', '--transaction', txn.transaction_id, '--reason', 'x'], root);
	assert.equal(secondRollback.code, 14);
	assert.match(secondRollback.stderr, /is "rolled_back", not "applied"/);
});

// D-patch-transactions: an unrelated flow-collection line elsewhere confirmed live to get
// collaterally reformatted by yaml's own Document API -- propose must refuse outright, never
// silently ship the reformatting, matching test/config-apply.test.mjs's own unit-level proof of
// the same hazard.
test('e2e: propose refuses outright when applying the edit would collaterally reformat an unrelated line', () => {
	const root = buildFixtureRepo({ applicationYaml: `${ORIGINAL_APPLICATION_YAML}flow-list: [a, b, c]   \n` });
	initFeature(root);
	const propose = run(['patch', 'propose', '--feature', '001-widget-management', '--choice', 'ngrok', '--target', APPLICATION_YAML_REL, '--json'], root);
	assert.equal(propose.code, 14);
	assert.match(propose.stderr, /would also change line\(s\).*outside the target key/);
	assert.equal(targetContent(root), `${ORIGINAL_APPLICATION_YAML}flow-list: [a, b, c]   \n`, 'a refused propose must never write anything');
});
