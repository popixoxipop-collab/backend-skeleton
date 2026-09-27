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

const ENTITY_CLASS_RE = /@Entity\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)\s*\n?\s*export\s+class\s+(\w+)/g;

// Only identifiers locally assigned to Express Router() are trusted as route receivers.
// This removes the accidental literal-name dependency on `router` without accepting arbitrary
// objects that merely expose get()/use()-shaped methods.
function escapeRegex(value) {
	const specials = '\\^$.*+?()[]{}|';
	let out = '';
	for (const ch of value) out += specials.includes(ch) ? '\\' + ch : ch;
	return out;
}

function expressRouterFactoryPatterns(text) {
	const patterns = new Set();
	const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]express['"]/g;
	for (const match of text.matchAll(importRe)) {
		let hasRouterBinding = false;
		for (const raw of match[2].split(',')) {
			const binding = raw.trim().match(/^Router(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
			if (!binding) continue;
			hasRouterBinding = true;
			patterns.add('\\b' + escapeRegex(binding[1] ?? 'Router') + '\\b');
		}
		if (hasRouterBinding && match[1]) {
			patterns.add('\\b' + escapeRegex(match[1]) + '\\s*\\.\\s*Router\\b');
		}
	}
	return [...patterns];
}

function routerVariables(text) {
	const out = new Set();
	for (const factoryPattern of expressRouterFactoryPatterns(text)) {
		const declarationRe = new RegExp(
			'\\b(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)' +
			'\\s*(?::\\s*[^=;\\n]+)?\\s*=\\s*' + factoryPattern + '\\s*\\(',
			'g',
		);
		for (const match of text.matchAll(declarationRe)) out.add(match[1]);
	}
	return [...out].sort();
}

// T19 real-holdout finding: an Express application created with the module's actual default
// import is also a route receiver. Keep this separate from routerVariables(): detect() still
// requires the stronger named-Router + Router() signal, while scan() may additionally follow the
// already-detected project's application root (`const application = express()`). An arbitrary
// callable, or an unrelated object's .Router(), never becomes authoritative through this path.
function expressDefaultBindings(text) {
	const out = new Set();
	const importRe = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]express['"]/g;
	for (const match of text.matchAll(importRe)) out.add(match[1]);
	return [...out].sort();
}

const SCOPE_REGEX_PRECEDING_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
const SCOPE_REGEX_PRECEDING_KEYWORD_RE = /\b(?:return|typeof|case|in|of|new|delete|do|else|yield|await|void|instanceof)\s*$/;

function scopeRegexStarts(lastSignificant, recentText) {
	if (lastSignificant === null) return true;
	if (SCOPE_REGEX_PRECEDING_CHARS.has(lastSignificant)) return true;
	return SCOPE_REGEX_PRECEDING_KEYWORD_RE.test(recentText);
}

function skipScopeRegexLiteral(text, start) {
	let i = start + 1;
	let inClass = false;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\') { i += 2; continue; }
		if (ch === '\n') return i;
		if (inClass) {
			if (ch === ']') inClass = false;
			i++;
			continue;
		}
		if (ch === '[') { inClass = true; i++; continue; }
		if (ch === '/') {
			i++;
			while (/[A-Za-z]/.test(text[i] ?? '')) i++;
			return i;
		}
		i++;
	}
	return i;
}

// The Express default import is only authoritative in its module scope. A nested function/block
// may shadow that identifier, so application factories are accepted only at top level. Comments
// are already masked by the caller; this walk also skips strings/templates/regex literals so
// braces inside them cannot fabricate lexical depth.
function isTopLevelCodePosition(text, targetIndex) {
	let depth = 0;
	let quote = null;
	let lastSignificant = null;
	let i = 0;
	while (i < targetIndex) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i += 2; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			i++;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; i++; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 12), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > targetIndex) return false;
			i = next;
			lastSignificant = '/';
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') depth = Math.max(0, depth - 1);
		if (!/\s/.test(ch)) lastSignificant = ch;
		i++;
	}
	return quote === null && depth === 0;
}

