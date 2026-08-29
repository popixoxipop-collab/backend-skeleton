// G2: the second first-class adapter, alongside java-spring.mjs (generic-grep.mjs is deliberately
// a shallow fallback, not a real second adapter -- see D-generic-grep-reconnaissance). Same
// philosophy as java-spring.mjs: ripgrep-for-discovery + regex-for-structure, deliberately no
// Python `ast`-module/interpreter shell-out -- see D-fastapi-adapter in DECISIONS.md for why that
// overrides CATALOG.md's own "Python AST" wording (measured against a real FastAPI repo with zero
// accuracy loss, and this CLI's only external binary dependency stays `rg`, not a second one).
//
// Verified against a real cloned oracle before this file was written (fastapi/full-stack-fastapi-
// template): running the PRE-G2 scanner against it reported `greenfield` -- 23 real routes existed
// and were entirely missed by score. That false negative, not portability alone, is this item's
// real motivation. See D-fastapi-adapter in DECISIONS.md for the full reproduction.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName } from '../text-util.mjs';

const PROJECT_FILE_GLOBS = ['pyproject.toml', 'requirements*.txt'];
const EXCLUDE_GLOBS = ['!**/.venv/**', '!**/site-packages/**', '!**/node_modules/**', '!**/__pycache__/**'];

