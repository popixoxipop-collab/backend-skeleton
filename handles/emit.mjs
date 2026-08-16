import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256File, sha256String } from '../lib/fsutil.mjs';
import { loadManifest, saveManifest, classifyFile, extractResolverOwnerFeatureId, BSKEL_GENERATED_MARKER } from '../lib/handles-manifest.mjs';

const HANDLES_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(HANDLES_ROOT, 'templates', 'java-spring');
const MIGRATION_TEMPLATE = path.join(HANDLES_ROOT, 'templates', 'migration', 'migration.sql.tmpl');
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

// O2: refuses --force on a target that isn't safely recoverable from git history -- a --force
// overwrite is only ever reversible if the content it destroys is already committed. Fails
// closed (treats git errors, or a repo where the path can't be resolved, as "dirty") since the
// whole point is to never make an irreversible action look safe by default.
function isDirtyOrUntracked(repoRoot, absPath) {
	try {
		const out = execFileSync('git', ['status', '--porcelain', '--', absPath], { cwd: repoRoot, encoding: 'utf8' });
		return out.trim().length > 0;
	} catch {
		return true;
	}
}

function readIfExists(target) {
	return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

function writeUnit(target, content) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

// See DECISIONS.md D-handles-ownership for the full design. `force`/`reason` overwrite any
// conflicted unit found within this call's own scope (already narrowed by featureId/module/
// resourceFilter) -- never a blanket, unscoped force. `resourceFilter` (the same array
// `planHandles()` was called with, or null) turns off orphan detection when non-null, since a
// scoped run would otherwise report every OTHER resource's resolver as orphaned.
export function emitHandles({ repoRoot, featureId, plan, basePackage, resourceFilter = null, force = false, reason = '' }) {
	const javaSrcRoot = path.join(repoRoot, 'src', 'main', 'java', ...basePackage.split('.'));
	const manifest = loadManifest(repoRoot);
	const nowIso = new Date().toISOString();

	const written = [];
	const conflicts = [];
	const orphans = [];
	const notes = [];
	const resolverStubs = [];
	const forced = [];
	let manifestChanged = false;

	// ---- infra: repo-owned, all-or-nothing (HandleCodec.java.tmpl itself says "do not hand-edit
	// -- change the source template and regenerate, or the JS/Java implementations will silently
	// diverge" -- a half-upgraded infra set is worse than either extreme, so one conflict blocks
	// the whole set unless --force). ----
	const infraUnits = INFRA_FILES.map((f) => {
		const rendered = render(path.join(TEMPLATES_DIR, f.template), { BASE_PACKAGE: basePackage });
		const target = path.join(javaSrcRoot, f.target);
		const relPath = path.relative(repoRoot, target);
		const diskContent = readIfExists(target);
		const exists = diskContent !== null;
		const diskHash = exists ? sha256String(diskContent) : null;
		const freshRenderHash = sha256String(rendered);
		const entry = manifest.files[relPath];
		// Infra takes only BASE_PACKAGE -- feature-independent, so a pristine render IS the fresh
		// render (no owner-recovery step needed, unlike a resolver's baked-in FEATURE_ID).
		const matchesPristineRender = exists && diskContent === rendered;
		const action = classifyFile({ exists, diskHash, manifestEntryHash: entry?.generated_hash ?? null, freshRenderHash, matchesPristineRender });
		return { kind: 'infra', template: f.template, relPath, target, rendered, freshRenderHash, action };
	});

	const infraHasConflict = infraUnits.some((u) => u.action === 'conflict');
	if (infraHasConflict && !force) {
		for (const u of infraUnits) conflicts.push({ path: u.relPath, kind: 'infra', reason: 'diverged from the last content backend-skeleton generated -- see notes for remediation' });
	} else {
		for (const u of infraUnits) {
			if (u.action === 'conflict') {
				if (isDirtyOrUntracked(repoRoot, u.target)) {
					conflicts.push({ path: u.relPath, kind: 'infra', reason: 'refusing --force: this file has uncommitted/untracked changes -- commit or stash it first so the overwrite is recoverable' });
					continue;
				}
				manifest.files[u.relPath] = {
					kind: 'infra', ownership: 'repo', owner: '_repo', template: u.template,
					template_hash: sha256File(path.join(TEMPLATES_DIR, u.template)), generated_hash: u.freshRenderHash,
					updated_at: nowIso, last_force: { reason, at: nowIso },
				};
				manifestChanged = true;
				writeUnit(u.target, u.rendered);
				written.push(u.relPath);
				forced.push(u.relPath);
				continue;
			}
			if (u.action === 'unchanged') continue;
			// 'adopt-unchanged' means disk content already IS the correct bytes (a pristine,
			// no-manifest-entry file) -- record the manifest entry so future runs see it as
			// 'unchanged', but don't rewrite bytes that are already correct, and don't claim we
			// "wrote" a file whose content didn't actually change.
			if (u.action !== 'adopt-unchanged') {
				writeUnit(u.target, u.rendered);
				written.push(u.relPath);
			}
			manifest.files[u.relPath] = {
				kind: 'infra', ownership: 'repo', owner: '_repo', template: u.template,
				template_hash: sha256File(path.join(TEMPLATES_DIR, u.template)), generated_hash: u.freshRenderHash,
				updated_at: nowIso,
			};
			manifestChanged = true;
		}
	}

	// ---- resolvers: feature-owned, independent per file. "Regenerate when provably untouched"
	// rather than "create once" -- requiredAuthority() is re-derived live from controller source
	// every run, and "once" would strand a stale role string in a security-relevant method
	// (D-security-7). ----
	const resolverTemplateHash = sha256File(RESOLVER_TEMPLATE);
	const generatedTypesThisRun = new Set();

	for (const resource of plan.resources) {
		if (!resource.willGenerateResolver) continue; // see plan.mjs: no broken imports generated on purpose
		resolverStubs.push(resource.type);

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
		const rendered = render(RESOLVER_TEMPLATE, vars);
		const target = path.join(javaSrcRoot, 'domain', plan.module, 'infrastructure', `${resource.type}Resolver.java`);
		const relPath = path.relative(repoRoot, target);
		generatedTypesThisRun.add(resource.type);

		const diskContent = readIfExists(target);
		const exists = diskContent !== null;
		const diskHash = exists ? sha256String(diskContent) : null;
		const freshRenderHash = sha256String(rendered);
		const entry = manifest.files[relPath];

		let matchesPristineRender = false;
		let recoveredOwner = null;
		if (exists) {
			recoveredOwner = extractResolverOwnerFeatureId(diskContent);
			if (recoveredOwner) {
				const pristineRendered = render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: recoveredOwner });
				matchesPristineRender = pristineRendered === diskContent;
			}
		}
		const action = classifyFile({ exists, diskHash, manifestEntryHash: entry?.generated_hash ?? null, freshRenderHash, matchesPristineRender });

		if (action === 'conflict') {
			if (force) {
				if (isDirtyOrUntracked(repoRoot, target)) {
					conflicts.push({ path: relPath, kind: 'resolver', resourceType: resource.type, reason: 'refusing --force: this file has uncommitted/untracked changes -- commit or stash it first so the overwrite is recoverable' });
					continue;
				}
				writeUnit(target, rendered);
				written.push(relPath);
				forced.push(relPath);
				manifest.files[relPath] = {
					kind: 'resolver', ownership: 'feature', owner: featureId, resource_type: resource.type, module: plan.module,
					template: 'ResourceResolverStub.java.tmpl', template_hash: resolverTemplateHash, generated_hash: freshRenderHash,
					updated_at: nowIso, last_force: { reason, at: nowIso, overwritten_hash: diskHash },
				};
				manifestChanged = true;
				continue;
			}
			conflicts.push({
				path: relPath, kind: 'resolver', resourceType: resource.type,
				reason: 'diverged from the last content backend-skeleton generated -- if you have not edited this file, this may be expected after a template upgrade or an @PreAuthorize change on the controller. If you HAVE edited it (e.g. finished patchField()), leave it -- nothing else in this run depends on it.',
			});
			continue;
		}

		const priorOwner = entry?.owner ?? recoveredOwner;
		if (priorOwner && priorOwner !== featureId) {
			notes.push(`ownership transfer: ${relPath} was generated by feature "${priorOwner}", now generated by "${featureId}"`);
		}

		if (action !== 'unchanged') {
			// Same "don't rewrite or claim to write bytes that already match" rule as infra above.
			if (action !== 'adopt-unchanged') {
				writeUnit(target, rendered);
				written.push(relPath);
			}
			manifest.files[relPath] = {
				kind: 'resolver', ownership: 'feature', owner: featureId, resource_type: resource.type, module: plan.module,
				template: 'ResourceResolverStub.java.tmpl', template_hash: resolverTemplateHash, generated_hash: freshRenderHash,
				updated_at: nowIso,
			};
			manifestChanged = true;
		}
	}

	// ---- orphan detection: a resolver this feature's CURRENT plan no longer generates (e.g.
	// willGenerateResolver flipped false after a service signature change), left untouched and
	// never deleted -- same conservative bias as D-migration-scope/D-config-patch. Suppressed
	// entirely under --resource, since every resource outside the filter would otherwise look
	// orphaned. ----
	if (!resourceFilter && plan.module) {
		const seenOrphanPaths = new Set();
		for (const [relPath, entry] of Object.entries(manifest.files)) {
			if (entry.kind !== 'resolver' || entry.module !== plan.module || generatedTypesThisRun.has(entry.resource_type)) continue;
			orphans.push({ path: relPath, resourceType: entry.resource_type, reason: 'manifest tracks this resolver but the current plan no longer generates it (e.g. the underlying service signature changed) -- left on disk untouched' });
			seenOrphanPaths.add(relPath);
		}
		const infraDir = path.join(javaSrcRoot, 'domain', plan.module, 'infrastructure');
		if (fs.existsSync(infraDir)) {
			for (const file of fs.readdirSync(infraDir)) {
				if (!file.endsWith('Resolver.java')) continue;
				const resourceType = file.replace(/Resolver\.java$/, '');
				if (generatedTypesThisRun.has(resourceType)) continue;
				const absPath = path.join(infraDir, file);
				const relPath = path.relative(repoRoot, absPath);
				if (seenOrphanPaths.has(relPath)) continue;
				const content = readIfExists(absPath);
				if (content && content.includes(BSKEL_GENERATED_MARKER)) {
					orphans.push({ path: relPath, resourceType, reason: 'file carries the backend-skeleton marker but the current plan no longer generates it -- left on disk untouched' });
				}
			}
		}
	}

	if (manifestChanged) saveManifest(repoRoot, manifest);

	const migrationContent = render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId });
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');
	writeUnit(migrationPath, migrationContent);
	written.push(path.relative(repoRoot, migrationPath));

	return { written, resolverStubs, conflicts, orphans, notes, forced, blocked: conflicts.length > 0 };
}
