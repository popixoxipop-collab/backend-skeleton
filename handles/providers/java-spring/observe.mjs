// D-runtime-conformance-receipts: the emit-side half of opt-in runtime contract-conformance
// checking. Kept as its own file, sibling to emit.mjs, rather than folded into it -- observe and
// handles are orthogonal capabilities (one validates real traffic shape, the other exposes/patches
// UUID-addressable fields) that happen to share the same repo-wide "generated infra" pattern, not
// the same feature. See DECISIONS.md for the full WHY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';
import { sha256File } from '../../../lib/fsutil.mjs';
import { specPath } from '../../../lib/paths.mjs';
import { detectJacksonPackage } from './emit.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');

// Repo-wide, shared across every feature that ever runs `bskel observe emit` -- ObserveSchemaLoader
// discovers every `bskel/*.observed-schema.json` classpath resource at startup rather than being
// regenerated per feature, so these four files are true infra (create-once-per-repo, all-or-nothing
// conflict unit), same treatment INFRA_FILES gives handles' own global/handle/* files.
const INFRA_FILES = [
	{ template: 'ObserveContract.java.tmpl', target: 'global/observe/ObserveContract.java' },
	{ template: 'ContractCheck.java.tmpl', target: 'global/observe/ContractCheck.java' },
	{ template: 'ObserveSchemaLoader.java.tmpl', target: 'global/observe/ObserveSchemaLoader.java' },
	{ template: 'ContractObservationAspect.java.tmpl', target: 'global/observe/ContractObservationAspect.java' },
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

// A property this project's own contracts already fully control the generation of when there's
// nothing deeper than a directly-checkable value -- string/number/integer/boolean with no nested
// properties/items/$ref/anyOf/allOf/oneOf. See DECISIONS.md D-runtime-conformance-receipts,
// Decision B: what's checkable is decided ONCE here, in JS, at `observe emit` time -- the Java
// side (ContractCheck.java.tmpl) is a dumb, mechanical executor of an already-simplified
// instruction set, never a second independent JSON-Schema interpreter.
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

function isScalarLeaf(schema) {
	if (!schema || typeof schema !== 'object') return false;
	if (schema.properties || schema.items || schema.$ref || schema.anyOf || schema.allOf || schema.oneOf) return false;
	return typeof schema.type === 'string' && SCALAR_TYPES.has(schema.type);
}

// Projects a real (possibly arbitrarily deep) JSON Schema object -- contract.operations[id]'s own
// requestBodySchema/responseSchema/errorSchema, present only when `contract emit --openapi-file`
// was used and something resolved (contracts/emit.mjs) -- down to the bounded, checkable-only
// shape ContractCheck.java.tmpl understands: top-level `required`, scalar-leaf `properties` kept
// as {type, pattern?}, everything else marked `unsupported` at its own JSON Pointer rather than
// silently treated as pass. A non-object root (anyOf/allOf/oneOf/$ref/any non-'object' type -- the
// real shape a multi-status-unioned responseSchema can take) is marked unsupported at the root
// pointer "" wholesale, rather than guessed into a partial projection.
function projectBodySchema(schema) {
	if (!schema || typeof schema !== 'object') return null;
	if (schema.anyOf || schema.allOf || schema.oneOf || schema.$ref || schema.type !== 'object') {
		return { required: [], properties: {}, unsupported: [''] };
	}
	const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
	const properties = {};
	const unsupported = [];
	for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
		if (isScalarLeaf(propSchema)) {
			properties[key] = { type: propSchema.type, ...(typeof propSchema.pattern === 'string' ? { pattern: propSchema.pattern } : {}) };
		} else {
			unsupported.push(`/${key}`);
		}
	}
	return { required, properties, unsupported };
}

// pathParams is ALWAYS the narrow, bskel-controlled vocabulary contracts/emit.mjs's own
// pathParamsSchema() produces (type:'object', additionalProperties:false, properties/required,
// each property {type:'string', pattern?}) -- passed through structurally rather than re-derived,
// but still routed through the same scalar-leaf check as body properties, defensively, in case a
// hand-edited contract ever puts something deeper there.
function projectPathParams(pathParamsSchema) {
	const required = Array.isArray(pathParamsSchema?.required) ? pathParamsSchema.required.filter((r) => typeof r === 'string') : [];
	const properties = {};
	const unsupported = [];
	for (const [key, propSchema] of Object.entries(pathParamsSchema?.properties ?? {})) {
		if (isScalarLeaf(propSchema)) {
			properties[key] = { type: propSchema.type, ...(typeof propSchema.pattern === 'string' ? { pattern: propSchema.pattern } : {}) };
		} else {
			unsupported.push(`/${key}`);
		}
	}
	return { required, properties, unsupported };
}

