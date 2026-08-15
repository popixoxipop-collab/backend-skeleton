import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HANDLES_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(HANDLES_ROOT, 'templates', 'java-spring');
const MIGRATION_TEMPLATE = path.join(HANDLES_ROOT, 'templates', 'migration', 'migration.sql.tmpl');

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

// Detected from the Spring Boot `*Application.java` file's own package declaration, rather
// than assumed/configured -- works for any Spring Boot project following the standard
// convention, not just Team-IZ-Backend's specific `com.bigproject.backend`.
export function detectBasePackage(repoRoot) {
	const srcRoot = path.join(repoRoot, 'src', 'main', 'java');
	if (!fs.existsSync(srcRoot)) return null;
	let files;
	try {
		files = execFileSync('rg', ['--files', '-g', '*Application.java', srcRoot], { encoding: 'utf8' }).split('\n').filter(Boolean);
	} catch {
		files = [];
	}
	if (files.length === 0) return null;
	const match = fs.readFileSync(files[0], 'utf8').match(/^package\s+([\w.]+);/m);
	return match ? match[1] : null;
}

export function emitHandles({ repoRoot, featureId, plan, basePackage }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const written = [];

	for (const f of INFRA_FILES) {
		const rendered = render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage });
		const target = path.join(javaSrcRoot, f.target);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, rendered);
		written.push(path.relative(repoRoot, target));
	}

	const resolverStubs = [];
	for (const resource of plan.resources) {
		if (!resource.willGenerateResolver) continue; // see plan.mjs: no broken imports generated on purpose
		const rendered = render(path.join(TEMPLATES_DIR, 'ResourceResolverStub.java.tmpl'), {
			BASE_PACKAGE: basePackage,
			MODULE: plan.module,
			RESOURCE_TYPE: resource.type,
			SERVICE_IMPORT: `${basePackage}.domain.${plan.module}.application.${resource.service.serviceType}`,
			SERVICE_TYPE: resource.service.serviceType,
			SERVICE_FIELD: lowerFirst(resource.service.serviceType),
			FETCH_METHOD: resource.fetchOperation.method,
			REQUIRED_AUTHORITY: resource.requiredAuthority,
			FEATURE_ID: featureId,
		});
		const target = path.join(javaSrcRoot, 'domain', plan.module, 'infrastructure', `${resource.type}Resolver.java`);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, rendered);
		written.push(path.relative(repoRoot, target));
		resolverStubs.push(resource.type);
	}

	const migrationContent = render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId });
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');
	fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
	fs.writeFileSync(migrationPath, migrationContent);
	written.push(path.relative(repoRoot, migrationPath));

	return { written, resolverStubs };
}
