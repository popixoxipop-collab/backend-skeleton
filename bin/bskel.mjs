#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { repoRoot, headSha, localDefaultBranch } from '../lib/repo.mjs';
import { requireGate, forceGate, passGate, awaitDispositionGate, EXIT } from '../lib/gates.mjs';
import { getGate, loadState } from '../lib/state.mjs';
import { sha256File, writeFileAtomic, readJsonIfExists } from '../lib/fsutil.mjs';
import { requireValidFeatureId, requireValidSlug, slugWords, nextFeatureNumber } from '../lib/featureid.mjs';
import { runScan } from '../scanners/index.mjs';
import { renderScanMarkdown, renderPlanConstraints } from '../scanners/render.mjs';
import { buildContract } from '../contracts/emit.mjs';
import { validateEnvelope, operationPayloadSchema } from '../contracts/validate.mjs';
import { loadCatalogEntry, listCatalogChoices, planApply, applyPlan } from '../stack/apply.mjs';
import { planHandles } from '../handles/plan.mjs';
import { emitHandles, detectBasePackage } from '../handles/emit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

// The preflight gate is repo-scoped, not feature-scoped -- it runs before a feature_id exists.
// Stored under the same per-feature state-file mechanism using the reserved id "_repo".
const REPO_GATE_ID = '_repo';

// Each gate's token must be computed from the SAME function both when the gate is written
// (pass) and when it's re-verified (require) -- otherwise "require" degenerates into comparing
// stored data against itself, which can never detect drift. One shared recomputer per gate name
// closes that gap structurally instead of relying on call sites staying in sync by hand.
// Gates without an entry here (scan/contract -- added in later phases) fall back to comparing
// against their own stored evidence, which means they cannot yet detect staleness on their own;
// each phase that adds a new gate-emitting command must register its recomputer here too.
const GATE_RECOMPUTERS = {
	preflight: (root) => ({ head_sha: headSha(root), default_branch: localDefaultBranch(root) }),
	// The scan gate's token covers head_sha (has the codebase moved since scanning?), the scan
	// report's own content hash (has disposition/re-scan changed it?), and spec.md's content
	// hash if it exists yet (scan can run before a spec is written, so this may be null).
	scan: (root, featureId) => ({
		head_sha: headSha(root),
		scan_report_hash: sha256File(specPath(root, featureId, 'brownfield-scan.json')),
		spec_hash: sha256File(specPath(root, featureId, 'spec.md')),
	}),
	// The contract gate's token covers the emitted contract file's own hash (re-emitting after
	// a re-scan invalidates it) and head_sha -- NOT the scan report's hash directly, since the
	// contract is a derived artifact; if the scan changes but the contract hasn't been
	// re-emitted, that should surface as "contract is out of date with scan", which is a
	// judgment call for `bskel contract emit` to re-run, not something require silently papers
	// over by trusting the old contract.
	contract: (root, featureId) => ({
		head_sha: headSha(root),
		contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
	}),
	// Repo-scoped like preflight (a stack choice is a project-wide decision, not per-feature).
	// Staleness here means "the applied files or the choice-of-catalog-entry are gone/changed",
	// not "re-verify the tunnel is currently running" -- that's a runtime concern, not a gate.
	stack: (root) => ({ head_sha: headSha(root), stack_record_hash: sha256File(path.join(root, '.sbf', 'stack.json')) }),
	// Staleness = the generated Java (or the contract it was generated from) has moved since
	// emit -- NOT "does the migration still match the DB schema" (unknowable without a live DB
	// connection this tool deliberately never opens on its own, see D-migration-scope).
	handles: (root, featureId) => ({
		head_sha: headSha(root),
		contract_hash: sha256File(specPath(root, featureId, 'contracts', `${featureId}.schema.json`)),
	}),
};

function currentGateInputs(root, gateName, featureId, storedEvidence) {
	const recompute = GATE_RECOMPUTERS[gateName];
	return recompute ? recompute(root, featureId) : (storedEvidence ?? {});
}

function specDir(root, featureId) {
	return path.join(root, 'specs', featureId);
}

function specPath(root, featureId, ...segments) {
	return path.join(specDir(root, featureId), ...segments);
}

