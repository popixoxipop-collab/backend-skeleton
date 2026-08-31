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
import path from 'node:path';
import { headSha, localDefaultBranch, remoteTrackingTip } from './repo.mjs';
import { sha256File, fileMode, readJsonIfExists, resolveWithinRoot } from './fsutil.mjs';
import { specPath, sbfPath } from './paths.mjs';
import { ADAPTERS, adapterById } from '../scanners/registry.mjs';
import { loadManifest } from './handles-manifest.mjs';
import { dependenciesPath, resolveClassFile } from './field-dependencies.mjs';

// S2: prefix for stack's per-applied-file input keys -- lib/gates.mjs's diffInputs() compares
// top-level keys only, so a manifest-shaped input (one hash per applied file) has to flatten
// itself into distinctly-named keys here to let a stale report name the exact file that drifted.
const APPLIED_FILE_PREFIX = 'applied_file:';
// S6 (D-verify-integrity): content hashing alone is blind to a chmod-only change -- a
// `chmod -x scripts/dev-tunnel.sh` leaves sha256File byte-identical, so the gate stayed `pass`
// even though the script no longer runs. Tracked as a distinct key (not merged into the content
// hash) so diffInputs() can name it specifically -- "the mode drifted" is a different, more
// actionable report than a generic "stale".
const APPLIED_FILE_MODE_PREFIX = 'applied_file_mode:';
// S2 (D-gate-precision, continued): same flattened-manifest convention as APPLIED_FILE_PREFIX --
// one key per file the adapter actually reads, so diffInputs() can name the exact file that
// changed instead of a generic "stale".
const SOURCE_FILE_PREFIX = 'source_file:';
// S2 (D-gate-precision, part 2): same flattened-manifest convention -- one key per file belonging
// to the DISPOSED module specifically (a narrower set than SOURCE_FILE_PREFIX's whole-adapter
// read-set), so the `contract` gate stops being sensitive to every Java file in the repo.
const MODULE_FILE_PREFIX = 'module_file:';
// D-field-dependency: flattened per-declared-dependency file tokens, one key per DISTINCT
// {feature, resourceType} the feature's own dependencies.json actually references (deduped --
// two fields on the same class collapse to one key, since this gate has no field-level parser and
// would otherwise just repeat the identical file hash N times with zero added diagnostic value).
const TARGET_FIELD_FILE_PREFIX = 'target_field_file:';
const SOURCE_FIELD_FILE_PREFIX = 'source_field_file:';

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
		// D-preflight-freshness (S3): `origin_tip_sha` added alongside (not instead of) `head_sha`/
		// `default_branch` -- D-gate-precision (S2) already decided this gate keeps `head_sha`, and
		// removing it here would break the "a commit stales preflight too" assumption
		// test/contract-cli.test.mjs and test/handles-ownership-cli.test.mjs already depend on.
		// `remoteTrackingTip()` is purely local (`git rev-parse`, no fetch) -- `require` noticing
		// this value moved only means something ELSE already fetched into this repo since the
		// gate last passed; if nothing has, the value is unchanged and this check is a no-op. See
		// D-preflight-freshness in DECISIONS.md for why that limited scope is honest, not a bug.
		recompute: (root) => {
			const defaultBranch = localDefaultBranch(root);
			return { head_sha: headSha(root), default_branch: defaultBranch, origin_tip_sha: remoteTrackingTip(root, defaultBranch) };
		},
		// D-preflight-freshness (S3): the one "freshness policy" slot S1's own catalog entry asked
		// for but never had a gate to fill. 30 minutes is not a guess -- derived from Team-IZ-
		// Backend's actual `origin/develop` commit cadence (109 commits over 35.8 days: p10=3m,
		// p25=25m, median=100m, p75=264m, p90=17h). Treating "P(the remote tip moves within the
		// TTL window)" as an upper bound on "this pass is silently wrong by the time it's used",
		// 30m -> 5.1%, 60m -> 9.4%, 24h -> 59.0% (making a day-long TTL meaningless). Re-derive for
		// any repo with:
		//   git log --first-parent --format=%ct origin/<default> | awk 'NR==1{p=$1;next}
		//   {d=p-$1;if(d>=0)g[n++]=d;p=$1}END{s=0;for(i=0;i<n;i++)s+=g[i];ttl=1800;num=0;
		//   for(i=0;i<n;i++)num+=(g[i]<ttl?g[i]:ttl);printf "P(moved within %dmin)=%.3f\n",
		//   ttl/60,num/s}'
		// See DECISIONS.md's D-preflight-freshness for the full table and reasoning.
		freshness: { defaultMaxAgeMinutes: 30 },
	},
	// S2 (D-gate-precision, continued): head_sha is GONE -- it was a repo-wide commit proxy for
	// "has the codebase moved since scanning?" that was simultaneously too broad (staled on any
	// unrelated commit, e.g. a doc or Python edit when the adapter is java-spring) and too narrow
	// (blind to an UNCOMMITTED edit -- confirmed live before this fix: editing a real controller's
	// content without committing left `scan` reporting `pass`). Replaced with a precise, per-file
	// content fingerprint of the adapter's own real read-set. Deliberately RE-DERIVED fresh via
	// `adapter.listReadSet(root)` on every check, not re-hashed from the report's OWN persisted
	// `files_read` list -- a stale persisted list would stay blind to a brand-NEW file the same way
	// D-gate-precision's own rejected alternative (ii) already named ("a manifest built from the
	// scan report's own matched files is structurally blind to a newly added colliding
	// controller"). Still covers the scan report's own content hash (has disposition/re-scan
	// changed it?) and spec.md's content hash if it exists yet (scan can run before a spec is
	// written, so this may be null).
	scan: {
		name: 'scan',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED,
		recompute: (root, featureId) => {
			const reportPath = specPath(root, featureId, 'brownfield-scan.json');
			const report = readJsonIfExists(reportPath);
			const inputs = {
				scan_report_hash: sha256File(reportPath),
				spec_hash: sha256File(specPath(root, featureId, 'spec.md')),
			};
			// No report yet, an adapter this build no longer has, or one that predates
			// listReadSet() (a hypothetical third-party adapter) -- fall back to the two hashes
			// above only, same graceful-degradation shape lib/verify.mjs's checkResolverConflicts
			// already established: never crash, never a false pass.
			const adapter = report ? adapterById(ADAPTERS, report.adapter) : null;
			if (adapter?.listReadSet) {
				// Found live, not assumed: a generated resolver (O2) lives INSIDE the same
				// src/main/java tree java-spring's listReadSet() globs -- without this exclusion,
				// `handles emit` writing its own output would make `scan` newly "see" a file that
				// didn't exist at scan time, indistinguishable from a human adding a real new
				// controller, staling `scan` on every single `handles emit` run. O2's own
				// generated-file registry (.sbf/handles-manifest.json) is the authoritative
				// answer to "did backend-skeleton itself write this" -- reused here rather than a
				// directory-name/filename-pattern guess. try/catch mirrors handlesManifestChecks():
				// an unreadable manifest must not crash gate recomputation.
				let generatedPaths;
				try {
					generatedPaths = new Set(Object.keys(loadManifest(root).files ?? {}));
				} catch {
					generatedPaths = new Set();
				}
				for (const rel of adapter.listReadSet(root)) {
					if (generatedPaths.has(rel)) continue;
					const abs = resolveWithinRoot(root, rel);
					if (!abs) continue;
					inputs[`${SOURCE_FILE_PREFIX}${rel}`] = sha256File(abs);
				}
			}
			return inputs;
		},
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
	//
	// A1: also covers the OpenAPI reconciliation snapshot's hash, for the identical reason --
	// path correction against a real OpenAPI document is only trustworthy for as long as the
	// snapshot that recorded it is intact. `null` when `bskel contract emit` was never run with
	// `--openapi-file` (the common case), which is stable and requires no special-casing here.
	//
	// S2 (D-gate-precision, part 2): head_sha is GONE, replaced by two PRECISE signals instead
	// of the single opaque "upstream_token" this item's own earlier EXIT sketched -- an
	// upstream_token equal to the scan gate's own token would inherit scan's deliberately
	// whole-Java-tree-sensitive design (Part 1), reintroducing "any Java file anywhere stales
	// this feature's contract" right back, which is exactly what per-feature narrowing means to
	// avoid. `scan_report_hash` catches an explicit re-scan/re-disposition (including this
	// module's own membership changing); `module_file:<relpath>` per-file hashes catch a content
	// edit to an ALREADY-KNOWN file belonging to the DISPOSED module specifically (not the whole
	// adapter read-set) -- the same "uncommitted change must be visible" property Part 1 already
	// established for `scan`, one level down. Known, accepted limitation: a brand-new file added
	// to the SAME already-disposed module, before the next explicit `bskel scan` re-run, is not
	// caught by the per-file hashes (only `scan_report_hash`, at the next re-scan, catches it) --
	// closing that precisely would mean re-running full module-assignment logic on every
	// verify/gate-require call, real added cost for an edge case, not the common one.
	contract: {
		name: 'contract',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED,
		recompute: (root, featureId) => {
			const reportPath = specPath(root, featureId, 'brownfield-scan.json');
			const report = readJsonIfExists(reportPath);
			const inputs = {
				scan_report_hash: sha256File(reportPath),
				contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
				resolution_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.resolution.json`)),
				openapi_snapshot_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.openapi.snapshot.json`)),
			};
			const moduleName = report?.disposition?.module ?? report?.related_modules?.[0]?.module;
			const mod = report?.related_modules?.find((m) => m.module === moduleName);
			// DTOs now included -- every adapter pushes {className, file} objects for dtos, the
			// same shape controllers/entities/enums already use. See D-gate-precision "Continued
			// (part 3)" in DECISIONS.md.
			for (const item of [...(mod?.controllers ?? []), ...(mod?.entities ?? []), ...(mod?.enums ?? []), ...(mod?.dtos ?? [])]) {
				if (!item.file) continue;
				// related_modules[].{controllers,entities,enums}[].file are stored ABSOLUTE
				// (unlike Part 1's own repo-relative files_read) -- confirmed live against a real
				// scan report before writing this.
				const rel = path.relative(root, item.file);
				inputs[`${MODULE_FILE_PREFIX}${rel}`] = sha256File(item.file);
			}
			return inputs;
		},
	},
	// D-field-dependency: a resolved file gets its real content hash; an UNRESOLVABLE one gets a
	// labeled sentinel string instead of a bare null -- unlike contract.recompute()'s own bare-null
	// precedent (safe there only because the path itself is always deterministic via specPath()),
	// here "no file resolves at all" (a renamed/deleted class) is a distinct failure mode from "a
	// known file was deleted" (also a real, legitimate null from sha256File), and a human reading
	// `changed_inputs` deserves to know which. Both are equally fail-closed: neither can coincide
	// with a previously-stored good hash.
	dependencies: {
		name: 'dependencies',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root, featureId) => {
			const depsPath = dependenciesPath(root, featureId);
			const inputs = { dependencies_hash: sha256File(depsPath) };
			const doc = readJsonIfExists(depsPath);
			const fileTokenFor = (resolution) => (resolution.file ? sha256File(resolution.file) : `unresolved:${resolution.reason}`);
			for (const dep of doc?.dependencies ?? []) {
				const targetKey = `${TARGET_FIELD_FILE_PREFIX}${dep.target.resourceType}`;
				if (!(targetKey in inputs)) inputs[targetKey] = fileTokenFor(resolveClassFile(root, featureId, dep.target.resourceType));
				const sourceKey = `${SOURCE_FIELD_FILE_PREFIX}${dep.source.feature}:${dep.source.resourceType}`;
				if (!(sourceKey in inputs)) inputs[sourceKey] = fileTokenFor(resolveClassFile(root, dep.source.feature, dep.source.resourceType));
			}
			return inputs;
		},
	},
	// Staleness = the generated Java (or the contract it was generated from) has moved since
	// emit -- NOT "does the migration still match the DB schema" (unknowable without a live DB
	// connection this tool deliberately never opens on its own, see D-migration-scope). Note
	// this token does NOT cover specs/<id>/handles/migration.sql itself -- lib/verify.mjs's
	// checkArtifacts() is the only thing that notices if that file goes missing (S6).
	//
	// S2 (D-gate-precision, part 2): head_sha dropped, no replacement needed -- contract_hash
	// alone is already sufficient. `handles` is derived from the CONTRACT, not directly from
	// source; now that `contract`'s own token is precise (above), contract_hash transitively
	// carries that precision. `contract` is a REQUIRED gate, so bskel verify's overall verdict is
	// already blocked whenever contract itself is stale -- `handles` reporting "pass" (its
	// emitted Java still matches the currently-emitted contract) stays accurate even then.
	handles: {
		name: 'handles',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root, featureId) => ({
			contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
		}),
	},
	// Repo-scoped like preflight (a stack choice is a project-wide decision, not per-feature).
	// Staleness here means "the applied files or the choice-of-catalog-entry are gone/changed",
	// not "re-verify the tunnel is currently running" -- that's a runtime concern, not a gate.
	// S2: the token now covers the CONTENT of every file the stack record says `stack apply` wrote,
	// not just the record's own bytes. Before this, deleting or editing scripts/dev-tunnel.sh left
	// stack.json byte-identical, so stack_record_hash never moved and the gate stayed `pass`
	// forever -- while the comment right above claimed applied-file drift was covered. It now is.
	// `head_sha` is deliberately gone: this gate's input set is precisely enumerated on disk (via
	// `applied_files`), so a repo-wide "something, somewhere, moved" proxy adds nothing except
	// staling the gate on every unrelated commit (D-gate-precision). The other four gates keep
	// head_sha -- their real read-sets are not enumerable yet, see D-gate-precision's EXIT.
	stack: {
		name: 'stack',
		scope: SCOPE.REPO,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root) => {
			const recordPath = sbfPath(root, 'stack.json');
			const record = readJsonIfExists(recordPath);
			const inputs = { stack_record_hash: sha256File(recordPath) };
			for (const rel of record?.applied_files ?? []) {
				const abs = resolveWithinRoot(root, rel);
				if (!abs) continue; // a path escaping the repo is not something `stack apply` wrote
				inputs[`${APPLIED_FILE_PREFIX}${rel}`] = sha256File(abs); // null == deleted -> stale
				inputs[`${APPLIED_FILE_MODE_PREFIX}${rel}`] = fileMode(abs); // null == deleted -> stale
			}
			return inputs;
		},
	},
	// D-runtime-conformance-receipts: passed by `bskel observe import`, never by `observe emit`
	// (emitting the checking infra is not evidence; importing real receipts is). Opt-in like
	// handles/stack -- not every feature runs runtime observation. Staleness = the contract moved
	// (re-emitting invalidates prior evidence) OR the persisted report itself moved/vanished
	// (hand-edited or re-imported) -- both covered by the existing generic diffInputs() machinery,
	// no special-casing needed. The deeper "was THIS receipt produced against the current contract"
	// question is answered per-receipt at import time (bucketed matched/stale_contract_ref in the
	// report itself), not by this token -- the token only needs to know "did the contract or the
	// persisted report move since I last passed", exactly like `handles` already does for its own
	// artifact.
	conformance: {
		name: 'conformance',
		scope: SCOPE.FEATURE,
		verifyPolicy: VERIFY_POLICY.REQUIRED_WHEN_PRESENT,
		recompute: (root, featureId) => ({
			contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
			conformance_report_hash: sha256File(specPath(root, featureId, 'observe', `${featureId}.conformance-report.json`)),
		}),
	},
});

// Explicit order (= workflow order), not `Object.keys(GATE_DEFINITIONS)` insertion order --
// test/gate-definitions.test.mjs asserts this stays exactly in sync with GATE_DEFINITIONS' own
// key set, so a gate added to one and not the other fails loudly instead of silently vanishing
// from `bskel verify` the way `stack` did before this module existed.
export const GATE_NAMES = Object.freeze(['preflight', 'scan', 'contract', 'dependencies', 'handles', 'stack', 'conformance']);

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
