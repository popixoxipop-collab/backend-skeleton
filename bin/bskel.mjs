#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { repoRoot } from '../lib/repo.mjs';
import { forceGate, requireNamedGate, passNamedGate, awaitNamedGateDisposition, EXIT } from '../lib/gates.mjs';
import { REPO_GATE_ID, GATE_NAMES, gateScopeId, requireGateDefinition } from '../lib/gate-definitions.mjs';
import { getGate, loadState } from '../lib/state.mjs';
import { writeFileAtomic, readJsonIfExists } from '../lib/fsutil.mjs';
import { specDir, specPath } from '../lib/paths.mjs';
import { requireValidFeatureId, requireValidSlug, requireValidFeatureOrRepoId, slugWords, nextFeatureNumber } from '../lib/featureid.mjs';
import { runScan } from '../scanners/index.mjs';
import { renderScanMarkdown, renderPlanConstraints } from '../scanners/render.mjs';
import { buildContract, selectModule } from '../contracts/emit.mjs';
import { validateEnvelope, operationPayloadSchema } from '../contracts/validate.mjs';
import { evaluateResolution, loadResolution, resolutionPath, requireWarningCode, warningKey, countByCode } from '../contracts/completeness.mjs';
import { buildReconciliation, snapshotFromReconciliation, describeSourceFile } from '../contracts/openapi.mjs';
import { loadCatalogEntry, listCatalogChoices, planApply, applyPlan } from '../stack/apply.mjs';
import { planHandles } from '../handles/plan.mjs';
import { emitHandles, detectBasePackage } from '../handles/emit.mjs';
import { collectGateStatuses, runBuildCheck, checkArtifacts } from '../lib/verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

function usage() {
	console.error(`bskel -- backend-skeleton CLI

  bskel preflight [--max-behind N] [--no-fetch] [--allow-dirty] [--json]
  bskel scan [--feature <id>] [--terms a,b,c] [--json]
  bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel [--note "..."] [--breaking-approved]
  bskel feature init --slug <name>
  bskel contract emit --feature <id> [--module <name>] [--json] [--openapi-file <path>] [--path-prefix /api/v0]
  bskel contract validate --feature <id> --file <envelope.json>
  bskel contract tool-schema --feature <id> --operation <operationId>
  bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path"|--all) --reason "..."
  bskel stack apply --choice <id> [--apply] [--port N] [--json]
  bskel handles plan --feature <id> [--module <name>] [--resource type1,type2]
  bskel handles emit --feature <id> [--module <name>] [--resource type1,type2]
  bskel verify --feature <id> [--build] [--json]
  bskel gate require <name> [--feature <id>]      (name: ${GATE_NAMES.join('|')})
  bskel gate force <name> --reason "..." [--feature <id>]
  bskel gate show [<name>] [--feature <id>]
  bskel doctor
`);
}

function requireRepoRoot() {
	const root = repoRoot();
	if (!root) {
		console.error('bskel: not inside a git repository');
		process.exit(10);
	}
	return root;
}

function parseFlags(args, spec) {
	const out = { _: [] };
	for (const key of Object.keys(spec)) out[key] = spec[key].default;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const flagName = arg.startsWith('--') ? arg.slice(2) : null;
		if (flagName && flagName in spec) {
			if (spec[flagName].type === 'boolean') {
				out[flagName] = true;
			} else {
				out[flagName] = args[++i];
			}
		} else {
			out._.push(arg);
		}
	}
	return out;
}

