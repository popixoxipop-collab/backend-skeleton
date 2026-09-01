// D-patch-transactions: the general, kind-agnostic content-addressed patch-transaction primitive.
// Generalizes lib/patch-approvals.mjs's (A3/D-patch-strategy) per-{resource,field} approval shape
// into a real lifecycle (propose -> approve -> apply -> rollback) with preimage-hash verification
// re-checked at every step and content-addressed rollback material saved BEFORE any edit is ever
// applied. Slice 1 wires exactly one `kind` ("config-apply", stack/config-apply.mjs) -- a later
// slice can add a second kind without touching this state machine at all.
//
// One file per transaction (specs/<featureId>/patch-transactions/<transaction_id>.json), not one
// growing array like patch-approvals.json -- each record carries real state transitions and
// references a potentially large rollback blob, so appending to one shared JSON array under a
// lock on every transition would be worse for both concurrency and the "content-addressed"
// framing this feature is named for. Blobs (specs/<featureId>/patch-transactions/blobs/<sha256>.
// blob) dedupe automatically: two transactions proposed against the same preimage produce the
// identical filename.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonIfExists, writeFileAtomic, sha256String } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { withLockSync, withLockAsync } from './lock.mjs';

const TRANSACTION_SCHEMA = 'sbf.patch-transaction/1';

export function transactionsDir(root, featureId) {
	return specPath(root, featureId, 'patch-transactions');
}

export function blobsDir(root, featureId) {
	return path.join(transactionsDir(root, featureId), 'blobs');
}

export function transactionPath(root, featureId, transactionId) {
	return path.join(transactionsDir(root, featureId), `${transactionId}.json`);
}

export function blobPath(root, featureId, hash) {
	return path.join(blobsDir(root, featureId), `${hash}.blob`);
}

export function newTransactionId() {
	return `pt-${randomUUID()}`;
}

// Idempotent -- identical content always produces the identical path, so re-saving the same
// preimage (e.g. a second propose against a target nothing has touched since) is a harmless no-op
// write, never a duplicate.
export function saveBlob(root, featureId, content) {
	const hash = sha256String(content);
	writeFileAtomic(blobPath(root, featureId, hash), content);
	return hash;
}

export function readBlob(root, featureId, hash) {
	return fs.readFileSync(blobPath(root, featureId, hash), 'utf8');
}

