// D1: turns raw gate state into "what's blocking, what do I run next" -- `bskel verify` already
// computes everything this needs (per-gate blocking/status/stale_reason/changed_inputs via
// lib/verify.mjs's collectGateStatuses, missing artifacts via checkArtifacts), it just flattens
// all of that into one pass/fail verdict instead of answering "what's the next command". This
// module is presentation/sequencing logic layered on those same primitives -- reused directly,
// not re-derived.
import fs from 'node:fs';
import path from 'node:path';
import { GATE_NAMES, GATE_DEFINITIONS, VERIFY_POLICY } from './gate-definitions.mjs';
import { collectGateStatuses, checkArtifacts, isBlockingGateResult } from './verify.mjs';
import { getGate } from './state.mjs';
import { requireNamedGate } from './gates.mjs';

// This repo's own known features -- .sbf/feature-index.json is keyed by feature_uid (not
// feature_id) and only ever holds a single-element array per uid, so it's not a convenient
// "list every feature_id" source. specs/<id>/feature.json (written once by `feature init`,
// never rewritten) is simpler and authoritative for what IDs actually exist.
export function listFeatures(root) {
	const specsRoot = path.join(root, 'specs');
	if (!fs.existsSync(specsRoot)) return [];
	return fs.readdirSync(specsRoot)
		.filter((name) => fs.existsSync(path.join(specsRoot, name, 'feature.json')))
		.map((featureId) => JSON.parse(fs.readFileSync(path.join(specsRoot, featureId, 'feature.json'), 'utf8')))
		.sort((a, b) => a.feature_id.localeCompare(b.feature_id));
}

// The command that first establishes each gate -- same phrasing as the existing inline "blocked:
// ... -- run `bskel ...` first" messages in requirePreflightPassed/cmdContractEmit/cmdHandlesEmit,
// kept here as the one place both those call sites and this module could eventually share (not
// done in this slice -- see D-status-next's COST in DECISIONS.md).
const ESTABLISH_COMMAND = {
	preflight: () => 'bskel preflight',
	scan: (id) => `bskel scan --feature ${id} --terms <a,b,c>`,
	contract: (id) => `bskel contract emit --feature ${id}`,
	// D-field-dependency: this and `conformance` immediately below were BOTH missing before this
	// item -- found live while adding this one, same crash class, fixed together. Neither had ever
	// been exercised through `next` on a stale REQUIRED_WHEN_PRESENT gate (no test covered it) --
	// without an entry here, `computeWorkflowState()` calls `ESTABLISH_COMMAND[gateName](featureId)`
	// directly on the first real stale occurrence and throws a raw TypeError instead of a clean
	// stale report.
	dependencies: (id) => `bskel dependency declare --feature ${id} --resource <Type> --field <name> --source-feature <id> --source-resource <Type> --source-field <name> --reason "..."`,
	handles: (id) => `bskel handles plan --feature ${id}   # then: bskel handles emit --feature ${id}`,
	stack: () => 'bskel stack apply --choice <id> --apply',
	conformance: (id) => `bskel observe emit --feature ${id}   # then: run the target app, then bskel observe import --feature ${id} --receipts <path>`,
};

// awaiting_disposition needs a genuinely different remediation per gate, not a re-run --
// cmdScanDisposition's own usage line and cmdHandlesEmit's awaiting_disposition hint
// (bin/bskel.mjs) already say exactly this; duplicated here rather than exported+imported to
// avoid pulling CLI-layer string-building into lib/ for two lines of text.
function awaitingDispositionCommand(gateName, featureId) {
	if (gateName === 'scan') {
		return `bskel scan disposition --feature ${featureId} --mode reuse|extend|replace|parallel --note "..."`;
	}
	if (gateName === 'contract') {
		return `bskel contract waive --feature ${featureId} --code <CODE> (--subject "..."|--all) --reason "..."   # or: bskel gate force contract --feature ${featureId} --reason "..." if intentional`;
	}
	return `bskel gate force ${gateName} --feature ${featureId} --reason "..."`;
}

// Whether a recommended command WRITES anything (gate state, generated files, applied files) as
// opposed to being a pure read (bskel verify, bskel status, bskel next itself). Matched by the
// command's own leading "bskel <verb...>" prefix so this can't silently drift from the actual
// command names above. `bskel observe emit`/`bskel observe import` were BOTH missing until found
// live while fixing the identical ESTABLISH_COMMAND gap above (same bug class: neither had ever
// been exercised through `next` recommending the real `conformance`-gate command, so a real
// `mutating: false` misclassification on a command that actually writes files + passes a gate went
// unnoticed) -- see D-field-dependency's COST section in DECISIONS.md.
const MUTATING_PREFIXES = [
	'bskel preflight', 'bskel scan', 'bskel feature init', 'bskel contract emit', 'bskel contract waive',
	'bskel gate force', 'bskel dependency declare', 'bskel dependency remove', 'bskel handles emit',
	'bskel handles plan', 'bskel stack apply', 'bskel observe emit', 'bskel observe import',
];

