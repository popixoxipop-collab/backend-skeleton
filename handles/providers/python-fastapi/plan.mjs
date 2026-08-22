import fs from 'node:fs';
import path from 'node:path';

// Walks up from a file's own directory while `__init__.py` exists, returning the topmost such
// directory (the "top package" dir), or null if the file's own directory has none at all. Not
// named-conditioned on any particular directory name -- a standard PyPA src-layout
// (`src/<package>/__init__.py`, a real `__init__.py`, just under a `src/` dir) walks up correctly
// like any other layout (see D-typescript-express-provider's slice-4 correction in DECISIONS.md,
// and the positive regression test in test/python-fastapi-handles.test.mjs). Only PEP 420
// *implicit namespace packages* (omitting `__init__.py` entirely) hit the null case below --
// unsupported, see COST in DECISIONS.md, exit 2.
function packageRootFor(file) {
	let dir = path.dirname(file);
	if (!fs.existsSync(path.join(dir, '__init__.py'))) return null;
	let top = dir;
	for (;;) {
		const parent = path.dirname(top);
		if (parent === top || !fs.existsSync(path.join(parent, '__init__.py'))) break;
		top = parent;
	}
	return top;
}

// O6-style ambiguity rejection (see java-spring's detectBasePackage): more than one DIFFERENT
// package root among this module's own files is refused with named candidates rather than
// silently picking one.
function detectImportRoot(moduleFiles, repoRoot) {
	const roots = new Set();
	for (const file of moduleFiles) {
		const r = packageRootFor(file);
		if (r) roots.add(r);
	}
	if (roots.size === 0) {
		throw new Error('could not detect a Python package root (no __init__.py found above any scanned file for this module) -- this provider does not support PEP 420 implicit namespace packages (omitting __init__.py entirely) yet. A standard src-layout WITH real __init__.py files works fine.');
	}
	if (roots.size > 1) {
		throw new Error(`ambiguous Python package root -- found ${roots.size} different candidates among this module's own files: ${[...roots].map((r) => path.relative(repoRoot, r)).join(', ')}. This provider doesn't support multi-package-root repos yet.`);
	}
	const topPackageDir = [...roots][0];
	return { importRoot: path.dirname(topPackageDir), topPackage: path.basename(topPackageDir) };
}

function listPythonFilesUnder(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listPythonFilesUnder(full));
		else if (entry.name.endsWith('.py')) out.push(full);
	}
	return out.sort();
}

// Same "canonical fetch" concept as java-spring's findFetchOperation, keyed on `ep.method` (the
// Python function name) instead of `ep.operationId` -- python-fastapi's scan output always sets
// operationId: null (see D-fastapi-adapter), so that logic cannot be shared as-is. A GET endpoint
// whose path is exactly `${controller.basePath}/{param}` (one trailing path segment) on a
// controller whose class-name affinity-matches the entity, mirroring java-spring's own check.
function findFetchRoute(controllers, entityClassName) {
	const needle = entityClassName.toLowerCase();
	for (const controller of controllers) {
		if (!controller.className.toLowerCase().includes(needle)) continue;
		for (const ep of controller.endpoints) {
			if (ep.verb !== 'GET') continue;
			const suffix = ep.path.slice(controller.basePath.length);
			if (/^\/\{[^/]+\}$/.test(suffix)) {
				return { method: ep.method, path: ep.path, file: controller.file, line: ep.line, controllerClassName: controller.className };
			}
		}
	}
	return null;
}

// `class <Entity>Public(...)` -- scoped to the entity's own file. Required, not decorative: the
// real oracle's User table carries hashed_password with no protection besides each individual
// route's own `response_model=UserPublic` declaration -- a generic handle-fetch route serving
// multiple types can't rely on that, so a resolver is refused entirely when this class is absent
// rather than risk leaking a raw table row.
function findPublicModel(entityFile, entityClassName) {
	if (!entityFile || !fs.existsSync(entityFile)) return null;
	const text = fs.readFileSync(entityFile, 'utf8');
	const re = new RegExp(`^class\\s+${entityClassName}Public\\s*\\(`, 'm');
	return re.test(text) ? `${entityClassName}Public` : null;
}

