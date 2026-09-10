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
import { projectOperation } from '../../observe-schema-projection.mjs';

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
	// D-runtime-conformance-receipts (cryptographic receipt attestation): JDK-stdlib-only Ed25519
	// signer, used by ContractObservationAspect -- see that template's own javadoc for why this is
	// a hand-rolled canonicalizer, not a Jackson mapper feature.
	{ template: 'ReceiptSigner.java.tmpl', target: 'global/observe/ReceiptSigner.java' },
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

// isScalarLeaf/projectBodySchema/projectPathParams/projectStatuses/projectOperation moved to
// handles/observe-schema-projection.mjs (D-runtime-conformance-receipts) -- pure contract-shape
// logic shared verbatim with python-fastapi/observe.mjs, nothing java-specific about it.

// See DECISIONS.md D-runtime-conformance-receipts. `contract` is the already-loaded, already
// schema-validated feature contract (bin/bskel.mjs's loadContract) -- this function does not read
// specs/ itself. `resolverUnits: []`/`orphanScan: null`: there is no per-resource generated file
// here (a human applies @ObserveContract directly to arbitrary existing methods), so emitUnits()'s
// resolver/orphan machinery has nothing to do -- confirmed its signature tolerates both.
export function emitObserveJavaSpring({ repoRoot, featureId, contract, basePackage, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const jacksonPackage = detectJacksonPackage(repoRoot);
	// D-runtime-conformance-receipts (Jackson 2/3 JsonNode field-iteration parity): Jackson 3's
	// JsonNode has no #fields()/#fieldNames() at all (confirmed live via javap against real
	// jackson-databind 3.1.5 -- only #properties(), a Set); Jackson 2's #fields() exists across
	// every real version checked (2.14 through 2.21), but #properties() does NOT exist on the
	// older ones (2.14 lacks it, 2.17+ has it) -- so the safe, version-spanning choice per major is
	// #fields() for Jackson 2, #properties() for Jackson 3, never the other way around.
	const jacksonFieldsOfImpl = jacksonPackage === 'tools.jackson.databind'
		? 'return node.properties();'
		: 'return () -> node.fields();';

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(javaSrcRoot, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage, JACKSON_PACKAGE: jacksonPackage, JACKSON_FIELDS_OF_IMPL: jacksonFieldsOfImpl }),
	}));

	const result = emitUnits({ repoRoot, featureId, provider: 'java-spring', force, reason, infraUnits, resolverUnits: [], orphanScan: null, dryRun, computeDiff });

	// The projected observed-schema.json classpath resource -- regenerated unconditionally every
	// run (unlike handles' own migration.sql, which moved to manifest tracking in
	// D-write-safety-phase0 -- this file stays unconditional: nobody hand-finishes a generated
	// data file the way they hand-finish a resolver stub, so O2-style conflict tracking buys
	// nothing here). `kind: 'spec'` still means "always regenerated, not conflict-tracked".
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
			'NOT done automatically: to sign receipts, set the `bskel.observe.signing-key-pem` Spring property (e.g. an env var via Spring\'s own relaxed binding: BSKEL_OBSERVE_SIGNING_KEY_PEM=...) to a PKCS#8 Ed25519 private key PEM -- `bskel attest keygen --out <dir>` already generates one in this exact format. Unset means every receipt stays unsigned (backward compatible). Verify with `bskel observe import --pubkey <path/to/attest-public.pem>`.',
		],
	};
}