function cmdPreflight(args) {
	const flags = parseFlags(args, {
		'max-behind': { type: 'string', default: '0' },
		'no-fetch': { type: 'boolean', default: false },
		'allow-dirty': { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	});
	const root = requireRepoRoot();
	const scriptPath = path.join(SKILL_ROOT, 'scripts', 'preflight-base-ref.sh');
	const scriptArgs = ['--max-behind', flags['max-behind']];
	if (flags['no-fetch']) scriptArgs.push('--no-fetch');
	if (flags['allow-dirty']) scriptArgs.push('--allow-dirty');
	scriptArgs.push('--json');

	let stdout;
	let exitCode = 0;
	try {
		stdout = execFileSync(scriptPath, scriptArgs, { cwd: root, encoding: 'utf8' });
	} catch (err) {
		stdout = err.stdout ?? '';
		exitCode = err.status ?? 1;
	}
	const result = JSON.parse(stdout);

	if (result.verdict === 'PASS') {
		passNamedGate(root, 'preflight', null, result.evidence);
	}

	if (flags.json) {
		console.log(stdout.trim());
	} else if (result.verdict === 'PASS') {
		console.log(`PASS: HEAD is up to date with origin/${result.evidence.default_branch}`);
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
		console.error(err.message);
		process.exit(14);
	}
	try {
		requireValidFeatureOrRepoId(featureFlag, REPO_GATE_ID);
	} catch (err) {
		console.error(err.message);
		process.exit(14);
	}
	return { def, scopeId: gateScopeId(gateName, featureFlag) };
}

function cmdGateRequire(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	const gateName = flags._[0];
	if (!gateName) { console.error('usage: bskel gate require <name> [--feature <id>]'); process.exit(14); }
	resolveGateArg(gateName, flags.feature);
	// `require` never re-runs the underlying check (e.g. it doesn't re-fetch or re-scan) -- it
	// freshly recomputes only the cheap, local inputs the gate's token was built from (see
	// lib/gate-definitions.mjs) and compares against what was stored when the gate last passed.
	const result = requireNamedGate(root, gateName, flags.feature);
	console.log(JSON.stringify({ gate: gateName, feature: flags.feature, ...result }));
	process.exit(result.code);
}

function cmdGateForce(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: REPO_GATE_ID },
		reason: { type: 'string', default: '' },
	});
	const gateName = flags._[0];
	if (!gateName) { console.error('usage: bskel gate force <name> --reason "..." [--feature <id>]'); process.exit(14); }
	const { scopeId } = resolveGateArg(gateName, flags.feature);
	const state = forceGate(root, scopeId, gateName, flags.reason);
	console.log(JSON.stringify(state.gates[gateName]));
	process.exit(EXIT.PASS);
}

function cmdGateShow(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	const gateName = flags._[0] ?? null;
	if (gateName === null) {
		try {
			requireValidFeatureOrRepoId(flags.feature, REPO_GATE_ID);
		} catch (err) {
			console.error(err.message);
			process.exit(14);
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
		console.error(`blocked: \`preflight\` gate is ${result.status} -- run \`bskel preflight\` first.`);
		process.exit(result.code);
	}
}

const DISPOSITION_MODES = ['reuse', 'extend', 'replace', 'parallel'];

function deriveTerms(flags) {
	const fromFlag = (flags.terms || '').split(',').map((s) => s.trim()).filter(Boolean);
	const fromFeature = flags.feature ? slugWords(flags.feature) : [];
	return [...new Set([...fromFlag, ...fromFeature])];
}

function cmdScan(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		terms: { type: 'string', default: '' },
		db: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	});
	if (flags.db) {
		console.error('note: --db (Plane C) is not implemented yet -- scanning without it. See DECISIONS.md.');
	}
	const terms = deriveTerms(flags);
	if (terms.length === 0) {
		console.error('usage: bskel scan [--feature <id>] --terms a,b,c   (need at least one search term, from --terms or a --feature slug)');
		process.exit(14);
	}
	if (flags.feature) {
		requireValidFeatureId(flags.feature);
		requirePreflightPassed(root);
	}

	const report = runScan({ repoRoot: root, terms });
	if (flags.feature) report.feature_id = flags.feature;

	if (!flags.feature) {
		// Ad-hoc mode: no feature_id, no files written, no gate touched -- matches the plan's own
		// example invocation `bskel scan --terms organization` for a quick look before committing
		// to a feature_id.
		console.log(flags.json ? JSON.stringify(report, null, 2) : renderScanMarkdown(report));
		process.exit(0);
	}

	const dir = specDir(root, flags.feature);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomic(specPath(root, flags.feature, 'brownfield-scan.json'), `${JSON.stringify(report, null, 2)}\n`);
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
	} else {
		console.log(renderScanMarkdown(report));
		console.log(`gate: scan -> ${gateState.gates.scan.status}`);
		if (report.verdict !== 'greenfield') {
			console.log(`\nblocked: run \`bskel scan disposition --feature ${flags.feature} --mode reuse|extend|replace|parallel --note "..."\` before continuing.`);
		}
	}
	process.exit(report.verdict === 'greenfield' ? EXIT.PASS : EXIT.AWAITING_DISPOSITION);
}

