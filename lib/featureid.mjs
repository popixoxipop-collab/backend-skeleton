import fs from 'node:fs';

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

// P2b (D-greenfield-parameters): exported (was module-private) so `new/params.mjs`'s
// `--artifact-id` validator reuses the exact grammar `--slug` already enforces, rather than
// declaring a second, subtly different one for the value `--artifact-id` defaults to.
export const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// D-security-3: `gate require/force/show` accept `--feature <anything>` and pass it straight
// into a path.join() (see lib/state.mjs) -- every OTHER feature-scoped command validates via
// requireValidFeatureId() first, but the three gate commands originally didn't, so
// `--feature ../../evil` could read/write a state file outside .sbf/. This accepts either the
// repo-scoped sentinel or a real feature_id, so gate commands (the only ones that operate on
// both scopes) can validate too. Found by the Codex security review.
export function requireValidFeatureOrRepoId(id, repoSentinel) {
	if (id === repoSentinel) return id;
	return requireValidFeatureId(id);
}

export function requireValidSlug(slug) {
	if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
		throw new Error(`invalid slug "${slug}" -- expected lowercase-hyphenated words (e.g. organization-management)`);
	}
	return slug;
}

// Next NNN- prefix, one past whatever's already under specs/ (spec-kit's own numbering
// convention -- reused rather than inventing a second one) -- 001 if specs/ doesn't exist yet.
export function nextFeatureNumber(specsDir) {
	if (!fs.existsSync(specsDir)) return '001';
	const nums = fs.readdirSync(specsDir)
		.map((name) => name.match(/^([0-9]{3})-/))
		.filter(Boolean)
		.map((m) => Number.parseInt(m[1], 10));
	const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
	return String(next).padStart(3, '0');
}
