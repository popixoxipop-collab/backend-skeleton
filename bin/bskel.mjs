#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { repoRoot, localDefaultBranch } from '../lib/repo.mjs';
import { forceNamedGate, revokeNamedGate, requireNamedGate, passNamedGate, awaitNamedGateDisposition, EXIT } from '../lib/gates.mjs';
import { REPO_GATE_ID, GATE_NAMES, gateScopeId, requireGateDefinition } from '../lib/gate-definitions.mjs';
import { getGate, loadState, historyPath } from '../lib/state.mjs';
import { writeFileAtomic } from '../lib/fsutil.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';
import { withLockSync } from '../lib/lock.mjs';
import { specDir, specPath } from '../lib/paths.mjs';
import { requireValidFeatureId, requireValidSlug, requireValidFeatureOrRepoId, slugWords, nextFeatureNumber } from '../lib/featureid.mjs';
import {
	loadFeatureFile, saveFeatureFile, loadFeatureIndex, saveFeatureIndex,
	listFeatures, currentFeatureIdForUid, uidForFeatureId, featureIdInUse,
	renameFeatureArtifacts, archiveFeature, linkFeature,
} from '../lib/featurelifecycle.mjs';
import { runScan } from '../scanners/index.mjs';
import { renderScanMarkdown, renderPlanConstraints, renderScanExplain } from '../scanners/render.mjs';
import { ADAPTERS, LOAD_ERRORS, adapterById } from '../scanners/registry.mjs';
import { COMMAND_CAPABILITIES, CAPABILITY_SATISFIERS, explainMissingCapability } from '../scanners/capabilities.mjs';
import { buildContract, selectModule } from '../contracts/emit.mjs';
import { validateEnvelope, operationPayloadSchema } from '../contracts/validate.mjs';
import { evaluateResolution, loadResolution, saveResolution, requireWarningCode, warningKey, countByCode } from '../contracts/completeness.mjs';
import { loadPatchApprovals, savePatchApprovals, approvalKey } from '../lib/patch-approvals.mjs';
import { STACKS as NEW_STACKS } from '../new/index.mjs';
import { buildReconciliation, snapshotFromReconciliation, describeSourceFile } from '../contracts/openapi.mjs';
import { loadCatalogEntry, listCatalogChoices, planApply, applyPlan } from '../stack/apply.mjs';
import { PROVIDERS, PROVIDER_LOAD_ERRORS, providerById } from '../handles/registry.mjs';
import { collectGateStatuses, runBuildCheck, checkArtifacts } from '../lib/verify.mjs';
import { computeWorkflowState } from '../lib/workflow.mjs';
import { computeDoctorChecks, WORKFLOWS as DOCTOR_WORKFLOWS } from '../lib/doctor.mjs';
import { parseCommand, renderCommandHelp, diagnostic } from '../lib/cli.mjs';
import { EXIT_CODES } from '../lib/exit-codes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

function usage() {
	console.error(`bskel -- backend-skeleton CLI

  bskel new --stack spring|fastapi --slug <name> [--dir <path>] [--offline] [--json]
  bskel preflight [--max-behind N] [--offline|--no-fetch] [--allow-dirty] [--max-age-minutes N] [--fetch-timeout-seconds N] [--json]
  bskel scan [--feature <id>] [--terms a,b,c] [--json] [--accept-low-confidence]
  bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel [--note "..."] [--breaking-approved]
  bskel scan explain <module> --feature <id> [--json]
  bskel feature init --slug <name>
  bskel feature list [--all] [--json]
  bskel feature show <id> [--json]
  bskel feature rename <id> --to <new-slug> --reason "..." [--json]
  bskel feature link <keepId> <aliasId> --reason "..." [--json]
  bskel feature archive <id> --reason "..." [--json]
  bskel contract emit --feature <id> [--module <name>] [--json] [--openapi-file <path>] [--path-prefix /api/v0]
  bskel contract validate --feature <id> --file <envelope.json>
  bskel contract tool-schema --feature <id> --operation <operationId>
  bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path"|--all) --reason "..."
  bskel stack apply --choice <id> [--apply] [--port N] [--json]
  bskel catalog lint [<choice>] [--json]
  bskel handles plan --feature <id> [--module <name>] [--resource type1,type2] [--diff]
  bskel handles emit --feature <id> [--module <name>] [--resource type1,type2] [--force --reason "..."] [--check] [--diff]
  bskel handles patch approve --feature <id> [--module <name>] --resource <Type> --field <name> --strategy patch-wrapper|null-means-unchanged --reason "..." [--json]
  bskel verify --feature <id> [--build] [--json]
  bskel status [--feature <id>] [--json]
  bskel next [--feature <id>] [--json]
  bskel gate require <name> [--feature <id>]      (name: ${GATE_NAMES.join('|')})
  bskel gate force <name> --reason "..." [--feature <id>] [--max-age-minutes N]
  bskel gate revoke <name> --reason "..." [--feature <id>]
  bskel gate history <name> [--feature <id>] [--json]
  bskel gate show [<name>] [--feature <id>]
  bskel doctor [--workflow ${DOCTOR_WORKFLOWS.join('|')}] [--json]
`);
}

// D2 (D-cli-contract): usage()'s exact shape (a single template literal passed directly to
// console.error) is load-bearing -- test/doc-integrity.test.mjs's regex-based drift guard parses
// it as source text, so it is never restructured. This is the "same text, but to stdout" bridge
// for --help/`help`/bare `bskel` -- a local, temporary console.error redirect rather than a second
// copy of the banner text (which could silently drift from the real one).
function printUsageToStdout() {
	const original = console.error;
	console.error = console.log;
	try {
		usage();
	} finally {
		console.error = original;
	}
}

// D2: module-level, set once per process right after a command's own parseCommand() succeeds --
// same lifetime class as `process.exitCode` itself. Threading {json,quiet,command} through every
// helper function's own parameter list would add noise to ~20 call sites for a value that is, by
// construction, fixed for the entire life of one `bskel` invocation.
const CTX = { command: null, json: false, quiet: false };

function setContext(command, flags) {
	CTX.command = command;
	CTX.json = Boolean(flags.json);
	CTX.quiet = Boolean(flags.quiet);
}

// Prints the diagnostic envelope to stdout IF --json was requested -- never prints the human
// message itself (the caller already did, on stderr, possibly across several console.error calls
// for a multi-line explanation). See DECISIONS.md D-cli-contract: this only ever fires on a
// PAYLOAD-LESS early exit -- a command whose stdout would otherwise be empty on this path.
function exitWithDiagnostic(code, reason, message, { next_actions = [] } = {}) {
	if (CTX.json) {
		console.log(JSON.stringify(diagnostic({ command: CTX.command, code, reason, message, next_actions }), null, 2));
	}
	process.exit(code);
}

// The common case: exactly one stderr line, then the (optional) JSON envelope, then exit.
function fail(code, reason, message, opts = {}) {
	console.error(message);
	exitWithDiagnostic(code, reason, message, opts);
}

function requireRepoRoot() {
	const root = repoRoot();
	if (!root) fail(EXIT_CODES.NOT_A_REPO, 'NOT_A_REPO', 'bskel: not inside a git repository');
	return root;
}

// D2: a gate blocked in a way where the underlying result.code varies (2/3/4 depending on
// current gate status) still needs the right `reason` for the envelope -- this is the one place
// that mapping lives, reused by every "some other gate must pass first" check below.
function gateReasonForCode(code) {
	if (code === EXIT.AWAITING_DISPOSITION) return 'GATE_AWAITING_DISPOSITION';
	if (code === EXIT.STALE) return 'GATE_STALE';
	return 'GATE_NOT_PASSED';
}

function cmdPreflight(args) {
	const flags = parseCommand('preflight', args);
	if (flags.help) { console.log(renderCommandHelp('preflight')); process.exit(0); }
	setContext('preflight', flags);
	const root = requireRepoRoot();
	const scriptPath = path.join(SKILL_ROOT, 'scripts', 'preflight-base-ref.sh');
	const fetchTimeoutSeconds = Number(flags['fetch-timeout-seconds']);
	const scriptArgs = ['--max-behind', flags['max-behind'], '--fetch-timeout-seconds', flags['fetch-timeout-seconds']];
	// D-preflight-freshness (S3): --no-fetch is kept as an exact alias for --offline (both flow
	// through to the script's own --offline, which also accepts --no-fetch) -- see lib/cli.mjs's
	// COMMANDS.preflight for why both flags are declared.
	if (flags.offline || flags['no-fetch']) scriptArgs.push('--offline');
	if (flags['allow-dirty']) scriptArgs.push('--allow-dirty');
	scriptArgs.push('--json');

	let stdout;
	let exitCode = 0;
	try {
		// D-preflight-freshness (S3): a backstop for transports `http.lowSpeedLimit`/
		// `http.lowSpeedTime` (set inside the script) don't cover -- a local-path or ssh remote
		// that simply hangs. +10s over the script's own fetch timeout so the script's own
		// REFRESH_FAILED message (which explains WHY) has a chance to win the race.
		stdout = execFileSync(scriptPath, scriptArgs, { cwd: root, encoding: 'utf8', timeout: (fetchTimeoutSeconds + 10) * 1000 });
	} catch (err) {
		stdout = err.stdout ?? '';
		exitCode = err.status ?? 1;
	}
	let result;
	try {
		result = JSON.parse(stdout);
	} catch {
		// Only reachable if the Node-side timeout above fired before the script produced any
		// output at all (or the script crashed outside its own fail()/JSON paths) -- the script
		// itself always emits a JSON verdict on every path `bskel` cares about.
		fail(EXIT_CODES.REFRESH_FAILED, 'REFRESH_FAILED', `preflight check timed out or produced no output after ${fetchTimeoutSeconds}s -- fix connectivity, or re-run with --offline to accept a local-only verdict`);
	}

	if (result.verdict === 'PASS') {
		const evidence = { ...result.evidence, freshness: { max_age_minutes: Number(flags['max-age-minutes']) } };
		passNamedGate(root, 'preflight', null, evidence);
		// detection only, never a silent fix -- see D-openapi-reconciliation's path_prefix_signals
		// precedent for the same "point it out, don't touch the user's repo metadata" stance.
		if (evidence.default_branch && !localDefaultBranch(root)) {
			console.error(`note: origin/HEAD is not set locally, so the preflight gate cannot detect remote-tracking movement -- run \`git remote set-head origin ${evidence.default_branch}\` (local-only) to enable it.`);
		}
	}

	if (flags.json) {
		console.log(stdout.trim());
	} else if (result.verdict === 'PASS') {
		if (!flags.quiet) console.log(`PASS: HEAD is up to date with origin/${result.evidence.default_branch}`);
	} else {
		console.error(`FAIL (${result.reason}): ${result.message}`);
	}
	process.exit(exitCode);
}

// S1: validates a gate name against the shared definitions, and the --feature/--repo scope
// shape (D-security-3), in one place shared by require/force/show. Before this, an unknown
// gate name silently reported `not_run` (exit 2) from `getGate`/`requireGate` -- indistinguishable
// from "a real gate that just hasn't run yet" -- so a typo read as "not done" instead of
// "this gate doesn't exist".
function resolveGateArg(gateName, featureFlag) {
	let def;
	try {
		def = requireGateDefinition(gateName);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	try {
		requireValidFeatureOrRepoId(featureFlag, REPO_GATE_ID);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	return { def, scopeId: gateScopeId(gateName, featureFlag) };
}

function cmdGateRequire(args) {
	const flags = parseCommand('gate require', args);
	if (flags.help) { console.log(renderCommandHelp('gate require')); process.exit(0); }
	setContext('gate require', flags);
	const root = requireRepoRoot();
	const gateName = flags._[0];
	if (!gateName) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel gate require <name> [--feature <id>]');
	resolveGateArg(gateName, flags.feature);
	// `require` never re-runs the underlying check (e.g. it doesn't re-fetch or re-scan) -- it
	// freshly recomputes only the cheap, local inputs the gate's token was built from (see
	// lib/gate-definitions.mjs) and compares against what was stored when the gate last passed.
	const result = requireNamedGate(root, gateName, flags.feature);
	console.log(JSON.stringify({ gate: gateName, feature: flags.feature, ...result }));
	process.exit(result.code);
}

// S4 (D-gate-history): `--max-age-minutes`, unlike preflight's own same-named flag, has no
// default -- opt-in only, so an un-timed force never silently starts expiring (see
// checkFreshness()'s own comment in lib/gates.mjs for why a forced record never inherits the
// underlying gate's TTL policy).
function parseForceMaxAge(raw) {
	if (raw == null) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `--max-age-minutes must be a non-negative number, got "${raw}"`);
	}
	return n;
}