// Returns the currently-active code-block opening braces at a call site. This mirrors the lexical
// skipping rules above but keeps the stack so application references inside a function can remain
// valid when they still resolve to the top-level Express binding.
function activeCodeScopeOpeningsAt(text, targetIndex) {
	const openings = [];
	let quote = null;
	let lastSignificant = null;
	let i = 0;
	while (i < targetIndex) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i += 2; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			i++;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; i++; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 12), i))) {
			i = skipScopeRegexLiteral(text, i);
			lastSignificant = '/';
			continue;
		}
		if (ch === '{') openings.push(i);
		else if (ch === '}') openings.pop();
		if (!/\s/.test(ch)) lastSignificant = ch;
		i++;
	}
	return openings;
}

function topLevelBindingSeparator(text, token) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '(') round++;
		else if (ch === ')') round = Math.max(0, round - 1);
		else if (ch === '[') square++;
		else if (ch === ']') square = Math.max(0, square - 1);
		else if (ch === '{') curly++;
		else if (ch === '}') curly = Math.max(0, curly - 1);
		else if (ch === token && round === 0 && square === 0 && curly === 0) return i;
	}
	return -1;
}

function leadingBindingPattern(text) {
	const value = text.trim().replace(/^\.\.\.\s*/, '');
	if (!value) return '';
	const ident = value.match(/^([A-Za-z_$][\w$]*)/);
	if (ident) return ident[1];
	const opener = value[0];
	if (opener !== '{' && opener !== '[') return '';
	const closer = opener === '{' ? '}' : ']';
	let depth = 0;
	let quote = null;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === opener) depth++;
		else if (ch === closer) {
			depth--;
			if (depth === 0) return value.slice(0, i + 1);
		}
	}
	return '';
}

function bindingPatternBindsName(pattern, name) {
	let value = pattern.trim().replace(/^\.\.\.\s*/, '');
	const assignment = topLevelBindingSeparator(value, '=');
	if (assignment !== -1) value = value.slice(0, assignment).trim();
	if (/^[A-Za-z_$][\w$]*$/.test(value)) return value === name;
	if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
		const inner = value.slice(1, -1);
		return splitTopLevelArgs(inner).some((entry) => {
			const item = entry.trim();
			if (!item) return false;
			const colon = topLevelBindingSeparator(item, ':');
			return bindingPatternBindsName(colon === -1 ? item : item.slice(colon + 1), name);
		});
	}
	return false;
}

function parameterBindsName(parameter, name) {
	const pattern = leadingBindingPattern(parameter);
	return pattern ? bindingPatternBindsName(pattern, name) : false;
}

function scopeBodyDeclaresName(text, name) {
	const escaped = escapeRegex(name);
	if (new RegExp('\\b(?:function|class)\\s+' + escaped + '\\b').test(text)) return true;
	if (new RegExp('\\b(?:const|let|var)\\s+' + escaped + '\\b').test(text)) return true;
	for (const match of text.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)) {
		for (const declarator of splitTopLevelArgs(match[1])) {
			const pattern = leadingBindingPattern(declarator);
			if ((pattern.startsWith('{') || pattern.startsWith('[')) && bindingPatternBindsName(pattern, name)) return true;
		}
	}
	return false;
}
function scopeHeaderShadowsName(text, openIndex, name) {
	const header = text.slice(Math.max(0, openIndex - 2048), openIndex).trimEnd();
	const escaped = escapeRegex(name);

	// Single-parameter arrow: `app => {`, `async app => {`, `app: App => {`.
	const singleArrow = new RegExp(`(?:^|[^\\w$])(?:async\\s+)?${escaped}\\s*(?::[^=]+)?=>\\s*$`);
	if (singleArrow.test(header)) return true;

	// Parenthesized function/method/arrow parameters immediately preceding this block.
	const paramsMatch = header.match(/\(([^()]*)\)\s*(?::[^{}=]+)?(?:=>)?\s*$/);
	if (!paramsMatch) return false;
	const params = paramsMatch[1];
	const before = header.slice(0, paramsMatch.index).trimEnd();
	const leader = before.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? '';
	const isArrow = /=>\s*$/.test(header);

	// Control-statement parens are not lexical parameter bindings. A for-loop declaration is.
	if (['if', 'while', 'switch', 'with'].includes(leader) && !isArrow) return false;
	if (leader === 'for' && !isArrow) return scopeBodyDeclaresName(params, name);
	return splitTopLevelArgs(params).some((param) => parameterBindsName(param, name));
}

