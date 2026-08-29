// D-runtime-conformance-receipts: the emit-side half of opt-in runtime contract-conformance
// checking for python-fastapi. Mirrors handles/providers/java-spring/observe.mjs's own shape --
// observe and handles are orthogonal capabilities that happen to share the same repo-wide
// "generated infra" pattern, not the same feature. See DECISIONS.md for the full WHY, including
// the python-specific async-wrapper correctness note the generated `observe_contract.py` itself
// implements.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';
import { sha256File } from '../../../lib/fsutil.mjs';
import { specPath } from '../../../lib/paths.mjs';
import { projectOperation } from '../../observe-schema-projection.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel observe emit` -- observed_schema.py
// discovers every schemas/*.observed-schema.json file at module-import time rather than being
// regenerated per feature, so these four files are true infra (create-once-per-repo, all-or-nothing
// conflict unit), same treatment INFRA_FILES gives handles' own handlesDir infra files. None of the
// three new templates need any {{VAR}} substitution (no {{PKG}} -- observe stays decoupled from
// handles/, cross-imports between them are relative `from . import ...`).
const INFRA_FILES = [
	{ template: '__init__.py.tmpl', target: '__init__.py' },
	{ template: 'observed_schema.py.tmpl', target: 'observed_schema.py' },
	{ template: 'contract_check.py.tmpl', target: 'contract_check.py' },
	{ template: 'observe_contract.py.tmpl', target: 'observe_contract.py' },
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

// See DECISIONS.md D-runtime-conformance-receipts. `contract` is the already-loaded, already
// schema-validated feature contract (bin/bskel.mjs's loadContract) -- this function does not read
// specs/ itself. `plan` is the already-computed python-fastapi resource plan (bin/bskel.mjs calls
// planPythonFastApi() before this) -- only `plan.importRoot`/`plan.topPackage` are used here,
// `plan.resources`/`plan.notes` are computed and simply unused, same tolerance-of-unused-fields
// pattern emitUnits() already extends to java's `resolverUnits: []`. `resolverUnits: []`/
// `orphanScan: null`: there is no per-resource generated file here (a human applies
// @observe_contract directly to arbitrary existing functions), so emitUnits()'s resolver/orphan
// machinery has nothing to do.
export function emitObservePythonFastApi({ repoRoot, featureId, contract, plan, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const observeDir = path.join(plan.importRoot, plan.topPackage, 'observe');

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(observeDir, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), {}),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'python-fastapi', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The projected observed-schema.json resource -- regenerated unconditionally every run, like
	// handles' own migration.sql (and java observe's own schema resource), and for the identical
	// reason: nobody hand-finishes a generated data file the way they hand-finish a resolver stub,
	// so O2-style conflict tracking buys nothing here. `kind: 'spec'` matches migration.sql's own
	// action-reporting convention. Discovered at runtime via a plain glob under observe/schemas/
	// (see observed_schema.py.tmpl's own docstring for why -- no importlib.resources needed since
	// this ecosystem only ever runs from source).
	const operations = {};
	for (const [opId, opContract] of Object.entries(contract.operations)) {
		operations[opId] = projectOperation(opContract);
	}
	const contractRef = sha256File(specPath(repoRoot, featureId, 'contracts', `${featureId}.schema.json`));
	const schemaContent = `${JSON.stringify({ sbf_observed_schema: '1', feature_id: featureId, feature_uid: contract.feature_uid, contract_ref: contractRef, operations }, null, '\t')}\n`;
	const schemaPath = path.join(observeDir, 'schemas', `${featureId}.observed-schema.json`);
	const schemaRelPath = path.relative(repoRoot, schemaPath);
	const schemaDiskContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : null;
	const schemaAction = schemaDiskContent === null ? 'create' : (schemaDiskContent === schemaContent ? 'unchanged' : 'update');
	if (!dryRun) writeUnit(schemaPath, schemaContent);
	result.written.push(schemaRelPath);
	const schemaActionEntry = { path: schemaRelPath, kind: 'spec', action: schemaAction };
	if (computeDiff && schemaAction === 'update') schemaActionEntry.diff = unifiedDiff(schemaRelPath, schemaDiskContent, schemaContent);
	result.actions.push(schemaActionEntry);

	return {
		...result,
		postEmitNotes: [
			'NOT done automatically: route the "bskel.observe.receipts" logger (Python\'s standard logging module) to wherever you want receipt lines collected (a dedicated handler to a file, your existing log pipeline, etc.) -- bskel never edits your logging config. Point `bskel observe import --receipts <path>` at whatever that logger\'s output ends up as.',
			`Contract-conformance checking only covers path params always, plus a bounded slice of request/response/error body shape -- and only when this contract was emitted with --openapi-file. See the emitted ${path.relative(repoRoot, schemaPath)}'s own "unsupported" markers for exactly what is skipped for this feature.`,
			'NOT done automatically: apply @observe_contract(operation_id="...") to whichever existing route handlers you want observed -- nothing is decorated for you (D-resolver-scope: never guess which function implements which operation). For a request body to be checked, also pass body_param="<the argument name>" explicitly -- Python has no @RequestBody-equivalent marker to infer it from.',
		],
	};
}