function cmdGateForce(args) {
	const flags = parseCommand('gate force', args);
	if (flags.help) { console.log(renderCommandHelp('gate force')); process.exit(0); }
	setContext('gate force', flags);
	const root = requireRepoRoot();
	const gateName = flags._[0];
	if (!gateName) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel gate force <name> --reason "..." [--feature <id>] [--max-age-minutes N]');
	resolveGateArg(gateName, flags.feature);
	const maxAgeMinutes = parseForceMaxAge(flags['max-age-minutes']);
	let state;
	try {
		state = forceNamedGate(root, gateName, flags.feature, flags.reason, { maxAgeMinutes });
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	console.log(JSON.stringify(state.gates[gateName]));
	process.exit(EXIT.PASS);
}

// S4 (D-gate-history): un-passes a gate. Distinct from `force` (which asserts a pass a check
// couldn't earn) -- revoke retracts one that's already there, e.g. a human decides a prior force
// or a stale-but-still-token-matching pass shouldn't be trusted after all.
function cmdGateRevoke(args) {
	const flags = parseCommand('gate revoke', args);
	if (flags.help) { console.log(renderCommandHelp('gate revoke')); process.exit(0); }
	setContext('gate revoke', flags);
	const root = requireRepoRoot();
	const gateName = flags._[0];
	if (!gateName) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel gate revoke <name> --reason "..." [--feature <id>]');
	resolveGateArg(gateName, flags.feature);
	let state;
	try {
		state = revokeNamedGate(root, gateName, flags.feature, flags.reason);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	console.log(JSON.stringify(state.gates[gateName]));
	process.exit(EXIT_CODES.NOT_PASSED);
}

// S4 (D-gate-history): reads the append-only .sbf/<feature>.history.jsonl -- a corrupt/invalid
// line is skipped with a warning, not a hard failure, matching JSONL's own resilience rationale
// (see lib/state.mjs's appendGateEvent).
function readGateHistory(root, featureId, gateName) {
	const file = historyPath(root, featureId);
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
	const events = [];
	for (const [i, line] of lines.entries()) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			console.error(`warning: ${file}:${i + 1}: not valid JSON, skipped`);
			continue;
		}
		const { ok, errors } = validateAgainstSchema('gate-event.schema.json', parsed);
		if (!ok) {
			console.error(`warning: ${file}:${i + 1}: does not match schemas/gate-event.schema.json, skipped:\n${formatSchemaErrors(errors).join('\n')}`);
			continue;
		}
		if (parsed.gate === gateName) events.push(parsed);
	}
	return events;
}

function cmdGateHistory(args) {
	const flags = parseCommand('gate history', args);
	if (flags.help) { console.log(renderCommandHelp('gate history')); process.exit(0); }
	setContext('gate history', flags);
	const root = requireRepoRoot();
	const gateName = flags._[0];
	if (!gateName) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel gate history <name> [--feature <id>] [--json]');
	resolveGateArg(gateName, flags.feature);
	const events = readGateHistory(root, flags.feature, gateName);
	if (flags.json) {
		console.log(JSON.stringify(events, null, 2));
	} else if (events.length === 0) {
		console.log(`no history recorded for gate "${gateName}" (feature ${flags.feature})`);
	} else {
		for (const e of events) {
			const detail = e.event === 'force' || e.event === 'revoke' ? ` -- ${e.reason}` : '';
			console.log(`${e.at}  ${e.event.padEnd(20)} status=${e.status}${detail}`);
		}
	}
	process.exit(0);
}

function cmdGateShow(args) {
	const flags = parseCommand('gate show', args);
	if (flags.help) { console.log(renderCommandHelp('gate show')); process.exit(0); }
	setContext('gate show', flags);
	const root = requireRepoRoot();
	const gateName = flags._[0] ?? null;
	if (gateName === null) {
		try {
			requireValidFeatureOrRepoId(flags.feature, REPO_GATE_ID);
		} catch (err) {
			fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
		}
		console.log(JSON.stringify(loadState(root, flags.feature), null, 2));
		process.exit(0);
	}
	const { scopeId } = resolveGateArg(gateName, flags.feature);
	console.log(JSON.stringify({ gate: gateName, feature: scopeId, record: getGate(root, scopeId, gateName) }, null, 2));
	process.exit(0);
}

// Structural enforcement of "preflight blocks everything below it" (see the workflow table in
// SKILL.md) for every feature-scoped command -- not just documented as a step order, checked.
// Ad-hoc `bskel scan` (no --feature) is exempt: it's an explicit side-channel quick-look
// utility outside the gated workflow, same as `bskel gate show`.
function requirePreflightPassed(root) {
	const result = requireNamedGate(root, 'preflight', null);
	if (result.code !== EXIT.PASS) {
		fail(result.code, gateReasonForCode(result.code), `blocked: \`preflight\` gate is ${result.status} -- run \`bskel preflight\` first.`, {
			next_actions: [{ command: 'bskel preflight', reason: 'the preflight gate has not passed yet', mutating: true }],
		});
	}
}

const DISPOSITION_MODES = ['reuse', 'extend', 'replace', 'parallel'];

function deriveTerms(flags) {
	const fromFlag = (flags.terms || '').split(',').map((s) => s.trim()).filter(Boolean);
	const fromFeature = flags.feature ? slugWords(flags.feature) : [];
	return [...new Set([...fromFlag, ...fromFeature])];
}

function cmdScan(args) {
	const flags = parseCommand('scan', args);
	if (flags.help) { console.log(renderCommandHelp('scan')); process.exit(0); }
	setContext('scan', flags);
	const root = requireRepoRoot();
	if (flags.db) {
		console.error('note: --db (Plane C) is not implemented yet -- scanning without it. See DECISIONS.md.');
	}
	const terms = deriveTerms(flags);
	if (terms.length === 0) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel scan [--feature <id>] --terms a,b,c   (need at least one search term, from --terms or a --feature slug)');
	}
	if (flags.feature) {
		requireValidFeatureId(flags.feature);
		requirePreflightPassed(root);
	}

	// G1: a broken adapter file doesn't stop the adapters that DID load, but every `scan` run
	// says so loudly (also see `bskel doctor`, which exits 1 while any of these remain).
	for (const e of LOAD_ERRORS) {
		console.error(`warning: scanner adapter failed to load (${e.file}): ${e.message}`);
	}
	let report;
	try {
		report = runScan({ repoRoot: root, terms });
	} catch (err) {
		// Unreachable with the two shipped adapters (generic-grep's specificity-0 detect() is
		// unconditional) -- becomes reachable the moment a future adapter's detect() is
		// conditional, or two adapters tie at the same specificity. See scanners/index.mjs.
		fail(EXIT_CODES.NOT_PASSED, 'SCAN_FAILED', err.message);
	}
	if (flags.feature) report.feature_id = flags.feature;

	if (!flags.feature) {
		// Ad-hoc mode: no feature_id, no files written, no gate touched -- matches the plan's own
		// example invocation `bskel scan --terms organization` for a quick look before committing
		// to a feature_id.
		if (flags.json) console.log(JSON.stringify(report, null, 2));
		else if (!flags.quiet) console.log(renderScanMarkdown(report));
		// Process-exit audit (post-A3): exitCode, not exit() -- a scan report for a broad term can
		// be large (reproduced live: `scan --terms a --json` against Team-IZ-Backend is 177583
		// bytes; captured via a pipe with the old process.exit(0) here, it truncated at exactly
		// 65536 bytes, the same pipe-buffer-sized cutoff A3 found and fixed in cmdContractEmit).
		// This is a guard-clause exit (more code follows below for the --feature path), so the
		// `return` is required -- exitCode alone does not stop execution the way exit() did.
		process.exitCode = 0;
		return;
	}

	// G3: a low-confidence (generic-grep) scan writes nothing and touches no gate without explicit
	// acknowledgment -- regardless of verdict, including greenfield, which used to auto-pass the
	// scan gate with zero confidence-awareness. The contract stage already refuses a zero-operation
	// contract unconditionally (A5, contracts/completeness.mjs), but generic-grep's route-pattern
	// grep can still mis-score a "collision"/"adjacent" verdict a human would act on in `scan
	// disposition` -- see D-generic-grep-reconnaissance in DECISIONS.md.
	if (report.confidence === 'low' && !flags['accept-low-confidence']) {
		if (flags.json) console.log(JSON.stringify(report, null, 2));
		else if (!flags.quiet) console.log(renderScanMarkdown(report));
		console.error(
			'\nblocked: this scan used the low-confidence generic-grep adapter (route-pattern grep, ' +
			'not a real parser -- collapsed evidence, no operation IDs, never contract-grade). Re-run ' +
			'with --accept-low-confidence to proceed, or point this at a java-spring-shaped repo / use ' +
			'--openapi-file at contract emit for a trustworthy result.',
		);
		// D-process-exit-audit: bounded by the report size already audited for the ad-hoc branch
		// above (same report object, same command) -- no pipe-truncation risk. This exit carries a
		// real payload (the report, already printed above) -- no diagnostic envelope on top of it.
		process.exit(16);
	}

	const dir = specDir(root, flags.feature);
	fs.mkdirSync(dir, { recursive: true });
	writeScanReportOrExit(specPath(root, flags.feature, 'brownfield-scan.json'), report);
	writeFileAtomic(specPath(root, flags.feature, 'brownfield-scan.md'), renderScanMarkdown(report));

	let gateState;
	if (report.verdict === 'greenfield') {
		gateState = passNamedGate(root, 'scan', flags.feature, { verdict: report.verdict });
	} else {
		gateState = awaitNamedGateDisposition(root, 'scan', flags.feature, {
			verdict: report.verdict,
			related_modules: report.related_modules.map((m) => m.module),
		});
	}

	if (flags.json) {
		console.log(JSON.stringify(report, null, 2));
	} else if (!flags.quiet) {
		console.log(renderScanMarkdown(report));
		console.log(`gate: scan -> ${gateState.gates.scan.status}`);
		if (report.verdict !== 'greenfield') {
			console.log(`\nblocked: run \`bskel scan disposition --feature ${flags.feature} --mode reuse|extend|replace|parallel --note "..."\` before continuing.`);
		}
	}
	// Same truncation risk as the ad-hoc branch above, and the last statement in this function --
	// safe to set exitCode directly, nothing else pending in this call path.
	process.exitCode = report.verdict === 'greenfield' ? EXIT.PASS : EXIT.AWAITING_DISPOSITION;
}

function cmdScanDisposition(args) {
	const flags = parseCommand('scan disposition', args);
	if (flags.help) { console.log(renderCommandHelp('scan disposition')); process.exit(0); }
	setContext('scan disposition', flags);
	const root = requireRepoRoot();
	requireValidFeatureId(flags.feature);
	if (!DISPOSITION_MODES.includes(flags.mode)) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `--mode must be one of: ${DISPOSITION_MODES.join(', ')}`);
	}
	if (flags.mode === 'replace' && !flags['breaking-approved']) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', '--mode replace requires --breaking-approved (this is a deliberate speed bump, not a bug)');
	}

	const reportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	const report = loadScanReportOrExit(root, flags.feature);
	report.feature_id = flags.feature;
	report.disposition = { mode: flags.mode, note: flags.note, at: new Date().toISOString() };
	writeScanReportOrExit(reportPath, report);
	writeFileAtomic(specPath(root, flags.feature, 'brownfield-scan.md'), renderScanMarkdown(report));
	const planConstraints = renderPlanConstraints(report);
	if (planConstraints) {
		writeFileAtomic(specPath(root, flags.feature, 'plan-constraints.md'), planConstraints);
	}

	const gateState = passNamedGate(root, 'scan', flags.feature, { verdict: report.verdict, disposition_mode: flags.mode });
	console.log(JSON.stringify(gateState.gates.scan));
	process.exit(EXIT.PASS);
}

// D-scanner-evidence (D3): reads the ALREADY-PERSISTED scan report (loadScanReportOrExit, same
// validated choke point every other scan-report reader uses) rather than recomputing evidence --
// `bskel scan` is the only place evidence is ever calculated; this command only explains what
// that run already found and wrote to disk.
function cmdScanExplain(args) {
	const flags = parseCommand('scan explain', args);
	if (flags.help) { console.log(renderCommandHelp('scan explain')); process.exit(0); }
	setContext('scan explain', flags);
	const root = requireRepoRoot();
	requireValidFeatureId(flags.feature);
	const moduleName = flags._[0];
	if (!moduleName) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel scan explain <module> --feature <id> [--json]');
	}
	const report = loadScanReportOrExit(root, flags.feature);
	const mod = report.related_modules.find((m) => m.module === moduleName);
	if (!mod) {
		const known = report.related_modules.map((m) => m.module).join(', ') || '(none)';
		fail(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no module "${moduleName}" in this scan report's related_modules -- known modules: ${known}`);
	}
	if (flags.json) {
		console.log(JSON.stringify(mod, null, 2));
	} else {
		console.log(renderScanExplain(mod));
	}
	process.exit(0);
}

