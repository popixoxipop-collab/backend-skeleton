// G5 (D-typescript-express-provider): the third scanner adapter, alongside java-spring.mjs (G1)
// and python-fastapi.mjs (G2) -- same philosophy (ripgrep-for-discovery + regex-for-structure,
// no real TS AST parser/tsc shell-out). Unlike G2, no framework-maintained reference oracle
// exists for Express (deliberately unopinionated framework, confirmed via real research before
// this file was written) -- verified instead against the best-validated real community boilerplate
// found (`mkosir/typeorm-express-typescript`, 461 stars/149 forks, not a fork itself, freshly
// cloned and read). See D-typescript-express-provider in DECISIONS.md for why this item's
// verification confidence is honestly, permanently weaker than G2's own.
import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt } from '../text-util.mjs';
// G6: these were this file's own private helpers until `javascript-express.mjs` needed the exact
// same ones -- moved verbatim to `_express-shared.mjs` (a `_`-prefixed shared helper, the same
// convention `_java-spring-analyzer.mjs` uses) rather than copy-pasted. No behavior change; see
// D-javascript-express-adapter in DECISIONS.md for why only these primitives are shared and the
// mount-tree/endpoint logic deliberately is not.
import {
	VERBS,
	STRING_LITERAL_RE,
	listRgFiles,
	rgFilesMatching,
	listCandidatePackageFiles,
	declaresExpress,
	matchBalancedParens,
	splitTopLevelArgs,
	joinPath,
	maskJsComments,
	expressDiagnostics,
} from './_express-shared.mjs';

const VERB_CALL_RE = new RegExp(`\\brouter\\.(${VERBS.join('|')})\\s*\\(`, 'gi');
const ROUTER_USE_RE = /\brouter\.use\s*\(/g;
const ENTITY_CLASS_RE = /@Entity\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)\s*\n?\s*export\s+class\s+(\w+)/g;

