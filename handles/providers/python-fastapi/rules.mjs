// D-business-rules (R9): the emit-side half of compiled business rules for python-fastapi. Mirrors
// handles/providers/java-spring/rules.mjs's own shape exactly -- rules, observe, and handles are
// orthogonal capabilities that happen to share the same repo-wide "generated infra" pattern.
//
// This emitter is deliberately THIN. It renders three fixed infra modules and copies an
// already-compiled artifact into `rules_schemas/` -- it makes no decision about what a rule means.
// Every such decision was made and verified in JS by rules/compile.mjs at `bskel rules check` time
// (R3), which is the invariant that lets three languages agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel rules emit` -- rule_set.py
// discovers every `rules_schemas/*.rules.json` file at module-import time rather than being
// regenerated per feature, so these files are true infra (create-once-per-repo, all-or-nothing
// conflict unit), the same treatment observe.mjs's own INFRA_FILES get. None of the three
// templates need any {{VAR}} substitution -- same reasoning observe's own INFRA_FILES give (no
// {{PKG}}, this stays decoupled from handles/, cross-imports are relative `from . import ...`).
const INFRA_FILES = [
	{ template: '__init__.py.tmpl', target: '__init__.py' },
	{ template: 'rule_check.py.tmpl', target: 'rule_check.py' },
	{ template: 'rule_set.py.tmpl', target: 'rule_set.py' },
	{ template: 'enforce_rules.py.tmpl', target: 'enforce_rules.py' },
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
 * `plan` is the already-computed python-fastapi resource plan (bin/bskel.mjs calls
 * planPythonFastApi() before this) -- only plan.importRoot/plan.topPackage are used, matching
 * observe.mjs's own tolerance-of-unused-fields pattern. `artifact` is the already-compiled,
 * already-schema-validated rules artifact (rules/store.mjs's loadRulesArtifact) -- this function
 * never reads specs/ itself, the same split observe.mjs holds for the contract.
 */
export function emitRulesPythonFastApi({ repoRoot, featureId, artifact, plan, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const rulesDir = path.join(plan.importRoot, plan.topPackage, 'rules');
	// __init__.py.tmpl is shared verbatim with the handles/observe infra sets (an empty marker
	// file) -- reuse the same template rather than duplicating a one-line file a third time.
	const sharedInitTemplate = path.join(PROVIDER_ROOT, 'templates', '__init__.py.tmpl');

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: f.template === '__init__.py.tmpl' ? sharedInitTemplate : path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(rulesDir, f.target),
		rendered: render(f.template === '__init__.py.tmpl' ? sharedInitTemplate : path.join(TEMPLATES_DIR, f.template), {}),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'python-fastapi', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The compiled artifact, copied verbatim -- byte-identical to the file `bskel rules check`
	// already wrote and schema-validated, deliberately NOT re-serialized here, the same "exactly
	// one representation of these rules" invariant java-spring's own emitter holds.
	const content = `${JSON.stringify(artifact, null, '\t')}\n`;
	const target = path.join(rulesDir, 'rules_schemas', `${featureId}.rules.json`);
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
			`field/cross rules are LOADED but not yet ACTIVE: decorate the real route handler with @enforce_rules(operation_id="<operationId>", body_param="<arg name>") to have them checked automatically on every call.`,
			`defaults to OBSERVE (logs to the "bskel.rules.violations" logger, never rejects a request) -- set the BSKEL_RULES_MODE=enforce environment variable when you're ready for a real violation to reject with HTTP 400. No re-run of \`bskel rules emit\` needed to switch.`,
			`transition rules are NOT checked by @enforce_rules -- they need the resource's CURRENT state, which no decorator can supply generically. Call rule_check.check_transitions(rules, body, {"/status": current.status}) directly wherever your service layer has that state. A transition whose current state is not supplied reports "unchecked", never a silent pass.`,
		],
	};
}
