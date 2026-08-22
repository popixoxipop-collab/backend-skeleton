import fs from 'node:fs';
import path from 'node:path';

// O6-style ambiguity rejection (mirrors java-spring's detectBasePackage / python-fastapi's
// detectImportRoot): TS/Node has no __init__.py-style package marker, so the project root is the
// nearest ancestor directory containing BOTH package.json and tsconfig.json among this module's
// own files. More than one distinct candidate is refused with named candidates, never silently
// picked. Source root is `<root>/src` if it exists (matches the real oracle's own layout), else
// the project root itself.
function projectRootFor(file) {
	let dir = path.dirname(file);
	for (;;) {
		if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'tsconfig.json'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function detectProjectRoot(moduleFiles, repoRoot) {
	const roots = new Set();
	for (const file of moduleFiles) {
		const r = projectRootFor(file);
		if (r) roots.add(r);
	}
	if (roots.size === 0) {
		throw new Error('could not detect a TypeScript project root (no ancestor directory with both package.json and tsconfig.json found above any scanned file for this module).');
	}
	if (roots.size > 1) {
		throw new Error(`ambiguous TypeScript project root -- found ${roots.size} different candidates among this module's own files: ${[...roots].map((r) => path.relative(repoRoot, r)).join(', ')}. This provider doesn't support multi-project-root repos yet.`);
	}
	const projectRoot = [...roots][0];
	const srcRoot = fs.existsSync(path.join(projectRoot, 'src')) ? path.join(projectRoot, 'src') : projectRoot;
	return { projectRoot, srcRoot };
}

function listTypeScriptFilesUnder(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listTypeScriptFilesUnder(full));
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out.sort();
}

// Same "canonical fetch" concept as java-spring's findFetchOperation / python-fastapi's
// findFetchRoute: a GET endpoint whose path is exactly `${basePath}/:param` (Express's own
// path-param syntax, optionally regex-constrained -- `:id([0-9]+)`, confirmed in the real oracle)
// on a controller whose class-name affinity-matches the entity.
function findFetchRoute(controllers, entityClassName) {
	const needle = entityClassName.toLowerCase();
	for (const controller of controllers) {
		if (!controller.className.toLowerCase().includes(needle)) continue;
		for (const ep of controller.endpoints) {
			if (ep.verb !== 'GET') continue;
			const suffix = ep.path.slice(controller.basePath.length);
			if (/^\/:[^/(]+(\([^)]*\))?$/.test(suffix)) {
				return { method: ep.method, path: ep.path, file: controller.file, line: ep.line, controllerClassName: controller.className };
			}
		}
	}
	return null;
}

// Resolves an import specifier to a real file on disk, extension-probed the same way Node's own
// TS resolver would. Relative specifiers (`./x`, `../x`) resolve against `fromFile`'s own
// directory; bare specifiers (`controllers/users`) resolve against `srcRoot` (this project's own
// `baseUrl`, confirmed against the real oracle's own tsconfig.json: `"baseUrl": "src/"`).
function resolveImportSpecifier(fromFile, specifier, srcRoot) {
	const base = specifier.startsWith('.') ? path.resolve(path.dirname(fromFile), specifier) : path.join(srcRoot, specifier);
	for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

// `router.get('/:id(...)', [...], show)` -- `show` is only ever an imported identifier (inline
// arrow-function handlers are already excluded by the scanner). Resolves the router file's own
// `import { ..., show, ... } from '<specifier>'`, then follows ONE level of barrel re-export
// (`export * from './show'`, confirmed in the real oracle's own controllers/users/index.ts) if
// the resolved file doesn't define `show` itself -- no deeper, matching the existing "narrow, not
// general" discipline every other cross-file resolution in this codebase already follows.
function resolveHandlerFile(routerFile, handlerName, srcRoot) {
	const routerText = fs.readFileSync(routerFile, 'utf8');
	const importRe = new RegExp(`import\\s*\\{[^}]*\\b${handlerName}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
	const importMatch = routerText.match(importRe);
	if (!importMatch) return null;
	const directFile = resolveImportSpecifier(routerFile, importMatch[1], srcRoot);
	if (!directFile) return null;

	const directText = fs.readFileSync(directFile, 'utf8');
	if (new RegExp(`export\\s+const\\s+${handlerName}\\b`).test(directText)) return directFile;

	// One barrel hop: `export * from './show'` inside an index.ts that doesn't define the handler
	// itself.
	for (const m of directText.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
		const barrelTarget = resolveImportSpecifier(directFile, m[1], srcRoot);
		if (barrelTarget && new RegExp(`export\\s+const\\s+${handlerName}\\b`).test(fs.readFileSync(barrelTarget, 'utf8'))) {
			return barrelTarget;
		}
	}
	return null;
}

// The oracle's own only real protection against leaking a column the app never otherwise exposes
// (e.g. a password hash): a hand-written `select: [...]` allow-list literal in the fetch handler's
// own `findOne(...)`/`find(...)` call -- TypeORM's real `{ select: false }` column option exists
// but the oracle doesn't use it, so requiring a Java/Python-style `<Entity>Public` convention this
// ecosystem's own real code doesn't demonstrate would be inventing a requirement, not grounding
// one. Required, not decorative -- mirrors D-fastapi-adapter's own `<Entity>Public` precondition
// in spirit exactly.
function findSelectAllowList(handlerFile) {
	if (!handlerFile) return null;
	const text = fs.readFileSync(handlerFile, 'utf8');
	const m = text.match(/select\s*:\s*\[([^\]]*)\]/);
	if (!m) return null;
	const fields = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
	return fields.length > 0 ? fields : null;
}

// `export const AppDataSource = new DataSource({...})` -- or whatever this app names its own
// DataSource instance. TypeORM 0.3.x's real, current app-owned-instance API (see
// D-typescript-express-provider in DECISIONS.md for why this targets DataSource and not the
// oracle's own stale `getRepository()` global-connection-manager pattern). Same
// shallowest-then-name deterministic tie-break as python-fastapi's own findSessionDep.
const DATA_SOURCE_RE = /export\s+const\s+(\w+)\s*=\s*new\s+DataSource\s*\(/;

function findDataSource(files) {
	const candidates = [];
	for (const file of files) {
		const m = fs.readFileSync(file, 'utf8').match(DATA_SOURCE_RE);
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

function dottedModulePath(file, srcRoot) {
	const rel = path.relative(srcRoot, file).replace(/\.ts$/, '');
	return rel.split(path.sep).join('/');
}

// The descriptor-facing entry point (handles/providers/typescript-express.mjs's provider.plan).
// See schemas/handles-plan.schema.json for the sbf.handles-plan/1 envelope this returns.
export function plan({ repoRoot, scanReport, module: moduleName, resourceFilter }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	if (!targetModule) {
		return {
			schema: 'sbf.handles-plan/1', provider: 'typescript-express', module: null, resources: [],
			notes: ['no related module in the scan report -- run `bskel scan` first, or pass --module explicitly'],
		};
	}

	const moduleFiles = [...targetModule.controllers.map((c) => c.file), ...targetModule.entities.map((e) => e.file)].filter(Boolean);
	const { projectRoot, srcRoot } = detectProjectRoot(moduleFiles, repoRoot);
	const allProjectFiles = listTypeScriptFilesUnder(srcRoot);
	const dataSource = findDataSource(allProjectFiles);

	const resources = [];
	const notes = [];

	for (const entity of targetModule.entities) {
		if (resourceFilter && !resourceFilter.includes(entity.className)) continue;
		const fetchRoute = findFetchRoute(targetModule.controllers, entity.className);
		const handlerFile = fetchRoute ? resolveHandlerFile(fetchRoute.file, fetchRoute.method, srcRoot) : null;
		const selectFields = handlerFile ? findSelectAllowList(handlerFile) : null;

		if (!fetchRoute) {
			notes.push(`${entity.className}: no single-resource GET route found on a router whose name contains "${entity.className}" -- fetch() will need to be hand-written`);
		} else if (!handlerFile) {
			notes.push(`${entity.className}: could not resolve ${fetchRoute.method}'s own defining file (import, or one barrel hop, from ${path.relative(repoRoot, fetchRoute.file)}) -- resolver NOT generated.`);
		} else if (!selectFields) {
			notes.push(`${entity.className}: no literal select: [...] allow-list found in ${path.relative(repoRoot, handlerFile)} -- resolver NOT generated (a generic handle-fetch route serializing the raw entity could leak a column the app never otherwise exposes, e.g. a password hash). Add one and re-run.`);
		}
		if (fetchRoute && !entity.idField) {
			notes.push(`${entity.className}: no primary-key field detected on the entity -- resolver NOT generated.`);
		} else if (fetchRoute && entity.idField && !entity.idFieldIsUuid) {
			// This handle system's own token format (kind:type:UUID[:pointer]) can only ever address a
			// UUID-shaped resource identifier -- an entity whose primary key is the TypeORM default
			// (an auto-incrementing integer, @PrimaryGeneratedColumn() with no argument) genuinely
			// cannot be reached through a handle at all, a structural fact about this whole project's
			// handle scheme, not a TypeScript-specific limitation. Found live via a real `tsc --noEmit`
			// type error (the real oracle's own User entity uses the integer form) before this
			// distinction was tracked.
			notes.push(`${entity.className}: primary key "${entity.idField}" is not UUID-typed (@PrimaryGeneratedColumn('uuid')) -- resolver NOT generated. This project's handle format can only address UUID-shaped resource identifiers.`);
		}
		if (fetchRoute && handlerFile && selectFields && entity.idField && entity.idFieldIsUuid && !dataSource) {
			notes.push(`${entity.className}: fetch route and select allow-list found, but no "export const X = new DataSource(...)" was found anywhere under ${path.relative(repoRoot, srcRoot)}/ -- resolver NOT generated. (This provider targets TypeORM's current DataSource API, not the older global getRepository() pattern.)`);
		}
		if (fetchRoute) {
			notes.push(`${entity.className}: static scanning cannot safely determine this route's real authorization logic (see ${path.relative(repoRoot, fetchRoute.file)}:${fetchRoute.line}) -- the generated resolver's checkAccess() always denies until hand-wired.`);
		}

		const willGenerateResolver = Boolean(fetchRoute && handlerFile && selectFields && entity.idField && entity.idFieldIsUuid && dataSource);

		resources.push({
			type: entity.className,
			table: entity.table,
			idField: entity.idField,
			readPath: fetchRoute ? `dataSource.getRepository(${entity.className}).findOne({ where: { ${entity.idField}: resourceUid } })` : null,
			requiredAuthority: 'TODO_ACCESS_CHECK',
			willGenerateResolver,
			// provider-specific extras (additionalProperties: true in schemas/handles-plan.schema.json)
			fetchRoute,
			selectFields,
			modelImport: dottedModulePath(entity.file, srcRoot),
			dataSource,
		});
	}

	if (resources.length === 0) {
		notes.push(`no entities found for module "${targetModule.module}" ${resourceFilter ? `matching --resource filter [${resourceFilter.join(', ')}]` : ''} -- nothing to plan.`);
	}

	return {
		schema: 'sbf.handles-plan/1',
		provider: 'typescript-express',
		projectRoot,
		srcRoot,
		module: targetModule.module,
		resources,
		notes,
	};
}
