import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits, unifiedDiff } from '../../_engine.mjs';
import { loadPatchApprovals, approvedStrategyFor } from '../../../lib/patch-approvals.mjs';
import { computeCodegenNeeds, renderPatchFieldBody } from './patch-strategy.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');
const MIGRATION_TEMPLATE = path.join(TEMPLATES_DIR, 'migration.sql.tmpl');
const RESOLVER_TEMPLATE = path.join(TEMPLATES_DIR, 'ResourceResolverStub.java.tmpl');

const INFRA_FILES = [
	{ template: 'HandleCodec.java.tmpl', target: 'global/handle/HandleCodec.java' },
	{ template: 'HandleRegistry.java.tmpl', target: 'global/handle/HandleRegistry.java' },
	{ template: 'HandleSnapshot.java.tmpl', target: 'global/handle/HandleSnapshot.java' },
	{ template: 'HandleRegistryRepository.java.tmpl', target: 'global/handle/HandleRegistryRepository.java' },
	{ template: 'HandleSnapshotRepository.java.tmpl', target: 'global/handle/HandleSnapshotRepository.java' },
	{ template: 'ResourceResolver.java.tmpl', target: 'global/handle/ResourceResolver.java' },
	{ template: 'HandleController.java.tmpl', target: 'global/handle/HandleController.java' },
];

