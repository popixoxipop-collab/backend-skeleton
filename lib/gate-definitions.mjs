// S1: the single declared source of what a gate IS -- its scope, whether `bskel verify` treats
// it as required, and how its token is recomputed from current repo state.
//
// WHY this module exists: before it, `bin/bskel.mjs`'s GATE_RECOMPUTERS (which gates get
// written and how their tokens are computed) and `lib/verify.mjs`'s GATE_SPECS (which gates
// `verify` reads and aggregates) were two hand-maintained lists. They drifted: `stack` was
// registered in GATE_RECOMPUTERS but missing from GATE_SPECS, so `stack apply` could pass a
// repo-scoped `stack` gate that `bskel verify` would never even look at. One list, consumed by
// both the write side (lib/gates.mjs's passNamedGate/awaitNamedGateDisposition) and the read
// side (lib/verify.mjs's collectGateStatuses), makes that specific class of drift structurally
// impossible -- there is no second list left to fall out of sync.
//
// Each gate's token must be computed from the SAME function both when the gate is written
// (pass) and when it's re-verified (require) -- otherwise "require" degenerates into comparing
// stored data against itself, which can never detect drift. If HEAD moved, or spec.md changed,
// or anything else in the gate's declared input set changed, the token mismatches and the gate
// reports `stale` -- it cannot be satisfied once and then silently drift out of sync with
// reality.
import { headSha, localDefaultBranch } from './repo.mjs';
import { sha256File } from './fsutil.mjs';
import { specPath, sbfPath } from './paths.mjs';

// The preflight and stack gates are repo-scoped, not feature-scoped -- preflight runs before a
// feature_id exists at all, and a stack choice is a project-wide decision, not per-feature.
// Both are stored under the same per-feature state-file mechanism using this reserved id.
export const REPO_GATE_ID = '_repo';

export const SCOPE = Object.freeze({ REPO: 'repo', FEATURE: 'feature' });

// required               : `not_run` or `stale` (or anything else short of `pass`) always fails
//                          `bskel verify`'s overall verdict.
// required-when-present  : a gate that's never been run does not block verify (not every
//                          feature needs UUID handles or a stack-choice decision) -- but once it
//                          HAS run, every non-pass status (stale, awaiting_disposition, ...) is
//                          still blocking. "Optional" means "not every feature needs this", not
//                          "once run, its correctness stops mattering".
export const VERIFY_POLICY = Object.freeze({
	REQUIRED: 'required',
	REQUIRED_WHEN_PRESENT: 'required-when-present',
});

export const GATE_DEFINITIONS = Object.freeze({
	preflight: {
		name: 'preflight',
		scope: SCOPE.REPO,
		verifyPolicy: VERIFY_POLICY.REQUIRED,
		recompute: (root) => ({ head_sha: headSha(root), default_branch: localDefaultBranch(root) }),
	},
	// The scan gate's token covers head_sha (has the codebase moved since scanning?), the scan
	// report's own content hash (has disposition/re-scan changed it?), and spec.md's content
	// hash if it exists yet (scan can run before a spec is written, so this may be null).
	scan: {
		name: 'scan',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED,
		recompute: (root, featureId) => ({
			head_sha: headSha(root),
			scan_report_hash: sha256File(specPath(root, featureId, 'brownfield-scan.json')),
			spec_hash: sha256File(specPath(root, featureId, 'spec.md')),
		}),
	},
	// The contract gate's token covers the emitted contract file's own hash (re-emitting after
	// a re-scan invalidates it) and head_sha -- NOT the scan report's hash directly, since the
	// contract is a derived artifact; if the scan changes but the contract hasn't been
	// re-emitted, that should surface as "contract is out of date with scan", which is a
	// judgment call for `bskel contract emit` to re-run, not something require silently papers
	// over by trusting the old contract.
	//
	// A5: also covers the resolution (waiver) file's hash. A waiver is a human decision that lets
	// a `partial` contract's outstanding warnings stop blocking `bskel verify` -- if that file is
	// deleted or hand-edited, the gate must go stale the same way it would if the contract itself
	// were tampered with; a gate that stays green after its waivers disappear underneath it is
	// exactly the "pass in name only" failure mode this whole gate mechanism exists to prevent
	// (see D1 in DECISIONS.md). `sha256File` returns null when the file doesn't exist, which is
	// the common no-waivers case -- stable and fine as a token input.
	contract: {
		name: 'contract',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED,
		recompute: (root, featureId) => ({
			head_sha: headSha(root),
			contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
			resolution_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.resolution.json`)),
		}),
	},
	// Staleness = the generated Java (or the contract it was generated from) has moved since
	// emit -- NOT "does the migration still match the DB schema" (unknowable without a live DB
	// connection this tool deliberately never opens on its own, see D-migration-scope). Note
	// this token does NOT cover specs/<id>/handles/migration.sql itself -- lib/verify.mjs's
	// checkArtifacts() is the only thing that notices if that file goes missing (S6).
	handles: {
		name: 'handles',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root, featureId) => ({
			head_sha: headSha(root),
			contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
		}),
	},
	// Repo-scoped like preflight (a stack choice is a project-wide decision, not per-feature).
	// Staleness here means "the applied files or the choice-of-catalog-entry are gone/changed",
	// not "re-verify the tunnel is currently running" -- that's a runtime concern, not a gate.
	stack: {
		name: 'stack',
		scope: SCOPE.REPO,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root) => ({ head_sha: headSha(root), stack_record_hash: sha256File(sbfPath(root, 'stack.json')) }),
	},
});

// Explicit order (= workflow order), not `Object.keys(GATE_DEFINITIONS)` insertion order --
// test/gate-definitions.test.mjs asserts this stays exactly in sync with GATE_DEFINITIONS' own
// key set, so a gate added to one and not the other fails loudly instead of silently vanishing
// from `bskel verify` the way `stack` did before this module existed.
export const GATE_NAMES = Object.freeze(['preflight', 'scan', 'contract', 'handles', 'stack']);

export function getGateDefinition(name) {
	return Object.hasOwn(GATE_DEFINITIONS, name) ? GATE_DEFINITIONS[name] : null;
}

// The typo-defense point. Before this, `bskel gate require scna` silently reported `not_run`
// (exit 2) -- indistinguishable from "a real gate that just hasn't run yet" -- so a typo reads
// as "not done" instead of "this gate doesn't exist", and a caller could wait forever for a
// gate that will never pass because it was never real.
export function requireGateDefinition(name) {
	const def = getGateDefinition(name);
	if (!def) {
		throw new Error(`unknown gate "${name}" -- known gates: ${GATE_NAMES.join(', ')}`);
	}
	return def;
}

// Scope comes from the definition, not from whatever a caller happened to pass as --feature --
// closes off the class of bug where a repo-scoped gate's write/read path depends on the caller
// remembering to pass (or not pass) the right --feature value.
export function gateScopeId(name, featureId) {
	return requireGateDefinition(name).scope === SCOPE.REPO ? REPO_GATE_ID : featureId;
}

export function gateInputs(root, name, featureId) {
	return requireGateDefinition(name).recompute(root, featureId);
}
