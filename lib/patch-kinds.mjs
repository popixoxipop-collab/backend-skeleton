// D-ddl-apply: the single, shared per-kind dispatch table for lib/patch-transactions.mjs's
// propose/approve/apply/rollback lifecycle -- imported by both bin/bskel.mjs (CLI) and
// lib/http-server.mjs (the new DDL routes), so there is exactly one copy of "which planner/
// executor goes with which kind" (matching D-http-serving-layer's own "no second copy of business
// logic" rule). Before this module existed, bin/bskel.mjs's cmdPatchPropose and
// replanFromTransaction both hardcoded a direct call to planConfigApply() -- this generalizes that
// into a real lookup, without lib/patch-transactions.mjs's own engine ever importing a kind-specific
// module or branching on `kind` itself.
import { loadCatalogEntry } from '../stack/apply.mjs';
import { planConfigApply, executeConfigApply, executeConfigRollback } from '../stack/config-apply.mjs';
import { planDdlApply, executeDdlApply, executeDdlRollback } from '../scanners/db/ddl-apply.mjs';

const PATCH_KINDS = {
	'config-apply': {
		// params: {choice, target}. planFresh loads the catalog entry itself (never trusts a stored
		// plan) so a catalog change is caught here too, not just by the engine's own region_hash
		// TOCTOU check.
		planFresh: (root, params) => planConfigApply(root, loadCatalogEntry(params.choice), params.target),
		paramsFromTxn: (txn) => ({ choice: txn.source.choice, target: txn.target.file }),
		apply: executeConfigApply,
		rollback: executeConfigRollback,
	},
	'ddl-apply': {
		// params: {databaseUrlEnv, schema, sqlText}.
		planFresh: (root, params) => planDdlApply(root, params),
		paramsFromTxn: (txn) => ({ databaseUrlEnv: txn.source.database_url_env, schema: txn.source.schema, sqlText: txn.target.sql_text }),
		apply: executeDdlApply,
		rollback: executeDdlRollback,
	},
};

export const PATCH_KIND_NAMES = Object.freeze(Object.keys(PATCH_KINDS));

export function getPatchKind(kind) {
	const entry = PATCH_KINDS[kind];
	if (!entry) throw new Error(`unknown patch-transaction kind "${kind}" -- known kinds: ${PATCH_KIND_NAMES.join(', ')}`);
	return entry;
}

// Re-runs the SAME kind's planner fresh from the transaction's own recorded source/target --
// never trusts the stored plan -- so a stale preimage (the target moved since propose/approve) is
// caught by the engine's own region_hash comparison, AND the underlying reference (a catalog
// choice; a live DB connection) is re-validated as still resolving at all, in case IT changed.
export async function replanTransaction(root, txn) {
	const kind = getPatchKind(txn.kind);
	return kind.planFresh(root, kind.paramsFromTxn(txn));
}