// Two independent signals required, mirroring java-spring's "build file AND src layout" /
// python-fastapi's "dependency declared AND source-confirmed" combined bar: (a) package.json
// declares express, (b) at least one .ts file actually imports Router from 'express' and calls
// Router(). Walks the whole repo for candidate package.json files (not just repoRoot) the same
// way python-fastapi does, for the same monorepo reason.
export function detectTypeScriptExpressRoot(repoRoot) {
	const pkgFile = listCandidatePackageFiles(repoRoot).find((f) => declaresExpress(f));
	if (!pkgFile) return null;

	const projectRoot = path.dirname(pkgFile);
	const sourceFiles = rgFilesMatching("import\\s*\\{[^}]*\\bRouter\\b[^}]*\\}\\s*from\\s*['\"]express['\"]", ['*.ts'], projectRoot);
	if (sourceFiles.length === 0) return null;
	// G6: `\bRouter\s*\(`, not `\bRouter\s*\(\s*\)` -- `Router({ mergeParams: true })` is ordinary
	// Express, and requiring empty parens made this whole adapter fail to detect a repo whose
	// routers all pass options. A strict widening of the SECOND half of an already-conjunctive
	// signal (the first half still requires a named `Router` import from 'express'), and there is
	// no word boundary inside `makeRouter(`, so this cannot match an unrelated factory.
	const callsRouter = sourceFiles.some((f) => {
		try {
			return /\bRouter\s*\(/.test(maskJsComments(fs.readFileSync(f, 'utf8')));
		} catch {
			return false;
		}
	});
	return callsRouter ? projectRoot : null;
}

function listTypeScriptFiles(projectRoot) {
	return listRgFiles(projectRoot, ['*.ts']);
}

// No path prefix is ever visible at a route-registration call site in this idiom (unlike
// `@RequestMapping`/`APIRouter(prefix=...)`) -- confirmed in the real oracle: `routes/v1/users.ts`
// itself declares no base path anywhere; the real absolute path only exists as the concatenation
// of `router.use('/literal', subRouter)` mount edges from a graph root down to the leaf file. This
// extracts just the LOCAL endpoints (verb/path/handler/line) with an EMPTY prefix -- the mount-tree
// walk in scanTypeScriptExpress() below joins the real prefix chain afterward.
function extractEndpoints(text) {
	const endpoints = [];
	for (const m of text.matchAll(VERB_CALL_RE)) {
		const verb = m[1].toUpperCase();
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = matchBalancedParens(text, openIdx);
		if (closeIdx === -1) continue;
		const argsText = text.slice(openIdx + 1, closeIdx);
		const pathMatch = argsText.match(STRING_LITERAL_RE);
		if (!pathMatch) continue; // no path literal (e.g. built dynamically) -- skip rather than guess

		const args = splitTopLevelArgs(argsText);
		const lastArg = args[args.length - 1]?.trim();
		// A bare identifier only -- an inline arrow-function handler has no name to correlate to a
		// controller file, so it's skipped rather than guessed at (same discipline as FastAPI's own
		// "no path literal -> skip").
		const handlerMatch = lastArg?.match(/^(\w+)$/);
		if (!handlerMatch) continue;

		endpoints.push({ verb, path: pathMatch[1], operationId: null, method: handlerMatch[1], line: lineNumberAt(text, m.index) });
	}
	return endpoints;
}

// Resolves a bare specifier's own file on disk, extension-probed the same way Node's own resolver
// would for a relative TS import (`./x` -> `./x.ts` or `./x/index.ts`). Returns null, never
// guesses, if neither exists.
function resolveRelativeImport(fromFile, specifier) {
	if (!specifier.startsWith('.')) return null; // only relative imports resolve mount edges -- see below
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

// Builds the router mount-tree: for every file with `export default router` (or `export default
// <name>` where <name> was assigned `= Router()`), finds every `router.use('/literal', identifier)`
// edge and resolves `identifier` via THAT FILE'S OWN relative `import` statement only -- bare/
// baseUrl-relative specifiers (`'controllers/users'`) are deliberately not resolved here, only for
// router-to-router mounts, which the real oracle confirms are always relative (`import v1 from
// './v1/'`). A file with no incoming edge is a root. Bounded, not general: a computed/dynamic mount
// (`router.use(prefix, buildRouter())`) is skipped, never guessed at.
function buildMountEdges(files, fileTexts) {
	const edges = []; // { fromFile, toFile, prefix }
	for (const file of files) {
		const text = fileTexts.get(file);
		for (const m of text.matchAll(ROUTER_USE_RE)) {
			const openIdx = m.index + m[0].length - 1;
			const closeIdx = matchBalancedParens(text, openIdx);
			if (closeIdx === -1) continue;
			const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
			if (args.length !== 2) continue; // single-arg router.use(subRouter) is a page/catch-all mount, not a prefixed module
			const pathMatch = args[0].match(STRING_LITERAL_RE);
			const identMatch = args[1].match(/^(\w+)$/);
			if (!pathMatch || !identMatch) continue;

			const importRe = new RegExp(`import\\s+${identMatch[1]}\\s+from\\s*["']([^"']+)["']`);
			const importMatch = text.match(importRe);
			if (!importMatch) continue;
			const toFile = resolveRelativeImport(file, importMatch[1]);
			if (!toFile || !files.includes(toFile)) continue;

			edges.push({ fromFile: file, toFile, prefix: pathMatch[1] });
		}
	}
	return edges;
}

// Prefix chain from a mount-tree root down to `file`, or '' if `file` is itself a root (no
// incoming edge) -- a file mounted through more than one path (unusual, not seen in the real
// oracle) uses whichever edge is found first, a documented, narrow limitation rather than
// resolving every possible path.
function prefixChainFor(file, edges) {
	const incoming = edges.find((e) => e.toFile === file);
	if (!incoming) return '';
	return joinPath(prefixChainFor(incoming.fromFile, edges), incoming.prefix);
}

// `@Entity('users') export class User { @PrimaryGeneratedColumn() id: number; ... }` -- table name
// is the lowercased class name when @Entity() carries no literal argument (TypeORM's own default,
// mirroring SQLModel's identical default-naming precedent already used for python-fastapi). idField
// search is scoped to just this class's body (its own `{` to the matching `}`) so a file with more
// than one entity class never finds the WRONG class's primary key.
function extractTableEntities(text, file) {
	const entities = [];
	for (const m of text.matchAll(ENTITY_CLASS_RE)) {
		const bodyOpen = text.indexOf('{', m.index + m[0].length);
		if (bodyOpen === -1) continue;
		let depth = 0;
		let bodyClose = -1;
		for (let i = bodyOpen; i < text.length; i++) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}') {
				depth--;
				if (depth === 0) { bodyClose = i; break; }
			}
		}
		if (bodyClose === -1) continue;
		const body = text.slice(bodyOpen, bodyClose);
		// @PrimaryGeneratedColumn('uuid') id: string; vs. the bare/default form (an auto-incrementing
		// integer, TypeORM's own default with no argument). This handle system's own token format
		// (kind:type:UUID[:pointer], see handles/codec.mjs's HANDLE_RE) can only ever address a
		// UUID-shaped resource identifier -- an integer primary key genuinely cannot be reached
		// through it, not a TypeScript-specific limitation. Found live via a real `tsc --noEmit` type
		// error before this distinction was tracked at all (the real oracle's own User entity uses
		// the bare/integer form).
		// `!` after the identifier (TypeScript's definite-assignment assertion, `id!: string;`) is
		// real, common TypeORM+strict-mode syntax -- found live when the fixture's own entity used it
		// (strict mode's strictPropertyInitialization otherwise rejects a decorator-initialized class
		// field with no constructor assignment) and a first regex draft without `!?` silently failed
		// to find the id field at all.
		const idMatch = body.match(/@PrimaryGeneratedColumn\s*\(([^)]*)\)\s*\n?\s*(\w+)\s*!?\s*:/);
		const className = m[2];
		entities.push({
			className,
			table: m[1] || className.toLowerCase(),
			idField: idMatch ? idMatch[2] : null,
			idFieldIsUuid: idMatch ? /['"]uuid['"]/.test(idMatch[1]) : false,
			file,
			line: lineNumberAt(text, m.index),
		});
	}
	return entities;
}

