// A3 (D-patch-strategy): the explicit human gate before ANY patchField() switch-case gets
// generated. Mirrors contracts/completeness.mjs's loadResolution()/saveResolution() shape
// exactly (same "documentation-file, validated at both read and write, no built-in locking of its
// own" contract) -- feature-scoped like contract-resolution.schema.json, not repo-scoped like
// .sbf/handles-manifest.json, because approving a field's patch strategy is a human DECISION made
// in the context of one feature's actual need, not a file-safety fact about the repo. Per-field,
// never a wildcard -- matches `bskel contract waive`'s own "no --all covering future warnings"
// precedent (A5): approving Organization.name today must never silently also approve a field
// added to that DTO next month.
import { readJsonIfExists, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';

const APPROVALS_SCHEMA = 'sbf.patch-approvals/1';

export function patchApprovalsPath(root, featureId) {
	return specPath(root, featureId, 'handles', 'patch-approvals.json');
}

export function loadPatchApprovals(root, featureId) {
	const path = patchApprovalsPath(root, featureId);
	const parsed = readJsonIfExists(path);
	if (parsed === null) {
		return { schema: APPROVALS_SCHEMA, feature_id: featureId, approvals: [] };
	}
	const { ok, errors } = validateAgainstSchema('patch-approvals.schema.json', parsed);
	if (!ok) {
		throw new Error(`${path}: does not match schemas/patch-approvals.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function savePatchApprovals(root, featureId, approvals) {
	const { ok, errors } = validateAgainstSchema('patch-approvals.schema.json', approvals);
	if (!ok) {
		throw new Error(`refusing to write invalid patch approvals for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(patchApprovalsPath(root, featureId), `${JSON.stringify(approvals, null, 2)}\n`);
	return approvals;
}

export function approvalKey(resource, field) {
	return `${resource}::${field}`;
}

// The single lookup emit.mjs's codegen needs: is {resource, field} approved, and if so for
// exactly which strategy? A stale approval (the DTO changed since approval, the classifier now
// computes a different bucket) must never silently generate against a strategy that no longer
// matches reality -- callers compare the returned strategy against the CURRENT classifier output
// themselves and fall back to the stub on any mismatch (fail-closed, same principle as
// D-resolver-scope's willGenerateResolver check).
export function approvedStrategyFor(approvals, resource, field) {
	const key = approvalKey(resource, field);
	const match = (approvals.approvals ?? []).find((a) => approvalKey(a.resource, a.field) === key);
	return match ? match.strategy : null;
}
