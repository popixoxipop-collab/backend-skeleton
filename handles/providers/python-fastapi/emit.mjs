import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits } from '../../_engine.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');
const RESOLVER_TEMPLATE = path.join(TEMPLATES_DIR, 'resolver.py.tmpl');

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

// See DECISIONS.md D-handles-providers. No migration, no recover() -- this provider generates
// nothing for either (see the EXCLUDED section there for why). `router.py` is only emitted when a
// SessionDep-shaped alias was actually found (plan()'s willGenerateResolver gate already implies
// this for every resolver, but the router itself is infra -- generated once, independent of which
// resolvers exist -- so it needs its own guard for the "found zero resolvers, and specifically
// because no SessionDep exists" case).
export function emitPythonFastApi({ repoRoot, featureId, plan, resourceFilter = null, force = false, reason = '' }) {
	const handlesDir = path.join(plan.importRoot, plan.topPackage, 'handles');
	const resolversDir = path.join(handlesDir, 'resolvers');

	const infraUnits = [
		{ id: '__init__.py.tmpl', templatePath: path.join(TEMPLATES_DIR, '__init__.py.tmpl'), targetAbs: path.join(handlesDir, '__init__.py'), rendered: render(path.join(TEMPLATES_DIR, '__init__.py.tmpl'), {}) },
		{ id: 'codec.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'codec.py.tmpl'), targetAbs: path.join(handlesDir, 'codec.py'), rendered: render(path.join(TEMPLATES_DIR, 'codec.py.tmpl'), {}) },
		{ id: 'registry.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'registry.py.tmpl'), targetAbs: path.join(handlesDir, 'registry.py'), rendered: render(path.join(TEMPLATES_DIR, 'registry.py.tmpl'), {}) },
		{ id: 'resolvers_init.py.tmpl', templatePath: path.join(TEMPLATES_DIR, 'resolvers_init.py.tmpl'), targetAbs: path.join(resolversDir, '__init__.py'), rendered: render(path.join(TEMPLATES_DIR, 'resolvers_init.py.tmpl'), {}) },
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
			}),
		});
	}

	const resolverUnits = plan.resources
		.filter((r) => r.willGenerateResolver)
		.map((resource) => {
			const vars = {
				FEATURE_ID: featureId,
				RESOURCE_TYPE: resource.type,
				MODEL: resource.type,
				PUBLIC_MODEL: resource.publicModel,
				MODEL_IMPORT: resource.modelImport,
				PKG: plan.topPackage,
				FETCH_ROUTE_FILE: resource.fetchRoute ? path.relative(repoRoot, resource.fetchRoute.file) : '(unknown)',
				FETCH_ROUTE_LINE: resource.fetchRoute ? resource.fetchRoute.line : '',
			};
			return {
				id: 'resolver.py.tmpl',
				resourceType: resource.type,
				module: plan.module,
				templatePath: RESOLVER_TEMPLATE,
				targetAbs: path.join(resolversDir, `${snakeCase(resource.type)}.py`),
				rendered: render(RESOLVER_TEMPLATE, vars),
				// FEATURE_ID is the only per-feature substitution in this template (same as java-spring's
				// resolver -- no other var here changes between features), so recovering the pristine
				// render under a different owner is exactly the same render with FEATURE_ID swapped.
				pristineRenderFor: (ownerId) => render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: ownerId }),
			};
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

	const result = emitUnits({ repoRoot, featureId, provider: 'python-fastapi', force, reason, infraUnits, resolverUnits, orphanScan });

	const postEmitNotes = [];
	if (!sessionDep) {
		postEmitNotes.push('router.py was NOT generated -- no SessionDep-shaped dependency alias was found under the detected package, see plan notes.');
	} else {
		postEmitNotes.push(`NOT done automatically: wiring the generated router into your app -- add "from ${plan.topPackage}.handles.router import router as handles_router" and include it via your app's own router-composition file (e.g. api_router.include_router(handles_router)) by hand.`);
	}

	return { ...result, postEmitNotes };
}