function cmdScanDisposition(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		mode: { type: 'string', default: null },
		note: { type: 'string', default: '' },
		'breaking-approved': { type: 'boolean', default: false },
	});
	if (!flags.feature) { console.error('usage: bskel scan disposition --feature <id> --mode <mode> [--note "..."]'); process.exit(14); }
	requireValidFeatureId(flags.feature);
	if (!DISPOSITION_MODES.includes(flags.mode)) {
		console.error(`--mode must be one of: ${DISPOSITION_MODES.join(', ')}`);
		process.exit(14);
	}
	if (flags.mode === 'replace' && !flags['breaking-approved']) {
		console.error('--mode replace requires --breaking-approved (this is a deliberate speed bump, not a bug)');
		process.exit(14);
	}

	const reportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	if (!fs.existsSync(reportPath)) {
		console.error(`no scan report at ${reportPath} -- run \`bskel scan --feature ${flags.feature}\` first`);
		process.exit(2);
	}
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	report.feature_id = flags.feature;
	report.disposition = { mode: flags.mode, note: flags.note, at: new Date().toISOString() };

	writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	writeFileAtomic(specPath(root, flags.feature, 'brownfield-scan.md'), renderScanMarkdown(report));
	const planConstraints = renderPlanConstraints(report);
	if (planConstraints) {
		writeFileAtomic(specPath(root, flags.feature, 'plan-constraints.md'), planConstraints);
	}

	const gateState = passNamedGate(root, 'scan', flags.feature, { verdict: report.verdict, disposition_mode: flags.mode });
	console.log(JSON.stringify(gateState.gates.scan));
	process.exit(EXIT.PASS);
}

function featureIndexPath(root) {
	return path.join(root, '.sbf', 'feature-index.json');
}

function cmdFeatureInit(args) {
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	const flags = parseFlags(args, { slug: { type: 'string', default: null } });
	if (!flags.slug) { console.error('usage: bskel feature init --slug <name>'); process.exit(14); }
	requireValidSlug(flags.slug);

	const featureId = `${nextFeatureNumber(path.join(root, 'specs'))}-${flags.slug}`;
	const featureUid = randomUUID();
	const record = { schema: 'sbf.feature/1', feature_id: featureId, feature_uid: featureUid, created_at: new Date().toISOString() };
	writeFileAtomic(specPath(root, featureId, 'feature.json'), `${JSON.stringify(record, null, 2)}\n`);

	const index = readJsonIfExists(featureIndexPath(root)) ?? { schema: 'sbf.feature-index/1', by_uid: {} };
	index.by_uid[featureUid] = [featureId];
	writeFileAtomic(featureIndexPath(root), `${JSON.stringify(index, null, 2)}\n`);

	console.log(JSON.stringify(record));
	process.exit(0);
}

function loadFeatureRecord(root, featureId) {
	const record = readJsonIfExists(specPath(root, featureId, 'feature.json'));
	if (!record) {
		console.error(`no feature.json at specs/${featureId}/ -- run \`bskel feature init --slug ${slugWords(featureId).join('-')}\` first (or hand-write specs/${featureId}/feature.json with a minted feature_uid)`);
		process.exit(2);
	}
	return record;
}

