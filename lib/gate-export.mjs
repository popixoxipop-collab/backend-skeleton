// D-attestation-payload-completeness: pure report-construction logic for `bskel gate export`,
// pulled out of bin/bskel.mjs so it is unit-testable without spawning a CLI process -- the same
// split lib/verify.mjs and lib/gates.mjs already follow (CLI stays thin, real logic lives in lib/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_NAMES, gateScopeId } from './gate-definitions.mjs';
import { collectGateStatuses } from './verify.mjs';
import { getGate, historyPath } from './state.mjs';
import { requireNamedGate } from './gates.mjs';
import { sha256File } from './fsutil.mjs';
import { specPath, sbfPath } from './paths.mjs';
import { crossFeatureReportPath, crossFeatureResolutionPath } from './cross-feature-collisions.mjs';
import { dependenciesPath } from './field-dependencies.mjs';
import { impactBaselinePath } from './impact-surface.mjs';
import { impactReportPath, impactResolutionPath } from './impact.mjs';
import { manifestPath } from './handles-manifest.mjs';
import { currentBranch, headSha, headTreeSha, worktreeStatus } from './repo.mjs';
import { validateAgainstSchema } from './schema-validate.mjs';
import { CANONICALIZATION_ID } from './attest.mjs';

export const EXPORT_SCHEMA_VERSION = 'sbf.gate-export/3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

let cachedToolVersion = null;
// D-attestation-payload-completeness (K2): backend-skeleton's OWN package.json (this tool's
// version), never the TARGET repo's -- resolved from this module's own file location, the same
// derivation bin/bskel.mjs's SKILL_ROOT already uses. Memoized: it cannot change within one
// process, and building one report already calls `sha256File`/git a dozen times.
export function toolVersion() {
	if (cachedToolVersion === null) {
		cachedToolVersion = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'package.json'), 'utf8')).version;
	}
	return cachedToolVersion;
}

// S4 (D-gate-history), moved here from bin/bskel.mjs so both cmdGateHistory and
// buildGateExportReport read history through one implementation instead of two copies that could
// drift. Reads the append-only .sbf/<feature>.history.jsonl -- a corrupt/invalid line is skipped
// with a warning, not a hard failure, matching JSONL's own resilience rationale (see
// lib/state.mjs's appendGateEvent).
export function readGateHistory(root, featureId, gateName, { onWarning } = {}) {
	const file = historyPath(root, featureId);
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
	const events = [];
	for (const [i, line] of lines.entries()) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			onWarning?.(`${file}:${i + 1}: not valid JSON, skipped`);
			continue;
		}
		const { ok, errors } = validateAgainstSchema('gate-event.schema.json', parsed);
		if (!ok) {
			onWarning?.(`${file}:${i + 1}: does not match schemas/gate-event.schema.json, skipped`, errors);
			continue;
		}
		if (parsed.gate === gateName) events.push(parsed);
	}
	return events;
}

// D-attestation-payload-completeness (K2/K8): the ONE place an attestation-bound artifact is
// declared -- adding a future artifact means adding one line here, the same single-source-of-
// truth argument D-gate-definitions made for GATE_NAMES. Each value is (root, featureId) => an
// absolute path; `test/gate-export-report.test.mjs` asserts this key set equals
// `schemas/gate-export.schema.json`'s own `artifacts.properties` key set, so the two cannot drift.
export const ARTIFACT_SOURCES = Object.freeze({
	scan_report_hash: (root, featureId) => specPath(root, featureId, 'brownfield-scan.json'),
	spec_hash: (root, featureId) => specPath(root, featureId, 'spec.md'),
	contract_hash: (root, featureId) => specPath(root, featureId, 'contracts', `${featureId}.schema.json`),
	contract_resolution_hash: (root, featureId) => specPath(root, featureId, 'contracts', `${featureId}.resolution.json`),
	openapi_snapshot_hash: (root, featureId) => specPath(root, featureId, 'contracts', `${featureId}.openapi.snapshot.json`),
	cross_feature_report_hash: (root, featureId) => crossFeatureReportPath(root, featureId),
	cross_feature_resolution_hash: (root, featureId) => crossFeatureResolutionPath(root, featureId),
	dependencies_hash: (root, featureId) => dependenciesPath(root, featureId),
	rules_source_hash: (root, featureId) => specPath(root, featureId, 'rules.yaml'),
	rules_compiled_hash: (root, featureId) => specPath(root, featureId, 'rules', `${featureId}.rules.json`),
	conformance_report_hash: (root, featureId) => specPath(root, featureId, 'observe', `${featureId}.conformance-report.json`),
	handles_manifest_hash: (root) => manifestPath(root),
	stack_record_hash: (root) => sbfPath(root, 'stack.json'),
	// D-cross-feature-impact-graph (IG4): additive, sbf.gate-export/2 -> /3 -- a /2 attestation
	// still verifies (K7's own promise), it just won't have these three keys.
	impact_baseline_hash: (root, featureId) => impactBaselinePath(root, featureId),
	impact_report_hash: (root, featureId) => impactReportPath(root, featureId),
	impact_resolution_hash: (root, featureId) => impactResolutionPath(root, featureId),
});

