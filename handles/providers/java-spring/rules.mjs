// D-business-rules (R9): the emit-side half of compiled business rules for java-spring. Its own
// file, sibling to observe.mjs and emit.mjs, for exactly the reason observe.mjs's own header gives:
// rules, observe, and handles are orthogonal capabilities that happen to share the same repo-wide
// "generated infra" pattern, not the same feature.
//
// This emitter is deliberately THIN. It renders two fixed infra classes and copies an
// already-compiled artifact onto the classpath -- it makes no decision about what a rule means.
// Every such decision was made and verified in JS by rules/compile.mjs at `bskel rules check` time
// (R3), which is the invariant that lets three languages agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';
import { detectJacksonPackage } from './emit.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel rules emit` -- RuleSetLoader
// discovers every `bskel/*.rules.json` classpath resource at startup rather than being regenerated
// per feature, so these files are true infra (create-once-per-repo, all-or-nothing conflict unit),
// the same treatment observe.mjs's own INFRA_FILES get. EnforceRules/RuleEnforcementAspect (R8) are
// the automatic field/cross wiring path -- transition rules stay a manual RuleCheck.checkTransitions
// call, since a transition guard needs the resource's current state, which no annotation can supply
// generically (see EnforceRules.java.tmpl's own javadoc).
const INFRA_FILES = [
	{ template: 'RuleSetLoader.java.tmpl', target: 'global/rules/RuleSetLoader.java' },
	{ template: 'RuleCheck.java.tmpl', target: 'global/rules/RuleCheck.java' },
	{ template: 'EnforceRules.java.tmpl', target: 'global/rules/EnforceRules.java' },
	{ template: 'RuleEnforcementAspect.java.tmpl', target: 'global/rules/RuleEnforcementAspect.java' },
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
 * @param {object} args
 * @param {object} args.artifact the already-compiled, already-schema-validated rules artifact
 *                               (rules/store.mjs's loadRulesArtifact) -- this function never reads
 *                               specs/ itself, the same split observe.mjs holds for the contract.
 */
export function emitRulesJavaSpring({ repoRoot, featureId, artifact, basePackage, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const jacksonPackage = detectJacksonPackage(repoRoot);

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(javaSrcRoot, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage, JACKSON_PACKAGE: jacksonPackage }),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'java-spring', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The compiled artifact, copied verbatim onto the classpath. Byte-identical to the file
	// `bskel rules check` already wrote and schema-validated -- deliberately NOT re-serialized
	// here, so there is exactly one representation of these rules and no chance of the runtime
	// executing something subtly different from what was audited. `kind: 'spec'` = always
	// regenerated, not conflict-tracked (nobody hand-finishes a generated data file).
	const content = `${JSON.stringify(artifact, null, '\t')}\n`;
	const target = path.join(repoRoot, 'src', 'main', 'resources', 'bskel', `${featureId}.rules.json`);
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
			`field/cross rules are LOADED but not yet ACTIVE: add @EnforceRules(operationId = "<operationId>") to the real controller method to have them checked automatically on every call.`,
			`defaults to OBSERVE (logs to the "bskel.rules.violations" logger, never rejects a request) -- set bskel.rules.mode: enforce in your own application.yml when you're ready for a real violation to reject with HTTP 400. No re-run of \`bskel rules emit\` needed to switch.`,
			`transition rules are NOT checked by @EnforceRules -- they need the resource's CURRENT state, which no annotation can supply generically. Call RuleCheck.checkTransitions(rules, body, Map.of("/status", current.getStatus())) directly wherever your service layer has that state. A transition whose current state is not supplied reports "unchecked", never a silent pass.`,
		],
	};
}