// A top-level Express application may legitimately be configured inside another function (the
// T19 holdout does exactly this in Main()). Reject only active lexical scopes that introduce a
// same-named binding, rather than rejecting every nested call wholesale.
function applicationReferenceIsAuthorized(text, name, targetIndex) {
	if (isTopLevelCodePosition(text, targetIndex)) return true;
	for (const openIndex of activeCodeScopeOpeningsAt(text, targetIndex)) {
		if (scopeHeaderShadowsName(text, openIndex, name)) return false;
		if (scopeBodyDeclaresName(text.slice(openIndex + 1, targetIndex), name)) return false;
	}
	return true;
}

function applicationVariables(text) {
	const out = new Set();
	for (const expressBinding of expressDefaultBindings(text)) {
		const declarationRe = new RegExp(
			'\\b(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)' +
			'\\s*(?::\\s*[^=;\\n]+)?\\s*=\\s*' + escapeRegex(expressBinding) + '\\s*\\(\\s*\\)',
			'g',
		);
		for (const match of text.matchAll(declarationRe)) {
			if (isTopLevelCodePosition(text, match.index)) out.add(match[1]);
		}
	}
	return [...out].sort();
}

function routeReceiverVariables(text) {
	return [...new Set([...routerVariables(text), ...applicationVariables(text)])].sort();
}

function nodeKey(file, receiverName) {
	return `${file}\0${receiverName}`;
}

function staticPathLiteral(expression) {
	const arg = expression?.trim() ?? '';
	const match = arg.match(STRING_LITERAL_RE);
	if (!match || match[0] !== arg) return null;
	if (arg.startsWith('`') && match[1].includes('${')) return null;
	return match[1];
}

function routerMemberCallRe(routerName, memberPattern, flags = 'g') {
	return new RegExp('\\b' + routerName + '\\.(' + memberPattern + ')\\s*\\(', flags);
}

// D-gate-precision (Continued, part 3): a pure PATH-CONVENTION heuristic, mirroring java-spring's
// own identical solution to the identical problem (`.../presentation/dto/`) rather than inventing
// syntactic DTO detection this ecosystem doesn't have a reliable single marker for -- plain
// `interface`, `type` aliases, class-validator classes, Zod schemas, and undecorated classes are
// all real conventions, and this adapter's own `api.request-shape: false` capability already names
// why no such regex is attempted here. One entry per FILE under a `dto/` directory, not per
// exported symbol -- same file-level granularity java's own DTO tracking already settled for.
const DTO_DIR_SEGMENT = `${path.sep}dto${path.sep}`;

// D-module-attribution-base-package (Update): found by the same shadow-validation pass that fixed
// java-spring's own moduleOf() -- a real project not using a `dto/` folder at all (flat `CreateUserDto.ts` files, or
// NestJS's own common `create-user.dto.ts` naming) had every DTO silently invisible, the same class
// of single-convention overfit, just on a narrower surface (DTO tracking only, not module/entity/
// controller extraction). This does NOT reopen the CONTENT-detection problem the comment above
// explicitly rejected (interface/type/class-validator/Zod/undecorated class all have different
// shapes) -- it's an independent, NAME-only signal: the file's own basename ends in "dto"
// (case-insensitive), the same near-definitional marker this file's own entity-matching step below
// already leans on for MATCHING. Catches both `CreateUserDto.ts` and `create-user.dto.ts`.
const DTO_NAME_SUFFIX_RE = /dto$/i;