const API_SURFACE_SOURCE = 'route paths are resolved by walking the router mount-tree (router.use(\'/literal\', ' +
	'subRouter) edges through RELATIVE imports only -- a computed/dynamic mount is skipped, never guessed) -- ' +
	'plain Express has no operationId concept at all (weaker than FastAPI, which at least generates one at ' +
	'runtime), so they are never statically derivable here. Pass a real OpenAPI document via ' +
	'`bskel contract emit --openapi-file <path> --path-prefix <prefix>` for trustworthy operation identity, ' +
	'if this target app has one (most plain Express apps do not auto-generate one the way FastAPI does).';

export function scanTypeScriptExpress(repoRoot, projectRoot) {
	const files = listTypeScriptFiles(projectRoot);
	// G6: masked, the same way javascript-express.mjs masks its own sources. Without this a
	// commented-out `// router.get('/old', oldHandler)` -- or prose quoting a route registration --
	// is extracted and reported as a LIVE endpoint. Same defect class A2 Phase 1's `maskNonCode()`
	// fixed for Java (D-java-analyzer's phantom-operationId bug); found while building G6's
	// adapter, where a fixture's own header comment collapsed the entire mount graph. String
	// literals are left intact, so every path/table VALUE this adapter reports is unchanged.
	const fileTexts = new Map(files.map((f) => [f, maskJsComments(fs.readFileSync(f, 'utf8'))]));
	const edges = buildMountEdges(files, fileTexts);

	const modules = new Map();
	const moduleEntry = (name) => {
		if (!modules.has(name)) modules.set(name, { module: name, controllers: [], entities: [], enums: [], dtos: [] });
		return modules.get(name);
	};

	const allEntities = [];
	for (const file of files) {
		const text = fileTexts.get(file);
		// G6: `\bRouter\s*\(` -- see detectTypeScriptExpressRoot above. Same widening for the same
		// reason: a router declared as `Router({ mergeParams: true })` is ordinary Express, and
		// this per-file gate previously skipped its whole file.
		if (/\bRouter\s*\(/.test(text) && /\brouter\.\w+\s*\(/.test(text)) {
			const localEndpoints = extractEndpoints(text);
			if (localEndpoints.length > 0) {
				const prefix = prefixChainFor(file, edges);
				const moduleName = path.basename(file, '.ts');
				const endpoints = localEndpoints.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }));
				const className = `${moduleName.charAt(0).toUpperCase()}${moduleName.slice(1)}Router`;
				moduleEntry(moduleName).controllers.push({ className, basePath: prefix, operationIds: [], endpoints, file });
			}
		}
		allEntities.push(...extractTableEntities(text, file));
	}

	// Entity -> module assignment: narrow name-match (exact singular or singular+'s'), same
	// precedent as python-fastapi's own -- an unmatched entity goes to a `_models` bucket rather
	// than being silently dropped.
	for (const entity of allEntities) {
		const lower = entity.className.toLowerCase();
		const candidates = new Set([lower, `${lower}s`]);
		const targetModule = [...modules.keys()].find((name) => candidates.has(name));
		moduleEntry(targetModule ?? '_models').entities.push(entity);
	}

	return {
		modules: [...modules.values()],
		pathPrefixSignals: [],
		apiSurfaceSource: API_SURFACE_SOURCE,
		filesRead: files.map((f) => path.relative(repoRoot, f)),
	};
}

