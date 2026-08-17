import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits } from '../../_engine.mjs';

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
export function emitJavaSpring({ repoRoot, featureId, plan, basePackage, resourceFilter = null, force = false, reason = '' }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));

	const infraUnits = INFRA_FILES.map((f) => ({
		id: f.template,
		templatePath: path.join(TEMPLATES_DIR, f.template),
		targetAbs: path.join(javaSrcRoot, f.target),
		rendered: render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage }),
	}));

	const resolverUnits = plan.resources
		.filter((r) => r.willGenerateResolver) // see plan.mjs: no broken imports generated on purpose
		.map((resource) => {
			const vars = {
				BASE_PACKAGE: basePackage,
				MODULE: plan.module,
				RESOURCE_TYPE: resource.type,
				SERVICE_IMPORT: `${basePackage}.domain.${plan.module}.application.${resource.service.serviceType}`,
				SERVICE_TYPE: resource.service.serviceType,
				SERVICE_FIELD: lowerFirst(resource.service.serviceType),
				FETCH_METHOD: resource.fetchOperation.method,
				REQUIRED_AUTHORITY: resource.requiredAuthority,
				FEATURE_ID: featureId,
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

	const result = emitUnits({ repoRoot, featureId, provider: 'java-spring', force, reason, infraUnits, resolverUnits, orphanScan });

	// The migration file is regenerated fresh every run, unconditionally, regardless of the
	// resolver/infra conflict-block state above -- it has never been manifest-tracked (no
	// conflict detection for it at all), matching the pre-G4 behavior exactly.
	const migrationContent = render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId });
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');
	writeUnit(migrationPath, migrationContent);
	result.written.push(path.relative(repoRoot, migrationPath));

	return {
		...result,
		postEmitNotes: ['NOT done automatically: applying specs/<id>/handles/migration.sql to any database. Review it and apply yourself.'],
	};
}