// Two independent signals required, mirroring java-spring's "build file AND src layout" /
// python-fastapi's "dependency declared AND source-confirmed" combined bar: (a) package.json
// declares express, (b) at least one .ts file actually imports Router from 'express' and calls
// Router(). Walks the whole repo for candidate package.json files (not just repoRoot) the same
// way python-fastapi does, for the same monorepo reason.
export function detectTypeScriptExpressRoot(repoRoot) {
	const pkgFile = listCandidatePackageFiles(repoRoot).find((f) => declaresExpress(f));
	if (!pkgFile) return null;

	const projectRoot = path.dirname(pkgFile);
	const sourceFiles = rgFilesMatching("import\\s+(?:[$\\w]+\\s*,\\s*)?\\{[^}]*\\bRouter\\b[^}]*\\}\\s*from\\s*['\"]express['\"]", ['*.ts'], projectRoot);
	if (sourceFiles.length === 0) return null;
	// G6: `\bRouter\s*\(`, not `\bRouter\s*\(\s*\)` -- `Router({ mergeParams: true })` is ordinary
	// Express, and requiring empty parens made this whole adapter fail to detect a repo whose
	// routers all pass options. A strict widening of the SECOND half of an already-conjunctive
	// signal (the first half still requires a named `Router` import from 'express'), and there is
	// no word boundary inside `makeRouter(`, so this cannot match an unrelated factory.
	const callsRouter = sourceFiles.some((f) => {
		try {
			return routerVariables(maskJsComments(fs.readFileSync(f, 'utf8'))).length > 0;
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
//
// D-typescript-express-inline-handlers: an inline function expression (`router.get('/x', async
// (req, res) => {...})`) is a DIFFERENT shape from a bare-identifier handler reference
// (`router.get('/x', show)`) -- confirmed live, dogfooding against a real, popular repo
// (gothinkster/node-express-realworld-example-app, 3,796 real GitHub stars): ALL 19 of its real
// route registrations use this inline form, and the bare-identifier-only gate this comment used to
// describe found ZERO of them (verdict: greenfield on a repo with a real, complete REST API).
// `method: null` (not a synthesized/guessed name) marks this case -- there is no export to
// correlate an inline handler to, and `handles/providers/typescript-express/plan.mjs`'s own
// `resolveHandlerFile()` already has a real, tested `null`-propagates-to-"resolver not generated"
// path for exactly this "handler correlates to nothing" case (see its own Update note in
// DECISIONS.md) -- this is NOT a new failure mode, just a new, real way to reach the existing one.
const INLINE_HANDLER_RE = /^(?:async\s+)?(?:\([^)]*\)|[$\w]+)\s*(?::[^=]*)?=>|^(?:async\s+)?function\b/;

function extractEndpoints(text, receiverNames, topLevelOnlyNames = new Set()) {
	const endpoints = [];
	for (const routerName of receiverNames) {
		const verbCallRe = routerMemberCallRe(routerName, VERBS.join('|'), 'gi');
		for (const m of text.matchAll(verbCallRe)) {
			// Application receivers are authorized from a top-level import binding. A nested scope
			// may redeclare the same identifier (for example configure(app: FakeApp)), so do not
			// let same-spelled nested calls inherit that authority. Router() behavior is unchanged.
			if (topLevelOnlyNames.has(routerName) && !applicationReferenceIsAuthorized(text, routerName, m.index)) continue;
			const verb = m[1].toUpperCase();
			const openIdx = m.index + m[0].length - 1;
			const closeIdx = matchBalancedParens(text, openIdx);
			if (closeIdx === -1) continue;
			const argsText = text.slice(openIdx + 1, closeIdx);
			const args = splitTopLevelArgs(argsText);
			const routePath = staticPathLiteral(args[0]);
			if (routePath === null) continue;

			const lastArg = args[args.length - 1]?.trim();
			const handlerMatch = lastArg?.match(/^(\w+)$/);
			const isInlineHandler = !handlerMatch && lastArg && INLINE_HANDLER_RE.test(lastArg);
			if (!handlerMatch && !isInlineHandler) continue;

			endpoints.push({
				verb, path: routePath, operationId: null,
				method: handlerMatch ? handlerMatch[1] : null,
				line: lineNumberAt(text, m.index), _offset: m.index,
			});
		}
	}
	return endpoints.sort((a, b) => a._offset - b._offset).map(({ _offset, ...endpoint }) => endpoint);
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

// Builds the route-receiver mount-tree: Router() receivers plus a trusted `express()` application
// root may contribute `.use('/literal', identifier)` edges. For Router() files, default-export
// hand-off remains the normal shape; every edge resolves `identifier` via THAT FILE'S OWN relative import only -- bare/
// baseUrl-relative specifiers (`'controllers/users'`) are deliberately not resolved here, only for
// router-to-router mounts, which the real oracle confirms are always relative (`import v1 from
// './v1/'`). A file with no incoming edge is a root. Bounded, not general: a computed/dynamic mount
// (`router.use(prefix, buildRouter())`) is skipped, never guessed at.
function defaultExportedReceiverName(text, receivers) {
	const match = text.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
	return match && receivers.has(match[1]) ? match[1] : null;
}

function buildMountEdges(files, fileTexts) {
	const edges = []; // { from: nodeKey, to: nodeKey, prefix }
	const fileSet = new Set(files);
	for (const file of files) {
		const text = fileTexts.get(file);
		const applicationReceivers = new Set(applicationVariables(text));
		const localReceivers = new Set([...routerVariables(text), ...applicationReceivers]);
		for (const receiver of localReceivers) {
			const useRe = routerMemberCallRe(receiver, 'use');
			for (const m of text.matchAll(useRe)) {
				// Same authority rule as endpoint extraction: a top-level Express application name
				// does not authorize a same-spelled parameter/local inside a nested scope.
				if (applicationReceivers.has(receiver) && !applicationReferenceIsAuthorized(text, receiver, m.index)) continue;
				const openIdx = m.index + m[0].length - 1;
				const closeIdx = matchBalancedParens(text, openIdx);
				if (closeIdx === -1) continue;
				const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
				if (args.length < 2) continue;
				const prefix = staticPathLiteral(args[0]);
				if (prefix === null) continue;

				// Express accepts middleware before/after a mounted router:
				// app.use('/api', authenticate, userRouter). Treat every argument after the path as a
				// candidate, but only a proven local receiver or default-imported exported receiver
				// becomes a graph edge; ordinary middleware naturally resolves to nothing.
				for (const candidate of args.slice(1)) {
					const identMatch = candidate.trim().match(/^([A-Za-z_$][\w$]*)$/);
					if (!identMatch) continue;
					const target = identMatch[1];

					if (localReceivers.has(target)) {
						edges.push({ from: nodeKey(file, receiver), to: nodeKey(file, target), prefix });
						continue;
					}

					const importRe = new RegExp('import\\s+' + escapeRegex(target) + '\\s+from\\s*["\\x27]([^"\\x27]+)["\\x27]');
					const importMatch = text.match(importRe);
					if (!importMatch) continue;
					const toFile = resolveRelativeImport(file, importMatch[1]);
					if (!toFile || !fileSet.has(toFile)) continue;
					const toText = fileTexts.get(toFile);
					const toReceivers = new Set(routeReceiverVariables(toText));
					const toReceiver = defaultExportedReceiverName(toText, toReceivers);
					if (!toReceiver) continue;

					edges.push({ from: nodeKey(file, receiver), to: nodeKey(toFile, toReceiver), prefix });
				}
			}
		}
	}
	return edges;
}

// Prefixes belong to receiver nodes, not whole files: one file may contain both an application
// root and a Router mounted beneath it. Cycles are bounded rather than recursively guessed through.
function prefixChainFor(node, edges, seen = new Set()) {
	if (seen.has(node)) return '';
	seen.add(node);
	const incoming = edges.find((e) => e.to === node);
	if (!incoming) return '';
	return joinPath(prefixChainFor(incoming.from, edges, seen), incoming.prefix);
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
			// D-cross-feature-collision: m[1] is ENTITY_CLASS_RE's own captured explicit
			// `@Entity('table_name')` literal argument -- already extracted above, just never
			// separately flagged as the confidence signal it actually is (vs. the lowercased-
			// classname fallback on the same line, which is a guess TypeORM's own real default-
			// naming convention happens to often match, but not always).
			tableSource: m[1] ? 'explicit' : 'inferred',
			idField: idMatch ? idMatch[2] : null,
			idFieldIsUuid: idMatch ? /['"]uuid['"]/.test(idMatch[1]) : false,
			file,
			line: lineNumberAt(text, m.index),
		});
	}
	return entities;
}

const API_SURFACE_SOURCE = 'route paths are resolved by walking a receiver-aware Express mount-tree (.use(\'/literal\', ' +
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
	const allDtos = [];
	for (const file of files) {
		const text = fileTexts.get(file);
		// G6: `\bRouter\s*\(` -- see detectTypeScriptExpressRoot above. Same widening for the same
		// reason: a router declared as `Router({ mergeParams: true })` is ordinary Express, and
		// this per-file gate previously skipped its whole file.
		const applicationReceivers = new Set(applicationVariables(text));
		const receivers = [...new Set([...routerVariables(text), ...applicationReceivers])].sort();
		const moduleName = path.basename(file, '.ts');
		const moduleClassBase = `${moduleName.charAt(0).toUpperCase()}${moduleName.slice(1)}`;
		for (const receiver of receivers) {
			const localEndpoints = extractEndpoints(text, [receiver], applicationReceivers);
			if (localEndpoints.length === 0) continue;
			const prefix = prefixChainFor(nodeKey(file, receiver), edges);
			const endpoints = localEndpoints.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }));
			const receiverSuffix = `${receiver.charAt(0).toUpperCase()}${receiver.slice(1)}`;
			const className = receivers.length === 1
				? `${moduleClassBase}Router`
				: `${moduleClassBase}${receiverSuffix}Router`;
			moduleEntry(moduleName).controllers.push({ className, basePath: prefix, operationIds: [], endpoints, file });
		}
		if (file.includes(DTO_DIR_SEGMENT) || DTO_NAME_SUFFIX_RE.test(path.basename(file, '.ts'))) {
			allDtos.push({ className: path.basename(file, '.ts'), file }); // no `line` -- path/name-based, no content parsed
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

	// DTO -> module assignment: same narrow name-match as entities, with a trailing literal
	// `Dto`/`DTO` stripped first -- the one near-definitional, cross-project-safe TS DTO marker (a
	// DTO's own name almost universally contains it). An action-prefixed name (`CreateUserDto.ts`,
	// a common real-world shape) still will NOT exact-match after stripping ("createuser" !=
	// "user"/"users") and lands in `_dtos` -- honestly uncovered rather than guessed at (see
	// D-gate-precision "Continued (part 3)" in DECISIONS.md).
	for (const dto of allDtos) {
		const lower = dto.className.replace(/Dto$/i, '').toLowerCase();
		const candidates = new Set([lower, `${lower}s`]);
		const targetModule = [...modules.keys()].find((name) => candidates.has(name));
		moduleEntry(targetModule ?? '_dtos').dtos.push(dto);
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