function usage() {
	console.error(`bskel -- backend-skeleton CLI

  bskel preflight [--max-behind N] [--no-fetch] [--allow-dirty] [--json]
  bskel scan [--feature <id>] [--terms a,b,c] [--json]
  bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel [--note "..."] [--breaking-approved]
  bskel feature init --slug <name>
  bskel contract emit --feature <id> [--module <name>] [--json]
  bskel contract validate --feature <id> --file <envelope.json>
  bskel contract tool-schema --feature <id> --operation <operationId>
  bskel stack apply --choice <id> [--apply] [--port N] [--json]
  bskel handles plan --feature <id> [--module <name>] [--resource type1,type2]
  bskel handles emit --feature <id> [--module <name>] [--resource type1,type2]
  bskel gate require <name> [--feature <id>]
  bskel gate force <name> --reason "..." [--feature <id>]
  bskel gate show [--feature <id>]
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
		passGate(root, REPO_GATE_ID, 'preflight', GATE_RECOMPUTERS.preflight(root), result.evidence);
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

function cmdGateRequire(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	const gateName = flags._[0];
	if (!gateName) { console.error('usage: bskel gate require <name> [--feature <id>]'); process.exit(14); }
	const record = getGate(root, flags.feature, gateName);
	// `require` never re-runs the underlying check (e.g. it doesn't re-fetch or re-scan) --
	// it freshly recomputes only the cheap, local inputs the gate's token was built from
	// (see GATE_RECOMPUTERS) and compares against what was stored when the gate last passed.
	const currentInputs = currentGateInputs(root, gateName, flags.feature, record?.evidence);
	const result = requireGate(root, flags.feature, gateName, currentInputs);
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
	const state = forceGate(root, flags.feature, gateName, flags.reason);
	console.log(JSON.stringify(state.gates[gateName]));
	process.exit(EXIT.PASS);
}

function cmdGateShow(args) {
	const root = requireRepoRoot();
	const flags = parseFlags(args, { feature: { type: 'string', default: REPO_GATE_ID } });
	console.log(JSON.stringify(loadState(root, flags.feature), null, 2));
	process.exit(0);
}

// Structural enforcement of "preflight blocks everything below it" (see the workflow table in
// SKILL.md) for every feature-scoped command -- not just documented as a step order, checked.
// Ad-hoc `bskel scan` (no --feature) is exempt: it's an explicit side-channel quick-look
// utility outside the gated workflow, same as `bskel gate show`.
function requirePreflightPassed(root) {
	const result = requireGate(root, REPO_GATE_ID, 'preflight', GATE_RECOMPUTERS.preflight(root));
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

	const inputs = GATE_RECOMPUTERS.scan(root, flags.feature);
	let gateState;
	if (report.verdict === 'greenfield') {
		gateState = passGate(root, flags.feature, 'scan', inputs, { verdict: report.verdict });
	} else {
		gateState = awaitDispositionGate(root, flags.feature, 'scan', inputs, {
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

	const inputs = GATE_RECOMPUTERS.scan(root, flags.feature);
	const gateState = passGate(root, flags.feature, 'scan', inputs, { verdict: report.verdict, disposition_mode: flags.mode });
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
	});
	if (!flags.feature) { console.error('usage: bskel contract emit --feature <id> [--module <name>]'); process.exit(14); }
	requireValidFeatureId(flags.feature);

	// Contract emission is only meaningful once the scan gate has actually passed (greenfield
	// auto-pass, or a recorded disposition) -- an unresolved collision must not be allowed to
	// silently flow into a contract as if it had been addressed.
	const scanResult = requireGate(root, flags.feature, 'scan', GATE_RECOMPUTERS.scan(root, flags.feature));
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

	const contract = buildContract({
		featureId: flags.feature,
		featureUid: featureRecord.feature_uid,
		scanReport,
		module: flags.module,
	});

	writeFileAtomic(specPath(root, flags.feature, 'contracts', `${flags.feature}.schema.json`), `${JSON.stringify(contract, null, 2)}\n`);

	const inputs = GATE_RECOMPUTERS.contract(root, flags.feature);
	const gateState = passGate(root, flags.feature, 'contract', inputs, { operation_count: Object.keys(contract.operations).length });

	if (flags.json) {
		console.log(JSON.stringify(contract, null, 2));
	} else {
		console.log(`wrote specs/${flags.feature}/contracts/${flags.feature}.schema.json -- ${Object.keys(contract.operations).length} operation(s)`);
		for (const w of contract.warnings) console.error(`warning: ${w}`);
		console.log(`gate: contract -> ${gateState.gates.contract.status}`);
	}
	process.exit(0);
}

function loadContract(root, featureId) {
	const contractPath = specPath(root, featureId, 'contracts', `${featureId}.schema.json`);
	if (!fs.existsSync(contractPath)) {
		console.error(`no contract at ${contractPath} -- run \`bskel contract emit --feature ${featureId}\` first`);
		process.exit(2);
	}
	return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
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
	const op = contract.operations[flags.operation];
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
	const plan = planApply(root, entry, { port: Number.parseInt(flags.port, 10) });

	if (!flags.apply) {
		// Dry-run is the default -- nothing is written without an explicit --apply, matching the
		// repo's own "minimal, explicit-approval" convention for anything that touches files.
		console.log(flags.json ? JSON.stringify(plan, null, 2) : renderStackPlan(plan));
		process.exit(0);
	}

	const written = applyPlan(root, plan);
	const stackRecord = {
		schema: 'sbf.stack/1', choice: flags.choice, applied_files: written,
		env_example_keys: plan.envExampleActions.map((e) => e.key), at: new Date().toISOString(),
	};
	writeFileAtomic(path.join(root, '.sbf', 'stack.json'), `${JSON.stringify(stackRecord, null, 2)}\n`);

	const inputs = GATE_RECOMPUTERS.stack(root);
	const gateState = passGate(root, REPO_GATE_ID, 'stack', inputs, { choice: flags.choice });

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
	const contractResult = requireGate(root, flags.feature, 'contract', GATE_RECOMPUTERS.contract(root, flags.feature));
	if (contractResult.code !== EXIT.PASS) {
		console.error(`blocked: \`contract\` gate for ${flags.feature} is ${contractResult.status} -- run \`bskel contract emit --feature ${flags.feature}\` first.`);
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

	const inputs = GATE_RECOMPUTERS.handles(root, flags.feature);
	const gateState = passGate(root, flags.feature, 'handles', inputs, { resolverStubs });

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