export function loadTransaction(root, featureId, transactionId) {
	const p = transactionPath(root, featureId, transactionId);
	const parsed = readJsonIfExists(p);
	if (parsed === null) return null;
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', parsed);
	if (!ok) {
		throw new Error(`${p}: does not match schemas/patch-transaction.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveTransaction(root, featureId, txn) {
	const { ok, errors } = validateAgainstSchema('patch-transaction.schema.json', txn);
	if (!ok) {
		throw new Error(`refusing to write an invalid patch transaction for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(transactionPath(root, featureId, txn.transaction_id), `${JSON.stringify(txn, null, 2)}\n`);
	return txn;
}

export function listTransactions(root, featureId) {
	const dir = transactionsDir(root, featureId);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => loadTransaction(root, featureId, name.slice(0, -'.json'.length)))
		.filter(Boolean)
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// `kindPlan` is whatever a kind-specific planner (e.g. stack/config-apply.mjs's planConfigApply())
// returns -- this module never inspects `kind`-specific fields beyond the ones every plan must
// carry (target/preimage/proposed_value/postcondition/originalContent/renderedContent).
// `source` is kind-specific, opaque bookkeeping this module never inspects -- for kind
// "config-apply" it's `{choice}`, the stack catalog choice id needed to re-locate the same
// config_check/apply block at approve/apply time (the record's own target.file alone is not
// enough, since a catalog choice is what the CLI's --choice flag resolves, not stored per-file).
export function proposeTransaction(root, featureId, kind, kindPlan, source) {
	return withLockSync(root, 'state', () => {
		const transactionId = newTransactionId();
		// The blob is keyed by its OWN content hash, never trusted from kindPlan.preimage.file_hash
		// blindly -- if a planner ever computed that field differently than a plain sha256 of the
		// same bytes, silently trusting it here would save a rollback blob under the WRONG filename,
		// making rollback impossible later. Fail loudly instead; this should never actually fire.
		const blobHash = saveBlob(root, featureId, kindPlan.originalContent);
		if (blobHash !== kindPlan.preimage.file_hash) {
			throw new Error(`internal error: kindPlan.preimage.file_hash ("${kindPlan.preimage.file_hash}") does not match the original content's own hash ("${blobHash}") -- refusing to propose a transaction whose rollback blob would be unrecoverable`);
		}
		const txn = {
			schema: TRANSACTION_SCHEMA,
			transaction_id: transactionId,
			feature_id: featureId,
			kind,
			source,
			target: kindPlan.target,
			preimage: kindPlan.preimage,
			current_value: kindPlan.current_value,
			proposed_value: kindPlan.proposed_value,
			postcondition: kindPlan.postcondition,
			status: 'proposed',
			created_at: new Date().toISOString(),
		};
		return saveTransaction(root, featureId, txn);
	});
}

class StaleTransactionError extends Error {
	constructor(message) {
		super(message);
		this.name = 'StaleTransactionError';
	}
}

function requireFreshPreimage(txn, freshKindPlan) {
	if (freshKindPlan.preimage.region_hash !== txn.preimage.region_hash) {
		throw new StaleTransactionError(
			`transaction "${txn.transaction_id}"'s target has changed since it was proposed -- re-propose it against the current content`,
		);
	}
}

// `freshKindPlan` MUST come from re-running the same kind's planner against the CURRENT on-disk
// state, never from the stored transaction record -- this is what makes "re-verify preimage at
// every step" real rather than assumed.
export function approveTransaction(root, featureId, transactionId, reason, freshKindPlan) {
	if (!reason || !reason.trim()) {
		throw new Error('approving a patch transaction requires a reason -- every approval must be auditable');
	}
	return withLockSync(root, 'state', () => {
		const txn = loadTransaction(root, featureId, transactionId);
		if (!txn) throw new Error(`no patch transaction "${transactionId}" for feature "${featureId}"`);
		requireFreshPreimage(txn, freshKindPlan);
		txn.approval = { reason, at: new Date().toISOString() };
		txn.status = 'approved';
		return saveTransaction(root, featureId, txn);
	});
}

// No --force escape here (mirrors cmdHandlesPatchApprove's permanent "a stale approval is
// rejected outright, never bypassed" precedent) -- a stale forward edit's collateral effects have
// never been re-verified, unlike a rollback restoring a known-good, git-recoverable prior state.
//
// D-ddl-apply: `executeApply(root, featureId, txn, freshKindPlan)` is an INJECTED, kind-specific
// async function that performs the actual mutation and returns the fields to merge into `txn.apply`
// (alongside `at`, added here uniformly). This module still never imports a kind-specific module
// and never branches on `kind` -- it only calls whatever executor its caller (lib/patch-kinds.mjs)
// injected, so the "kind-agnostic" framing stays literally true; this is dependency injection, not
// a switch statement. Uses withLockAsync, not withLockSync -- a naive `async` callback passed to
// withLockSync would release the lock the instant the callback RETURNS a Promise, not once that
// Promise RESOLVES, releasing the lock before a live DB write (or any other async executor) has
// actually finished. withLockAsync's `try { return await fn() } finally { ... }` makes that
// ordering bug structurally impossible.
export async function applyTransaction(root, featureId, transactionId, freshKindPlan, executeApply) {
	return withLockAsync(root, 'state', async () => {
		const txn = loadTransaction(root, featureId, transactionId);
		if (!txn) throw new Error(`no patch transaction "${transactionId}" for feature "${featureId}"`);
		if (txn.status !== 'approved') {
			throw new Error(`transaction "${transactionId}" is "${txn.status}", not "approved" -- approve it first`);
		}
		requireFreshPreimage(txn, freshKindPlan);
		const applyResult = await executeApply(root, featureId, txn, freshKindPlan);
		txn.apply = { at: new Date().toISOString(), ...applyResult };
		txn.status = 'applied';
		return saveTransaction(root, featureId, txn);
	});
}

// `executeRollback(root, featureId, txn, {force})` is the injected, kind-specific async restore --
// for config-apply it re-validates the file-hash drift check and restores from the CAS blob
// exactly as before (moved verbatim, not reimplemented); for ddl-apply it always throws (rollback
// of a live DDL apply is out of scope for Slice 1 -- see scanners/db/ddl-apply.mjs's
// executeDdlRollback). This function itself no longer knows what "restore" means for any kind --
// the drift-check-then-restore logic lives entirely in the executor now.
export async function rollbackTransaction(root, featureId, transactionId, reason, { force = false } = {}, executeRollback) {
	if (!reason || !reason.trim()) {
		throw new Error('rolling back a patch transaction requires a reason -- every rollback must be auditable');
	}
	return withLockAsync(root, 'state', async () => {
		const txn = loadTransaction(root, featureId, transactionId);
		if (!txn) throw new Error(`no patch transaction "${transactionId}" for feature "${featureId}"`);
		if (txn.status !== 'applied') {
			throw new Error(`transaction "${transactionId}" is "${txn.status}", not "applied" -- only an applied transaction can be rolled back`);
		}
		const rollbackResult = await executeRollback(root, featureId, txn, { force });
		txn.rollback = { reason, at: new Date().toISOString(), ...(force ? { forced: true } : {}), ...rollbackResult };
		txn.status = 'rolled_back';
		return saveTransaction(root, featureId, txn);
	});
}
