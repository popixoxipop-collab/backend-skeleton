// G6 (D-javascript-express-adapter): the fourth first-class scanner adapter -- plain-JavaScript
// ESM Express, with NO ORM and NO TypeScript anywhere. Sibling of `typescript-express.mjs` (G5),
// not a generalization of it: they share the low-level Express primitives (`_express-shared.mjs`)
// and deliberately do NOT share endpoint/mount-tree extraction, because a plain-JS app's routing
// is written differently in three ways that each break G5's own regexes (see below).
//
// This exists because a real production backend -- an `express.Router()` app on AWS Lambda
// (nodejs20.x) behind a one-line `serverless-http` wrapper -- was completely invisible to `bskel`:
// `typescript-express`'s detect() greps `-g '*.ts'` only, so a repo with zero `.ts` files fell all
// the way through to the low-confidence `generic-grep` fallback.
//
// THREE real divergences from G5, each grounded in what plain-JS Express code actually looks like,
// not anticipated defensively:
//   1. `import express from 'express'; const r = express.Router()` is the dominant plain-JS idiom.
//      G5's detect() requires a NAMED `import { Router } from 'express'`, which a repo using only
//      the default import never has. Both forms are accepted here.
//   2. The router variable is not always called `router`. G5 hardcodes the identifier in
//      `/\brouter\.use\s*\(/` and `/\brouter\.(get|...)\(/`; the real target app's own entry file
//      declares `const route = express.Router()`. This adapter binds whatever name the file
//      actually declares.
//   3. The global path prefix routinely lives on an INTRA-FILE edge from the `express()`
//      application to a locally-declared Router (`app.use('/api', route)`) -- no import involved,
//      so G5's file-to-file edge model cannot represent it and would silently drop `/api` from
//      every route below it. Mount-tree nodes here are (file, variable) pairs, not files.
//
// **`codegen.handles` is false, and that is the whole shipped scope.** There is no
// `handles/providers/javascript-express/`. See D-javascript-express-adapter's EXCLUDED section in
// DECISIONS.md for the measured reason (raw `mysql2`/`mariadb` SQL string literals carry no
// trustworthy table/primary-key/column-allow-list metadata), and D-fastapi-adapter (G2) for the
// precedent: a real scanner adapter with zero codegen is a legitimate shipped state.
import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt } from '../text-util.mjs';
import {
	VERBS,
	STRING_LITERAL_RE,
	listRgFiles,
	rgFilesMatching,
	listCandidatePackageFiles,
	declaresExpress,
	readPackageJson,
	matchBalancedParens,
	splitTopLevelArgs,
	joinPath,
	maskJsComments,
	expressDiagnostics,
} from './_express-shared.mjs';

// detect()'s ripgrep candidate filter -- deliberately just the `from 'express'` tail, not a whole
// import statement: rg matches line by line, so a clause spread over several lines would be missed
// by a fuller pattern. This is only a cheap pre-filter; the masked re-read in detect() is the real
// gate, so a false positive here costs nothing.
const FROM_EXPRESS_SRC = "from\\s*['\"]express['\"]";
const FROM_EXPRESS_RE = /\bfrom\s*['"]express['"]/g;

// The exact shapes an express import clause may legally take: `express`, `{ Router }`,
// `express, { Router }`. Anything else is REFUSED rather than parsed optimistically.
const IMPORT_CLAUSE_RE = /^(?:([\w$]+))?(?:\s*,\s*)?(?:\{([^}]*)\})?$/;

// Node's OWN module-resolution rule, not a heuristic: `.mjs` is unconditionally ESM; `.js` is ESM
// only when the nearest package.json says `"type": "module"`. A CommonJS app
// (`const express = require('express')`) is therefore out of scope BY CONSTRUCTION rather than by
// a separate exclusion check -- its files never match IMPORT_EXPRESS_SRC either way.
function esmExtensionsFor(pkg) {
	return pkg?.type === 'module' ? ['*.js', '*.mjs'] : ['*.mjs'];
}

function extensionSuffixes(globs) {
	return globs.map((g) => g.replace(/^\*/, '')); // ['*.js','*.mjs'] -> ['.js','.mjs']
}