// D6 (D-feature-lifecycle): the whole read-specs/->compute-NNN->write-feature.json->
// load-modify-save-feature-index.json sequence runs under one exclusive lock -- confirmed live
// during this item's own grounding, the same lost-update shape S5 already fixed for setGate():
// two concurrent `feature init` calls (same slug) could silently overwrite feature.json, and
// feature-index.json's own load->modify->save raced independently of that. `'feature-index'` is
// a distinct lock name from `'state'` (gate/waiver writes) so this doesn't unnecessarily
// serialize against unrelated `gate`/`contract waive` calls.
function cmdFeatureInit(args) {
	const flags = parseCommand('feature init', args);
	if (flags.help) { console.log(renderCommandHelp('feature init')); process.exit(0); }
	setContext('feature init', flags);
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	requireValidSlug(flags.slug);

	const record = withLockSync(root, 'feature-index', () => {
		const featureId = `${nextFeatureNumber(path.join(root, 'specs'))}-${flags.slug}`;
		const featureUid = randomUUID();
		const rec = { schema: 'sbf.feature/1', feature_id: featureId, feature_uid: featureUid, created_at: new Date().toISOString() };
		saveFeatureFile(root, featureId, rec);

		const index = loadFeatureIndex(root);
		index.by_uid[featureUid] = [featureId];
		saveFeatureIndex(root, index);

		return rec;
	});

	console.log(JSON.stringify(record));
	process.exit(0);
}

function loadFeatureRecord(root, featureId) {
	const record = loadFeatureFile(root, featureId);
	if (!record) {
		fail(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no feature.json at specs/${featureId}/ -- run \`bskel feature init --slug ${slugWords(featureId).join('-')}\` first (or hand-write specs/${featureId}/feature.json with a minted feature_uid)`);
	}
	return record;
}

// D6: scans specs/*/feature.json directly (lib/featurelifecycle.mjs::listFeatures) -- archived
// features are hidden by default, --all shows everything.
function cmdFeatureList(args) {
	const flags = parseCommand('feature list', args);
	if (flags.help) { console.log(renderCommandHelp('feature list')); process.exit(0); }
	setContext('feature list', flags);
	const root = requireRepoRoot();
	const records = listFeatures(root, { includeArchived: flags.all });

	if (flags.json) {
		console.log(JSON.stringify(records, null, 2));
	} else if (records.length === 0) {
		console.log('no features found -- run `bskel feature init --slug <name>` to create one.');
	} else {
		for (const r of records) {
			const archivedNote = r.archived_at ? ` [archived: ${r.archived_reason}]` : '';
			console.log(`${r.feature_id}  ${r.feature_uid}  ${r.created_at}${archivedNote}`);
		}
	}
	process.exit(0);
}

// D6: feature-IDENTITY metadata (id/uid/created_at/archived/rename history/merge cross-
// reference/artifact-existence summary) -- deliberately NOT gate/workflow status, which
// `bskel status --feature <id>` (D1) already owns. Confirmed non-overlapping by reading
// cmdStatus's own output shape before designing this.
function cmdFeatureShow(args) {
	const flags = parseCommand('feature show', args);
	if (flags.help) { console.log(renderCommandHelp('feature show')); process.exit(0); }
	setContext('feature show', flags);
	const root = requireRepoRoot();
	const featureId = flags._[0];
	if (!featureId) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel feature show <id> [--json]');
	requireValidFeatureId(featureId);
	const record = loadFeatureRecord(root, featureId);

	const index = loadFeatureIndex(root);
	const uid = uidForFeatureId(index, featureId);
	const renameHistory = uid ? index.by_uid[uid] : [featureId];
	const mergedInto = index.merged_into?.[featureId] ?? null;
	const artifacts = {
		contract_emitted: fs.existsSync(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
		handles_migration_present: fs.existsSync(specPath(root, featureId, 'handles', 'migration.sql')),
	};

	if (flags.json) {
		console.log(JSON.stringify({ ...record, rename_history: renameHistory, merged_into: mergedInto, artifacts }, null, 2));
	} else {
		console.log(`# ${record.feature_id}`);
		console.log(`- feature_uid: ${record.feature_uid}`);
		console.log(`- created_at: ${record.created_at}`);
		if (record.archived_at) console.log(`- archived: ${record.archived_at} (${record.archived_reason})`);
		if (renameHistory.length > 1) console.log(`- previously known as: ${renameHistory.slice(0, -1).join(', ')}`);
		if (mergedInto) console.log(`- merged into: ${mergedInto} (specs/handles/gate state were NOT moved -- see \`bskel feature link\`)`);
		console.log(`- contract emitted: ${artifacts.contract_emitted}`);
		console.log(`- handles migration present: ${artifacts.handles_migration_present}`);
	}
	process.exit(0);
}

function requireLifecycleReason(commandName, reason) {
	if (!reason || !reason.trim()) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `${commandName} requires --reason "..." -- every identity change must be auditable`);
	}
}

// D6: a bskel-internal control-flow error carrying a real exit code/reason -- thrown from INSIDE
// a withLockSync() callback and caught OUTSIDE it, after the lock has actually been released.
// Found live, not designed in from the start: an early draft called fail() (which calls
// process.exit() directly) from inside the locked callback for a collision/missing-feature
// check -- process.exit() does NOT run pending `finally` blocks the way a thrown exception does,
// so lib/lock.mjs's own `finally { fs.rmSync(lockPath) }` never ran, leaving the lock directory
// behind forever and hanging every subsequent `feature init`/`rename`/`link` call in that repo.
// A real `throw` (unlike process.exit()) DOES unwind through withLockSync's finally correctly --
// this class exists so the CLI-facing exit code/reason survive that unwind to be reported once
// safely outside the lock.
class LockedCommandFailure extends Error {
	constructor(code, reason, message) {
		super(message);
		this.code = code;
		this.reason = reason;
	}
}

function runLockedOrFail(root, lockName, fn) {
	try {
		return withLockSync(root, lockName, fn);
	} catch (err) {
		if (err instanceof LockedCommandFailure) fail(err.code, err.reason, err.message);
		throw err;
	}
}

// D6: the whole validate-then-migrate-then-index-update sequence runs under the SAME
// 'feature-index' lock `feature init` uses -- a rename racing another rename (or an init) must
// not interleave. Collision is checked INSIDE the lock, right before any mutation, to avoid a
// TOCTOU on the check itself; slug/reason validation happens outside the lock (fails fast, no
// need to hold it for a purely local validation). See lib/featurelifecycle.mjs::
// renameFeatureArtifacts() for the full migration this performs.
function cmdFeatureRename(args) {
	const flags = parseCommand('feature rename', args);
	if (flags.help) { console.log(renderCommandHelp('feature rename')); process.exit(0); }
	setContext('feature rename', flags);
	const root = requireRepoRoot();
	const oldId = flags._[0];
	if (!oldId) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel feature rename <id> --to <new-slug> --reason "..." [--json]');
	requireValidFeatureId(oldId);
	requireValidSlug(flags.to);
	requireLifecycleReason('bskel feature rename', flags.reason);

	const record = runLockedOrFail(root, 'feature-index', () => {
		const existing = loadFeatureFile(root, oldId);
		if (!existing) {
			throw new LockedCommandFailure(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no feature.json at specs/${oldId}/`);
		}
		const nnn = oldId.match(/^[0-9]{3}/)[0];
		const newId = `${nnn}-${flags.to}`;
		if (newId === oldId) {
			throw new LockedCommandFailure(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `--to "${flags.to}" produces the same feature_id ("${newId}") -- nothing to rename`);
		}
		const index = loadFeatureIndex(root);
		if (featureIdInUse(root, index, newId)) {
			throw new LockedCommandFailure(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `"${newId}" is already in use (an existing specs/ directory or a retired id already in the feature index) -- choose a different --to`);
		}

		renameFeatureArtifacts(root, oldId, newId);

		index.by_uid[existing.feature_uid] = [...(index.by_uid[existing.feature_uid] ?? [oldId]), newId];
		saveFeatureIndex(root, index);

		return loadFeatureFile(root, newId);
	});

	console.log(flags.json ? JSON.stringify(record, null, 2) : `renamed ${oldId} -> ${record.feature_id}`);
	process.exit(0);
}

// D6: index-only (lib/featurelifecycle.mjs::linkFeature) -- deliberately does NOT touch either
// feature's specs/.sbf/ artifacts or attempt to merge scan/contract/handles state. See
// DECISIONS.md D-feature-lifecycle for why an automatic merge was rejected.
function cmdFeatureLink(args) {
	const flags = parseCommand('feature link', args);
	if (flags.help) { console.log(renderCommandHelp('feature link')); process.exit(0); }
	setContext('feature link', flags);
	const root = requireRepoRoot();
	const keepId = flags._[0];
	const aliasId = flags._[1];
	if (!keepId || !aliasId) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel feature link <keepId> <aliasId> --reason "..." [--json]');
	requireValidFeatureId(keepId);
	requireValidFeatureId(aliasId);
	if (keepId === aliasId) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'bskel feature link requires two DIFFERENT feature ids');
	requireLifecycleReason('bskel feature link', flags.reason);

	const index = runLockedOrFail(root, 'feature-index', () => {
		for (const id of [keepId, aliasId]) {
			if (!loadFeatureFile(root, id)) {
				throw new LockedCommandFailure(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no feature.json at specs/${id}/`);
			}
		}
		const idx = loadFeatureIndex(root);
		linkFeature(idx, keepId, aliasId);
		saveFeatureIndex(root, idx);
		return idx;
	});

	if (flags.json) {
		console.log(JSON.stringify({ merged_into: index.merged_into }, null, 2));
	} else {
		console.log(`${aliasId} is now linked to ${keepId} -- specs/ and .sbf/ state for BOTH features are unchanged, this only records the cross-reference (reason: ${flags.reason})`);
	}
	process.exit(0);
}

// D6: soft-delete only (lib/featurelifecycle.mjs::archiveFeature) -- sets archived_at in place,
// no filesystem move, no lock needed (a single feature.json write, no cross-file coordination).
function cmdFeatureArchive(args) {
	const flags = parseCommand('feature archive', args);
	if (flags.help) { console.log(renderCommandHelp('feature archive')); process.exit(0); }
	setContext('feature archive', flags);
	const root = requireRepoRoot();
	const featureId = flags._[0];
	if (!featureId) fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'usage: bskel feature archive <id> --reason "..." [--json]');
	requireValidFeatureId(featureId);
	requireLifecycleReason('bskel feature archive', flags.reason);
	loadFeatureRecord(root, featureId); // exits cleanly if the feature doesn't exist
	const updated = archiveFeature(root, featureId, flags.reason);

	console.log(flags.json ? JSON.stringify(updated, null, 2) : `archived ${featureId} (${flags.reason})`);
	process.exit(0);
}

// G1: intercepts BEFORE any adapter-specific codegen runs (in particular, before
// detectBasePackageOrExit's Spring-only base-package detection below) -- a repo scanned by an
// adapter that doesn't declare what this command needs gets an honest, actionable message
// instead of a confusing framework-specific failure. Before this existed, a generic-grep-scanned
// repo's ONLY visible error at `handles plan`/`handles emit` was detectBasePackageOrExit's "is
// this a Spring Boot project?" -- which reads as a broken Spring detector, not "the adapter that
// scanned this repo doesn't support handle codegen". See D-adapter-registry in DECISIONS.md.
// G2: `satisfiedBy` is a Set of flag names the caller has already confirmed were passed (e.g.
// `--openapi-file`) -- when a missing capability has a CAPABILITY_SATISFIERS entry and its flag is
// in this set, the check is skipped for that capability specifically. See CAPABILITY_SATISFIERS in
// scanners/capabilities.mjs for why this lives as data there, not as adapter- or command-specific
// logic here.
function requireCapabilitiesOrExit(scanReport, command, { featureId, scanReportPath, satisfiedBy = new Set() }) {
	const adapter = adapterById(ADAPTERS, scanReport.adapter);
	if (!adapter) {
		const loadErr = LOAD_ERRORS.find((e) => path.basename(e.file, '.mjs') === scanReport.adapter);
		const message = loadErr
			? `blocked: the "${scanReport.adapter}" adapter that produced this scan report failed to load: ${loadErr.message}`
			: `blocked: this scan report was produced by adapter "${scanReport.adapter}", which this installed version of backend-skeleton does not have -- re-run \`bskel scan --feature ${featureId}\`.`;
		fail(EXIT_CODES.NOT_PASSED, 'ADAPTER_UNAVAILABLE', message);
	}
	for (const capability of COMMAND_CAPABILITIES[command] ?? []) {
		if (adapter.capabilities[capability]) continue;
		const satisfier = CAPABILITY_SATISFIERS[capability];
		if (satisfier && satisfiedBy.has(satisfier.flag)) continue;
		fail(EXIT_CODES.MISSING_CAPABILITY, 'MISSING_CAPABILITY', explainMissingCapability({ adapterId: adapter.id, capability, command, featureId, scanReportPath }));
	}
}