function cmdContractEmit(args) {
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		module: { type: 'string', default: null },
		json: { type: 'boolean', default: false },
		'openapi-file': { type: 'string', default: null },
		'path-prefix': { type: 'string', default: null },
	});
	if (!flags.feature) { console.error('usage: bskel contract emit --feature <id> [--module <name>] [--openapi-file <path>] [--path-prefix /api/v0]'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	// Contract emission is only meaningful once the scan gate has actually passed (greenfield
	// auto-pass, or a recorded disposition) -- an unresolved collision must not be allowed to
	// silently flow into a contract as if it had been addressed.
	const scanResult = requireNamedGate(root, 'scan', flags.feature);
	if (scanResult.code !== EXIT.PASS) {
		console.error(`blocked: \`scan\` gate for ${flags.feature} is ${scanResult.status} -- run \`bskel scan --feature ${flags.feature}\` (and \`scan disposition\` if it collides) first.`);
		process.exit(scanResult.code);
	}

	const scanReportPath = specPath(root, flags.feature, 'brownfield-scan.json');
	if (!fs.existsSync(scanReportPath)) {
		console.error(`no scan report at ${scanReportPath} -- run \`bskel scan --feature ${flags.feature}\` first`);
		process.exit(2);
	}
	const scanReport = JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
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
				console.error(result.error);
				process.exit(14);
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
		console.log(`wrote specs/${flags.feature}/contracts/${flags.feature}.schema.json -- ${contract.completeness.operation_count} operation(s), completeness: ${evaluation.status}`);
		if (reconciliation) {
			console.log(`openapi: ${reconciliation.stats.matched} path(s) corrected, ${reconciliation.stats.adopted} adopted (prefix ${reconciliation.prefix.value ?? '(none)'}, ${reconciliation.prefix.origin})`);
		}
		for (const w of contract.warnings) console.error(`warning[${w.severity}] ${w.code}${w.subject ? ` (${w.subject})` : ''}: ${w.message}`);
		console.log(`gate: contract -> ${gateState.gates.contract.status}`);
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
	process.exit(evaluation.blocking ? EXIT.AWAITING_DISPOSITION : EXIT.PASS);
}

function loadContract(root, featureId) {
	const contractPath = specPath(root, featureId, 'contracts', `${featureId}.schema.json`);
	if (!fs.existsSync(contractPath)) {
		console.error(`no contract at ${contractPath} -- run \`bskel contract emit --feature ${featureId}\` first`);
		process.exit(2);
	}
	return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

// A5: the `scan disposition` of contracts -- lets a human explicitly accept a `partial`
// contract's outstanding warnings so the `contract` gate can pass. Deliberately no wildcard
// waiver: `--all` expands to the SPECIFIC code+subject pairs present right now, recorded as
// individual entries -- a warning that doesn't exist yet (e.g. a new unannotated endpoint added
// later) is never covered by an old waive. See D-contract-completeness in DECISIONS.md.
function cmdContractWaive(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		code: { type: 'string', default: null },
		subject: { type: 'string', default: null },
		all: { type: 'boolean', default: false },
		reason: { type: 'string', default: '' },
		json: { type: 'boolean', default: false },
	});
	const usage = 'usage: bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path" | --all) --reason "..."';
	if (!flags.feature) { console.error(usage); process.exit(14); }
	requireValidFeatureId(flags.feature);
	if (!flags.code) { console.error(usage); process.exit(14); }
	try {
		requireWarningCode(flags.code);
	} catch (err) {
		console.error(err.message);
		process.exit(14);
	}
	if (!flags.reason || !flags.reason.trim()) {
		console.error('bskel contract waive requires --reason "..." -- every waiver must be auditable');
		process.exit(14);
	}
	if (!flags.subject && !flags.all) {
		console.error(usage);
		process.exit(14);
	}

	const contract = loadContract(root, flags.feature);
	if (contract.completeness.status === 'blocked') {
		console.error(`\`${flags.feature}\`'s contract has zero operations -- there is nothing to waive. Fix --module/--terms, or use \`bskel gate force contract --feature ${flags.feature} --reason "..."\` if this is intentional.`);
		process.exit(14);
	}

	const currentMatches = contract.warnings.filter((w) => w.code === flags.code && w.severity === 'error');
	let toWaive;
	if (flags.all) {
		toWaive = currentMatches;
		if (toWaive.length === 0) {
			console.error(`no current warning with code "${flags.code}" in this contract -- nothing to waive`);
			process.exit(14);
		}
	} else {
		const match = currentMatches.find((w) => w.subject === flags.subject);
		if (!match) {
			console.error(`no current warning with code "${flags.code}" and subject "${flags.subject}" in this contract -- known ${flags.code} subjects: ${currentMatches.map((w) => w.subject).join(', ') || '(none)'}`);
			process.exit(14);
		}
		toWaive = [match];
	}

	const resolution = loadResolution(root, flags.feature);
	const existingKeys = new Set((resolution.waivers ?? []).map(warningKey));
	const at = new Date().toISOString();
	const newEntries = toWaive
		.filter((w) => !existingKeys.has(warningKey(w)))
		.map((w) => ({ code: w.code, subject: w.subject, reason: flags.reason, at }));
	const updatedResolution = {
		schema: 'sbf.contract-resolution/1',
		feature_id: flags.feature,
		waivers: [...(resolution.waivers ?? []), ...newEntries],
	};
	writeFileAtomic(resolutionPath(root, flags.feature), `${JSON.stringify(updatedResolution, null, 2)}\n`);

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
		console.log(`waived ${newEntries.length} new warning(s)${newEntries.length < toWaive.length ? ` (${toWaive.length - newEntries.length} already waived)` : ''}`);
		console.log(`gate: contract -> ${gateState.gates.contract.status}`);
		if (evaluation.blocking) {
			console.error(`\nstill blocked: ${evaluation.unwaived.length} unresolved warning(s) remain:`);
			for (const w of evaluation.unwaived) console.error(`  ${w.code} (${w.subject})`);
		}
	}
	process.exit(evaluation.blocking ? EXIT.AWAITING_DISPOSITION : EXIT.PASS);
}