// Two independent signals required, the same combined bar java-spring ("build file AND src
// layout"), python-fastapi ("dependency declared AND source-confirmed") and typescript-express all
// use: (a) a package.json declares express, (b) at least one ESM source file under it both imports
// express and calls `Router()` / `<something>.Router()`. Walks the whole repo for candidate
// package.json files (not just repoRoot) for the same monorepo reason python-fastapi does.
export function detectJavaScriptExpressRoot(repoRoot) {
	for (const pkgFile of listCandidatePackageFiles(repoRoot)) {
		if (!declaresExpress(pkgFile)) continue;
		const projectRoot = path.dirname(pkgFile);
		const globs = esmExtensionsFor(readPackageJson(pkgFile));
		// rg is a cheap candidate filter over raw bytes and can match inside a comment; the real
		// gate is the masked re-read below, which is why detection needs both the import AND a
		// Router() call to be genuine code.
		const sourceFiles = rgFilesMatching(FROM_EXPRESS_SRC, globs, projectRoot);
		// `\bRouter\s*\(` matches BOTH `Router(...)` and `express.Router(...)` -- there is a word
		// boundary between `.` and `R`, and none inside `makeRouter(`. Not `\(\s*\)`: an options
		// object (`Router({ mergeParams: true })`) is ordinary Express and must still detect.
		const callsRouter = sourceFiles.some((f) => {
			try {
				const masked = maskJsComments(fs.readFileSync(f, 'utf8'));
				return expressBindings(masked) !== null && /\bRouter\s*\(/.test(masked);
			} catch {
				return false;
			}
		});
		if (callsRouter) return { projectRoot, globs };
	}
	return null;
}

function listSourceFiles(projectRoot, globs) {
	return listRgFiles(projectRoot, globs);
}

// What THIS file named its express bindings. `import express, { Router } from 'express'` yields
// {defaultName: 'express', hasNamedRouter: true}. Returns null when the file doesn't import
// express at all, which is how non-routing files are skipped without reading them twice.
//
// Anchors on `from 'express'` and scans BACKWARD to the nearest `import` keyword, rather than
// matching a whole `import ... from 'express'` statement forward. A forward
// `import\s+([^;]*?)\s*from\s*['"]express['"]` looks right and is wrong on two shapes that are
// both entirely ordinary: semicolon-less ESM (standard.js style), where `[^;]` runs straight
// through the PREVIOUS import statement and yields a clause like `cors from 'cors'\nimport
// express`; and a clause spread over several lines. The backward scan handles both, and the
// strict IMPORT_CLAUSE_RE shape check means an unparseable clause is REFUSED (skipped), never
// parsed optimistically into a wrong binding name.
function expressBindings(text) {
	let defaultName = null;
	let hasNamedRouter = false;
	let found = false;
	for (const m of text.matchAll(FROM_EXPRESS_RE)) {
		const before = text.slice(0, m.index);
		const importIdx = before.lastIndexOf('import');
		if (importIdx === -1) continue; // e.g. `export * from 'express'` -- not an import binding
		const clause = before.slice(importIdx + 'import'.length).replace(/\s+/g, ' ').trim();
		const parsed = clause.match(IMPORT_CLAUSE_RE);
		if (!parsed) continue;
		found = true;
		if (parsed[1]) defaultName = parsed[1];
		// `Router as R` aliasing is deliberately NOT resolved -- a documented, narrow limitation
		// (see D-javascript-express-adapter COST), not a silent guess at which local name means
		// Router.
		if (parsed[2] && parsed[2].split(',').some((s) => s.trim() === 'Router')) hasNamedRouter = true;
	}
	return found ? { defaultName, hasNamedRouter } : null;
}

// Every locally-declared mountable value in this file, with what it is. Both kinds matter: an
// express() APPLICATION and an express.Router() both mount sub-routers with identical semantics
// (`app.use(path, router)` and `router.use(path, router)` are the same Express mechanism), and
// both can carry endpoints directly.
//
// Deliberately only `const`/`let`/`var` declarations with a direct call initializer -- a router
// returned from a factory function (`const r = buildRouter()`) is skipped, never guessed at, the
// same "bounded, not general" discipline every other cross-file resolution in this codebase uses.
function declaredMountables(text, bindings) {
	const mountables = new Map(); // varName -> 'router' | 'app'
	// `Router\s*\(` deliberately does NOT require empty parens: `Router({ mergeParams: true })` is
	// completely ordinary Express, and requiring `()` dropped the declaration entirely -- which,
	// here, means the file yields no routes at all rather than merely losing an option. Matching
	// the opening paren is sufficient to identify the variable; the argument list is never read.
	const routerDeclRe = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\.\s*)?Router\s*\(/g;
	for (const m of text.matchAll(routerDeclRe)) {
		// A bare `Router()` only counts when Router is genuinely imported from express; a
		// `<name>.Router()` member call always counts (that IS the default-import idiom).
		// NOT `$`-anchored: an earlier draft tested `/\.\s*Router\s*\($/` against a match that ends
		// past the member call, so it classified EVERY `express.Router()` as a bare call -- which,
		// with no named `Router` import in the file, dropped the declaration entirely and collapsed
		// the whole mount graph. Found by running the real fixture, not by review.
		const isMemberCall = /[\w$]\s*\.\s*Router\s*\(/.test(m[0]);
		if (isMemberCall || bindings.hasNamedRouter) mountables.set(m[1], 'router');
	}
	if (bindings.defaultName) {
		const appDeclRe = new RegExp(`\\b(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${bindings.defaultName}\\s*\\(\\s*\\)`, 'g');
		for (const m of text.matchAll(appDeclRe)) mountables.set(m[1], 'app');
	}
	return mountables;
}

function alternationOf(names) {
	return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

// One node per (file, variable) pair -- see divergence #3 in this file's header.
function nodeKey(file, varName) {
	return `${file} ${varName}`;
}

// LOCAL endpoints only (verb/path/handler/line), with an EMPTY prefix -- exactly like G5, because
// no path prefix is ever visible at an Express route-registration call site. The mount-tree walk in
// scanJavaScriptExpress() joins the real prefix chain afterward.
function extractEndpoints(text, mountableNames) {
	if (mountableNames.length === 0) return [];
	const re = new RegExp(`\\b(${alternationOf(mountableNames)})\\.(${VERBS.join('|')})\\s*\\(`, 'gi');
	const endpoints = [];
	for (const m of text.matchAll(re)) {
		const varName = m[1];
		const verb = m[2].toUpperCase();
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = matchBalancedParens(text, openIdx);
		if (closeIdx === -1) continue;
		const argsText = text.slice(openIdx + 1, closeIdx);
		const pathMatch = argsText.match(STRING_LITERAL_RE);
		if (!pathMatch) continue; // no path literal (built dynamically) -- skip rather than guess

		const args = splitTopLevelArgs(argsText);
		const lastArg = args[args.length - 1]?.trim();
		// A bare identifier only -- an inline arrow-function handler has no name to correlate to a
		// controller file, so it's skipped rather than guessed at (same discipline as G5's and
		// FastAPI's own "no path literal -> skip").
		const handlerMatch = lastArg?.match(/^([\w$]+)$/);
		if (!handlerMatch) continue;

		endpoints.push({ varName, verb, path: pathMatch[1], operationId: null, method: handlerMatch[1], line: lineNumberAt(text, m.index) });
	}
	return endpoints;
}

// Resolves a relative ESM specifier the way Node itself would, plus the two extensionless forms
// people write anyway. Node's real ESM resolver requires the full extension (`./x.js`); a bundler-
// or TypeScript-influenced codebase often omits it, so both are probed. Never guesses: returns
// null if nothing on disk matches.
function resolveEsmImport(fromFile, specifier, suffixes) {
	if (!specifier.startsWith('.')) return null; // only relative specifiers resolve mount edges
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [base];
	for (const ext of suffixes) candidates.push(`${base}${ext}`, path.join(base, `index${ext}`));
	for (const candidate of candidates) {
		// isFile(), not existsSync() -- `./v1` names a DIRECTORY that exists, and treating it as the
		// resolved module would silently produce a mount edge to nothing.
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch { /* not on disk */ }
	}
	return null;
}

// D-javascript-express-adapter (Update): found by the same shadow-validation-style audit that
// closed D-module-attribution-base-package's own EXIT item for this adapter -- cross-file mount
// resolution only ever recognized `export default router;`, a real but narrower limitation than
// java-spring's own moduleOf() bug (endpoints still get FOUND either way, only their prefix goes
// unresolved). A router handed off via a bare named export (`export { router };`) or an
// export-prefixed declaration (`export const router = Router();`, ordinary and common) previously
// had no path to being recognized as this file's "the" exported mountable at all.
//
// Three real ways a module hands a locally-declared mountable to whoever imports it -- `export
// { router as r }` aliasing is deliberately NOT resolved, same restraint as this file's own
// `Router as R` import-aliasing decision (D-javascript-express-adapter COST): a documented, narrow
// limitation, not a silent guess at which local name an alias refers to.
function exportedMountableName(text, mountables) {
	const defaultMatch = text.match(/export\s+default\s+([\w$]+)\s*;?/);
	if (defaultMatch && mountables.has(defaultMatch[1])) return defaultMatch[1];
	const namedMatch = text.match(/export\s*\{\s*([\w$]+)\s*\}/);
	if (namedMatch && mountables.has(namedMatch[1])) return namedMatch[1];
	const exportedDeclMatch = text.match(/\bexport\s+(?:const|let|var)\s+([\w$]+)\s*=/);
	if (exportedDeclMatch && mountables.has(exportedDeclMatch[1])) return exportedDeclMatch[1];
	return null;
}

// `import target from '...'` (default) OR `import { target } from '...'` (named, unaliased) --
// two real ways an imported mountable's LOCAL name reaches this file. `import { target as alias }`
// is deliberately not resolved, same restraint as exportedMountableName's own aliasing decision
// above -- a bare, unaliased single-name clause only, matching this file's existing default-import
// regex's own narrow scope (never a general multi-specifier import-clause parser).
function importSourceFor(text, target) {
	const defaultImportRe = new RegExp(`import\\s+${target}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*["']([^"']+)["']`);
	const defaultMatch = text.match(defaultImportRe);
	if (defaultMatch) return defaultMatch[1];
	const namedImportRe = new RegExp(`import\\s*\\{\\s*${target}\\s*\\}\\s*from\\s*["']([^"']+)["']`);
	const namedMatch = text.match(namedImportRe);
	return namedMatch ? namedMatch[1] : null;
}

// Builds the mount graph over (file, variable) nodes. Two edge kinds, both from the same
// `X.use('/literal', Y)` call shape:
//   - INTRA-FILE: Y is another mountable declared in this same file (`app.use('/api', route)`)
//   - CROSS-FILE: Y is imported from a RELATIVE specifier whose file default-exports a mountable
// A computed/dynamic mount (`route.use(prefix, buildRouter())`), a bare/package specifier, or a
// single-argument `use()` (a middleware mount, not a prefixed module) is skipped, never guessed at.
function buildMountEdges(files, fileInfo, suffixes) {
	const edges = []; // { from: nodeKey, to: nodeKey, prefix }
	for (const file of files) {
		const info = fileInfo.get(file);
		if (!info || info.mountables.size === 0) continue;
		const names = [...info.mountables.keys()];
		const useRe = new RegExp(`\\b(${alternationOf(names)})\\.use\\s*\\(`, 'g');
		for (const m of info.text.matchAll(useRe)) {
			const fromVar = m[1];
			const openIdx = m.index + m[0].length - 1;
			const closeIdx = matchBalancedParens(info.text, openIdx);
			if (closeIdx === -1) continue;
			const args = splitTopLevelArgs(info.text.slice(openIdx + 1, closeIdx));
			if (args.length !== 2) continue;
			const pathMatch = args[0].match(STRING_LITERAL_RE);
			const identMatch = args[1].match(/^([\w$]+)$/);
			if (!pathMatch || !identMatch) continue;
			const target = identMatch[1];

			if (info.mountables.has(target)) {
				edges.push({ from: nodeKey(file, fromVar), to: nodeKey(file, target), prefix: pathMatch[1] });
				continue;
			}
			const importSource = importSourceFor(info.text, target);
			if (!importSource) continue;
			const toFile = resolveEsmImport(file, importSource, suffixes);
			if (!toFile || !fileInfo.has(toFile)) continue;
			const toInfo = fileInfo.get(toFile);
			const toVar = exportedMountableName(toInfo.text, toInfo.mountables);
			if (!toVar) continue;
			edges.push({ from: nodeKey(file, fromVar), to: nodeKey(toFile, toVar), prefix: pathMatch[1] });
		}
	}
	return edges;
}

// Prefix chain from a mount-graph root down to `node`, or '' if `node` is itself a root. A node
// reachable through more than one edge uses whichever edge is found first -- a documented, narrow
// limitation rather than resolving every possible path.
//
// `seen` is NOT defensive boilerplate: intra-file edges make a genuine cycle representable
// (`a.use('/x', b); b.use('/y', a)` inside one file), which the file-to-file model G5 uses cannot
// express. Without it that shape is infinite recursion, not a wrong answer.
function prefixChainFor(node, edges, seen = new Set()) {
	if (seen.has(node)) return '';
	seen.add(node);
	const incoming = edges.find((e) => e.to === node);
	if (!incoming) return '';
	return joinPath(prefixChainFor(incoming.from, edges, seen), incoming.prefix);
}

// `user.route.js` -> `user`. A trailing `.route`/`.routes`/`.router` segment is a near-universal
// naming convention for Express route files and carries no information; stripping it makes the
// module name match the resource the way `routes/v1/users.ts`'s bare stem already does for G5.
// This is a display/scoring LABEL only -- nothing downstream generates code from it (this adapter
// declares codegen.handles: false), so the cost of the convention being wrong somewhere is a
// slightly odd module name, never wrong output.
function moduleNameFor(file) {
	const stem = path.basename(file, path.extname(file));
	return stem.replace(/\.(routes?|router)$/i, '');
}

const API_SURFACE_SOURCE = 'route paths are resolved by walking the Express mount graph over (file, router-variable) ' +
	'nodes -- both cross-file `use(\'/literal\', importedRouter)` edges (RELATIVE specifiers only) and intra-file ' +
	'`app.use(\'/literal\', localRouter)` edges, where a global prefix usually lives. A computed/dynamic mount is ' +
	'skipped, never guessed. Plain Express has no operationId concept at all, so they are never statically ' +
	'derivable here. This adapter also reports NO persistence entities: the target stack calls a raw SQL driver ' +
	'(mysql2/mariadb) directly, and a SQL string literal carries no trustworthy table/primary-key/column metadata ' +
	'-- see D-javascript-express-adapter in DECISIONS.md. Pass a real OpenAPI document via `bskel contract emit ' +
	'--openapi-file <path> --path-prefix <prefix>` for trustworthy operation identity, if this app has one.';

export function scanJavaScriptExpress(repoRoot, detection) {
	const { projectRoot, globs } = detection;
	const suffixes = extensionSuffixes(globs);
	// Normalized to absolute up front: `rg --files` echoes back paths in whatever style its `dir`
	// argument used, but `resolveEsmImport()` builds candidates with `path.resolve()`, which is
	// ALWAYS absolute. With a relative repoRoot the two never compare equal, every cross-file mount
	// edge is silently dropped, and every route loses its prefix while still looking successfully
	// scanned. Real callers happen to pass an absolute repoRoot today (`git rev-parse
	// --show-toplevel`), so this was latent rather than user-visible -- found by running the
	// adapter directly against a relative fixture path. Sorting happens before this map, and
	// resolve() prepends the same prefix to every entry, so O6 determinism is unaffected;
	// `path.relative()` resolves both of its arguments, so `filesRead` stays repo-relative.
	const files = listSourceFiles(projectRoot, globs).map((f) => path.resolve(f));

	const fileInfo = new Map();
	for (const file of files) {
		// Masked ONCE, here -- every structural regex below (bindings, mountable declarations,
		// endpoints, mount edges, default export) runs against the masked text, so prose about
		// routing can never be mistaken for routing. String literals survive intact, so every path
		// value is still read from the real source. See maskJsComments in _express-shared.mjs.
		const text = maskJsComments(fs.readFileSync(file, 'utf8'));
		const bindings = expressBindings(text);
		fileInfo.set(file, { text, bindings, mountables: bindings ? declaredMountables(text, bindings) : new Map() });
	}
	const edges = buildMountEdges(files, fileInfo, suffixes);

	const modules = new Map();
	const moduleEntry = (name) => {
		if (!modules.has(name)) modules.set(name, { module: name, controllers: [], entities: [], enums: [], dtos: [] });
		return modules.get(name);
	};

	for (const file of files) {
		const info = fileInfo.get(file);
		if (info.mountables.size === 0) continue;
		const localEndpoints = extractEndpoints(info.text, [...info.mountables.keys()]);
		if (localEndpoints.length === 0) continue;

		// One controller per (file, router-variable): a file declaring two routers mounted at two
		// different prefixes has two genuinely different base paths, and collapsing them onto the
		// file would attribute the wrong absolute path to half its endpoints.
		const byVar = new Map();
		for (const ep of localEndpoints) {
			if (!byVar.has(ep.varName)) byVar.set(ep.varName, []);
			byVar.get(ep.varName).push(ep);
		}
		const moduleName = moduleNameFor(file);
		for (const [varName, eps] of byVar) {
			const prefix = prefixChainFor(nodeKey(file, varName), edges);
			const endpoints = eps.map(({ varName: _v, ...ep }) => ({ ...ep, path: joinPath(prefix, ep.path) }));
			const className = `${moduleName.charAt(0).toUpperCase()}${moduleName.slice(1)}${varName.charAt(0).toUpperCase()}${varName.slice(1)}`;
			moduleEntry(moduleName).controllers.push({ className, basePath: prefix, operationIds: [], endpoints, file });
		}
	}

	return {
		modules: [...modules.values()],
		pathPrefixSignals: [],
		apiSurfaceSource: API_SURFACE_SOURCE,
		filesRead: files.map((f) => path.relative(repoRoot, f)),
	};
}

// G6 (D-javascript-express-adapter): adapter descriptor consumed by scanners/registry.mjs. `id`
// must equal this file's stem ("javascript-express").
//
// specificity 80 -- deliberately BELOW typescript-express's 85 (and java-spring's 100 /
// python-fastapi's 90). A repo containing both a `.ts` Express app and `.mjs` ESM sources could be
// detected by both Express adapters; the TypeScript one carries strictly more (real entity
// metadata and a working codegen provider), so it should win that overlap quietly rather than
// tripping runScan()'s same-specificity ambiguity error. Checkable via `bskel doctor`.
export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'javascript-express',
	title: 'JavaScript / Express (ESM, no ORM)',
	specificity: 80,
	// high, matching python-fastapi's own G2 shipping state: confidence describes trust in what the
	// scan REPORTS (routes and their real absolute paths, resolved through a genuine mount-graph
	// walk), not how many capabilities it can offer. generic-grep is `low` because it has no module
	// inference and no prefix resolution at all -- this adapter has both.
	confidence: 'high',
	// D-adapter-verification-basis: no real-world oracle at all, unlike every other real framework
	// adapter -- the real target repository was deliberately never touched, and the committed
	// synthetic fixture carries all of the regression weight. Named honestly, not hidden.
	verificationBasis: 'synthetic-only',
	capabilities: {
		// false: plain Express has no operationId concept at all. --openapi-file is the honest path
		// forward for an app that has one; see CAPABILITY_SATISFIERS in scanners/capabilities.mjs.
		'api.operations': false,
		// false: contracts/emit.mjs's detectRequestBody() is a Java-only regex, and plain JS has no
		// typed request-body convention to read instead. Costs only body:'unknown' (WARN, waivable).
		'api.request-shape': false,
		// false, and structurally so: this stack has no ORM, so this adapter reports zero entities
		// -- there is nothing carrying a table name or primary key for a resolver to fetch BY. This
		// is not "not implemented yet"; see D-javascript-express-adapter's EXCLUDED section for the
		// measured reason raw SQL literals cannot supply it safely.
		'resource.fetch': false,
		// false: no handles/providers/javascript-express/ exists, by design. The biconditional test
		// in test/handles-provider-registry.test.mjs enforces that this stays honest.
		'codegen.handles': false,
	},
	detect: detectJavaScriptExpressRoot,
	scan(repoRoot, detection) {
		return scanJavaScriptExpress(repoRoot, detection);
	},
	listReadSet(repoRoot) {
		const detection = detectJavaScriptExpressRoot(repoRoot);
		if (!detection) return [];
		return listSourceFiles(detection.projectRoot, detection.globs).map((f) => path.relative(repoRoot, f));
	},
	diagnostics(repoRoot) {
		return expressDiagnostics(repoRoot);
	},
};
