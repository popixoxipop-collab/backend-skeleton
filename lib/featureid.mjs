export const FEATURE_ID_RE = /^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidFeatureId(id) {
	return typeof id === 'string' && FEATURE_ID_RE.test(id);
}

export function requireValidFeatureId(id) {
	if (!isValidFeatureId(id)) {
		throw new Error(`invalid feature_id "${id}" -- expected NNN-slug-words (e.g. 001-organization-management)`);
	}
	return id;
}

// The searchable words a feature_id itself contributes to a scan's term set, independent of
// whatever spec.md may or may not say yet (scan can run before a spec exists).
export function slugWords(featureId) {
	return featureId.replace(/^[0-9]{3}-/, '').split('-').filter(Boolean);
}