function cmdContractValidate(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: null }, file: { type: 'string', default: null } });
	if (!flags.feature || !flags.file) { console.error('usage: bskel contract validate --feature <id> --file <envelope.json>'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	const contract = loadContract(root, flags.feature);
	let envelope;
	try {
		envelope = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
	} catch (err) {
		console.error(`could not read/parse ${flags.file}: ${err.message}`);
		process.exit(14);
	}

	const result = validateEnvelope(envelope, contract);
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok ? 0 : 1);
}

function cmdContractToolSchema(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: null }, operation: { type: 'string', default: null } });
	if (!flags.feature || !flags.operation) { console.error('usage: bskel contract tool-schema --feature <id> --operation <operationId>'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	const contract = loadContract(root, flags.feature);
	// A1: same class of gap as D-security-1 (contracts/validate.mjs's Object.hasOwn fix) --
	// `contract.operations` is a plain object, so `--operation constructor` would otherwise
	// resolve an inherited Object.prototype property and be treated as a real, defined
	// operation. Reachability went up with A1: an operationId can now be adopted directly from
	// an external OpenAPI document, not just from Java source the repo owner controls.
	const op = Object.hasOwn(contract.operations, flags.operation) ? contract.operations[flags.operation] : undefined;
	if (!op) {
		console.error(`operation "${flags.operation}" not in this feature's contract (known: ${Object.keys(contract.operations).join(', ') || '(none)'})`);
		process.exit(2);
	}

	// Anthropic tool-use `input_schema` is a JSON Schema subset -- the operation's payload
	// schema (already plain JSON Schema, no $ref/$defs) is directly usable as-is.
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
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	const flags = parseFlags(args, {
		choice: { type: 'string', default: null },
		apply: { type: 'boolean', default: false },
		port: { type: 'string', default: '8080' },
		json: { type: 'boolean', default: false },
	});
	if (!flags.choice) {
		console.error(`usage: bskel stack apply --choice <id> [--apply] [--port N]   (known choices: ${listCatalogChoices().join(', ') || '(none)'})`);
		process.exit(14);
	}

	let entry;
	try {
		entry = loadCatalogEntry(flags.choice);
	} catch (err) {
		console.error(err.message);
		process.exit(14);
	}
	let plan;
	try {
		plan = planApply(root, entry, { port: Number.parseInt(flags.port, 10) });
	} catch (err) {
		console.error(err.message);
		process.exit(14);
	}

	if (!flags.apply) {
		// Dry-run is the default -- nothing is written without an explicit --apply, matching the
		// repo's own "minimal, explicit-approval" convention for anything that touches files.
		console.log(flags.json ? JSON.stringify(plan, null, 2) : renderStackPlan(plan));
		process.exit(0);
	}

	let written;
	try {
		written = applyPlan(root, plan);
	} catch (err) {
		console.error(err.message);
		process.exit(14);
	}
	const stackRecord = {
		schema: 'sbf.stack/1', choice: flags.choice, applied_files: written,
		env_example_keys: plan.envExampleActions.map((e) => e.key), at: new Date().toISOString(),
	};
	writeFileAtomic(path.join(root, '.sbf', 'stack.json'), `${JSON.stringify(stackRecord, null, 2)}\n`);

	const gateState = passNamedGate(root, 'stack', null, { choice: flags.choice });

	if (flags.json) {
		console.log(JSON.stringify({ written, gate: gateState.gates.stack }, null, 2));
	} else {
		console.log(written.length > 0 ? `wrote: ${written.join(', ')}` : 'nothing to write (already up to date)');
		for (const c of plan.configChecks.filter((c) => c.status === 'needs-manual-patch')) {
			console.log(`\nmanual step needed -- ${c.target}:\n${c.note}`);
		}
		console.log(`gate: stack -> ${gateState.gates.stack.status}`);
		console.log(`\nnext: fill in ${entry.static?.env_example?.filter((e) => e.required).map((e) => e.key).join(', ') || 'the required'} in your .env, then run ./${entry.runtime.script}`);
	}
	process.exit(0);
}

function loadScanReportOrExit(root, featureId) {
	const scanReportPath = specPath(root, featureId, 'brownfield-scan.json');
	if (!fs.existsSync(scanReportPath)) {
		console.error(`no scan report at ${scanReportPath} -- run \`bskel scan --feature ${featureId}\` first`);
		process.exit(2);
	}
	return JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
}

function renderHandlesPlan(plan) {
	const lines = [`# Handles plan: module "${plan.module ?? '(none)'}"`, ''];
	if (plan.resources.length === 0) {
		lines.push('No candidate resources.');
	}
	for (const r of plan.resources) {
		lines.push(`## ${r.type}${r.willGenerateResolver ? '' : ' (resolver will NOT be generated -- see notes)'}`);
		lines.push(`- table: ${r.table ?? '(unknown)'}, PK field: ${r.idField ?? '(unknown)'}`);
		lines.push(`- fetch: ${r.fetchOperation ? `${r.fetchOperation.method}() via ${r.fetchOperation.path}` : '(none found)'}`);
		lines.push(`- service: ${r.service ? r.service.serviceType : '(not found)'}`);
		lines.push(`- requiredAuthority: ${r.requiredAuthority}`);
		lines.push('');
	}
	if (plan.notes.length > 0) {
		lines.push('## Notes');
		for (const n of plan.notes) lines.push(`- ${n}`);
	}
	return `${lines.join('\n')}\n`;
}

function cmdHandlesPlan(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		module: { type: 'string', default: null },
		resource: { type: 'string', default: '' },
		json: { type: 'boolean', default: false },
	});
	if (!flags.feature) { console.error('usage: bskel handles plan --feature <id> [--module <name>] [--resource type1,type2]'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	const scanReport = loadScanReportOrExit(root, flags.feature);
	const basePackage = detectBasePackage(root);
	if (!basePackage) {
		console.error('could not detect the base package (no *Application.java found under src/main/java) -- is this a Spring Boot project?');
		process.exit(2);
	}
	const javaSrcRoot = path.join(root, 'src', 'main', 'java', ...basePackage.split('.'));
	const resourceFilter = flags.resource ? flags.resource.split(',').map((s) => s.trim()).filter(Boolean) : null;

	const plan = planHandles({ repoRoot: root, javaSrcRoot, scanReport, module: flags.module, resourceFilter });
	console.log(flags.json ? JSON.stringify(plan, null, 2) : renderHandlesPlan(plan));
	process.exit(0);
}

function cmdHandlesEmit(args) {
	const root = requireRepoRoot();
	requirePreflightPassed(root);
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		module: { type: 'string', default: null },
		resource: { type: 'string', default: '' },
		json: { type: 'boolean', default: false },
	});
	if (!flags.feature) { console.error('usage: bskel handles emit --feature <id> [--module <name>] [--resource type1,type2]'); process.exit(14); }
	requireValidFeatureId(flags.feature);

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
		console.error(`blocked: \`contract\` gate for ${flags.feature} is ${contractResult.status} -- ${hint}`);
		process.exit(contractResult.code);
	}

	const scanReport = loadScanReportOrExit(root, flags.feature);
	const basePackage = detectBasePackage(root);
	if (!basePackage) {
		console.error('could not detect the base package (no *Application.java found under src/main/java) -- is this a Spring Boot project?');
		process.exit(2);
	}
	const javaSrcRoot = path.join(root, 'src', 'main', 'java', ...basePackage.split('.'));
	const resourceFilter = flags.resource ? flags.resource.split(',').map((s) => s.trim()).filter(Boolean) : null;

	const plan = planHandles({ repoRoot: root, javaSrcRoot, scanReport, module: flags.module, resourceFilter });
	const { written, resolverStubs } = emitHandles({ repoRoot: root, featureId: flags.feature, plan, basePackage });

	const gateState = passNamedGate(root, 'handles', flags.feature, { resolverStubs });

	if (flags.json) {
		console.log(JSON.stringify({ written, resolverStubs, notes: plan.notes, gate: gateState.gates.handles }, null, 2));
	} else {
		console.log(`wrote ${written.length} file(s):`);
		for (const w of written) console.log(`  ${w}`);
		if (plan.notes.length > 0) {
			console.log('\nnotes:');
			for (const n of plan.notes) console.log(`  - ${n}`);
		}
		console.log(`\ngate: handles -> ${gateState.gates.handles.status}`);
		console.log('\nNOT done automatically: applying specs/<id>/handles/migration.sql to any database. Review it and apply yourself.');
	}
	process.exit(0);
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
		lines.push(`- [${marker}] ${g.gate}${suffix}${completenessNote}`);
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
	const root = requireRepoRoot();
	const flags = parseFlags(args, {
		feature: { type: 'string', default: null },
		build: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	});
	if (!flags.feature) { console.error('usage: bskel verify --feature <id> [--build] [--json]'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	const gates = collectGateStatuses(root, flags.feature, { getGate, requireNamedGate });
	const artifacts = checkArtifacts(root, flags.feature, gates);
	const build = flags.build ? runBuildCheck(root) : null;

	const gatesOk = gates.every((g) => !g.blocking);
	const artifactsPresent = artifacts.every((a) => a.exists);
	const buildOk = !build || !build.ran || build.ok;
	const overallPass = gatesOk && artifactsPresent && buildOk;

	if (flags.json) {
		console.log(JSON.stringify({ feature: flags.feature, pass: overallPass, gates, artifacts, build }, null, 2));
	} else {
		console.log(renderVerifyReport({ featureId: flags.feature, gates, artifacts, build }));
		console.log(overallPass ? 'VERIFY: PASS' : 'VERIFY: FAIL');
	}
	process.exit(overallPass ? 0 : 1);
}

function cmdDoctor() {
	const root = repoRoot();
	const checks = [];
	checks.push({ name: 'inside a git repo', ok: Boolean(root), detail: root ?? 'not a git repo' });

	for (const bin of ['git', 'gh', 'rg']) {
		let ok = true;
		let detail = '';
		try {
			execFileSync(bin, ['--version'], { stdio: 'pipe' });
		} catch {
			ok = false;
			detail = 'not found on PATH';
		}
		checks.push({ name: `binary: ${bin}`, ok, detail });
	}

	for (const line of checks) {
		console.log(`${line.ok ? 'OK  ' : 'FAIL'}  ${line.name}${line.detail ? ` (${line.detail})` : ''}`);
	}
	const allOk = checks.every((c) => c.ok);
	process.exit(allOk ? 0 : 1);
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case 'preflight':
			cmdPreflight(rest);
			break;
		case 'scan': {
			if (rest[0] === 'disposition') return cmdScanDisposition(rest.slice(1));
			cmdScan(rest);
			break;
		}
		case 'feature': {
			if (rest[0] === 'init') return cmdFeatureInit(rest.slice(1));
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
		case 'handles': {
			if (rest[0] === 'plan') return cmdHandlesPlan(rest.slice(1));
			if (rest[0] === 'emit') return cmdHandlesEmit(rest.slice(1));
			usage();
			process.exit(14);
			break;
		}
		case 'verify':
			cmdVerify(rest);
			break;
		case 'gate': {
			const sub = rest[0];
			const subArgs = rest.slice(1);
			if (sub === 'require') return cmdGateRequire(subArgs);
			if (sub === 'force') return cmdGateForce(subArgs);
			if (sub === 'show') return cmdGateShow(subArgs);
			usage();
			process.exit(14);
			break;
		}
		case 'doctor':
			cmdDoctor();
			break;
		default:
			usage();
			process.exit(cmd ? 14 : 0);
	}
}

main();