// A8: sourceResponses' own keys are literal status codes/ranges/"default" straight from a real
// source document (schemas/feature-contract.schema.json's own propertyNames pattern), never
// re-bucketed here -- matching status against them at runtime (a real observed code against
// "4XX"/"default") is a bounded, mechanical string comparison, not JSON-Schema interpretation, so
// doing it in Java (ContractCheck) doesn't violate Decision B's "one interpreter" boundary.
function projectStatuses(sourceResponses) {
	return sourceResponses ? Object.keys(sourceResponses) : null;
}

function projectOperation(opContract) {
	return {
		verb: opContract.verb,
		path: opContract.path,
		pathParams: projectPathParams(opContract.pathParams),
		// Normalized to always a JSON string ("true"/"false"/"unknown") -- opContract.body is a
		// true|false|'unknown' tri-state (mixed boolean/string), awkward for the Java side to parse
		// unambiguously; String() keeps this file's own schema uniformly typed.
		body: String(opContract.body),
		request: opContract.body === false ? null : projectBodySchema(opContract.requestBodySchema),
		response: projectBodySchema(opContract.responseSchema),
		error: projectBodySchema(opContract.errorSchema),
		statuses: projectStatuses(opContract.sourceResponses),
	};
}

// See DECISIONS.md D-runtime-conformance-receipts. `contract` is the already-loaded, already
// schema-validated feature contract (bin/bskel.mjs's loadContract) -- this function does not read
// specs/ itself. `resolverUnits: []`/`orphanScan: null`: there is no per-resource generated file
// here (a human applies @ObserveContract directly to arbitrary existing methods), so emitUnits()'s
// resolver/orphan machinery has nothing to do -- confirmed its signature tolerates both.
export function emitObserveJavaSpring({ repoRoot, featureId, contract, basePackage, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const jacksonPackage = detectJacksonPackage(repoRoot);

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(javaSrcRoot, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage, JACKSON_PACKAGE: jacksonPackage }),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'java-spring', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The projected observed-schema.json classpath resource -- regenerated unconditionally every
	// run, like handles' own migration.sql, and for the identical reason: nobody hand-finishes a
	// generated data file the way they hand-finish a resolver stub, so O2-style conflict tracking
	// buys nothing here. `kind: 'spec'` matches migration.sql's own action-reporting convention.
	const operations = {};
	for (const [opId, opContract] of Object.entries(contract.operations)) {
		operations[opId] = projectOperation(opContract);
	}
	const contractRef = sha256File(specPath(repoRoot, featureId, 'contracts', `${featureId}.schema.json`));
	const schemaContent = `${JSON.stringify({ sbf_observed_schema: '1', feature_id: featureId, feature_uid: contract.feature_uid, contract_ref: contractRef, operations }, null, '\t')}\n`;
	const schemaPath = path.join(repoRoot, 'src', 'main', 'resources', 'bskel', `${featureId}.observed-schema.json`);
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
			'NOT done automatically: ContractObservationAspect.java requires spring-boot-starter-aop on your own build.gradle classpath -- if you already added it for @RecordHandleSnapshot (O4/handles), no new dependency is needed here.',
			'NOT done automatically: route the "bskel.observe.receipts" SLF4J logger to wherever you want receipt lines collected (a dedicated logback/log4j2 appender to a file, your existing log pipeline, etc.) -- bskel never edits your logging config. Point `bskel observe import --receipts <path>` at whatever that logger\'s output ends up as.',
			`Contract-conformance checking only covers path params always, plus a bounded slice of request/response/error body shape -- and only when this contract was emitted with --openapi-file. See the emitted ${path.relative(repoRoot, schemaPath)}'s own "unsupported" markers for exactly what is skipped for this feature.`,
			'NOT done automatically: apply @ObserveContract(operationId = "...") to whichever existing controller/service methods you want observed -- nothing is annotated for you (D-resolver-scope: never guess which method implements which operation).',
		],
	};
}
