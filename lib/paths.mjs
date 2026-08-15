// Shared path-building helpers for anything under specs/<feature_id>/ or .sbf/ -- pulled out of
// bin/bskel.mjs so lib/gate-definitions.mjs and lib/verify.mjs don't each grow their own copy
// (that kind of duplication is exactly what let lib/verify.mjs's GATE_SPECS drift out of sync
// with bin/bskel.mjs's GATE_RECOMPUTERS -- see lib/gate-definitions.mjs).
//
// This module only joins paths. It does NOT validate `featureId` -- that's the CLI boundary's
// job (lib/featureid.mjs's requireValidFeatureId/requireValidFeatureOrRepoId), and duplicating
// that check in here would just create a second place for it to go stale.
import path from 'node:path';

export function specDir(root, featureId) {
	return path.join(root, 'specs', featureId);
}

export function specPath(root, featureId, ...segments) {
	return path.join(specDir(root, featureId), ...segments);
}

export function sbfPath(root, ...segments) {
	return path.join(root, '.sbf', ...segments);
}
