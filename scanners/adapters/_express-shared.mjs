// G6 (D-javascript-express-adapter): the primitives `typescript-express.mjs` (G5) and
// `javascript-express.mjs` (G6) genuinely share, extracted verbatim from the former when the
// latter was written -- same `_`-prefixed shared-helper convention `_java-spring-analyzer.mjs`
// already uses (scanners/registry.mjs skips `_`-prefixed files, so this file is never mistaken for
// an adapter), and the same "three adapters had privately duplicated it" reasoning that produced
// `scanners/text-util.mjs` under D-scanner-evidence.
//
// Deliberately NARROW: only the pieces that are byte-identical between the two adapters live here.
// Endpoint extraction, mount-edge building and prefix resolution are NOT shared -- they diverge
// materially (the TS adapter keys on a hardcoded `router` identifier and one node per FILE; the JS
// adapter binds the real declared variable name and needs one node per (file, variable) pair, see
// D-javascript-express-adapter). Parameterizing them into one function would have produced a worse
// abstraction than two clear implementations, the same "narrow, not general" call this codebase
// makes at every other cross-file resolution.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const EXCLUDE_GLOBS = ['!**/node_modules/**', '!**/dist/**', '!**/build/**'];
export const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

// A string literal in any of the three forms real Express route registration actually uses --
// found live in G5's own oracle: `router.use(\`/v1\`, v1)` uses a backtick TEMPLATE literal for a
// plain path with no interpolation, not a regular string.
export const STRING_LITERAL_RE = /^\s*["'`]([^"'`]*)["'`]/;

export function listRgFiles(dir, globs) {
	try {
		const out = execFileSync('rg', ['--files', ...globs.flatMap((g) => ['-g', g]), ...EXCLUDE_GLOBS.flatMap((g) => ['-g', g]), dir], { encoding: 'utf8' });
		return out.split('\n').filter(Boolean).sort(); // O6: rg --files order isn't guaranteed.
	} catch {
		return []; // rg exits 1 on "no files matched" -- not an error, just nothing to report
	}
}

// `rg -l -e <pattern> -g <glob>...` -- the "which source files even mention this" pass both
// adapters' detect() runs before doing any real reading.
export function rgFilesMatching(pattern, globs, dir) {
	try {
		return execFileSync('rg', [
			'-l', '-e', pattern,
			...globs.flatMap((g) => ['-g', g]), ...EXCLUDE_GLOBS.flatMap((g) => ['-g', g]),
			dir,
		], { encoding: 'utf8' }).split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

export function byShallowestThenName(a, b) {
	const depthA = a.split(path.sep).length;
	const depthB = b.split(path.sep).length;
	return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
}

export function listCandidatePackageFiles(repoRoot) {
	return listRgFiles(repoRoot, ['package.json']).sort(byShallowestThenName);
}

// Real JSON.parse, not a bounded regex -- package.json is always valid JSON, so unlike
// java-spring's build.gradle or python-fastapi's pyproject.toml (both need a "good-enough regex,
// not a real parser" compromise), there is no regex-vs-parser trade-off to make here at all.
export function readPackageJson(packageJsonPath) {
	try {
		return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	} catch {
		return null;
	}
}

export function declaresExpress(packageJsonPath) {
	const pkg = readPackageJson(packageJsonPath);
	return Boolean(pkg?.dependencies?.express || pkg?.devDependencies?.express);
}

// G6: the JavaScript/TypeScript counterpart of `_java-spring-analyzer.mjs`'s `maskNonCode()`
// (A2 Phase 1, D-java-analyzer), added for the same reason and against the same failure: a regex
// scanning raw source cannot tell code from prose about code. Found live, not anticipated -- the
// javascript-express fixture's own header comment contains the words `import { Router } from
// 'express'` (describing what the TS adapter looks for), and an unmasked
// `import\s+([^;]*?)\s*from\s*['"]express['"]` happily matched starting at the word "import"
// INSIDE that comment and ran across the newline into the real statement below it, yielding a
// nonsense import clause and silently collapsing the entire mount graph to empty prefixes.
// The same exposure lets a commented-out `// router.get('/old', oldHandler)` be reported as a
// live route by ANY of these regex adapters.
//
// Comments (line and block) are blanked to spaces ENTIRELY, markers included -- they must never
// look structurally like anything. String and template literals are left FULLY INTACT, unlike the
// Java masker which blanks string interiors: every path this adapter reports is read straight out
// of a string literal (`router.get('/:id', ...)`), so blanking interiors would destroy the values
// rather than protect them. Newlines are preserved and no character index shifts, so
// `lineNumberAt()` and every `matchBalancedParens()` offset stay valid against the masked text.
//
// Deliberately NOT handled: a regex literal containing an unescaped comment marker. `/` inside a
// regex literal must be escaped (`/\/\//`) or the literal ends there, so a regex body can never
// legally contain a bare `//` or `/*` for this scanner to trip over.
export function maskJsComments(text) {
	const out = text.split('');
	let i = 0;
	let quote = null; // "'" | '"' | '`' when inside a string/template literal
	while (i < text.length) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i += 2; continue; }
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; i++; continue; }
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			const stop = end === -1 ? text.length : end + 2;
			for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
			continue;
		}
		i++;
	}
	return out.join('');
}

// Walks forward from `openIndex` (text[openIndex] must be '(') tracking paren depth -- needed
// because a middleware array routinely nests its own parens/brackets, confirmed in G5's real
// oracle: `router.get('/:id([0-9]+)', [checkJwt, checkRole(['ADMINISTRATOR'], true)], show)`.
// Same technique python-fastapi.mjs's own matchBalancedParens already uses.
export function matchBalancedParens(text, openIndex) {
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

// Splits a balanced top-level argument list on commas, respecting nested (), [], {} -- needed to
// pull the LAST positional argument (the handler) out of `path, [middlewares], handler` without a
// naive split(',') breaking on the commas inside `[checkJwt, checkRole(...)]`.
export function splitTopLevelArgs(argsText) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < argsText.length; i++) {
		const ch = argsText[i];
		if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) depth--;
		else if (ch === ',' && depth === 0) {
			parts.push(argsText.slice(start, i));
			start = i + 1;
		}
	}
	const last = argsText.slice(start);
	if (last.trim() !== '') parts.push(last);
	return parts.map((p) => p.trim());
}

export function joinPath(base, segment) {
	const b = (base || '').replace(/\/$/, '');
	const s = (segment || '').replace(/^\//, '');
	return s ? `${b}/${s}` : (b || '/');
}

// Shared `diagnostics()` body for both Express adapters: whether any package.json was found at
// all, whether any declares express, and whether `rg` (which both adapters shell out to, and which
// they THROW on rather than degrade without) is actually on PATH.
export function expressDiagnostics(repoRoot) {
	const messages = [];
	const pkgFiles = listCandidatePackageFiles(repoRoot);
	if (pkgFiles.length === 0) {
		messages.push({ level: 'info', code: 'no-package-json', message: 'no package.json found' });
	} else if (!pkgFiles.some((f) => declaresExpress(f))) {
		messages.push({ level: 'info', code: 'express-not-a-dependency', message: `found ${pkgFiles.length} package.json file(s), but none declare an express dependency` });
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
	return messages;
}
