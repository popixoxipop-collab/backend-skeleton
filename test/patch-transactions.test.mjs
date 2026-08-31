// Pure lifecycle tests for lib/patch-transactions.mjs -- the general, kind-agnostic
// propose/approve/apply/rollback primitive. Uses a hand-built fake "kindPlan" shape (matching
// exactly what stack/config-apply.mjs's planConfigApply() returns) rather than going through a
// real YAML fixture, since this file is testing the TRANSACTION lifecycle itself, independent of
// any one kind -- see test/config-apply.test.mjs for the config-apply kind planner's own tests,
// and test/patch-config-apply-cli.test.mjs for the full real-CLI, real-YAML end-to-end sequence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256String, sha256File } from '../lib/fsutil.mjs';
import {
	transactionsDir, blobsDir, transactionPath, blobPath, saveBlob, readBlob,
	loadTransaction, saveTransaction, listTransactions,
	proposeTransaction, approveTransaction, applyTransaction, rollbackTransaction,
} from '../lib/patch-transactions.mjs';

const FEATURE_ID = '001-widget-management';
const TARGET_REL = 'config/app.yaml';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-patch-transactions-'));
}

function writeTarget(root, content) {
	const abs = path.join(root, TARGET_REL);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

function fakeKindPlan(originalContent, renderedContent, overrides = {}) {
	return {
		target: { file: TARGET_REL, key_path: ['a', 'b'] },
		preimage: { region_hash: sha256String(originalContent.trim()), file_hash: sha256String(originalContent) },
		current_value: 'old', proposed_value: 'new',
		postcondition: { kind: 'regex-match', pattern: 'new' },
		originalContent, renderedContent,
		...overrides,
	};
}

test('saveBlob: identical content saved twice produces one file at the same path (content-addressed dedup)', () => {
	const root = tmpRoot();
	const h1 = saveBlob(root, FEATURE_ID, 'hello world');
	const h2 = saveBlob(root, FEATURE_ID, 'hello world');
	assert.equal(h1, h2);
	assert.equal(fs.readdirSync(blobsDir(root, FEATURE_ID)).length, 1);
	assert.equal(readBlob(root, FEATURE_ID, h1), 'hello world');
});

test('saveTransaction refuses a document that violates the schema (e.g. missing preimage)', () => {
	const root = tmpRoot();
	const invalid = { schema: 'sbf.patch-transaction/1', transaction_id: 'pt-x', feature_id: FEATURE_ID, kind: 'config-apply', status: 'proposed', created_at: new Date().toISOString() };
	assert.throws(() => saveTransaction(root, FEATURE_ID, invalid), /does not match schemas\/patch-transaction\.schema\.json|refusing to write an invalid/);
});

test('loadTransaction returns null for a transaction id that was never written', () => {
	const root = tmpRoot();
	assert.equal(loadTransaction(root, FEATURE_ID, 'pt-does-not-exist'), null);
});

test('listTransactions returns an empty array when the directory was never created', () => {
	const root = tmpRoot();
	assert.deepEqual(listTransactions(root, FEATURE_ID), []);
});

test('full lifecycle: propose -> approve -> apply -> rollback, each stage advancing status and writing the expected side effects', () => {
	const root = tmpRoot();
	writeTarget(root, 'original content\n');
	const plan = fakeKindPlan('original content\n', 'edited content\n');

	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	assert.equal(proposed.status, 'proposed');
	assert.equal(proposed.source.choice, 'ngrok');
	assert.ok(fs.existsSync(blobPath(root, FEATURE_ID, proposed.preimage.file_hash)), 'rollback blob must exist before any edit is applied');
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'original content\n', 'propose alone must never touch the real target file');

	const approved = approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'because', plan);
	assert.equal(approved.status, 'approved');
	assert.deepEqual(approved.approval.reason, 'because');

	const applied = applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan);
	assert.equal(applied.status, 'applied');
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'edited content\n');
	assert.equal(applied.apply.postimage_file_hash, sha256String('edited content\n'));

	const rolledBack = rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, 'undo');
	assert.equal(rolledBack.status, 'rolled_back');
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'original content\n', 'rollback must restore the file byte-for-byte');

	assert.equal(listTransactions(root, FEATURE_ID).length, 1);
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'rolled_back');
});

