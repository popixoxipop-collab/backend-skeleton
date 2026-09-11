// D-business-rules (R9): the emit-side half of compiled business rules for typescript-express.
// Mirrors handles/providers/python-fastapi/rules.mjs's own shape -- rules, observe, and handles
// are orthogonal capabilities that happen to share the same repo-wide "generated infra" pattern.
//
// This emitter is deliberately THIN. It renders three fixed infra modules and copies an
// already-compiled artifact into `rulesSchemas/` -- it makes no decision about what a rule means.
// Every such decision was made and verified in JS by rules/compile.mjs at `bskel rules check` time
// (R3), which is the invariant that lets three languages agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel rules emit` -- ruleSet.ts
// discovers every `rulesSchemas/*.rules.json` file at module-load time rather than being
// regenerated per feature, so these files are true infra (create-once-per-repo, all-or-nothing
// conflict unit), the same treatment observe.mjs's own INFRA_FILES get. None need any {{VAR}}
// substitution -- same reasoning observe's own INFRA_FILES give.
const INFRA_FILES = [
	{ template: 'ruleCheck.ts.tmpl', target: 'ruleCheck.ts' },
	{ template: 'ruleSet.ts.tmpl', target: 'ruleSet.ts' },
	{ template: 'enforceRules.ts.tmpl', target: 'enforceRules.ts' },
];

function render(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

function writeUnit(target, content) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

/**
 * `plan` is the already-computed typescript-express resource plan (bin/bskel.mjs calls
 * planTypeScriptExpress() before this) -- only plan.srcRoot is used, matching observe.mjs's own
 * tolerance-of-unused-fields pattern. `artifact` is the already-compiled, already-schema-validated
 * rules artifact (rules/store.mjs's loadRulesArtifact) -- this function never reads specs/ itself.
 */
export function emitRulesTypeScriptExpress({ repoRoot, featureId, artifact, plan, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const rulesDir = path.join(plan.srcRoot, 'rules');

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(rulesDir, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), {}),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'typescript-express', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The compiled artifact, copied verbatim -- byte-identical to the file `bskel rules check`
	// already wrote and schema-validated, deliberately NOT re-serialized here, the same "exactly
	// one representation of these rules" invariant every other provider's emitter holds.
	const content = `${JSON.stringify(artifact, null, '\t')}\n`;
	const target = path.join(rulesDir, 'rulesSchemas', `${featureId}.rules.json`);
	const relPath = path.relative(repoRoot, target);
	const diskContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
	const action = diskContent === null ? 'create' : (diskContent === content ? 'unchanged' : 'update');
	if (!dryRun) writeUnit(target, content);
	result.written.push(relPath);
	const actionEntry = { path: relPath, kind: 'spec', action };
	if (computeDiff && action === 'update') actionEntry.diff = unifiedDiff(relPath, diskContent, content);
	result.actions.push(actionEntry);

	return {
		...result,
		postEmitNotes: [
			`field/cross rules are LOADED but not yet ACTIVE: insert enforceRules("<operationId>") into the real route's own middleware array to have them checked automatically on every request.`,
			`defaults to OBSERVE (logs violations to stderr, never rejects a request) -- set the BSKEL_RULES_MODE=enforce environment variable when you're ready for a real violation to reject with HTTP 400. No re-run of \`bskel rules emit\` needed to switch.`,
			`transition rules are NOT checked by enforceRules() -- they need the resource's CURRENT state, which no middleware can supply generically. Call ruleCheck.checkTransitions(rules, req.body, {"/status": current.status}) directly wherever your route handler has that state. A transition whose current state is not supplied reports "unchecked", never a silent pass.`,
		],
	};
}