// Bounded, not a TOML/requirements.txt parser (A2's "good-enough regex, not a real parser"
// philosophy for Java, applied here) -- must reject `fastapi` as a substring of a longer
// identifier and still match real forms like `"fastapi[standard]>=0.141.1,<1.0.0"` and
// `fastapi==0.100.0`.
const FASTAPI_DEP_RE = /(?:^|[\s"'[])fastapi(?:\[[^\]]*\])?(?:[\s"',\]=<>~!;]|$)/mi;

const VERB_DECORATOR_RE = /@\w+\.(get|post|put|patch|delete)\s*\(/gi;
const CLASS_RE = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
const INCLUDE_ROUTER_RE = /include_router\s*\(/g;

function listRgFiles(dir, globs) {
	return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS);
}

function listCandidateProjectFiles(repoRoot) {
	return listRgFiles(repoRoot, PROJECT_FILE_GLOBS).sort(byShallowestThenName);
}

// Returns the Python project root (the analogue of java-spring's srcRoot) or null. Two independent
// signals, both required, mirroring java-spring's own "build file AND src layout" combined bar:
// (a) a dependency declaration naming fastapi, (b) at least one .py file that actually imports or
// instantiates it. Genuinely different from java-spring in one respect: this walks the WHOLE repo
// for candidate project files rather than assuming repoRoot itself is the project root, because a
// real target (the oracle) is a monorepo whose FastAPI project lives under backend/ -- verified to
// resolve correctly.
export function detectPythonFastApiRoot(repoRoot) {
	const depFile = listCandidateProjectFiles(repoRoot).find((f) => {
		try {
			return FASTAPI_DEP_RE.test(fs.readFileSync(f, 'utf8'));
		} catch {
			return false;
		}
	});
	if (!depFile) return null;

	const projectRoot = path.dirname(depFile);
	const sourceFiles = (() => {
		try {
			return execFileSync('rg', [
				'-l', '-e', 'from\\s+fastapi\\s+import', '-e', 'import\\s+fastapi\\b', '-e', 'FastAPI\\(',
				'-g', '*.py', ...EXCLUDE_GLOBS.flatMap((g) => ['-g', g]),
				projectRoot,
			], { encoding: 'utf8' }).split('\n').filter(Boolean);
		} catch {
			return [];
		}
	})();
	return sourceFiles.length > 0 ? projectRoot : null;
}

function listPythonFiles(projectRoot) {
	return listRgFiles(projectRoot, ['*.py']);
}

// Walks forward from `openIndex` (text[openIndex] must be '(') tracking paren depth, and returns
// the index of the matching close paren, or -1. Needed because a decorator's own kwargs routinely
// nest parens (`dependencies=[Depends(get_current_active_superuser)]`, confirmed in the real
// oracle) -- a non-greedy `[\s\S]*?\)` regex would stop at the FIRST close paren (Depends(...)'s
// own), truncating the argument text before response_model=/the path literal are even reached.
function matchBalancedParens(text, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}


function joinPath(base, segment) {
	const b = (base || '').replace(/\/$/, '');
	const s = (segment || '').replace(/^\//, '');
	return s ? `${b}/${s}` : (b || '/');
}

function capitalize(s) {
	return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// `router = APIRouter(prefix="/items", tags=["items"])` -- balanced-paren scan (not a simple
// regex) for the same nested-paren reason as endpoint extraction. Router-local only, never
// resolved against a global prefix applied elsewhere (e.g. `include_router(prefix=...)`) -- that
// asymmetry is exactly what `pathPrefixSignals`/`unknowns` exists to flag, same role java-spring's
// detectGlobalPathPrefixSignals plays for `configurePathMatch`/`context-path`.
function extractBasePath(text) {
	const m = text.match(/APIRouter\s*\(/);
	if (!m) return '';
	const openIdx = m.index + m[0].length - 1;
	const closeIdx = matchBalancedParens(text, openIdx);
	if (closeIdx === -1) return '';
	const prefixMatch = text.slice(openIdx + 1, closeIdx).match(/prefix\s*=\s*["']([^"']*)["']/);
	return prefixMatch ? prefixMatch[1] : '';
}

// `operationId` is always null -- see the adapter's own `api.operations: false` and
// D-fastapi-adapter in DECISIONS.md: FastAPI generates operation ids at request-handling time
// (per-project, sometimes via a custom `generate_unique_id_function`), never pinned in source the
// way `@Operation(operationId=...)` is for Java, so there is nothing honest to statically correlate.
function extractEndpoints(text) {
	const endpoints = [];
	for (const m of text.matchAll(VERB_DECORATOR_RE)) {
		const verb = m[1].toUpperCase();
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = matchBalancedParens(text, openIdx);
		if (closeIdx === -1) continue;
		const argsText = text.slice(openIdx + 1, closeIdx);
		const pathMatch = argsText.match(/^\s*["']([^"']*)["']/); // first positional arg
		if (!pathMatch) continue; // no path literal (e.g. built dynamically) -- skip rather than guess

		const afterDecoratorRe = /\s*(?:async\s+)?def\s+(\w+)\s*\(/y;
		afterDecoratorRe.lastIndex = closeIdx + 1;
		const funcMatch = afterDecoratorRe.exec(text);
		if (!funcMatch) continue;

		endpoints.push({ verb, path: pathMatch[1], operationId: null, method: funcMatch[1], line: lineNumberAt(text, m.index) });
	}
	return endpoints;
}

// SQLModel `class X(<bases>, table=True):` -- table name is the lowercased class name (SQLModel's
// own default when no explicit `__tablename__` is declared; cross-checked against the real
// oracle's own Alembic migration, `op.create_table("user", ...)`/`op.create_table("item", ...)`,
// not assumed). `idField` search is scoped to just this class's body (from its own `:` to the next
// top-level `class` or end of file) -- a file-wide search would find the WRONG class's primary key
// when more than one table class lives in the same file (the real oracle's models.py has several).
function extractTableEntities(text, file) {
	const classMatches = [...text.matchAll(CLASS_RE)];
	const entities = [];
	for (let i = 0; i < classMatches.length; i++) {
		const m = classMatches[i];
		if (!/table\s*=\s*True/.test(m[2])) continue;
		const bodyStart = m.index + m[0].length;
		const bodyEnd = i + 1 < classMatches.length ? classMatches[i + 1].index : text.length;
		const body = text.slice(bodyStart, bodyEnd);
		const idMatch = body.match(/(\w+)\s*:[^=\n]+=\s*Field\([^)]*primary_key\s*=\s*True/);
		entities.push({ className: m[1], table: m[1].toLowerCase(), idField: idMatch ? idMatch[1] : null, file, line: lineNumberAt(text, m.index) });
	}
	return entities;
}

// D-gate-precision (Continued, part 3): the DTO/request-response-shape counterpart to
// extractTableEntities() -- a SQLModel-family class WITHOUT `table=True` (`ItemBase(SQLModel)`,
// `ItemPublic(ItemBase)`, `ItemCreate(ItemBase)`), the real convention confirmed against this
// project's own committed fixture and the real oracle it mirrors (fastapi/full-stack-fastapi-
// template). Deliberately a separate function, not merged into extractTableEntities() -- zero
// regression risk to existing entity extraction. One narrow, named exclusion beyond "not
// table=True": `class Settings(BaseSettings):` (pydantic-settings' own well-known config-class
// base) is not API request/response surface -- excluding it is a concrete, common false-positive
// fix, not a hypothetical one. No broader positive allowlist (e.g. requiring `SQLModel`/`BaseModel`
// literally in the base list) is layered on top: the real oracle's own `ItemPublic(ItemBase)` shape
// (a DTO extending ANOTHER DTO, not SQLModel/BaseModel directly) would fail such an allowlist,
// trading a bounded, low-cost false positive for a worse false negative (a missed real DTO change)
// -- the same "prefer false positive over false negative" call this exact drift-detection mechanism
// already makes for controllers/entities/enums.
function extractDtoClasses(text, file) {
	const dtos = [];
	for (const m of text.matchAll(CLASS_RE)) {
		if (/table\s*=\s*True/.test(m[2])) continue; // has its own entity extractor above
		if (/\bBaseSettings\b/.test(m[2])) continue; // pydantic-settings config, not API surface
		dtos.push({ className: m[1], file, line: lineNumberAt(text, m.index) });
	}
	return dtos;
}

// Bounded, non-exhaustive allowlist of DTO class-name suffixes -- validated against this project's
// own committed fixture (ItemBase/ItemCreate/ItemPublic/ItemsPublic, all correctly stripping to
// "item"/"items", the real "items" module). A DTO whose class name uses a different convention
// (Schema, Payload, Out) lands in the `_dtos` bucket below instead -- named, accepted, untracked,
// same shape as an unmatched entity's `_models` fallback. Purely additive to extend: a future
// suffix added here can only ever gain coverage, never lose it.
const KNOWN_DTO_SUFFIXES = ['Base', 'Create', 'Update', 'Public', 'Read', 'Response', 'Request', 'In', 'Out'];
function stripKnownDtoSuffix(className) {
	const suffix = KNOWN_DTO_SUFFIXES.find((s) => className.length > s.length && className.endsWith(s));
	return suffix ? className.slice(0, -suffix.length) : className;
}

// A1 §7 equivalent for FastAPI: `include_router(router, prefix=X)` applies a prefix the
// per-router-file scan above cannot see (each file is read independently, with no idea another
// file mounts it under a further prefix). Two-step resolution when X is a variable/attribute
// reference (e.g. `prefix=settings.API_V1_STR`), mirroring java-spring's
// `configurePathMatch`->`addPathPrefix` two-step exactly: find the literal assignment elsewhere in
// the project. This function can't CORRECT anything (only --openapi-file's real-document
// reconciliation can) -- it exists so scanners/index.mjs's `unknowns` note points a user who
// doesn't know --openapi-file/--path-prefix exist at the real defect.
function extractIncludeRouterPrefixSignals(repoRoot, files) {
	const signals = [];
	const fileTextCache = new Map();
	const readFile = (f) => {
		if (!fileTextCache.has(f)) fileTextCache.set(f, fs.readFileSync(f, 'utf8'));
		return fileTextCache.get(f);
	};

	for (const file of files) {
		const text = readFile(file);
		for (const m of text.matchAll(INCLUDE_ROUTER_RE)) {
			const openIdx = m.index + m[0].length - 1;
			const closeIdx = matchBalancedParens(text, openIdx);
			if (closeIdx === -1) continue;
			const argsText = text.slice(openIdx + 1, closeIdx);

			const literalMatch = argsText.match(/prefix\s*=\s*["']([^"']*)["']/);
			if (literalMatch) {
				signals.push({ kind: 'include_router-prefix', file: path.relative(repoRoot, file), prefix: literalMatch[1] });
				continue;
			}
			const varMatch = argsText.match(/prefix\s*=\s*([\w.]+)/);
			if (!varMatch) continue;
			const varName = varMatch[1].split('.').pop();
			const assignRe = new RegExp(`\\b${varName}\\s*:?[^=\\n]*=\\s*["']([^"']*)["']`);
			for (const otherFile of files) {
				const assign = readFile(otherFile).match(assignRe);
				if (assign) {
					signals.push({ kind: 'include_router-prefix', file: path.relative(repoRoot, file), prefix: assign[1], via: varMatch[1] });
					break;
				}
			}
		}
	}
	return signals;
}

// D-fastapi-adapter: paths are router-local (see extractBasePath); FastAPI generates operation ids
// at runtime, never pinned in source -- see extractEndpoints. --openapi-file + --path-prefix is the
// trustworthy path (contracts/openapi.mjs's existing, adapter-agnostic reconciliation).
const API_SURFACE_SOURCE = 'router-local paths only (this scan does not resolve a global prefix applied via ' +
	'include_router(prefix=...) beyond a simple literal/single-variable lookup -- see unknowns below if one ' +
	'was found) -- FastAPI generates operation ids at request-handling time (per-project, sometimes via a ' +
	'custom generate_unique_id_function), so they are never statically derivable here. Pass a real OpenAPI ' +
	'document via `bskel contract emit --openapi-file <path> --path-prefix <prefix>` for trustworthy ' +
	'operation identity and schemas.';

export function scanPythonFastApi(repoRoot, projectRoot) {
	const files = listPythonFiles(projectRoot);
	const modules = new Map();
	const moduleEntry = (name) => {
		if (!modules.has(name)) modules.set(name, { module: name, controllers: [], entities: [], enums: [], dtos: [] });
		return modules.get(name);
	};

	const allEntities = [];
	const allDtos = [];
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');

		if (/APIRouter\s*\(/.test(text)) {
			// module = filename stem, NOT the router's own prefix -- verified against the real oracle's
			// login.py, which declares `APIRouter(tags=["login"])` with no prefix at all, so a
			// prefix-derived name fails on a real file while the filename stem works for every one.
			const moduleName = path.basename(file, '.py');
			const basePath = extractBasePath(text);
			const endpoints = extractEndpoints(text).map((ep) => ({ ...ep, path: joinPath(basePath, ep.path) }));
			if (endpoints.length > 0) {
				moduleEntry(moduleName).controllers.push({ className: `${capitalize(moduleName)}Router`, basePath, operationIds: [], endpoints, file });
			}
		}

		allEntities.push(...extractTableEntities(text, file));
		allDtos.push(...extractDtoClasses(text, file));
	}

	// Entity -> module assignment: this repo's real layout has no domain/<module>/ folder (all
	// SQLModel classes live in one flat models.py), so java-spring's path-segment convention
	// (moduleOf()) doesn't apply. Narrow name-match instead of general pluralization: `Item`
	// attaches to a real `items` module, `User` to `users` -- exact singular or singular+'s' only.
	// An unmatched table class (no route module shares its name) goes to a `_models` bucket rather
	// than being silently dropped.
	for (const entity of allEntities) {
		const lower = entity.className.toLowerCase();
		const candidates = new Set([lower, `${lower}s`]);
		const targetModule = [...modules.keys()].find((name) => candidates.has(name));
		moduleEntry(targetModule ?? '_models').entities.push(entity);
	}

	// DTO -> module assignment: same narrow name-match as entities, suffix-stripped first via the
	// bounded allowlist above (ItemPublic -> "item" -> matches "items"). Unmatched (unlisted suffix,
	// or no correlation at all) lands in a separate `_dtos` bucket -- not merged into entities' own
	// `_models` -- and is therefore NOT tracked by any feature's contract gate; a real, named,
	// accepted limitation (see D-gate-precision "Continued (part 3)" in DECISIONS.md).
	for (const dto of allDtos) {
		const lower = stripKnownDtoSuffix(dto.className).toLowerCase();
		const candidates = new Set([lower, `${lower}s`]);
		const targetModule = [...modules.keys()].find((name) => candidates.has(name));
		moduleEntry(targetModule ?? '_dtos').dtos.push(dto);
	}

	return {
		modules: [...modules.values()],
		pathPrefixSignals: extractIncludeRouterPrefixSignals(repoRoot, files),
		apiSurfaceSource: API_SURFACE_SOURCE,
		// S2 (D-gate-precision, continued): repo-relative, matching every other manifest-shaped
		// gate input in this codebase.
		filesRead: files.map((f) => path.relative(repoRoot, f)),
	};
}

// G2: adapter descriptor consumed by scanners/registry.mjs -- see D-adapter-registry (G1) and
// D-fastapi-adapter (G2) in DECISIONS.md. `id` must equal this file's stem ("python-fastapi").
//
// specificity 90, deliberately BELOW java-spring's 100 (not equal) -- same class of signal
// (dependency declaration AND source-confirmed, exactly java-spring's "build file AND src layout"
// bar), but a polyglot monorepo containing BOTH a Spring build file+src/main/java AND a FastAPI
// pyproject.toml must resolve deterministically rather than hitting runScan()'s "ambiguous adapter
// selection" hard error, which is what specificity 100 would cause. java-spring still wins that
// tie -- both adapters now declare codegen.handles:true (G4), so the actual reason is just "one of
// them has to win, and it must be the same one every time" -- not a functional gap on this side
// anymore, a real, documented trade-off (see DECISIONS.md), checkable via `bskel doctor`.
export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'python-fastapi',
	title: 'Python / FastAPI',
	specificity: 90,
	confidence: 'high',
	// D-adapter-verification-basis: verified against `fastapi/full-stack-fastapi-template`, the
	// official FastAPI-author-maintained reference stack -- the strongest verification tier this
	// project distinguishes (unlike java-spring's real-but-non-canonical production repo).
	verificationBasis: 'official-reference',
	capabilities: {
		// false: FastAPI generates operation ids at runtime (per-project, sometimes customized) --
		// never statically derivable from source. --openapi-file is the honest path forward; see
		// CAPABILITY_SATISFIERS in scanners/capabilities.mjs.
		'api.operations': false,
		// false: contracts/emit.mjs's detectRequestBody() is a Java-only regex -- declaring true
		// would be dishonest. Costs only `body:'unknown'` (WARN, waivable); the real request schema
		// still arrives via --openapi-file's existing, adapter-agnostic schema projection (A2).
		'api.request-shape': false,
		// true: table/idField ARE genuinely extracted and cross-checked against the real oracle's
		// own Alembic migration. `table` itself is no longer load-bearing for codegen (the Python
		// provider re-derives SQLModel's read path from idField + the class itself, not the table
		// name) -- idField and the entity's own GET route are what `handles plan`/`emit` actually
		// depend on now.
		'resource.fetch': true,
		// true (G4): handles/providers/python-fastapi/ is a real, executed-and-verified codegen
		// provider -- see D-handles-providers in DECISIONS.md for what it generates, what it always
		// stubs (check_access, patch_field), and what it deliberately excludes (recover(), migration).
		'codegen.handles': true,
	},
	detect: detectPythonFastApiRoot,
	scan(repoRoot, detection) {
		return scanPythonFastApi(repoRoot, detection);
	},
	// S2 (D-gate-precision, continued): same listPythonFiles() call scan() itself makes, via the
	// same detectPythonFastApiRoot() this adapter's own detect() already uses.
	listReadSet(repoRoot) {
		const projectRoot = detectPythonFastApiRoot(repoRoot);
		if (!projectRoot) return [];
		return listPythonFiles(projectRoot).map((f) => path.relative(repoRoot, f));
	},
	diagnostics(repoRoot) {
		const messages = [];
		const depFiles = listCandidateProjectFiles(repoRoot);
		if (depFiles.length === 0) {
			messages.push({ level: 'info', code: 'no-python-project-file', message: `none of ${PROJECT_FILE_GLOBS.join(', ')} found` });
		} else if (!depFiles.some((f) => {
			try { return FASTAPI_DEP_RE.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
		})) {
			messages.push({ level: 'info', code: 'fastapi-not-a-dependency', message: `found ${depFiles.length} Python project file(s), but none declare a fastapi dependency` });
		}
		let rgOk = true;
		try {
			execFileSync('rg', ['--version'], { stdio: 'pipe' });
		} catch {
			rgOk = false;
		}
		if (!rgOk) {
			messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter shells out to it and will throw, not degrade, if it is missing' });
		}
		// D-openapi-extraction-hint: unlike java-spring, this adapter's own capabilities already
		// declare `api.operations: false` (FastAPI assigns operationIds at runtime) -- --openapi-file
		// isn't just an accuracy improvement here, it's load-bearing for `contract emit` to adopt any
		// operation at all (see D-fastapi-adapter). FastAPI exposes its own OpenAPI schema directly
		// via `app.openapi()` -- no server needs to actually be listening, just importing the app
		// object is enough, the real mechanism this project's own oracle checks used.
		messages.push({
			level: 'info', code: 'openapi-extraction-hint',
			message: '--openapi-file is not just an accuracy improvement for this adapter -- api.operations is false (FastAPI assigns operationIds at runtime), so `contract emit` cannot adopt any operation without one. No server needs to be running: `python -c "from app.main import app; import json; print(json.dumps(app.openapi()))" > api-docs.json` (adjust the import path to your own app module). Ignore this if you already have a source document.',
		});
		return messages;
	},
};