test('approve requires a reason', () => {
	const root = tmpRoot();
	writeTarget(root, 'x\n');
	const plan = fakeKindPlan('x\n', 'y\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	assert.throws(() => approveTransaction(root, FEATURE_ID, proposed.transaction_id, '', plan), /requires a reason/);
	assert.throws(() => approveTransaction(root, FEATURE_ID, proposed.transaction_id, '   ', plan), /requires a reason/);
});

test('rollback requires a reason', () => {
	const root = tmpRoot();
	writeTarget(root, 'x\n');
	const plan = fakeKindPlan('x\n', 'y\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);
	applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan);
	assert.throws(() => rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, ''), /requires a reason/);
});

// Fail-closed #1: the target changed between propose and approve.
test('approve refuses (and does not advance status) when the target has changed since propose', () => {
	const root = tmpRoot();
	writeTarget(root, 'original\n');
	const proposedPlan = fakeKindPlan('original\n', 'edited\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', proposedPlan, { choice: 'ngrok' });

	const driftedPlan = fakeKindPlan('someone changed this\n', 'edited\n'); // different region_hash
	assert.throws(() => approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', driftedPlan), /has changed since it was proposed/);
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'proposed', 'a refused approve must not silently advance the status');
});

// Fail-closed #2: the target changed between approve and apply (the TOCTOU case this whole design
// exists to close) -- confirmed here at the pure-function level; test/patch-config-apply-cli.test.
// mjs proves the identical thing through the real CLI against a real hand-edited file.
test('apply refuses (and never writes the target) when the target has changed since approve', () => {
	const root = tmpRoot();
	writeTarget(root, 'original\n');
	const plan = fakeKindPlan('original\n', 'edited\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);

	fs.writeFileSync(path.join(root, TARGET_REL), 'someone changed this between approve and apply\n');
	const driftedPlan = fakeKindPlan('someone changed this between approve and apply\n', 'edited\n');
	assert.throws(() => applyTransaction(root, FEATURE_ID, proposed.transaction_id, driftedPlan), /has changed since it was proposed/);
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'someone changed this between approve and apply\n', 'a refused apply must leave the file exactly as the human left it');
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'approved', 'a refused apply must not silently advance the status');
});

test('apply refuses a transaction that was never approved', () => {
	const root = tmpRoot();
	writeTarget(root, 'x\n');
	const plan = fakeKindPlan('x\n', 'y\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	assert.throws(() => applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan), /is "proposed", not "approved"/);
});

// Fail-closed #3: the target changed AFTER a successful apply, before rollback was requested.
test('rollback refuses (without --force) when the file has changed since apply, and never touches it', () => {
	const root = tmpRoot();
	writeTarget(root, 'original\n');
	const plan = fakeKindPlan('original\n', 'edited\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);
	applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan);

	fs.writeFileSync(path.join(root, TARGET_REL), 'a human edited the applied file afterward\n');
	assert.throws(() => rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, 'undo'), /has changed since transaction .* applied/);
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'a human edited the applied file afterward\n');
	assert.equal(loadTransaction(root, FEATURE_ID, proposed.transaction_id).status, 'applied');
});

test('rollback --force overrides the diverged-file refusal, restores the original anyway, and records forced:true', () => {
	const root = tmpRoot();
	writeTarget(root, 'original\n');
	const plan = fakeKindPlan('original\n', 'edited\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	approveTransaction(root, FEATURE_ID, proposed.transaction_id, 'ok', plan);
	applyTransaction(root, FEATURE_ID, proposed.transaction_id, plan);

	fs.writeFileSync(path.join(root, TARGET_REL), 'a human edited the applied file afterward\n');
	const rolledBack = rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, 'forced undo', { force: true });
	assert.equal(rolledBack.status, 'rolled_back');
	assert.equal(rolledBack.rollback.forced, true);
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), 'original\n');
});

test('rollback refuses a transaction that was never applied', () => {
	const root = tmpRoot();
	writeTarget(root, 'x\n');
	const plan = fakeKindPlan('x\n', 'y\n');
	const proposed = proposeTransaction(root, FEATURE_ID, 'config-apply', plan, { choice: 'ngrok' });
	assert.throws(() => rollbackTransaction(root, FEATURE_ID, proposed.transaction_id, 'undo'), /is "proposed", not "applied"/);
});

test('transactionPath/blobPath stay within specs/<featureId>/patch-transactions/', () => {
	const root = tmpRoot();
	assert.ok(transactionPath(root, FEATURE_ID, 'pt-x').startsWith(transactionsDir(root, FEATURE_ID)));
	assert.ok(blobPath(root, FEATURE_ID, 'abc').startsWith(blobsDir(root, FEATURE_ID)));
});