function cmdContractEmit(args) {
	const flags = parseCommand('contract emit', args);
	if (flags.help) { console.log(renderCommandHelp('contract emit')); process.exit(0); }
	setContext('contract emit', flags);
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	requireValidFeatureId(flags.feature);

	// Contract emission is only meaningful once the scan gate has actually passed (greenfield
	// auto-pass, or a recorded disposition) -- an unresolved collision must not be allowed to
	// silently flow into a contract as if it had been addressed.
	const scanResult = requireNamedGate(root, 'scan', flags.feature);
	if (scanResult.code !== EXIT.PASS) {
		fail(scanResult.code, gateReasonForCode(scanResult.code), `blocked: \`scan\` gate for ${flags.feature} is ${scanResult.status} -- run \`bskel scan --feature ${flags.feature}\` (and \`scan disposition\` if it collides) first.`, {
			next_actions: [{ command: `bskel scan --feature ${flags.feature}`, reason: 'the scan gate has not passed yet', mutating: true }],
		});
	}

	const scanReportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	if (!fs.existsSync(scanReportPath)) {
		fail(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no scan report at ${scanReportPath} -- run \`bskel scan --feature ${flags.feature}\` first`);
	}
	const scanReport = JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
	requireCapabilitiesOrExit(scanReport, 'contract emit', {
		featureId: flags.feature,
		scanReportPath,
		satisfiedBy: flags['openapi-file'] ? new Set(['openapi-file']) : undefined,
	});
	const featureRecord = loadFeatureRecord(root, flags.feature);

	// A1: computed before anything is written -- a bad --openapi-file (missing/unreadable/
	// malformed/oversized) or an invalid --path-prefix must not leave a half-updated contract or
	// touch the gate at all.
	let reconciliation = null;
	if (flags['openapi-file']) {
		const targetModule = selectModule(scanReport, flags.module);
		if (targetModule) {
			const result = buildReconciliation({ filePath: flags['openapi-file'], module: targetModule, pathPrefix: flags['path-prefix'] });
			if (!result.ok) {
				fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', result.error);
			}
			reconciliation = result;
		}
		// else: no module matched at all -- buildContract()'s existing CONTRACT_NO_MODULE/
		// CONTRACT_EMPTY handling takes over unchanged; there is nothing to reconcile against.
	}

	const contract = buildContract({
		featureId: flags.feature,
		featureUid: featureRecord.feature_uid,
		scanReport,
		module: flags.module,
		openapi: reconciliation,
	});

	// Written unconditionally, even when blocked/partial -- what the scan actually found is a
	// real artifact worth inspecting, not just a side effect of a fully-passing run.
	// S5 (D-persistence-integrity): validated before it touches disk -- same "fail loud here, not
	// later" reasoning as every other write site this item touched.
	{
		const { ok, errors } = validateAgainstSchema('feature-contract.schema.json', contract);
		if (!ok) {
			fail(EXIT_CODES.NOT_PASSED, 'INVALID_ARTIFACT', `refusing to write an invalid contract:\n${formatSchemaErrors(errors).join('\n')}`);
		}
	}
	writeFileAtomic(specPath(root, flags.feature, 'contracts', `${flags.feature}.schema.json`), `${JSON.stringify(contract, null, 2)}\n`);

	// A1: written BEFORE the gate is passed/awaited below -- lib/gate-definitions.mjs's contract
	// token reads this file's hash at that moment, so writing it after would leave the gate
	// looking at a stale (pre-snapshot) token.
	const snapshotPath = specPath(root, flags.feature, 'contracts', `${flags.feature}.openapi.snapshot.json`);
	if (reconciliation) {
		const sourceFile = describeSourceFile(root, flags['openapi-file']);
		const snapshot = snapshotFromReconciliation(reconciliation, { featureId: flags.feature, sourceFile });
		writeFileAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	} else if (fs.existsSync(snapshotPath)) {
		// A5-style conservative handling: a snapshot from a PREVIOUS --openapi-file run is not
		// deleted just because this run didn't pass one -- deleting it here would also silently
		// invalidate the contract gate's token (see lib/gate-definitions.mjs).
		console.error(`note: an OpenAPI reconciliation snapshot from a previous run exists (specs/${flags.feature}/contracts/${flags.feature}.openapi.snapshot.json) but --openapi-file was not given this time -- left as-is.`);
	}
	// A2: unconditional (not gated behind !flags.json), same as the snapshot-reuse note above --
	// a diagnostic side-channel note belongs on stderr regardless of what shape stdout takes.
	if (reconciliation && !reconciliation.schemaProjection.enabled) {
		console.error(`note: OpenAPI document declares version "${reconciliation.document.openapi_version ?? '(unknown)'}" -- schema projection needs 3.1.x, path/verb reconciliation above is unaffected`);
	}

	const resolution = loadResolution(root, flags.feature);
	const evaluation = evaluateResolution(contract, resolution);
	const evidence = {
		operation_count: contract.completeness.operation_count,
		endpoint_count: contract.completeness.endpoint_count,
		completeness: evaluation.status,
		warning_codes: countByCode(contract.warnings),
		waived_count: evaluation.waived.length,
		stale_waivers: evaluation.staleWaivers.length,
		openapi: reconciliation
			? {
				applied: true,
				document_hash: reconciliation.document.hash,
				path_prefix: reconciliation.prefix.value,
				prefix_origin: reconciliation.prefix.origin,
				// A2: schema_projection + the schema_resolved/unresolved/none/skipped_media_type
				// counters arrive for free via this spread -- reconciliation.stats already carries
				// them (initialized in contracts/openapi.mjs's reconcileModule), no separate
				// derivation needed here.
				schema_projection: reconciliation.schemaProjection,
				...reconciliation.stats,
			}
			: { applied: false },
	};
	// A5: "schema emitted" (this always happens) is not "complete enough to trust" (this gates).
	// A partial/blocked contract awaits a human decision the same way an unresolved scan
	// collision does -- awaiting_disposition, not a silent pass. See D-contract-completeness.
	const gateState = evaluation.blocking
		? awaitNamedGateDisposition(root, 'contract', flags.feature, { ...evidence, unwaived: evaluation.unwaived.map(({ code, subject }) => ({ code, subject })) })
		: passNamedGate(root, 'contract', flags.feature, evidence);

	if (flags.json) {
		console.log(JSON.stringify(contract, null, 2));
	} else {
		if (!flags.quiet) {
			console.log(`wrote specs/${flags.feature}/contracts/${flags.feature}.schema.json -- ${contract.completeness.operation_count} operation(s), completeness: ${evaluation.status}`);
			if (reconciliation) {
				console.log(`openapi: ${reconciliation.stats.matched} path(s) corrected, ${reconciliation.stats.adopted} adopted (prefix ${reconciliation.prefix.value ?? '(none)'}, ${reconciliation.prefix.origin})`);
				if (reconciliation.schemaProjection.enabled) {
					const s = reconciliation.stats;
					console.log(`openapi: ${s.schema_resolved} request body schema(s) projected, ${s.schema_unresolved} unresolved`);
					console.log(`openapi: ${s.response_schema_resolved} response + ${s.error_schema_resolved} error schema(s) projected, ${s.response_schema_unresolved + s.error_schema_unresolved} unresolved`);
				}
			}
		}
		for (const w of contract.warnings) console.error(`warning[${w.severity}] ${w.code}${w.subject ? ` (${w.subject})` : ''}: ${w.message}`);
		if (!flags.quiet) console.log(`gate: contract -> ${gateState.gates.contract.status}`);
		if (evaluation.staleWaivers.length > 0) {
			console.error(`\nnote: ${evaluation.staleWaivers.length} recorded waiver(s) no longer match any current warning (kept as-is, not auto-removed):`);
			for (const w of evaluation.staleWaivers) console.error(`  ${w.code} (${w.subject ?? '*'})`);
		}
		if (evaluation.blocking) {
			if (evaluation.status === 'blocked') {
				console.error(`\nblocked: this contract has zero operations and cannot be waived -- fix --module/--terms, or run \`bskel gate force contract --feature ${flags.feature} --reason "..."\` if this module genuinely has no HTTP surface (yet).`);
			} else {
				const byCode = {};
				for (const w of evaluation.unwaived) (byCode[w.code] ??= []).push(w);
				console.error(`\nblocked: ${evaluation.unwaived.length} unresolved warning(s):`);
				for (const [code, group] of Object.entries(byCode)) {
					for (const w of group) console.error(`  bskel contract waive --feature ${flags.feature} --code ${code} --subject "${w.subject}" --reason "..."`);
					console.error(`  # or all ${group.length} at once: bskel contract waive --feature ${flags.feature} --code ${code} --all --reason "..."`);
				}
			}
		}
	}
	// A3: NOT process.exit() here -- found live, during real Team-IZ-Backend verification, not
	// a hypothetical. A large `--json` contract (organization/member/projectexecution-sized,
	// now routinely >64KB once response/error schemas are projected) written to a PIPE (not a
	// TTY or a file) can have its stdout write still in flight when process.exit() forcibly
	// tears the process down -- Node does not guarantee a pending async pipe write completes
	// first. Reproduced directly: `contract emit --json` captured via a subshell truncated at
	// exactly 65536 bytes (a classic pipe-buffer-sized cutoff) while the same command redirected
	// to a file wrote its full, correct length. Setting exitCode (not calling exit()) lets the
	// event loop drain -- including flushing this write -- before Node exits on its own with the
	// same code. This is the last statement in this function, and cmdContractEmit is the last
	// thing `main()` calls on this path, so there is nothing else pending that exitCode would
	// incorrectly keep alive.
	process.exitCode = evaluation.blocking ? EXIT.AWAITING_DISPOSITION : EXIT.PASS;
}

function loadContract(root, featureId) {
	const contractPath = specPath(root, featureId, 'contracts', `${featureId}.schema.json`);
	if (!fs.existsSync(contractPath)) {
		fail(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no contract at ${contractPath} -- run \`bskel contract emit --feature ${featureId}\` first`);
	}
	const parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
	// S5 (D-persistence-integrity): validated against schemas/feature-contract.schema.json (the
	// meta-schema for THIS file's own shape -- not the same as contracts/validate.mjs, which
	// validates a runtime agent envelope's PAYLOAD against one operation inside an already-valid
	// contract).
	const { ok, errors } = validateAgainstSchema('feature-contract.schema.json', parsed);
	if (!ok) {
		fail(EXIT_CODES.NOT_PASSED, 'INVALID_ARTIFACT', `${contractPath}: does not match schemas/feature-contract.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

// A5: the `scan disposition` of contracts -- lets a human explicitly accept a `partial`
// contract's outstanding warnings so the `contract` gate can pass. Deliberately no wildcard
// waiver: `--all` expands to the SPECIFIC code+subject pairs present right now, recorded as
// individual entries -- a warning that doesn't exist yet (e.g. a new unannotated endpoint added
// later) is never covered by an old waive. See D-contract-completeness in DECISIONS.md.
function cmdContractWaive(args) {
	const flags = parseCommand('contract waive', args);
	if (flags.help) { console.log(renderCommandHelp('contract waive')); process.exit(0); }
	setContext('contract waive', flags);
	const root = requireRepoRoot();
	const usageText = 'usage: bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path" | --all) --reason "..."';
	try {
		requireWarningCode(flags.code);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	if (!flags.reason || !flags.reason.trim()) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'bskel contract waive requires --reason "..." -- every waiver must be auditable');
	}
	if (!flags.subject && !flags.all) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', usageText);
	}

	const contract = loadContract(root, flags.feature);
	if (contract.completeness.status === 'blocked') {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `\`${flags.feature}\`'s contract has zero operations -- there is nothing to waive. Fix --module/--terms, or use \`bskel gate force contract --feature ${flags.feature} --reason "..."\` if this is intentional.`);
	}

	const currentMatches = contract.warnings.filter((w) => w.code === flags.code && w.severity === 'error');
	let toWaive;
	if (flags.all) {
		toWaive = currentMatches;
		if (toWaive.length === 0) {
			fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `no current warning with code "${flags.code}" in this contract -- nothing to waive`);
		}
	} else {
		const match = currentMatches.find((w) => w.subject === flags.subject);
		if (!match) {
			fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `no current warning with code "${flags.code}" and subject "${flags.subject}" in this contract -- known ${flags.code} subjects: ${currentMatches.map((w) => w.subject).join(', ') || '(none)'}`);
		}
		toWaive = [match];
	}

	// S5 (D-persistence-integrity): the whole load-modify-save cycle runs under one lock -- closes
	// the same lost-update race confirmed live in lib/state.mjs's setGate() during this item's own
	// grounding (two concurrent `contract waive` calls could otherwise silently drop one's
	// entries). Locking only the final write (inside saveResolution()) would NOT close this race --
	// the window is between this function's own loadResolution() read and its save, not inside the
	// write call itself.
	const { resolution: updatedResolution, newEntries } = withLockSync(root, 'state', () => {
		const resolution = loadResolution(root, flags.feature);
		const existingKeys = new Set((resolution.waivers ?? []).map(warningKey));
		const at = new Date().toISOString();
		const entries = toWaive
			.filter((w) => !existingKeys.has(warningKey(w)))
			.map((w) => ({ code: w.code, subject: w.subject, reason: flags.reason, at }));
		const next = {
			schema: 'sbf.contract-resolution/1',
			feature_id: flags.feature,
			waivers: [...(resolution.waivers ?? []), ...entries],
		};
		saveResolution(root, flags.feature, next);
		return { resolution: next, newEntries: entries };
	});

	const evaluation = evaluateResolution(contract, updatedResolution);
	const evidence = {
		operation_count: contract.completeness.operation_count,
		endpoint_count: contract.completeness.endpoint_count,
		completeness: evaluation.status,
		warning_codes: countByCode(contract.warnings),
		waived_count: evaluation.waived.length,
		stale_waivers: evaluation.staleWaivers.length,
	};
	const gateState = evaluation.blocking
		? awaitNamedGateDisposition(root, 'contract', flags.feature, { ...evidence, unwaived: evaluation.unwaived.map(({ code, subject }) => ({ code, subject })) })
		: passNamedGate(root, 'contract', flags.feature, evidence);

	if (flags.json) {
		console.log(JSON.stringify({ waived: newEntries, gate: gateState.gates.contract }, null, 2));
	} else {
		if (!flags.quiet) {
			console.log(`waived ${newEntries.length} new warning(s)${newEntries.length < toWaive.length ? ` (${toWaive.length - newEntries.length} already waived)` : ''}`);
			console.log(`gate: contract -> ${gateState.gates.contract.status}`);
		}
		if (evaluation.blocking) {
			console.error(`\nstill blocked: ${evaluation.unwaived.length} unresolved warning(s) remain:`);
			for (const w of evaluation.unwaived) console.error(`  ${w.code} (${w.subject})`);
		}
	}
	process.exit(evaluation.blocking ? EXIT.AWAITING_DISPOSITION : EXIT.PASS);
}

