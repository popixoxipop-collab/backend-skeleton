import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits } from '../../_engine.mjs';
import { sha256File } from '../../../lib/fsutil.mjs';
import { specPath } from '../../../lib/paths.mjs';
import { loadFeatureFile } from '../../../lib/featurelifecycle.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');
const RESOLVER_TEMPLATE = path.join(TEMPLATES_DIR, 'resolver.py.tmpl');
// D-resolver-policy-split: a resource's live-derived values (CONTRACT_REF/FEATURE_UID) are
// generated into this separate, always-safe-to-regenerate companion module rather than the same
// file as the hand-editable check_access()/patch_field() body -- see the template's own docstring
// and DECISIONS.md.
const POLICY_TEMPLATE = path.join(TEMPLATES_DIR, 'resolver_policy.py.tmpl');
const MIGRATION_TEMPLATE = path.join(TEMPLATES_DIR, 'migration.sql.tmpl');

function render(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

// PascalCase -> snake_case, good enough for the class names this scanner actually extracts
// (ASCII identifiers only, same assumption java-spring's own naming makes).
function snakeCase(s) {
	return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function dottedModulePath(file, importRoot) {
	const rel = path.relative(importRoot, file).replace(/\.py$/, '');
	return rel.split(path.sep).join('.');
}

// O3 follow-up (D-handle-registry-enforcement, "Continued"): same static, coarse, per-resource
// presence check as java-spring's own -- see that file's identical comment for the false-
// positive/false-negative bias reasoning (unchanged here).
const RECORD_SNAPSHOT_RE = /@record_snapshot\s*\(/;

function hasRecordSnapshot(routeFilePath) {
	if (!routeFilePath || !fs.existsSync(routeFilePath)) return false;
	return RECORD_SNAPSHOT_RE.test(fs.readFileSync(routeFilePath, 'utf8'));
}

// See DECISIONS.md D-handles-providers. G4 follow-up: migration.sql + a real recover() lifecycle
// (tables.py/handle_service.py/record_snapshot.py) are now generated, mirroring java-spring's own
// O4 work -- the EXCLUDED section's original "even Java hasn't got O4" reasoning is stale, see
// that entry's own follow-up paragraph. `router.py` is only emitted when a SessionDep-shaped alias
// was actually found (plan()'s willGenerateResolver gate already implies this for every resolver,
// but the router itself is infra -- generated once, independent of which resolvers exist -- so it
// needs its own guard for the "found zero resolvers, and specifically because no SessionDep
// exists" case).
export function emitPythonFastApi({ repoRoot, featureId, plan, resourceFilter = null, force = false, reason = '', dryRun = false, computeDiff = false, enforceRegistry = false }) {
	const handlesDir = path.join(plan.importRoot, plan.topPackage, 'handles');
	const resolversDir = path.join(handlesDir, 'resolvers');

	const infraUnits = [
		{ id: '__init__.py.tmpl', templatePath: path.join(TEMPLATES_DIR, '__init__.py.tmpl'), targetAbs: path.join(handlesDir, '__init__.py'), rendered: render(path.join(TEMPLATES_DIR, '__init__.py.tmpl'), {}) },
		{ id: 'codec.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'codec.py.tmpl'), targetAbs: path.join(handlesDir, 'codec.py'), rendered: render(path.join(TEMPLATES_DIR, 'codec.py.tmpl'), {}) },
		{ id: 'registry.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'registry.py.tmpl'), targetAbs: path.join(handlesDir, 'registry.py'), rendered: render(path.join(TEMPLATES_DIR, 'registry.py.tmpl'), {}) },
		{ id: 'resolvers_init.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'resolvers_init.py.tmpl'), targetAbs: path.join(resolversDir, '__init__.py'), rendered: render(path.join(TEMPLATES_DIR, 'resolvers_init.py.tmpl'), {}) },
		// G4 follow-up (D-handles-providers): tables.py has zero {{VAR}} substitutions (same class
		// as codec.py.tmpl above -- fixed schema, not per-feature), handle_service.py/
		// record_snapshot.py each need only {{PKG}} to resolve their own sibling-module imports.
		{ id: 'tables.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'tables.py.tmpl'), targetAbs: path.join(handlesDir, 'tables.py'), rendered: render(path.join(TEMPLATES_DIR, 'tables.py.tmpl'), {}) },
		{ id: 'handle_service.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'handle_service.py.tmpl'), targetAbs: path.join(handlesDir, 'handle_service.py'), rendered: render(path.join(TEMPLATES_DIR, 'handle_service.py.tmpl'), { PKG: plan.topPackage }) },
		{ id: 'record_snapshot.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'record_snapshot.py.tmpl'), targetAbs: path.join(handlesDir, 'record_snapshot.py'), rendered: render(path.join(TEMPLATES_DIR, 'record_snapshot.py.tmpl'), { PKG: plan.topPackage }) },
	];

	const sessionDep = plan.resources.find((r) => r.sessionDep)?.sessionDep ?? null;
	if (sessionDep) {
		infraUnits.push({
			id: 'router.py.tmpl',
			templatePath: path.join(TEMPLATES_DIR, 'router.py.tmpl'),
			targetAbs: path.join(handlesDir, 'router.py'),
			rendered: render(path.join(TEMPLATES_DIR, 'router.py.tmpl'), {
				PKG: plan.topPackage,
				SESSION_DEP_MODULE: dottedModulePath(sessionDep.file, plan.importRoot),
				SESSION_DEP_NAME: sessionDep.name,
				// O3 (D-handle-registry-enforcement): a Python boolean LITERAL ("True"/"False",
				// capitalized) -- render()'s plain String(value) would produce JS-style lowercase
				// "true"/"false", invalid Python syntax.
				ENFORCE_REGISTRY: enforceRegistry ? 'True' : 'False',
			}),
		});
	}

	// G4 follow-up (D-handles-providers): mirrors java-spring/emit.mjs's own contractRefFor/
	// featureUidFor exactly, including the cross-feature adoption-safety fix that item's own Java
	// work found the hard way -- proactively included here rather than rediscovered in Python
	// later. requireNamedGate(root, 'contract', ...) already ran before emitPythonFastApi() is
	// ever reached (cmdHandlesEmit's own precondition), so this feature's own contract file is
	// guaranteed to exist here.
	const contractRefFor = (id) => sha256File(specPath(repoRoot, id, 'contracts', `${id}.schema.json`));
	const featureUidFor = (id) => loadFeatureFile(repoRoot, id)?.feature_uid ?? '00000000-0000-0000-0000-000000000000';
	const contractRef = contractRefFor(featureId);
	const featureUid = featureUidFor(featureId);

	const resolverUnits = plan.resources
		.filter((r) => r.willGenerateResolver)
		.flatMap((resource) => {
			// D-resolver-policy-split: CONTRACT_REF/FEATURE_UID no longer appear in the resolver's
			// own vars -- they move to policyVars below, into a separate generated module, so a
			// hand-edited check_access()/patch_field() (which stales THIS file's own template
			// render) can never block one of those values from updating.
			const vars = {
				FEATURE_ID: featureId,
				RESOURCE_TYPE: resource.type,
				RESOURCE_TYPE_SNAKE: snakeCase(resource.type),
				MODEL: resource.type,
				PUBLIC_MODEL: resource.publicModel,
				MODEL_IMPORT: resource.modelImport,
				PKG: plan.topPackage,
				FETCH_ROUTE_FILE: resource.fetchRoute ? path.relative(repoRoot, resource.fetchRoute.file) : '(unknown)',
				FETCH_ROUTE_LINE: resource.fetchRoute ? resource.fetchRoute.line : '',
			};
			const policyVars = {
				FEATURE_ID: featureId,
				RESOURCE_TYPE: resource.type,
				CONTRACT_REF: contractRef,
				FEATURE_UID: featureUid,
			};
			return [
				{
					id: 'resolver.py.tmpl',
					resourceType: resource.type,
					module: plan.module,
					templatePath: RESOLVER_TEMPLATE,
					targetAbs: path.join(resolversDir, `${snakeCase(resource.type)}.py`),
					rendered: render(RESOLVER_TEMPLATE, vars),
					// Only FEATURE_ID varies by owner now -- CONTRACT_REF/FEATURE_UID no longer live here.
					pristineRenderFor: (ownerId) => render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: ownerId }),
				},
				{
					id: 'resolver_policy.py.tmpl',
					resourceType: resource.type,
					module: plan.module,
					templatePath: POLICY_TEMPLATE,
					targetAbs: path.join(resolversDir, `${snakeCase(resource.type)}_policy.py`),
					rendered: render(POLICY_TEMPLATE, policyVars),
					// FEATURE_ID/CONTRACT_REF/FEATURE_UID all change between features -- deliberately NOT
					// reused verbatim for a DIFFERENT owner (see java-spring/emit.mjs's own identical
					// comment): O2's cross-feature adoption check re-renders using the ORIGINAL owner's
					// feature_id specifically, so baking in the CURRENT run's own contract_ref/feature_uid
					// there would compare disk content against the wrong feature's values and manufacture a
					// false conflict for an untouched file.
					pristineRenderFor: (ownerId) => render(POLICY_TEMPLATE, {
						...policyVars,
						FEATURE_ID: ownerId,
						CONTRACT_REF: ownerId === featureId ? contractRef : contractRefFor(ownerId),
						FEATURE_UID: ownerId === featureId ? featureUid : featureUidFor(ownerId),
					}),
				},
			];
		});

	const orphanScan = (!resourceFilter && plan.module) ? {
		dir: resolversDir,
		module: plan.module,
		matchesFile: (file) => file.endsWith('.py') && file !== '__init__.py',
		// Filename can't reliably recover the type (organization_policy.py could be OrganizationPolicy
		// or Organizationpolicy) -- read the `type = "X"` class attribute the resolver template
		// itself carries instead of guessing from the filename, unlike java-spring's orphan scan.
		resourceTypeOf: (_file, content) => {
			const m = content.match(/^\s*type\s*=\s*"([^"]+)"/m);
			return m ? m[1] : null;
		},
	} : null;

	// D-write-safety-phase0 (item 1): mirrors java-spring/emit.mjs's own fix exactly -- migration.sql
	// used to be regenerated fresh every run, unconditionally, never manifest-tracked. Reuses
	// emitUnits()'s postResolverUnit slot (kind/ownership/owner overridden for feature ownership)
	// instead of a separate, untracked write path.
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');
	const result = emitUnits({
		repoRoot, featureId, provider: 'python-fastapi', force, reason, infraUnits, resolverUnits, orphanScan, dryRun, computeDiff,
		postResolverUnit: {
			id: 'migration.sql.tmpl', templatePath: MIGRATION_TEMPLATE, targetAbs: migrationPath,
			render: () => render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId }),
			kind: 'migration', ownership: 'feature', owner: featureId,
		},
	});

	const postEmitNotes = [
		'NOT done automatically: applying specs/<id>/handles/migration.sql to any database. Review it and apply yourself.',
	];
	if (!sessionDep) {
		postEmitNotes.push('router.py was NOT generated -- no SessionDep-shaped dependency alias was found under the detected package, see plan notes.');
	} else {
		postEmitNotes.push(`NOT done automatically: wiring the generated router into your app -- add "from ${plan.topPackage}.handles.router import router as handles_router" and include it via your app's own router-composition file (e.g. api_router.include_router(handles_router)) by hand.`);
	}
	// G4 follow-up (D-handles-providers): record_snapshot.py's decorator needs nothing extra
	// installed (unlike Java's spring-boot-starter-aop requirement) -- Python decorators need no
	// framework support -- but still requires a human to apply it to their own code, same "review
	// and apply yourself" boundary as the migration note above.
	postEmitNotes.push('NOT done automatically: applying @record_snapshot (handles/record_snapshot.py) to any of your own service functions. Codegen never touches existing business logic files.');

	// O3 follow-up (D-handle-registry-enforcement, "Continued"): per-resource, conditional on
	// enforceRegistry.
	// D-write-safety-phase1 (item 2): mirrors java-spring/emit.mjs's own registrationGaps exactly --
	// see that file's comment for the full reasoning.
	const registrationGaps = [];
	if (enforceRegistry) {
		for (const resource of plan.resources) {
			if (!resource.willGenerateResolver) continue;
			if (hasRecordSnapshot(resource.fetchRoute.file)) continue;
			const relRouteFile = path.relative(repoRoot, resource.fetchRoute.file);
			const note = `${resource.type}: --enforce-registry is on, but no @record_snapshot(...) was found anywhere in ${relRouteFile} -- this resource may never get its first registry row, and every fetch/patch call against it will 404 until something registers it. Apply @record_snapshot to its own create-flow route function (or call handle_service.register() by hand at least once per resource), then re-emit. See D-handle-registry-enforcement in DECISIONS.md for the full bootstrapping explanation.`;
			postEmitNotes.push(note);
			registrationGaps.push({ resourceType: resource.type, file: relRouteFile, note });
		}
	}

	return { ...result, postEmitNotes, registrationGaps };
}