// `SessionDep = Annotated[Session, Depends(get_db)]` -- or whatever this app names its own
// session-dependency alias. Searches the whole detected package (not just this module's files,
// since the alias is typically declared once in a shared deps module), deterministic
// shallowest-then-name tie-break if more than one file declares one -- same convention
// scanners/adapters/python-fastapi.mjs's own byShallowestThenName helper uses.
const SESSION_DEP_RE = /^(\w+)\s*=\s*Annotated\[\s*Session\s*,\s*Depends\(/m;

function findSessionDep(files) {
	const candidates = [];
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		const m = text.match(SESSION_DEP_RE);
		if (m) candidates.push({ file, name: m[1] });
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => {
		const depthA = a.file.split(path.sep).length;
		const depthB = b.file.split(path.sep).length;
		return depthA !== depthB ? depthA - depthB : a.file.localeCompare(b.file);
	});
	return candidates[0];
}

function dottedModulePath(file, importRoot) {
	const rel = path.relative(importRoot, file).replace(/\.py$/, '');
	return rel.split(path.sep).join('.');
}

// The descriptor-facing entry point (handles/providers/python-fastapi.mjs's provider.plan). See
// schemas/handles-plan.schema.json for the sbf.handles-plan/1 envelope this returns.
export function plan({ repoRoot, scanReport, module: moduleName, resourceFilter }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	if (!targetModule) {
		return {
			schema: 'sbf.handles-plan/1', provider: 'python-fastapi', module: null, resources: [],
			notes: ['no related module in the scan report -- run `bskel scan` first, or pass --module explicitly'],
		};
	}

	const moduleFiles = [...targetModule.controllers.map((c) => c.file), ...targetModule.entities.map((e) => e.file)].filter(Boolean);
	const { importRoot, topPackage } = detectImportRoot(moduleFiles, repoRoot);
	const allProjectFiles = listPythonFilesUnder(path.join(importRoot, topPackage));
	const sessionDep = findSessionDep(allProjectFiles);

	const resources = [];
	const notes = [];

	for (const entity of targetModule.entities) {
		if (resourceFilter && !resourceFilter.includes(entity.className)) continue;
		const fetchRoute = findFetchRoute(targetModule.controllers, entity.className);
		const publicModel = fetchRoute ? findPublicModel(entity.file, entity.className) : null;

		if (!fetchRoute) {
			notes.push(`${entity.className}: no single-resource GET route found on a router whose name contains "${entity.className}" -- fetch() will need to be hand-written`);
		} else if (!publicModel) {
			notes.push(`${entity.className}: no ${entity.className}Public class found in ${path.relative(repoRoot, entity.file)} -- resolver NOT generated (a generic handle-fetch route serializing the raw table model could leak a column the app never otherwise exposes, e.g. a password hash). Add a Public projection class and re-run.`);
		}
		if (fetchRoute && !entity.idField) {
			notes.push(`${entity.className}: no primary-key field detected on the table model -- resolver NOT generated.`);
		}
		if (fetchRoute && publicModel && entity.idField && !sessionDep) {
			notes.push(`${entity.className}: fetch route and Public model found, but no SessionDep-shaped dependency alias (Annotated[Session, Depends(...)]) was found anywhere under ${topPackage}/ -- resolver NOT generated.`);
		}
		if (fetchRoute) {
			notes.push(`${entity.className}: static scanning cannot safely determine this route's real authorization logic (see ${path.relative(repoRoot, fetchRoute.file)}:${fetchRoute.line}) -- the generated resolver's check_access() always denies until hand-wired.`);
		}

		const willGenerateResolver = Boolean(fetchRoute && publicModel && entity.idField && sessionDep);

		resources.push({
			type: entity.className,
			table: entity.table,
			idField: entity.idField,
			readPath: fetchRoute ? `session.get(${entity.className}, ${entity.idField})` : null,
			requiredAuthority: 'TODO_ACCESS_CHECK',
			willGenerateResolver,
			// provider-specific extras (additionalProperties: true in schemas/handles-plan.schema.json)
			fetchRoute,
			publicModel,
			modelImport: dottedModulePath(entity.file, importRoot),
			sessionDep,
		});
	}

	if (resources.length === 0) {
		notes.push(`no entities found for module "${targetModule.module}" ${resourceFilter ? `matching --resource filter [${resourceFilter.join(', ')}]` : ''} -- nothing to plan.`);
	}

	return {
		schema: 'sbf.handles-plan/1',
		provider: 'python-fastapi',
		importRoot,
		topPackage,
		module: targetModule.module,
		resources,
		notes,
	};
}