function cmdContractValidate(args) {
	const flags = parseCommand('contract validate', args);
	if (flags.help) { console.log(renderCommandHelp('contract validate')); process.exit(0); }
	setContext('contract validate', flags);
	const root = requireRepoRoot();
	const contract = loadContract(root, flags.feature);
	let envelope;
	try {
		envelope = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `could not read/parse ${flags.file}: ${err.message}`);
	}

	const result = validateEnvelope(envelope, contract);
	console.log(JSON.stringify(result, null, 2));
	// Process-exit audit (post-A3): a validation failure against a schema-rich A2/A3 contract can
	// produce a very large `errors` array under ajv's allErrors:true -- reproduced live: 5000
	// wrong-typed array elements against a real registerTrainees contract produced a real,
	// correct 243926-byte result that a piped capture truncated at exactly 65536 bytes with the
	// old process.exit() here. Last statement in this function -- safe to set exitCode directly.
	// This exit code (0/1) carries a real payload (the result just printed), never a diagnostic
	// envelope on top of it.
	process.exitCode = result.ok ? 0 : 1;
}

function cmdContractToolSchema(args) {
	const flags = parseCommand('contract tool-schema', args);
	if (flags.help) { console.log(renderCommandHelp('contract tool-schema')); process.exit(0); }
	setContext('contract tool-schema', flags);
	const root = requireRepoRoot();
	const contract = loadContract(root, flags.feature);
	// A1: same class of gap as D-security-1 (contracts/validate.mjs's Object.hasOwn fix) --
	// `contract.operations` is a plain object, so `--operation constructor` would otherwise
	// resolve an inherited Object.prototype property and be treated as a real, defined
	// operation. Reachability went up with A1: an operationId can now be adopted directly from
	// an external OpenAPI document, not just from Java source the repo owner controls.
	const op = Object.hasOwn(contract.operations, flags.operation) ? contract.operations[flags.operation] : undefined;
	if (!op) {
		fail(EXIT_CODES.NOT_PASSED, 'UNKNOWN_OPERATION', `operation "${flags.operation}" not in this feature's contract (known: ${Object.keys(contract.operations).join(', ') || '(none)'})`);
	}

	// Anthropic tool-use `input_schema` is a JSON Schema subset -- the operation's payload
	// schema (already plain JSON Schema, no $ref/$defs) is directly usable as-is. A2: when `op`
	// carries a projected `requestBodySchema`, it flows through here for free -- this function
	// changed not at all; contracts/openapi.mjs's inlineSchema() is what guarantees the no-$ref
	// promise this comment makes.
	const toolSchema = {
		name: flags.operation,
		description: `${op.verb} ${op.path} (feature ${flags.feature})`,
		input_schema: operationPayloadSchema(op),
	};
	console.log(JSON.stringify(toolSchema, null, 2));
	process.exit(0);
}

function renderStackPlan(plan) {
	const lines = [`# Stack apply plan: ${plan.choice}`, ''];
	lines.push(plan.alreadyDetected ? '**Already detected as applied** (files/env keys from `detect:` found) -- re-running is idempotent.' : 'Not yet applied.');
	lines.push('');
	lines.push('## Files');
	for (const f of plan.files) lines.push(`- [${f.action}] ${f.path}${f.mode ? ` (mode ${f.mode})` : ''}`);
	lines.push('');
	lines.push('## .env.example entries');
	for (const e of plan.envExampleActions) lines.push(`- [${e.action}] ${e.key}${e.required ? ' (required)' : ''}${e.secret ? ' (secret)' : ''} -- ${e.doc}`);
	lines.push('');
	if (plan.configChecks.length > 0) {
		lines.push('## Config checks (informational -- never auto-patched, see D-config-patch)');
		for (const c of plan.configChecks) lines.push(`- ${c.target}: **${c.status}**${c.status === 'needs-manual-patch' ? `\n  ${c.note}` : ''}`);
	}
	return `${lines.join('\n')}\n`;
}

function cmdStackApply(args) {
	const flags = parseCommand('stack apply', args);
	if (flags.help) { console.log(renderCommandHelp('stack apply')); process.exit(0); }
	setContext('stack apply', flags);
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	if (!flags.choice) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `usage: bskel stack apply --choice <id> [--apply] [--port N]   (known choices: ${listCatalogChoices().join(', ') || '(none)'})`);
	}

	let entry;
	try {
		entry = loadCatalogEntry(flags.choice);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	let plan;
	try {
		plan = planApply(root, entry, { port: Number.parseInt(flags.port, 10) });
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}

	if (!flags.apply) {
		// Dry-run is the default -- nothing is written without an explicit --apply, matching the
		// repo's own "minimal, explicit-approval" convention for anything that touches files.
		if (flags.json) console.log(JSON.stringify(plan, null, 2));
		else if (!flags.quiet) console.log(renderStackPlan(plan));
		process.exit(0);
	}

	let written;
	try {
		written = applyPlan(root, plan);
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}
	// S2: `applied_files` must be this choice's FULL file set in this repo (its desired state),
	// not just whatever `applyPlan()` happened to write THIS run -- applyPlan() skips files whose
	// action is 'unchanged', so a second, idempotent `--apply` used to overwrite this with `[]`,
	// erasing the only record of what the choice owns. That silently gutted the `stack` gate's new
	// applied-file hashing above (nothing left to hash -> nothing left to protect). `written` is
	// still what's reported to the user below -- unchanged output, only the persisted record fixed.
	const appliedFiles = [...new Set([
		...plan.files.map((f) => f.path),
		...(plan.envExampleActions.length > 0 ? ['.env.example'] : []),
	])].sort();
	const stackRecord = {
		schema: 'sbf.stack/1', choice: flags.choice, applied_files: appliedFiles,
		env_example_keys: plan.envExampleActions.map((e) => e.key), at: new Date().toISOString(),
	};
	// S5 (D-persistence-integrity): schemas/stack-record.schema.json is new -- this record had NO
	// schema at all before (not the same file as stack-choice.schema.json, which validates a
	// stack/catalog/<id>.yml CATALOG ENTRY, a completely different persistence boundary). Validated
	// before it touches disk, same "fail loud here" reasoning as every other write site this item
	// touched. No corresponding read helper -- nothing in this codebase reads .sbf/stack.json back
	// (confirmed by grep before adding this), so there's no read boundary to close yet; adding an
	// unused loadStackRecord() export would just be dead code.
	{
		const { ok, errors } = validateAgainstSchema('stack-record.schema.json', stackRecord);
		if (!ok) {
			fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `refusing to write an invalid stack record:\n${formatSchemaErrors(errors).join('\n')}`);
		}
	}
	writeFileAtomic(path.join(root, '.sbf', 'stack.json'), `${JSON.stringify(stackRecord, null, 2)}\n`);

	const gateState = passNamedGate(root, 'stack', null, { choice: flags.choice });

	if (flags.json) {
		console.log(JSON.stringify({ written, gate: gateState.gates.stack }, null, 2));
	} else if (!flags.quiet) {
		console.log(written.length > 0 ? `wrote: ${written.join(', ')}` : 'nothing to write (already up to date)');
		for (const c of plan.configChecks.filter((c) => c.status === 'needs-manual-patch')) {
			console.log(`\nmanual step needed -- ${c.target}:\n${c.note}`);
		}
		console.log(`gate: stack -> ${gateState.gates.stack.status}`);
		console.log(`\nnext: fill in ${entry.static?.env_example?.filter((e) => e.required).map((e) => e.key).join(', ') || 'the required'} in your .env, then run ./${entry.runtime.script}`);
	}
	process.exit(0);
}

// P4 (D-extension-conformance): a {{VAR}}-shaped token that survives a real render -- renderTemplate()
// (stack/apply.mjs) only ever substitutes {PORT}, so anything else left in rendered output is a
// variable no catalog author declared and nothing will ever fill in at apply time. Scanning the
// RENDERED output (not the raw template source) catches this the same way a real `stack apply`
// would produce it, without needing a separate variable-declaration+injection system for a single
// current consumer (see D-extension-conformance in DECISIONS.md for why that was rejected).
const RESIDUAL_TEMPLATE_VAR_RE = /\{\{[A-Z_][A-Z0-9_]*\}\}/g;

// P4: reuses loadCatalogEntry()'s existing schema validation and planApply()'s existing
// assertContained() path-containment checks (template path, target path, config_check target
// path -- all three) unchanged -- lint is just "run planApply() against a throwaway directory
// nothing ever gets written to" rather than a second, parallel validation implementation.
function lintCatalogEntry(choiceId) {
	let entry;
	try {
		entry = loadCatalogEntry(choiceId);
	} catch (err) {
		return { choice: choiceId, ok: false, errors: [err.message] };
	}
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-catalog-lint-'));
	const errors = [];
	try {
		let plan;
		try {
			plan = planApply(scratch, entry, { port: 8080 });
		} catch (err) {
			errors.push(err.message);
			return { choice: choiceId, ok: false, errors };
		}
		for (const f of plan.files) {
			const residual = [...new Set(f.content.match(RESIDUAL_TEMPLATE_VAR_RE) ?? [])];
			for (const token of residual) {
				errors.push(`template for ${f.path} references undeclared variable ${token} -- this will never be substituted`);
			}
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	return { choice: choiceId, ok: errors.length === 0, errors };
}

// P4: deliberately does NOT call requireRepoRoot() -- lint only ever touches this skill's own
// stack/catalog/ (via listCatalogChoices/loadCatalogEntry) and a throwaway scratch directory, so
// an extension author can lint a new catalog entry without even being inside a target repo.
function cmdCatalogLint(args) {
	const flags = parseCommand('catalog lint', args);
	if (flags.help) { console.log(renderCommandHelp('catalog lint')); process.exit(0); }
	setContext('catalog lint', flags);
	const known = listCatalogChoices();
	if (flags._[0] && !known.includes(flags._[0])) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `unknown stack choice "${flags._[0]}" -- known choices: ${known.join(', ') || '(none)'}`);
	}
	const choices = flags._[0] ? [flags._[0]] : known;
	const results = choices.map(lintCatalogEntry);
	const allOk = results.every((r) => r.ok);
	if (flags.json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		for (const r of results) {
			console.log(`${r.ok ? '✔' : '✖'} ${r.choice}`);
			for (const e of r.errors) console.log(`  - ${e}`);
		}
	}
	// P4: CHECK_FAILED (not BAD_ARGS) -- this run itself was valid (a real command with valid
	// flags), the LINTED CONTENT is what's wrong, same distinction bskel already draws elsewhere
	// (e.g. contract emit's completeness verdict vs. a malformed CLI invocation).
	process.exit(allOk ? EXIT_CODES.OK : EXIT_CODES.CHECK_FAILED);
}

