// D-runtime-conformance-receipts: the emit-side half of opt-in runtime contract-conformance
// checking for typescript-express. Mirrors handles/providers/python-fastapi/observe.mjs's own
// shape -- observe and handles are orthogonal capabilities that happen to share the same repo-wide
// "generated infra" pattern, not the same feature. See DECISIONS.md for the full WHY, including the
// TS-specific response-body-capture note (res.json patch + res.on('finish', ...), never a wrapped
// return value the way java's @Around/python's `await fn(...)` are) the generated
// observeContract.ts itself implements.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';
import { sha256File } from '../../../lib/fsutil.mjs';
import { specPath } from '../../../lib/paths.mjs';
import { projectOperation } from '../../observe-schema-projection.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel observe emit` -- observedSchema.ts
// discovers every schemas/*.observed-schema.json file at MODULE LOAD time rather than being
// regenerated per feature, so these three files are true infra (create-once-per-repo, all-or-nothing
// conflict unit), same treatment INFRA_FILES gives handles' own handlesDir infra files (codec.ts/
// registry.ts/router.ts). Three files, not python's four -- TS/Node has no __init__.py-equivalent
// package marker a plain relative-import directory needs to be importable, so there is no
// __init__.ts-shaped file to carry over. None of the three need any {{VAR}} substitution -- observe
// stays decoupled from handles/, cross-imports between them are relative `from './contractCheck'`.
const INFRA_FILES = [
	{ template: 'contractCheck.ts.tmpl', target: 'contractCheck.ts' },
	{ template: 'observedSchema.ts.tmpl', target: 'observedSchema.ts' },
	{ template: 'observeContract.ts.tmpl', target: 'observeContract.ts' },
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
// specs/ itself. `plan` is the already-computed typescript-express resource plan (bin/bskel.mjs
// calls planTypeScriptExpress() before this, the same --module dependency python-fastapi's own
// observe emit already established) -- only `plan.srcRoot` is used here, `plan.resources`/
// `plan.notes` are computed and simply unused, same tolerance emitUnits() already extends to
// java's/python's own `resolverUnits: []`. There is no per-resource generated file here (a human
// inserts observeContract('...') directly into an existing route's own middleware array), so
// emitUnits()'s resolver/orphan machinery has nothing to do.
export function emitObserveTypeScriptExpress({ repoRoot, featureId, contract, plan, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const observeDir = path.join(plan.srcRoot, 'observe');

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(observeDir, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), {}),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'typescript-express', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The projected observed-schema.json resource -- regenerated unconditionally every run (unlike
	// handles' own migration.sql, which moved to manifest tracking in D-write-safety-phase0; this
	// file, and both other providers' own observe schema resource, stay unconditional: nobody
	// hand-finishes a generated data file, so O2-style conflict tracking buys nothing here).
	// `kind: 'spec'` still means "always regenerated, not conflict-tracked" -- NOT the
	// `kind: 'infra'` A13 gave resolvers_index.ts, which was a genuinely hand-editable barrel;
	// this is a generated data file, a different class.
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
			'NOT done automatically: route observeContract\'s own receipt sink (defaults to one JSON line per receipt via process.stdout.write) to wherever you want receipt lines collected -- bskel never edits your logging/process-supervisor config. Override it at app startup ("import { setReceiptSink } from \'./observe/observeContract\';") to point it at your own log pipeline, then point `bskel observe import --receipts <path>` at whatever that ends up as.',
			'If your build compiles TypeScript to a separate output directory (`tsc --outDir dist`), make sure observe/schemas/*.json is copied alongside the compiled observedSchema.js -- tsc only compiles .ts files, it does not copy plain data files into the output tree, and observedSchema.ts discovers its schemas relative to its OWN compiled location at runtime (__dirname). A target app that only ever runs from src/ (ts-node, tsx) needs no extra step here.',
			`Contract-conformance checking only covers path params always, plus a bounded slice of request/response/error body shape -- and only when this contract was emitted with --openapi-file. See the emitted ${path.relative(repoRoot, schemaPath)}'s own "unsupported" markers for exactly what is skipped for this feature.`,
			'NOT done automatically: insert observeContract(\'<operationId>\') into whichever existing route\'s own middleware array/argument list you want observed (e.g. `router.get(path, [checkJwt, observeContract(\'op-id\')], handler)`) -- nothing is inserted for you (D-resolver-scope: never guess which route implements which operation).',
			'error_class is never populated in this provider\'s receipts (always omitted) -- Express middleware runs BEFORE the route handler and is structurally unable to observe a thrown error the way java\'s @Around/python\'s except block can (by the time a handler throws or calls next(err), this middleware\'s own call frame has already returned). See DECISIONS.md D-runtime-conformance-receipts.',
			'Response-body checking only covers a handler that calls res.json(...) or res.send(<object>) (Express\'s own res.send delegates to res.json for a plain-object body) -- a handler that calls res.send(<string>)/res.end(...) directly, or whose response is produced by Express\'s own default/generic error handler, has its response check silently skipped, never guessed.',
			'OpenAPI reconciliation for this adapter matches scanned Express route strings EXACTLY against the OpenAPI document\'s own path keys (contracts/openapi.mjs has no ":id" <-> "{id}" translation) -- a real, standards-compliant OpenAPI document (which must use "{id}") will not match a scanned ":id"/":id([0-9]+)" route unless the document\'s own path key happens to already read that way. Unlike python-fastapi, this is not "for free."',
		],
	};
}