// Exported (not just inlined into action()) so lib/workflow.mjs's own test suite can assert the
// classification directly, without needing a full end-to-end fixture that drives a feature all the
// way to a stale `conformance` gate just to observe one boolean.
export function isMutatingCommand(command) {
	return MUTATING_PREFIXES.some((p) => command.startsWith(p));
}

function action(command, reason) {
	return { command, reason, mutating: isMutatingCommand(command) };
}

// featureId === null means "repo scope only" -- feature-scoped gates (scan/contract/handles)
// cannot be meaningfully evaluated without a feature_id, so only `preflight` is considered.
export function computeWorkflowState(root, featureId) {
	let gates;
	if (featureId) {
		gates = collectGateStatuses(root, featureId, { getGate, requireNamedGate });
	} else {
		// Same call requirePreflightPassed already makes -- preflight's recompute() ignores
		// featureId entirely (it's repo-scoped), so `null` here is exactly correct, not a stand-in.
		const result = requireNamedGate(root, 'preflight', null);
		const def = GATE_DEFINITIONS.preflight;
		gates = [{
			gate: 'preflight', scope: def.scope, policy: def.verifyPolicy,
			required: def.verifyPolicy === VERIFY_POLICY.REQUIRED,
			blocking: isBlockingGateResult(def, result),
			ran: getGate(root, '_repo', 'preflight') !== null,
			...result,
		}];
	}

	const blockedBy = gates.filter((g) => g.blocking).map((g) => g.gate);
	const nextActions = [];

	// featureId === null means `gates` only ever contains the preflight entry (see above) -- every
	// other gate name is legitimately absent, not "not_run", so `!g` must fall through to the next
	// gate name rather than being treated as blocking. This loop can therefore only ever produce an
	// action from `preflight` when there's no featureId; the "what comes after preflight" case (no
	// feature selected yet) is handled in the fallback block below, not in here.
	for (const gateName of GATE_NAMES) {
		const g = gates.find((x) => x.gate === gateName);
		if (!g || !g.blocking) continue; // not_run on an optional (required-when-present) gate isn't blocking -- isBlockingGateResult already encodes that.
		if (g.status === 'not_run') {
			nextActions.push(action(ESTABLISH_COMMAND[gateName](featureId), `${gateName} gate has not run yet`));
		} else if (g.status === 'awaiting_disposition') {
			nextActions.push(action(awaitingDispositionCommand(gateName, featureId), `${gateName} gate is awaiting disposition`));
		} else if (g.status === 'stale') {
			// D-preflight-freshness (S3): ttl_expired carries age_seconds/max_age_seconds (see
			// lib/gates.mjs's checkFreshness()) -- worth a word count here, since "stale (ttl_expired)"
			// alone doesn't say whether the pass is 1 minute or 1 day past its limit.
			const staleDetail = g.stale_reason === 'inputs_changed'
				? `: ${g.changed_inputs.join(', ')}`
				: g.stale_reason === 'ttl_expired'
					? ` (ttl_expired, ${Math.round(g.age_seconds / 60)}m old > ${Math.round(g.max_age_seconds / 60)}m limit)`
					: g.stale_reason ? ` (${g.stale_reason})` : '';
			nextActions.push(action(ESTABLISH_COMMAND[gateName](featureId), `${gateName} gate is stale${staleDetail}`));
		}
		break; // GATE_NAMES order -- only the earliest blocking gate; `next` promises exactly one action.
	}

	if (nextActions.length === 0) {
		if (featureId) {
			// Every required gate passes -- verify is the natural next step. Optional gates
			// (handles/stack) that never ran are surfaced separately, not as a blocking action.
			nextActions.push(action(`bskel verify --feature ${featureId}`, 'all required gates pass -- verify the full feature state'));
		} else {
			// preflight passed and no --feature was given -- there is no gate to hook this off of
			// (feature-scoped gates aren't even evaluated without a feature_id), so point at
			// starting or selecting one directly.
			const features = listFeatures(root);
			if (features.length === 0) {
				nextActions.push(action('bskel feature init --slug <name>', 'no feature exists yet -- create one to start the scan/contract/handles workflow'));
			} else {
				nextActions.push(action(
					'bskel next --feature <id>',
					`pick an existing feature to continue (known: ${features.map((f) => f.feature_id).join(', ')}), or run \`bskel feature init --slug <name>\` to start a new one`,
				));
			}
		}
	}

	const optionalNotRun = gates.filter((g) => (g.gate === 'handles' || g.gate === 'stack') && g.status === 'not_run').map((g) => g.gate);

	return {
		gates,
		artifacts: featureId ? checkArtifacts(root, featureId, gates) : [],
		blocked_by: blockedBy,
		next_actions: nextActions,
		optional_not_run: optionalNotRun,
	};
}