// S5 (D-persistence-integrity): the ONE choke point for reading brownfield-scan.json --
// cmdScanDisposition() and cmdContractEmit() used to each duplicate this exact "exists? parse it"
// logic inline; consolidated here so schema validation has a single place to live instead of
// three copies to keep in sync.
function loadScanReportOrExit(root, featureId) {
	const scanReportPath = specPath(root, featureId, 'brownfield-scan.json');
	if (!fs.existsSync(scanReportPath)) {
		fail(EXIT_CODES.NOT_PASSED, 'MISSING_ARTIFACT', `no scan report at ${scanReportPath} -- run \`bskel scan --feature ${featureId}\` first`);
	}
	const parsed = JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
	const { ok, errors } = validateAgainstSchema('scan-report.schema.json', parsed);
	if (!ok) {
		fail(EXIT_CODES.NOT_PASSED, 'INVALID_ARTIFACT', `${scanReportPath}: does not match schemas/scan-report.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

// S5 (D-persistence-integrity): the write-side sibling of loadScanReportOrExit() above -- validated
// before it ever touches disk, same "fail loud here, not as a confusing error somewhere later"
// reasoning as lib/state.mjs's saveState(). Used by both cmdScan()'s own write and
// cmdScanDisposition()'s read-modify-write.
function writeScanReportOrExit(reportPath, report) {
	const { ok, errors } = validateAgainstSchema('scan-report.schema.json', report);
	if (!ok) {
		fail(EXIT_CODES.NOT_PASSED, 'INVALID_ARTIFACT', `refusing to write an invalid scan report to ${reportPath}:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

// D4 (D-handles-dryrun): the marker vocabulary a human report uses for classifyFile()'s 6
// possible actions (+ the java-spring-only 'spec' kind, which reuses the same 3 labels since it's
// classified the same 3-way create/unchanged/update, just outside classifyFile() itself).
const ACTION_MARKERS = { create: '+', unchanged: '=', update: '~', 'adopt-unchanged': '=', 'adopt-update': '~', conflict: '!' };

// D4: shared between `handles plan`'s preview and `handles emit --check`'s report -- both show
// the exact same per-file action list, since they're both now backed by the same
// emitUnits({dryRun:true}) computation. Diff bodies print only when computeDiff was actually
// requested (an action only carries a.diff when it was).
function renderFileActions(actions) {
	const lines = ['## File actions'];
	if (actions.length === 0) {
		lines.push('(no infra/resolver units in scope)');
		return lines.join('\n');
	}
	for (const a of actions) {
		const marker = ACTION_MARKERS[a.action] ?? '?';
		const specNote = a.kind === 'spec' ? ' [spec-owned: always regenerated on a real run, not conflict-tracked]' : '';
		lines.push(`  [${marker}] ${a.action}\t${a.path}${a.resourceType ? ` (${a.resourceType})` : ''}${specNote}`);
		if (a.diff) {
			for (const dl of a.diff.split('\n')) if (dl) lines.push(`      ${dl}`);
		}
	}
	return lines.join('\n');
}

function renderHandlesPlan(plan, actions) {
	const lines = [`# Handles plan: module "${plan.module ?? '(none)'}"`, ''];
	if (plan.resources.length === 0) {
		lines.push('No candidate resources.');
	}
	for (const r of plan.resources) {
		lines.push(`## ${r.type}${r.willGenerateResolver ? '' : ' (resolver will NOT be generated -- see notes)'}`);
		lines.push(`- table: ${r.table ?? '(unknown)'}, PK field: ${r.idField ?? '(unknown)'}`);
		lines.push(`- read via: ${r.readPath ?? '(not found)'}`);
		lines.push(`- requiredAuthority: ${r.requiredAuthority}`);
		lines.push('');
	}
	if (plan.notes.length > 0) {
		lines.push('## Notes');
		for (const n of plan.notes) lines.push(`- ${n}`);
		lines.push('');
	}
	if (actions) lines.push(renderFileActions(actions));
	return `${lines.join('\n')}\n`;
}

// D-handles-providers (G4): selects the codegen provider for this scan report's adapter by exact
// id match -- never arbitrated, since there is nothing to arbitrate (see handles/registry.mjs).
// Reachable only after requireCapabilitiesOrExit has already confirmed codegen.handles === true
// for this adapter, which by construction means a provider SHOULD exist -- the drift-bug branch
// below exists only to fail loudly if that invariant is ever violated (e.g. the provider file
// itself failed to load), not as an expected path.
function selectProviderOrExit(scanReport) {
	const provider = providerById(PROVIDERS, scanReport.adapter);
	if (!provider) {
		const loadErr = PROVIDER_LOAD_ERRORS.find((e) => path.basename(e.file, '.mjs') === scanReport.adapter);
		const message = loadErr
			? `blocked: the "${scanReport.adapter}" codegen provider failed to load: ${loadErr.message}`
			: `blocked: no codegen provider is registered for adapter "${scanReport.adapter}" even though it declares codegen.handles -- this is a drift bug, please report it.`;
		fail(EXIT_CODES.NOT_PASSED, 'PROVIDER_UNAVAILABLE', message);
	}
	return provider;
}

// A provider declares its OWN capability requirements (e.g. java-spring/python-fastapi both need
// `resource.fetch`) separately from the command-level dispatch capability (`codegen.handles`,
// checked by requireCapabilitiesOrExit before the provider is even selected) -- see
// D-handles-providers in DECISIONS.md for why this is two checks, not one.
function requireProviderCapabilitiesOrExit(scanReport, provider, command, { featureId, scanReportPath }) {
	const adapter = adapterById(ADAPTERS, scanReport.adapter);
	for (const capability of provider.requiresCapabilities ?? []) {
		if (adapter.capabilities[capability]) continue;
		fail(EXIT_CODES.MISSING_CAPABILITY, 'MISSING_CAPABILITY', explainMissingCapability({ adapterId: adapter.id, capability, command, featureId, scanReportPath }));
	}
}

function cmdHandlesPlan(args) {
	const flags = parseCommand('handles plan', args);
	if (flags.help) { console.log(renderCommandHelp('handles plan')); process.exit(0); }
	setContext('handles plan', flags);
	const root = requireRepoRoot();
	const scanReport = loadScanReportOrExit(root, flags.feature);
	const scanReportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	requireCapabilitiesOrExit(scanReport, 'handles plan', { featureId: flags.feature, scanReportPath });
	const provider = selectProviderOrExit(scanReport);
	requireProviderCapabilitiesOrExit(scanReport, provider, 'handles plan', { featureId: flags.feature, scanReportPath });
	const resourceFilter = flags.resource ? flags.resource.split(',').map((s) => s.trim()).filter(Boolean) : null;

	let plan;
	try {
		plan = provider.plan({ repoRoot: root, scanReport, module: flags.module, resourceFilter });
	} catch (err) {
		fail(EXIT_CODES.NOT_PASSED, 'PLAN_FAILED', err.message);
	}
	// D4 (D-handles-dryrun): a dry, never-writing preview of exactly what `handles emit` would do
	// to disk -- reuses the identical classifyFile()-backed engine `handles emit` itself calls,
	// just with dryRun:true. Always computed (cheap: no diff bodies unless --diff asks for them),
	// so `handles plan` becomes a true pre-write plan, not just an abstract resource list. Does NOT
	// require the contract gate -- same as the rest of this command, unaffected by this addition
	// since dryRun never writes.
	let actions;
	try {
		({ actions } = provider.emit({ repoRoot: root, featureId: flags.feature, plan, resourceFilter, force: false, reason: '', dryRun: true, computeDiff: flags.diff }));
	} catch (err) {
		fail(EXIT_CODES.NOT_PASSED, 'PLAN_FAILED', err.message);
	}
	console.log(flags.json ? JSON.stringify({ ...plan, actions }, null, 2) : renderHandlesPlan(plan, actions));
	process.exit(0);
}

function cmdHandlesEmit(args) {
	const flags = parseCommand('handles emit', args);
	if (flags.help) { console.log(renderCommandHelp('handles emit')); process.exit(0); }
	setContext('handles emit', flags);
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	// O2: mirrors `cmdContractWaive`'s --reason requirement -- every overwrite of a diverged
	// generated file must be auditable, not silent. See DECISIONS.md D-handles-ownership.
	if (flags.force && (!flags.reason || !flags.reason.trim())) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'bskel handles emit --force requires --reason "..." -- every overwrite of diverged generated code must be auditable');
	}

	// Handles are only emitted for a feature whose contract has actually been established --
	// codegen against a feature nobody has scanned/contracted yet has nothing real to route to.
	const contractResult = requireNamedGate(root, 'contract', flags.feature);
	if (contractResult.code !== EXIT.PASS) {
		// A5: awaiting_disposition here almost always means a contract WAS emitted but is
		// partial/blocked (not "never ran") -- "run contract emit first" would be wrong advice in
		// that case, so point at `contract waive`/`gate force` instead.
		const hint = contractResult.status === 'awaiting_disposition'
			? `resolve it first -- \`bskel contract waive --feature ${flags.feature} --code <CODE> (--subject "..."|--all) --reason "..."\`, or \`bskel gate force contract --feature ${flags.feature} --reason "..."\` if intentional.`
			: `run \`bskel contract emit --feature ${flags.feature}\` first.`;
		fail(contractResult.code, gateReasonForCode(contractResult.code), `blocked: \`contract\` gate for ${flags.feature} is ${contractResult.status} -- ${hint}`, {
			next_actions: [{ command: `bskel contract emit --feature ${flags.feature}`, reason: 'the contract gate has not passed yet', mutating: true }],
		});
	}

	const scanReport = loadScanReportOrExit(root, flags.feature);
	const scanReportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	requireCapabilitiesOrExit(scanReport, 'handles emit', { featureId: flags.feature, scanReportPath });
	const provider = selectProviderOrExit(scanReport);
	requireProviderCapabilitiesOrExit(scanReport, provider, 'handles emit', { featureId: flags.feature, scanReportPath });
	const resourceFilter = flags.resource ? flags.resource.split(',').map((s) => s.trim()).filter(Boolean) : null;

	let plan;
	try {
		plan = provider.plan({ repoRoot: root, scanReport, module: flags.module, resourceFilter });
	} catch (err) {
		fail(EXIT_CODES.NOT_PASSED, 'PLAN_FAILED', err.message);
	}
	// D4 (D-handles-dryrun): --diff alone implies --check -- there is no sane reading of "show me
	// a diff" that also means "and actually write it", so --diff forces dryRun the same as --check
	// does, without requiring both flags together.
	const dryRun = flags.check || flags.diff;
	const { written, resolverStubs, conflicts, orphans, notes, forced, blocked, actions, postEmitNotes = [] } = provider.emit({
		repoRoot: root, featureId: flags.feature, plan, resourceFilter, force: flags.force, reason: flags.reason, dryRun, computeDiff: flags.diff,
	});
	// D4: found live while grounding this against a real fixture -- `written` (pre-existing field,
	// unchanged semantics) unconditionally includes a java-spring `outputs.spec` file like
	// migration.sql even when its content is byte-identical (P4 already found this: it's never
	// manifest-tracked, always regenerated). Using `written.length` here would make --check report
	// "something changed" forever for java-spring, even on a truly up-to-date repo. `actions`
	// (this item's own new field) carries the real per-file classification, so it's the correct
	// source for "did anything actually change" -- 'unchanged'/'adopt-unchanged' both mean no.
	const wouldChange = actions.some((a) => a.action !== 'unchanged' && a.action !== 'adopt-unchanged');
	const allNotes = [...plan.notes, ...notes];
	if (flags.force && forced.length === 0 && conflicts.length === 0) allNotes.push('--force had no effect: 0 conflicts found in this run\'s scope');
	else if (flags.force && forced.length > 0) allNotes.push(`--force overwrote ${forced.length} diverged file(s): ${forced.join(', ')}`);

	// O2: a conflict means SOME generated file diverged from what backend-skeleton last wrote --
	// files that were safe to (re)write still were, but the `handles` gate does not pass this run
	// (partial writes are intentional, see D-handles-ownership; blocking the gate on any conflict
	// is not). D4: --check reports the exact same verdict a real run WOULD reach (same exit 15),
	// without ever writing -- `written`/`forced` above already say "would" under dryRun since
	// emitUnits() populates them identically whether or not it actually touched disk.
	if (blocked) {
		if (flags.json) {
			console.log(JSON.stringify({ written, resolverStubs, conflicts, orphans, forced, notes: allNotes, actions, blocked: true, gate: null, check: dryRun }, null, 2));
		} else {
			const verb = dryRun ? 'would be blocked' : 'blocked';
			console.error(`${verb}: ${conflicts.length} generated file(s) diverged from what backend-skeleton last wrote -- ${dryRun ? 'a real run would refuse to overwrite them' : 'refusing to overwrite'} without --force:`);
			for (const c of conflicts) console.error(`  ${c.path} (${c.kind}${c.resourceType ? `: ${c.resourceType}` : ''})\n    ${c.reason}`);
			if (written.length > 0) {
				console.error(`\n${written.length} other file(s) ${dryRun ? 'would still be written' : 'were still written this run'}:`);
				for (const w of written) console.error(`  ${w}`);
			}
			if (!dryRun) console.error(`\nre-run with: bskel handles emit --feature ${flags.feature}${flags.module ? ` --module ${flags.module}` : ''}${flags.resource ? ` --resource ${flags.resource}` : ''} --force --reason "..."`);
			if (orphans.length > 0) {
				console.error('\norphaned (previously generated, no longer in the current plan -- left untouched):');
				for (const o of orphans) console.error(`  ${o.path} (${o.resourceType})`);
			}
			if (dryRun) console.error(`\n${renderFileActions(actions)}`);
		}
		// D-process-exit-audit: bounded by 7 + plan.resources.length units, no pipe-truncation risk.
		// Carries a real payload (already printed above in --json mode) -- no diagnostic envelope.
		// P4 precedent (catalog lint): reused, not a new exit code -- --check reaching the exact
		// same verdict a real run would (exit 15) is the point, not a distinct "check found a
		// conflict" code.
		process.exit(EXIT_CODES.HANDLES_CONFLICT);
	}

	// D4: dryRun never marks the gate passed -- nothing real happened this run.
	const gateState = dryRun ? null : passNamedGate(root, 'handles', flags.feature, { resolverStubs });

	if (flags.json) {
		console.log(JSON.stringify({ written, resolverStubs, conflicts, orphans, forced, notes: allNotes, actions, blocked: false, gate: gateState?.gates.handles ?? null, check: dryRun, postEmitNotes }, null, 2));
	} else if (!flags.quiet) {
		console.log(`${dryRun ? 'would write' : 'wrote'} ${written.length} file(s):`);
		for (const w of written) console.log(`  ${w}`);
		if (allNotes.length > 0) {
			console.log('\nnotes:');
			for (const n of allNotes) console.log(`  - ${n}`);
		}
		if (orphans.length > 0) {
			console.log('\norphaned (previously generated, no longer in the current plan -- left untouched):');
			for (const o of orphans) console.log(`  ${o.path} (${o.resourceType})`);
		}
		if (dryRun) {
			console.log(`\n${renderFileActions(actions)}`);
		} else {
			console.log(`\ngate: handles -> ${gateState.gates.handles.status}`);
			for (const n of postEmitNotes) console.log(`\n${n}`);
		}
	}
	// D4: --check is CI-friendly by the catalog's own explicit ask -- 0 means fully up to date
	// (every action is 'unchanged'/'adopt-unchanged'), CHECK_FAILED (the same code P4's `catalog
	// lint` established for "this run was valid, the checked content is not") means a real run
	// would actually change something.
	if (dryRun) process.exit(wouldChange ? EXIT_CODES.CHECK_FAILED : EXIT_CODES.OK);
	process.exit(0);
}

// A3 (D-patch-strategy): the explicit human gate that must exist BEFORE handles emit generates
// any patchField() switch-case -- mirrors cmdContractWaive's exact shape (withLockSync, --reason
// required, append-only-by-key record). Re-runs the provider's own plan() to read the CURRENT
// classifier output for {resource, field}, rather than trusting whatever --strategy the caller
// typed -- an approval whose strategy doesn't match what the classifier says RIGHT NOW is
// rejected outright (BAD_ARGS), so a human can never approve a strategy the classifier disagrees
// with, and a stale approval from before a DTO change can never be created in the first place.
function cmdHandlesPatchApprove(args) {
	const flags = parseCommand('handles patch approve', args);
	if (flags.help) { console.log(renderCommandHelp('handles patch approve')); process.exit(0); }
	setContext('handles patch approve', flags);
	const root = requireRepoRoot();
	if (!flags.reason || !flags.reason.trim()) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', 'bskel handles patch approve requires --reason "..." -- every approval must be auditable');
	}

	const scanReport = loadScanReportOrExit(root, flags.feature);
	const scanReportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	requireCapabilitiesOrExit(scanReport, 'handles patch approve', { featureId: flags.feature, scanReportPath });
	const provider = selectProviderOrExit(scanReport);
	requireProviderCapabilitiesOrExit(scanReport, provider, 'handles patch approve', { featureId: flags.feature, scanReportPath });

	let plan;
	try {
		plan = provider.plan({ repoRoot: root, scanReport, module: flags.module, resourceFilter: [flags.resource] });
	} catch (err) {
		fail(EXIT_CODES.NOT_PASSED, 'PLAN_FAILED', err.message);
	}
	const resource = plan.resources.find((r) => r.type === flags.resource);
	if (!resource) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `no resource "${flags.resource}" found in this plan -- known resources: ${plan.resources.map((r) => r.type).join(', ') || '(none)'}`);
	}
	if (resource.updateServiceBlockedReason) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `"${flags.resource}" cannot have any field auto-generated: ${resource.updateServiceBlockedReason}`);
	}
	const field = (resource.patchable ?? []).find((f) => f.field === flags.field);
	if (!field) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `"${flags.resource}.${flags.field}" is not a classified patchable field -- known fields: ${(resource.patchable ?? []).map((f) => f.field).join(', ') || '(none -- see \`bskel handles plan\`\'s notes for why)'}`);
	}
	if (field.bucket !== flags.strategy) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `"${flags.resource}.${flags.field}" is currently classified "${field.bucket}", not "${flags.strategy}" -- re-run \`bskel handles plan\` and approve the strategy it actually reports (the DTO may have changed)`);
	}
	if (field.bucket !== 'patch-wrapper' && field.bucket !== 'null-means-unchanged') {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `"${flags.resource}.${flags.field}" is classified "${field.bucket}" -- this strategy is never auto-generated (see D-patch-strategy in DECISIONS.md), approving it would have no effect`);
	}

	const updated = withLockSync(root, 'state', () => {
		const current = loadPatchApprovals(root, flags.feature);
		const key = approvalKey(flags.resource, flags.field);
		const at = new Date().toISOString();
		const entry = { resource: flags.resource, field: flags.field, strategy: flags.strategy, reason: flags.reason, at };
		const withoutExisting = (current.approvals ?? []).filter((a) => approvalKey(a.resource, a.field) !== key);
		const next = { schema: 'sbf.patch-approvals/1', feature_id: flags.feature, approvals: [...withoutExisting, entry] };
		savePatchApprovals(root, flags.feature, next);
		return next;
	});

	console.log(flags.json ? JSON.stringify(updated, null, 2) : `approved: ${flags.resource}.${flags.field} -> ${flags.strategy}`);
	process.exit(0);
}