function render(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

function lowerFirst(s) {
	return s.charAt(0).toLowerCase() + s.slice(1);
}

// A3 (D-patch-strategy): Spring Boot 4+ ships Jackson 3 as its primary JSON engine (package
// `tools.jackson.databind`, NOT `com.fasterxml.jackson.databind`) -- confirmed by reading the
// real oracle repo's own build.gradle (`id 'org.springframework.boot' version '4.1.0'`) AND its
// own source (`SecurityConfig.java` imports `tools.jackson.databind.ObjectMapper`). A single
// OTHER file in that same repo (`AiClient.java`) imports the classic `com.fasterxml.jackson`
// package for a third-party AI SDK's own bundled Jackson 2 instance -- NOT what Spring actually
// autoconfigures as the injectable `ObjectMapper` BEAN, so grepping "does any file mention this
// import" would have been ambiguous/wrong here. The Spring Boot plugin's own major version is the
// reliable signal: it determines which Jackson generation Spring's autoconfiguration wires up as
// the primary `ObjectMapper` bean, which is what `@RequiredArgsConstructor` injection needs.
// Defaults to the classic package when build.gradle/the plugin version can't be found -- covers
// the far more common Spring Boot <=3.x case, and matches this project's own CI fixture corpus.
export function detectJacksonPackage(repoRoot) {
	const buildGradlePath = path.join(repoRoot, 'build.gradle');
	if (!fs.existsSync(buildGradlePath)) return 'com.fasterxml.jackson.databind';
	const text = fs.readFileSync(buildGradlePath, 'utf8');
	const match = text.match(/id\s+['"]org\.springframework\.boot['"]\s+version\s+['"](\d+)\./);
	const majorVersion = match ? Number(match[1]) : null;
	return majorVersion !== null && majorVersion >= 4 ? 'tools.jackson.databind' : 'com.fasterxml.jackson.databind';
}

// The import block patchField() codegen needs, computed fresh every run
// from the CURRENT classification + approvals (never cached against a prior emit) -- empty string
// when nothing is approved yet, so a resource with no approved fields renders byte-identical to
// one with no update endpoint at all.
function buildPatchImports({ basePackage, module, dtoTypeName, needsPatchFieldImport, jacksonPackage }) {
	const lines = [
		`import ${basePackage}.domain.${module}.presentation.dto.${dtoTypeName};`,
		'import jakarta.validation.ConstraintViolation;',
		'import jakarta.validation.ConstraintViolationException;',
		'import jakarta.validation.Validator;',
		`import ${jacksonPackage}.ObjectMapper;`,
		'import java.util.Set;',
	];
	if (needsPatchFieldImport) lines.push(`import ${basePackage}.global.json.PatchField;`);
	return lines.map((l) => `${l}\n`).join('');
}

function buildPatchFields() {
	return '\tprivate final Validator validator;\n\tprivate final ObjectMapper objectMapper;\n';
}

// The set of {resource, field} approvals whose recorded strategy still matches what the
// classifier computes RIGHT NOW -- a stale approval (the DTO changed since approval) is excluded
// here, not just skipped at codegen time, so callers never even have to reason about staleness
// themselves. Fail-closed: a mismatch silently falls back to the "classified but not approved"
// explanatory stub, exactly like never having been approved at all.
function currentlyApprovedFields(approvals, resourceType, patchable) {
	const approved = new Set();
	for (const field of patchable) {
		if (approvedStrategyFor(approvals, resourceType, field.field) === field.bucket) approved.add(field.field);
	}
	return approved;
}

function writeUnit(target, content) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

// See DECISIONS.md D-handles-ownership for the full design; the conflict/manifest/force/orphan
// logic itself now lives in handles/_engine.mjs (D-handles-providers, G4) -- this function's job
// is purely to compute java-spring's own render/paths and hand them to emitUnits(). `force`/
// `reason` overwrite any conflicted unit found within this call's own scope (already narrowed by
// featureId/module/resourceFilter) -- never a blanket, unscoped force. `resourceFilter` (the same
// array plan() was called with, or null) turns off orphan detection when non-null, since a scoped
// run would otherwise report every OTHER resource's resolver as orphaned.
export function emitJavaSpring({ repoRoot, featureId, plan, basePackage, resourceFilter = null, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(javaSrcRoot, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage }),
	}));

	// A3 (D-patch-strategy): both loaded/detected once per emit call, outside the resolver loop --
	// approvals are feature-scoped (not per-resource) and the Jackson package is repo-wide, so one
	// computation each covers every resource this call touches.
	const patchApprovals = loadPatchApprovals(repoRoot, featureId);
	const jacksonPackage = detectJacksonPackage(repoRoot);

	const resolverUnits = plan.resources
		.filter((r) => r.willGenerateResolver) // see plan.mjs: no broken imports generated on purpose
		.map((resource) => {
			const patchable = resource.patchable ?? [];
			// A blocked update service (see plan.mjs's updateServiceBlockedReason) means NO field of
			// this resource can be auto-generated regardless of approvals -- ignore any recorded
			// approvals for its codegen-needs computation, but the classification itself still renders
			// (see renderPatchFieldBody's blockedReason handling).
			const approvedFields = resource.updateServiceBlockedReason ? new Set() : currentlyApprovedFields(patchApprovals, resource.type, patchable);
			const { needsValidation, needsPatchFieldImport } = computeCodegenNeeds(patchable, approvedFields);
			const serviceField = lowerFirst(resource.service.serviceType);
			const vars = {
				BASE_PACKAGE: basePackage,
				MODULE: plan.module,
				RESOURCE_TYPE: resource.type,
				SERVICE_IMPORT: `${basePackage}.domain.${plan.module}.application.${resource.service.serviceType}`,
				SERVICE_TYPE: resource.service.serviceType,
				SERVICE_FIELD: serviceField,
				FETCH_METHOD: resource.fetchOperation.method,
				REQUIRED_AUTHORITY: resource.requiredAuthority,
				FEATURE_ID: featureId,
				PATCH_IMPORTS: needsValidation ? buildPatchImports({ basePackage, module: plan.module, dtoTypeName: resource.dtoTypeName, needsPatchFieldImport, jacksonPackage }) : '',
				PATCH_FIELDS: needsValidation ? buildPatchFields() : '',
				PATCH_FIELD_BODY: renderPatchFieldBody({
					resourceType: resource.type,
					dtoTypeName: resource.dtoTypeName,
					patchable,
					updateOperation: resource.updateOperation,
					serviceField,
					approvedFields,
					blockedReason: resource.updateServiceBlockedReason,
				}),
			};
			return {
				id: 'ResourceResolverStub.java.tmpl',
				resourceType: resource.type,
				module: plan.module,
				templatePath: RESOLVER_TEMPLATE,
				targetAbs: path.join(javaSrcRoot, 'domain', plan.module, 'infrastructure', `${resource.type}Resolver.java`),
				rendered: render(RESOLVER_TEMPLATE, vars),
				pristineRenderFor: (ownerId) => render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: ownerId }),
			};
		});

	const orphanScan = (!resourceFilter && plan.module) ? {
		dir: path.join(javaSrcRoot, 'domain', plan.module, 'infrastructure'),
		module: plan.module,
		matchesFile: (file) => file.endsWith('Resolver.java'),
		resourceTypeOf: (file, _content) => file.replace(/Resolver\.java$/, ''),
	} : null;

	const result = emitUnits({ repoRoot, featureId, provider: 'java-spring', force, reason, infraUnits, resolverUnits, orphanScan, dryRun, computeDiff });

	// The migration file is regenerated fresh every run, unconditionally, regardless of the
	// resolver/infra conflict-block state above -- it has never been manifest-tracked (no
	// conflict detection for it at all), matching the pre-G4 behavior exactly. D4: this is exactly
	// the `outputs.spec` category P4's conformance harness already had to special-case (see
	// handles/conformance.mjs) -- classifyFile() never runs against it, so its create/unchanged/
	// update action is derived locally here, tagged `kind: 'spec'` in the actions report so it
	// reads distinctly from the manifest-tracked infra/resolver kinds.
	const migrationContent = render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId });
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');
	const migrationRelPath = path.relative(repoRoot, migrationPath);
	const migrationDiskContent = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : null;
	const migrationAction = migrationDiskContent === null ? 'create' : (migrationDiskContent === migrationContent ? 'unchanged' : 'update');
	if (!dryRun) writeUnit(migrationPath, migrationContent);
	result.written.push(migrationRelPath);
	const migrationActionEntry = { path: migrationRelPath, kind: 'spec', action: migrationAction };
	if (computeDiff && migrationAction === 'update') migrationActionEntry.diff = unifiedDiff(migrationRelPath, migrationDiskContent, migrationContent);
	result.actions.push(migrationActionEntry);

	return {
		...result,
		postEmitNotes: ['NOT done automatically: applying specs/<id>/handles/migration.sql to any database. Review it and apply yourself.'],
	};
}
