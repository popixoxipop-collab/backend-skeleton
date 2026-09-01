// D-ddl-apply: lib/patch-kinds.mjs's dispatch table, and lib/patch-transactions.mjs's
// applyTransaction()/rollbackTransaction() executor-injection contract -- proven with a FAKE
// executor (not a real kind's), so this file never needs a live DB or a real YAML fixture to
// exercise the engine's own contract. See test/ddl-apply-plan.test.mjs for the ddl-apply kind's own
// pure allowlist/classification logic, and test/patch-transactions.test.mjs for the config-apply
// kind's full real lifecycle (now going through the real stack/config-apply.mjs executors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256String } from '../lib/fsutil.mjs';
import { getPatchKind, replanTransaction, PATCH_KIND_NAMES } from '../lib/patch-kinds.mjs';
import { proposeTransaction, approveTransaction, applyTransaction, rollbackTransaction, loadTransaction } from '../lib/patch-transactions.mjs';

const FEATURE_ID = '001-widget-management';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-kinds-'));
}

function fakeKindPlan(originalContent, renderedContent) {
	return {
		target: { file: 'config/app.yaml', key_path: ['a', 'b'] },
		preimage: { region_hash: sha256String(originalContent.trim()), file_hash: sha256String(originalContent) },
		current_value: 'old', proposed_value: 'new',
		postcondition: { kind: 'regex-match', pattern: 'new' },
		originalContent, renderedContent,
	};
}

test('PATCH_KIND_NAMES lists exactly config-apply and ddl-apply', () => {
	assert.deepEqual([...PATCH_KIND_NAMES].sort(), ['config-apply', 'ddl-apply']);
});

test('getPatchKind returns a {planFresh, paramsFromTxn, apply, rollback} shape for every known kind', () => {
	for (const kind of PATCH_KIND_NAMES) {
		const entry = getPatchKind(kind);
		assert.equal(typeof entry.planFresh, 'function');
		assert.equal(typeof entry.paramsFromTxn, 'function');
		assert.equal(typeof entry.apply, 'function');
		assert.equal(typeof entry.rollback, 'function');
	}
});

test('getPatchKind throws a clear error naming known kinds for an unrecognized kind', () => {
	assert.throws(() => getPatchKind('nonsense'), /unknown patch-transaction kind "nonsense"/);
	assert.throws(() => getPatchKind('nonsense'), /config-apply/);
	assert.throws(() => getPatchKind('nonsense'), /ddl-apply/);
});

test('getPatchKind("ddl-apply").paramsFromTxn extracts {databaseUrlEnv, schema, sqlText} from a transaction record shape', () => {
	const txn = { source: { database_url_env: 'MY_DB_URL', schema: 'public' }, target: { sql_text: 'CREATE TABLE t (id uuid);' } };
	assert.deepEqual(
		getPatchKind('ddl-apply').paramsFromTxn(txn),
		{ databaseUrlEnv: 'MY_DB_URL', schema: 'public', sqlText: 'CREATE TABLE t (id uuid);' },
	);
});

test('getPatchKind("config-apply").paramsFromTxn extracts {choice, target} from a transaction record shape', () => {
	const txn = { source: { choice: 'ngrok' }, target: { file: 'config/app.yaml' } };
	assert.deepEqual(getPatchKind('config-apply').paramsFromTxn(txn), { choice: 'ngrok', target: 'config/app.yaml' });
});

// Executor-injection contract: applyTransaction()/rollbackTransaction() merge whatever the
// injected executor returns into txn.apply/txn.rollback (alongside `at`), and never hardcode a
// file-write mutation themselves.
test('applyTransaction merges the injected executor\'s return value into txn.apply', async () => {
	const root = tmpRoot();
	const plan = fakeKindPlan('a\n', 'b\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);

	const fakeExecutor = async () => ({ postimage_file_hash: 'fake-hash-from-executor' });
	const applied = await applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan, fakeExecutor);
	assert.equal(applied.status, 'applied');
	assert.equal(applied.apply.postimage_file_hash, 'fake-hash-from-executor');
	assert.ok(applied.apply.at);
});

test('rollbackTransaction merges the injected executor\'s return value into txn.rollback', async () => {
	const root = tmpRoot();
	const plan = fakeKindPlan('a\n', 'b\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);
	await applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan, async () => ({ postimage_file_hash: 'x' }));

	const rolledBack = await rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, 'undo', {}, async () => ({}));
	assert.equal(rolledBack.status, 'rolled_back');
});

// D-ddl-apply: rollback of an APPLIED ddl-apply transaction is refused outright, always -- proven
// through the real dispatch table (getPatchKind('ddl-apply').rollback), not a hand-rolled
// stand-in, so an accidental future relaxation of executeDdlRollback() would be caught here.
test('getPatchKind("ddl-apply").rollback always rejects, naming the real mitigation', async () => {
	await assert.rejects(getPatchKind('ddl-apply').rollback(), /rollback is not supported for kind "ddl-apply"/);
	await assert.rejects(getPatchKind('ddl-apply').rollback(), /propose a new forward ddl-apply transaction/);
});

test('replanTransaction dispatches to the recorded kind\'s planFresh with paramsFromTxn(txn)', async () => {
	const root = tmpRoot();
	const targetRel = 'src/main/resources/application.yaml';
	fs.mkdirSync(path.dirname(path.join(root, targetRel)), { recursive: true });
	fs.writeFileSync(path.join(root, targetRel), 'auth:\n  login:\n    allowed-origins: a.example.com\n');
	const txn = { kind: 'config-apply', source: { choice: 'ngrok' }, target: { file: targetRel, key_path: ['auth', 'login', 'allowed-origins'] } };
	const plan = await replanTransaction(root, txn);
	assert.equal(plan.target.file, targetRel);
	assert.ok(plan.preimage.file_hash);
});