// S2: "stale" alone sends a human/agent re-running steps until one happens to stick. Name the
// input that actually moved, using the exact reason requireGate()'s explainStaleness() reports.
function describeStale(g) {
	if (g.status !== 'stale') return '';
	if (g.stale_reason === 'inputs_changed') return ` (stale: ${g.changed_inputs.join(', ')})`;
	if (g.stale_reason === 'no_recorded_inputs') return ' (stale: recorded before input snapshots existed -- re-run this step for a precise reason)';
	if (g.stale_reason === 'recorded_inputs_mismatch') return ' (stale: recorded inputs do not reproduce the recorded token -- .sbf state was hand-edited)';
	return ' (stale)';
}

function renderVerifyReport({ featureId, gates, artifacts, build }) {
	const lines = [`# Verify: ${featureId}`, '', '## Gates'];
	for (const g of gates) {
		const marker = g.code === EXIT.PASS ? 'PASS' : g.blocking ? 'FAIL' : `SKIP (${g.status})`;
		const suffix = g.policy === 'required' ? '' : ` (${g.policy}, ${g.scope}-scoped)`;
		// A5: surfaces the contract gate's completeness (complete/partial/blocked) and how many
		// warnings were waived, right in the verify report -- not just visible via `contract emit`'s
		// own output.
		const evidence = g.record?.evidence;
		const completenessNote = g.gate === 'contract' && evidence?.completeness
			? ` (${evidence.completeness}${evidence.waived_count ? `: ${evidence.waived_count} waived` : ''})`
			: '';
		// S4 (D-gate-history): a revoked gate's reason is exactly the kind of "why is this
		// blocking" detail describeStale() already surfaces for stale gates -- same treatment here.
		const revokedNote = g.status === 'revoked' && g.record?.reason ? ` (revoked: ${g.record.reason})` : '';
		lines.push(`- [${marker}] ${g.gate}${suffix}${completenessNote}${describeStale(g)}${revokedNote}`);
	}
	lines.push('', '## Artifacts');
	for (const a of artifacts) lines.push(`- [${a.exists ? 'OK' : 'MISSING'}] ${a.artifact}: ${a.path}`);
	if (build) {
		lines.push('', '## Build');
		if (!build.ran) {
			lines.push(`- SKIPPED: ${build.message}`);
		} else {
			lines.push(`- [${build.ok ? 'PASS' : 'FAIL'}] ${build.tool}`);
			if (!build.ok) lines.push('', '```', build.message, '```');
		}
	}
	return `${lines.join('\n')}\n`;
}

function cmdVerify(args) {
	const flags = parseCommand('verify', args);
	if (flags.help) { console.log(renderCommandHelp('verify')); process.exit(0); }
	setContext('verify', flags);
	const root = requireRepoRoot();
	const gates = collectGateStatuses(root, flags.feature, { getGate, requireNamedGate });
	const artifacts = checkArtifacts(root, flags.feature, gates);
	const build = flags.build ? runBuildCheck(root) : null;

	const gatesOk = gates.every((g) => !g.blocking);
	const artifactsPresent = artifacts.every((a) => a.exists);
	const buildOk = !build || !build.ran || build.ok;
	const overallPass = gatesOk && artifactsPresent && buildOk;

	if (flags.json) {
		console.log(JSON.stringify({ feature: flags.feature, pass: overallPass, gates, artifacts, build }, null, 2));
	} else if (!flags.quiet) {
		console.log(renderVerifyReport({ featureId: flags.feature, gates, artifacts, build }));
		console.log(overallPass ? 'VERIFY: PASS' : 'VERIFY: FAIL');
	}
	// This exit code (0/1) carries a real payload (the report just printed) -- never a diagnostic
	// envelope on top of it, matching the "one execution, one JSON document" rule.
	process.exit(overallPass ? 0 : 1);
}

// D1: same per-gate line shape renderVerifyReport uses (reusing describeStale), but framed as
// "where am I" rather than a pass/fail verdict -- no VERIFY: PASS/FAIL line, and blocked_by/
// next_actions/optional_not_run are appended so a human doesn't have to re-derive them by eye.
function renderStatusReport(featureId, state) {
	const lines = [`# Status: ${featureId ?? '(no feature -- repo scope only)'}`, '', '## Gates'];
	for (const g of state.gates) {
		const marker = g.code === EXIT.PASS ? 'PASS' : g.blocking ? 'BLOCKING' : `(${g.status})`;
		const suffix = g.policy === 'required' ? '' : ` (${g.policy}, ${g.scope}-scoped)`;
		lines.push(`- [${marker}] ${g.gate}${suffix}${describeStale(g)}`);
	}
	if (state.artifacts.length > 0) {
		lines.push('', '## Artifacts');
		for (const a of state.artifacts) lines.push(`- [${a.exists ? 'OK' : 'MISSING'}] ${a.artifact}: ${a.path}`);
	}
	lines.push('', '## Next');
	if (state.next_actions.length > 0) {
		lines.push(`- ${state.next_actions[0].command}   # ${state.next_actions[0].reason}`);
	} else {
		lines.push('- nothing blocking');
	}
	if (state.optional_not_run.length > 0) {
		lines.push('', `## Optional, not yet run: ${state.optional_not_run.join(', ')}`);
	}
	return `${lines.join('\n')}\n`;
}