export function collectArtifactHashes(root, featureId) {
	const out = {};
	for (const [key, resolvePath] of Object.entries(ARTIFACT_SOURCES)) {
		out[key] = sha256File(resolvePath(root, featureId));
	}
	return out;
}

// D-attestation-payload-completeness (K2): forced/revoked decisions rolled up from the gate
// records already in the payload -- zero new file reads. Waivers (contract_resolution/
// cross_feature_resolution) are represented by presence+hash only, never embedded content: the
// content is already bound via `artifacts` above, and embedding it again would duplicate that
// binding while ballooning the payload for no new guarantee.
export function collectDecisions(gatesById, artifacts) {
	const forced = [];
	const revoked = [];
	for (const [gate, entry] of Object.entries(gatesById)) {
		const record = entry.current;
		if (!record) continue;
		if (record.forced) forced.push({ gate, scope: entry.scope, reason: record.reason ?? null, at: record.at ?? null });
		if (record.status === 'revoked') revoked.push({ gate, scope: entry.scope, reason: record.reason ?? null, at: record.at ?? null });
	}
	return {
		forced,
		revoked,
		waiver_files: {
			contract_resolution: { present: artifacts.contract_resolution_hash !== null, hash: artifacts.contract_resolution_hash },
			cross_feature_resolution: { present: artifacts.cross_feature_resolution_hash !== null, hash: artifacts.cross_feature_resolution_hash },
		},
	};
}

// D-attestation-payload-completeness (K2/K3): pure derivation from `live` -- what a human or CI
// actually greps for, so they read one line instead of walking every gate.
export function buildVerdict(liveEntries) {
	const blocking_gates = liveEntries.filter((g) => g.blocking).map((g) => g.gate);
	const passing = liveEntries.filter((g) => g.status === 'pass' || g.status === 'pass (forced)').length;
	return { blocking_gates, passing, total: liveEntries.length, ok: blocking_gates.length === 0 };
}

// D-attestation-payload-completeness (K2/K3): the report `bskel gate export` builds and (with
// --sign) signs. `gates[name].live` is RECOMPUTED at export time via lib/verify.mjs's
// collectGateStatuses() -- the exact same function `bskel verify` uses -- so a gate export and
// `bskel verify` can never disagree about the same repo's current state. `gates[name].current`
// stays the raw STORED record (unchanged from schema /1), so a reader sees both "what was last
// written" and "what is honestly true right now" side by side.
export function buildGateExportReport(root, featureId, { now = new Date(), dirtyAcknowledged = false, dirtyCap = 200 } = {}) {
	const liveResults = collectGateStatuses(root, featureId, { getGate, requireNamedGate });
	const liveByName = new Map(liveResults.map((g) => [g.gate, g]));

	const gates = {};
	for (const name of GATE_NAMES) {
		const live = liveByName.get(name);
		// collectGateStatuses()'s own `scope` field is the gate's DEFINITION scope type
		// ('repo'|'feature'), not the resolved scope id -- gateScopeId() computes the real one
		// (REPO_GATE_ID for a repo-scoped gate, or featureId itself), matching cmdGateExport's own
		// pre-existing lookup exactly.
		const scopeId = gateScopeId(name, featureId);
		gates[name] = {
			scope: scopeId,
			current: getGate(root, scopeId, name),
			history: readGateHistory(root, scopeId, name),
			live: {
				policy: live.policy,
				status: live.status,
				blocking: live.blocking,
				ran: live.ran,
				current_token: live.currentToken ?? null,
				stale_reason: live.stale_reason ?? null,
				changed_inputs: live.changed_inputs && live.changed_inputs.length > 0 ? live.changed_inputs : null,
			},
		};
	}

	const artifacts = collectArtifactHashes(root, featureId);
	const decisions = collectDecisions(gates, artifacts);
	const verdict = buildVerdict(Object.entries(gates).map(([gate, g]) => ({ gate, blocking: g.live.blocking, status: g.live.status })));

	const status = worktreeStatus(root, { cap: dirtyCap });
	const dirty = status === null ? null : status.count > 0;

	return {
		schema: EXPORT_SCHEMA_VERSION,
		feature_id: featureId,
		generated_at: now.toISOString(),
		tool: {
			name: 'bskel',
			version: toolVersion(),
			gate_names: [...GATE_NAMES],
			canonicalization: CANONICALIZATION_ID,
		},
		git: {
			branch: currentBranch(root),
			head_sha: headSha(root),
			dirty,
			head_tree_sha: headTreeSha(root),
			dirty_acknowledged: Boolean(dirtyAcknowledged),
			dirty_file_count: status?.count ?? 0,
			dirty_files_truncated: status?.truncated ?? false,
			dirty_files: status?.entries ?? [],
		},
		artifacts,
		gates,
		decisions,
		verdict,
	};
}