// G5 (D-typescript-express-provider): adapter descriptor consumed by scanners/registry.mjs. `id`
// must equal this file's stem ("typescript-express").
//
// specificity 85 -- distinct from java-spring's 100 and python-fastapi's 90, same combined-signal
// strength as both (package.json dependency AND source-confirmed), a real documented trade-off
// (not an inherent "TypeScript signals are weaker" claim) so a polyglot repo's adapter selection
// stays deterministic, checkable via `bskel doctor`.
export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'typescript-express',
	title: 'TypeScript / Express / TypeORM',
	specificity: 85,
	confidence: 'high',
	// D-adapter-verification-basis: no framework-maintained Express reference exists (confirmed by
	// real research before this adapter was built) -- verified instead against the best-validated
	// real community boilerplate found, `mkosir/typeorm-express-typescript`. Permanently weaker
	// than java-spring/python-fastapi's own basis, named honestly rather than hidden.
	verificationBasis: 'community-sample',
	capabilities: {
		// false: plain Express has no operationId concept at all. --openapi-file is the honest path
		// forward for an app that has one; see CAPABILITY_SATISFIERS in scanners/capabilities.mjs.
		'api.operations': false,
		// false: contracts/emit.mjs's detectRequestBody() is a Java-only regex -- declaring true
		// would be dishonest. Costs only body:'unknown' (WARN, waivable).
		'api.request-shape': false,
		// true: table/idField are genuinely, statically extracted from @Entity()/
		// @PrimaryGeneratedColumn(). An app using Prisma/Sequelize/Drizzle instead of TypeORM simply
		// yields zero entities at scan time, not a detect() failure or a capability lie.
		'resource.fetch': true,
		// true (G5): handles/providers/typescript-express/ is a real, executed-and-verified codegen
		// provider -- see D-typescript-express-provider in DECISIONS.md.
		'codegen.handles': true,
	},
	detect: detectTypeScriptExpressRoot,
	scan(repoRoot, detection) {
		return scanTypeScriptExpress(repoRoot, detection);
	},
	listReadSet(repoRoot) {
		const projectRoot = detectTypeScriptExpressRoot(repoRoot);
		if (!projectRoot) return [];
		return listTypeScriptFiles(projectRoot).map((f) => path.relative(repoRoot, f));
	},
	diagnostics(repoRoot) {
		return expressDiagnostics(repoRoot);
	},
};