function cmdStatus(args) {
	const flags = parseCommand('status', args);
	if (flags.help) { console.log(renderCommandHelp('status')); process.exit(0); }
	setContext('status', flags);
	const root = requireRepoRoot();
	if (flags.feature) requireValidFeatureId(flags.feature);
	const state = computeWorkflowState(root, flags.feature);
	if (flags.json) {
		console.log(JSON.stringify({ feature: flags.feature, ...state }, null, 2));
	} else if (!flags.quiet) {
		console.log(renderStatusReport(flags.feature, state));
	}
	process.exit(0);
}

// D1: prints exactly ONE copy-pasteable command on stdout (nothing else) so `$(bskel next)` is
// safe to eval directly -- the reason it was chosen goes to stderr instead, matching the same
// stdout/stderr split cmdContractEmit/cmdHandlesEmit already use for "here's the data" vs. "here's
// what went wrong" output. Deliberately no --execute flag -- see D-status-next's EXIT in
// DECISIONS.md for why running the recommended (often mutating) command automatically is out of
// scope for this slice. D2: this stdout line is `next`'s entire PAYLOAD, not narration -- --quiet
// deliberately does not touch it (quieting it would defeat the command's whole purpose).
function cmdNext(args) {
	const flags = parseCommand('next', args);
	if (flags.help) { console.log(renderCommandHelp('next')); process.exit(0); }
	setContext('next', flags);
	const root = requireRepoRoot();
	if (flags.feature) requireValidFeatureId(flags.feature);
	const state = computeWorkflowState(root, flags.feature);
	if (flags.json) {
		console.log(JSON.stringify({ feature: flags.feature, blocked_by: state.blocked_by, next_actions: state.next_actions, optional_not_run: state.optional_not_run }, null, 2));
	} else if (state.next_actions.length > 0) {
		console.log(state.next_actions[0].command);
		console.error(`# ${state.next_actions[0].reason}`);
	} else {
		console.log('# nothing blocking -- feature workflow complete (or no --feature given and preflight already passed)');
	}
	process.exit(0);
}

// D5: renders whatever lib/doctor.mjs's computeDoctorChecks() decided -- this function is pure
// CLI glue (arg parsing + printing), same split as D1's cmdStatus/lib/workflow.mjs.
function cmdDoctor(args) {
	const flags = parseCommand('doctor', args);
	if (flags.help) { console.log(renderCommandHelp('doctor')); process.exit(0); }
	setContext('doctor', flags);
	const root = repoRoot();

	let checks;
	let showAdapters;
	try {
		({ checks, showAdapters } = computeDoctorChecks(root, { workflow: flags.workflow }));
	} catch (err) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', err.message);
	}

	const adapters = showAdapters
		? ADAPTERS.map((a) => ({
			id: a.id, specificity: a.specificity, confidence: a.confidence, capabilities: a.capabilities,
			// `detect()` itself can return null on a legitimate non-match -- coerce to a real
			// boolean here so `null` unambiguously means "not applicable, no root" below, not
			// "detect() happened to return a falsy value".
			detects: root ? Boolean(a.detect(root)) : null,
			diagnostics: root && typeof a.diagnostics === 'function' ? a.diagnostics(root) : [],
		}))
		: [];
	const loadErrors = showAdapters ? LOAD_ERRORS : [];

	// D5: `required:false` checks never affect the verdict -- this is the direct fix for `gh`
	// being unconditionally required before (missing `gh` failed `bskel doctor` even though
	// preflight itself already tolerates its absence). See D-doctor-workflow in DECISIONS.md.
	const allOk = checks.every((c) => c.required ? c.ok : true) && loadErrors.length === 0;

	if (flags.json) {
		console.log(JSON.stringify({ workflow: flags.workflow, checks, adapters, load_errors: loadErrors, ok: allOk }, null, 2));
		process.exit(allOk ? 0 : 1);
	}

	if (!flags.quiet) {
		for (const c of checks) {
			const marker = c.ok ? 'OK  ' : (c.required ? 'FAIL' : 'WARN');
			console.log(`${marker}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
			if (!c.ok && c.remediation) console.log(`      -> ${c.remediation}`);
		}

		if (showAdapters) {
			console.log('');
			console.log('Scanner adapters:');
			for (const a of adapters) {
				const caps = Object.entries(a.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none)';
				let line = `  ${a.id} (specificity ${a.specificity}, confidence ${a.confidence}) -- capabilities: ${caps}`;
				if (a.detects !== null) line += a.detects ? ' -- DETECTS this repo' : ' -- does not detect this repo';
				console.log(line);
				for (const d of a.diagnostics) console.log(`      [${d.level}] ${d.code}: ${d.message}`);
			}
			for (const e of loadErrors) console.log(`  FAIL  ${e.file}: ${e.message}`);
		}
	}

	process.exit(allOk ? 0 : 1);
}

// P2 (D-greenfield-bootstrap): the one path into this tool that doesn't require an existing git
// repo (contrast requireRepoRoot(), used by nearly everything else) -- `bskel new` is what CREATES
// one. `--stack`'s two choices come from new/index.mjs's plain dispatch map, not a dynamic
// registry (no third-party-extensibility need for exactly two first-party stacks). Deliberately
// never creates a remote or auto-chains into `preflight` -- see this function's own printed
// guidance for why `bskel preflight` cannot simply be "the next command" here (it requires a real
// origin remote with a resolvable default branch, which a brand-new local-only repo doesn't have).
async function cmdNew(args) {
	const flags = parseCommand('new', args);
	if (flags.help) { console.log(renderCommandHelp('new')); process.exit(0); }
	setContext('new', flags);

	const stack = NEW_STACKS[flags.stack];
	if (!stack) {
		fail(EXIT_CODES.BAD_ARGS, 'BAD_ARGS', `bskel new --stack must be one of: ${Object.keys(NEW_STACKS).join(', ')} (got ${JSON.stringify(flags.stack)})`);
	}
	requireValidSlug(flags.slug);

	const dir = flags.dir ? path.resolve(flags.dir) : path.resolve(process.cwd(), flags.slug);

	let result;
	try {
		result = await stack.scaffold({ dir, slug: flags.slug, offline: flags.offline });
	} catch (err) {
		fail(EXIT_CODES.NOT_PASSED, 'SCAFFOLD_FAILED', err.message);
	}

	execFileSync('git', ['init', '--quiet'], { cwd: dir });
	execFileSync('git', ['add', '-A'], { cwd: dir });
	execFileSync('git', ['commit', '--quiet', '-m', `chore: scaffold ${flags.stack} project via bskel new`], { cwd: dir });

	if (flags.json) {
		console.log(JSON.stringify({ stack: flags.stack, dir, ...result }, null, 2));
	} else if (!flags.quiet) {
		console.log(`scaffolded a new ${flags.stack} project at ${dir}`);
		console.log('');
		console.log('git init + an initial commit were made locally -- bskel preflight needs a REAL remote');
		console.log('with a resolvable default branch, which this command deliberately does not create:');
		console.log(`  1. cd ${dir}`);
		console.log('  2. create a remote repo yourself (e.g. `gh repo create <name> --private --source=. --push`), or push to one you already own');
		console.log('  3. git remote set-head origin --auto   (or: git remote set-head origin <branch>)');
		console.log('  4. bskel preflight');
	}
	process.exit(0);
}

function printVersion(json) {
	const pkg = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'package.json'), 'utf8'));
	if (json) console.log(JSON.stringify({ name: 'bskel', version: pkg.version }));
	else console.log(`bskel ${pkg.version}`);
	process.exit(0);
}

// D2: `--help`/`help`/bare `bskel` and `--version` are handled BEFORE this switch -- they are not
// "a command's own arguments are bad", they're requests for information that never touch a repo,
// a gate, or any command-specific parsing. Every other thrown error (a CliUsageError from
// parseCommand(), or a plain Error from a domain validator like requireValidFeatureId/
// requireValidSlug that used to propagate as an uncaught exception) is caught here and turned
// into a clean, single-line diagnosis -- see D-cli-contract in DECISIONS.md for the crash this
// fixes (`bskel verify --feature --json` used to print a full Node stack trace).
// `new` (P2/D-greenfield-bootstrap) is the one command needing a real `await` (its network call
// to start.spring.io) -- main()/dispatchCommand() are `async` for that one case only; every other
// command stays a plain synchronous function returning immediately (awaiting a non-Promise value
// is a harmless no-op), so this is a minimal-diff change, not a rewrite of the dispatch shape.
async function main() {
	const argv = process.argv.slice(2);
	const [cmd, ...rest] = argv;

	if (cmd === undefined || cmd === 'help' || cmd === '--help') {
		printUsageToStdout();
		process.exit(0);
	}
	if (cmd === '--version') {
		printVersion(rest.includes('--json'));
		return;
	}

	try {
		await dispatchCommand(cmd, rest);
	} catch (err) {
		// A JS-native error class (TypeError/ReferenceError/RangeError) signals something this
		// codebase itself got wrong, not a bad user input -- everything else reaching here is
		// either a CliUsageError (parseCommand()) or a plain, message-only Error a domain
		// validator (requireValidFeatureId/requireValidSlug/requireValidFeatureOrRepoId, or a
		// malformed-state read) deliberately threw with an already user-facing message.
		const isInternalBug = err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError;
		const jsonRequested = CTX.command ? CTX.json : argv.includes('--json');
		const commandName = CTX.command ?? cmd ?? '(none)';

		if (isInternalBug) {
			console.error(`bskel: internal error: ${err.message}`);
			if (process.env.BSKEL_DEBUG === '1') console.error(err.stack);
			if (jsonRequested) console.log(JSON.stringify(diagnostic({ command: commandName, code: EXIT_CODES.CHECK_FAILED, reason: 'INTERNAL_ERROR', message: err.message }), null, 2));
			process.exit(EXIT_CODES.CHECK_FAILED);
		}

		console.error(err.message);
		if (jsonRequested) console.log(JSON.stringify(diagnostic({ command: commandName, code: EXIT_CODES.BAD_ARGS, reason: 'BAD_ARGS', message: err.message }), null, 2));
		process.exit(EXIT_CODES.BAD_ARGS);
	}
}

async function dispatchCommand(cmd, rest) {
	switch (cmd) {
		case 'preflight':
			cmdPreflight(rest);
			break;
		case 'scan': {
			if (rest[0] === 'disposition') return cmdScanDisposition(rest.slice(1));
			if (rest[0] === 'explain') return cmdScanExplain(rest.slice(1));
			cmdScan(rest);
			break;
		}
		case 'feature': {
			if (rest[0] === 'init') return cmdFeatureInit(rest.slice(1));
			if (rest[0] === 'list') return cmdFeatureList(rest.slice(1));
			if (rest[0] === 'show') return cmdFeatureShow(rest.slice(1));
			if (rest[0] === 'rename') return cmdFeatureRename(rest.slice(1));
			if (rest[0] === 'link') return cmdFeatureLink(rest.slice(1));
			if (rest[0] === 'archive') return cmdFeatureArchive(rest.slice(1));
			usage();
			process.exit(14);
			break;
		}
		case 'contract': {
			const sub = rest[0];
			const subArgs = rest.slice(1);
			if (sub === 'emit') return cmdContractEmit(subArgs);
			if (sub === 'validate') return cmdContractValidate(subArgs);
			if (sub === 'tool-schema') return cmdContractToolSchema(subArgs);
			if (sub === 'waive') return cmdContractWaive(subArgs);
			usage();
			process.exit(14);
			break;
		}
		case 'stack': {
			if (rest[0] === 'apply') return cmdStackApply(rest.slice(1));
			usage();
			process.exit(14);
			break;
		}
		case 'catalog': {
			if (rest[0] === 'lint') return cmdCatalogLint(rest.slice(1));
			usage();
			process.exit(14);
			break;
		}
		case 'handles': {
			if (rest[0] === 'plan') return cmdHandlesPlan(rest.slice(1));
			if (rest[0] === 'emit') return cmdHandlesEmit(rest.slice(1));
			if (rest[0] === 'patch' && rest[1] === 'approve') return cmdHandlesPatchApprove(rest.slice(2));
			usage();
			process.exit(14);
			break;
		}
		case 'verify':
			cmdVerify(rest);
			break;
		case 'status':
			cmdStatus(rest);
			break;
		case 'next':
			cmdNext(rest);
			break;
		case 'gate': {
			const sub = rest[0];
			const subArgs = rest.slice(1);
			if (sub === 'require') return cmdGateRequire(subArgs);
			if (sub === 'force') return cmdGateForce(subArgs);
			if (sub === 'revoke') return cmdGateRevoke(subArgs);
			if (sub === 'history') return cmdGateHistory(subArgs);
			if (sub === 'show') return cmdGateShow(subArgs);
			usage();
			process.exit(14);
			break;
		}
		case 'doctor':
			cmdDoctor(rest);
			break;
		case 'new':
			return cmdNew(rest);
		default:
			usage();
			process.exit(cmd ? 14 : 0);
	}
}

main();
