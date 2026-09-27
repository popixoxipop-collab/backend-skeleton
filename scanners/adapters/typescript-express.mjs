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

function routerDeclarations(text, name) {
	const out = [];
	const escapedName = escapeRegex(name);
	for (const factoryPattern of expressRouterFactoryPatterns(text)) {
		const declarationRe = new RegExp(
			'\\b(?:export\\s+)?(const|let|var)\\s+' + escapedName +
			'\\s*(?::\\s*[^=;\\n]+)?\\s*=\\s*' + factoryPattern + '\\s*\\(',
			'g',
		);
		for (const match of text.matchAll(declarationRe)) {
			out.push({ index: match.index, declarationKind: match[1] });
		}
	}
	return out.sort((x, y) => x.index - y.index);
}

function routerDeclarationPositions(text, name) {
	return routerDeclarations(text, name).map((declaration) => declaration.index);
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
const SCOPE_REGEX_PRECEDING_KEYWORD_RE = /\b(?:return|throw|typeof|case|in|of|new|delete|do|else|yield|await|void|instanceof)\s*$/;

function scopeRegexStarts(lastSignificant, recentText) {
	if (lastSignificant === null) return true;
	if (SCOPE_REGEX_PRECEDING_CHARS.has(lastSignificant)) return true;
	if (/=>\s*$/.test(recentText)) return true;
	if (lastSignificant === ')' && /\b(?:if|while|for|with|switch|catch)\s*\([\s\S]*\)\s*$/.test(recentText)) return true;
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
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 512), i))) {
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
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 512), i))) {
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
	let value = text.trim().replace(/^\.\.\.\s*/, '');
	value = value.replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '');
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

function readVariableDeclarationClause(text, startIndex, limitIndex = text.length) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let lastSignificant = null;
	for (let i = startIndex; i < limitIndex; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(startIndex, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > i) { i = next - 1; lastSignificant = '/'; continue; }
		}
		if (ch === '(') round++;
		else if (ch === ')') round = Math.max(0, round - 1);
		else if (ch === '[') square++;
		else if (ch === ']') square = Math.max(0, square - 1);
		else if (ch === '{') curly++;
		else if (ch === '}') curly = Math.max(0, curly - 1);
		else if (ch === ';' && round === 0 && square === 0 && curly === 0) return text.slice(startIndex, i);
		else if (ch === '\n' && round === 0 && square === 0 && curly === 0) {
			if (lastSignificant == null || !',=.?+-*/%&|^!:'.includes(lastSignificant)) return text.slice(startIndex, i);
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	return text.slice(startIndex, limitIndex);
}

function splitBindingDeclarators(text) {
	const parts = [];
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let lastSignificant = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > i) { i = next - 1; lastSignificant = '/'; continue; }
		}
		if (ch === '(') round++;
		else if (ch === ')') round = Math.max(0, round - 1);
		else if (ch === '[') square++;
		else if (ch === ']') square = Math.max(0, square - 1);
		else if (ch === '{') curly++;
		else if (ch === '}') curly = Math.max(0, curly - 1);
		else if (ch === ',' && round === 0 && square === 0 && curly === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
			lastSignificant = ',';
			continue;
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	const last = text.slice(start).trim();
	if (last) parts.push(last);
	return parts;
}

function variableClauseBindsName(clause, name) {
	return splitBindingDeclarators(clause).some((declarator) => {
		const pattern = leadingBindingPattern(declarator);
		return pattern ? bindingPatternBindsName(pattern, name) : false;
	});
}

function isCodePosition(text, targetIndex) {
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
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > targetIndex) return false;
			i = next;
			lastSignificant = '/';
			continue;
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
		i++;
	}
	return quote === null;
}
function scopeBodyDeclaresName(text, name) {
	const escaped = escapeRegex(name);
	for (const match of text.matchAll(new RegExp('\\b(?:function|class)\\s+' + escaped + '\\b', 'g'))) {
		if (isCodePosition(text, match.index)) return true;
	}
	for (const match of text.matchAll(/\b(?:const|let|var)\b/g)) {
		if (!isCodePosition(text, match.index)) continue;
		const clause = readVariableDeclarationClause(text, match.index + match[0].length);
		if (variableClauseBindsName(clause, name)) return true;
	}
	return false;
}

function matchingParenClose(text, openIndex) {
	let depth = 0;
	let quote = null;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function delimitersBalanced(text) {
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
		else if (ch === ')') { if (--round < 0) return false; }
		else if (ch === '[') square++;
		else if (ch === ']') { if (--square < 0) return false; }
		else if (ch === '{') curly++;
		else if (ch === '}') { if (--curly < 0) return false; }
	}
	return quote === null && round === 0 && square === 0 && curly === 0;
}
function parameterListBeforeBlock(text, blockOpenIndex) {
	let close = blockOpenIndex - 1;
	while (close >= 0 && /\s/.test(text[close])) close--;
	if (text[close] !== ')') {
		const candidateClose = text.lastIndexOf(')', blockOpenIndex - 1);
		if (candidateClose === -1) return null;
		// Reaching backward past the immediately preceding token is only valid for TS return-type
		// tails (`): Type {`) or parenthesized arrows (`) => {`). A bare child block must never
		// reuse an older function/call `)` and become a fake function scope.
		const tail = text.slice(candidateClose + 1, blockOpenIndex).trim();
		if (!tail || tail.includes(';') || !delimitersBalanced(tail) || (!tail.startsWith(':') && !tail.includes('=>'))) return null;
		close = candidateClose;
	}
	const searchStart = Math.max(0, close - 4096);
	for (let open = close; open >= searchStart; open--) {
		if (text[open] !== '(') continue;
		if (matchingParenClose(text, open) === close) return { open, close, params: text.slice(open + 1, close) };
	}
	return null;
}

function scopeHeaderShadowsName(text, openIndex, name) {
	const header = text.slice(Math.max(0, openIndex - 4096), openIndex).trimEnd();
	const escaped = escapeRegex(name);
	const singleArrow = new RegExp('(?:^|[^\\w$])(?:async\\s+)?' + escaped + '\\s*(?::[^=]+)?=>\\s*$');
	if (singleArrow.test(header)) return true;

	const list = parameterListBeforeBlock(text, openIndex);
	if (!list) return false;
	const before = text.slice(Math.max(0, list.open - 256), list.open).trimEnd();
	const leader = before.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? '';
	const namedFunction = before.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? null;
	if (namedFunction === name) return true;
	const tail = text.slice(list.close + 1, openIndex);
	const isArrow = /=>\s*$/.test(tail);
	if (['if', 'while', 'switch', 'with'].includes(leader) && !isArrow) return false;
	if (leader === 'for' && !isArrow) return scopeBodyDeclaresName(list.params, name);
	return splitTopLevelArgs(list.params).some((param) => parameterBindsName(param, name));
}

function matchingBraceClose(text, openIndex) {
	let depth = 0;
	let quote = null;
	let lastSignificant = null;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(0, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > i) { i = next - 1; lastSignificant = '/'; continue; }
		}
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	return -1;
}

function scopeIsFunctionLike(text, openIndex) {
	const header = text.slice(Math.max(0, openIndex - 4096), openIndex).trimEnd();
	if (/(?:^|[^\\w$])(?:async\s+)?[A-Za-z_$][\w$]*\s*(?::[^=]+)?=>\s*$/.test(header)) return true;
	const list = parameterListBeforeBlock(text, openIndex);
	if (!list) return false;
	const before = text.slice(Math.max(0, list.open - 256), list.open).trimEnd();
	const leader = before.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? '';
	const tail = text.slice(list.close + 1, openIndex);
	if (/=>\s*$/.test(tail)) return true;
	return !['if', 'while', 'switch', 'with', 'for', 'catch'].includes(leader);
}

function scopeDirectlyDeclaresName(text, openIndex, name) {
	const closeIndex = matchingBraceClose(text, openIndex);
	const scopeEnd = closeIndex === -1 ? text.length : closeIndex;
	const segmentStart = openIndex + 1;
	const segment = text.slice(segmentStart, scopeEnd);
	const directlyInside = (relativeIndex) => {
		const scopes = activeCodeScopeOpeningsAt(text, segmentStart + relativeIndex);
		return scopes[scopes.length - 1] === openIndex;
	};

	for (const match of segment.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)\b/g)) {
		if (!isCodePosition(segment, match.index)) continue;
		if (match[1] === name && directlyInside(match.index)) return true;
	}
	for (const match of segment.matchAll(/\b(?:const|let|var)\b/g)) {
		if (!isCodePosition(segment, match.index) || !directlyInside(match.index)) continue;
		const absoluteEnd = readVariableDeclarationClause(text, segmentStart + match.index + match[0].length, scopeEnd);
		if (variableClauseBindsName(absoluteEnd, name)) return true;
	}
	return false;
}

function nearestFunctionScopeOpenAt(text, index) {
	const openings = activeCodeScopeOpeningsAt(text, index);
	for (let i = openings.length - 1; i >= 0; i--) {
		if (scopeIsFunctionLike(text, openings[i])) return openings[i];
	}
	return null;
}

function functionScopeDeclaresVarName(text, functionOpenIndex, name) {
	const closeIndex = matchingBraceClose(text, functionOpenIndex);
	const scopeEnd = closeIndex === -1 ? text.length : closeIndex;
	const segmentStart = functionOpenIndex + 1;
	const segment = text.slice(segmentStart, scopeEnd);
	for (const match of segment.matchAll(/\bvar\b/g)) {
		if (!isCodePosition(segment, match.index)) continue;
		const absoluteIndex = segmentStart + match.index;
		if (nearestFunctionScopeOpenAt(text, absoluteIndex) !== functionOpenIndex) continue;
		const clause = readVariableDeclarationClause(text, absoluteIndex + match[0].length, scopeEnd);
		if (variableClauseBindsName(clause, name)) return true;
	}
	return false;
}

function delimiterDepthAt(text, targetIndex) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	for (let i = 0; i < targetIndex; i++) {
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
	}
	return { round, square, curly };
}

function arrowExpressionContainsTarget(text, arrowIndex, targetIndex) {
	const initial = delimiterDepthAt(text, arrowIndex);
	let round = initial.round;
	let square = initial.square;
	let curly = initial.curly;
	let quote = null;
	let sawBodyToken = false;
	let lastSignificant = null;
	for (let i = arrowIndex + 2; i < targetIndex; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; sawBodyToken = true; lastSignificant = ch; continue; }
		const atBase = round === initial.round && square === initial.square && curly === initial.curly;
		if ((ch === ',' || ch === ';') && atBase) return false;
		if (ch === '\n' && atBase && sawBodyToken) {
			let j = i + 1;
			while (j < targetIndex && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j++;
			const next = text[j] ?? '';
			const prevContinues = lastSignificant != null && '.?+-*/%&|^!=<>,:'.includes(lastSignificant);
			const nextContinues = next !== '' && '.?+-*/%&|^!=<>,:([`'.includes(next);
			if (!prevContinues && !nextContinues) return false;
		}
		if (ch === '(') round++;
		else if (ch === ')') { round--; if (round < initial.round) return false; }
		else if (ch === '[') square++;
		else if (ch === ']') { square--; if (square < initial.square) return false; }
		else if (ch === '{') curly++;
		else if (ch === '}') { curly--; if (curly < initial.curly) return false; }
		if (!/\s/.test(ch)) { sawBodyToken = true; lastSignificant = ch; }
	}
	return true;
}

function arrowParameterBindsName(text, arrowIndex, name) {
	let end = arrowIndex - 1;
	while (end >= 0 && /\s/.test(text[end])) end--;
	if (end < 0) return false;
	if (text[end] !== ')') {
		const ident = text.slice(Math.max(0, end - 256), end + 1).match(/(?:^|[^\\w$])([A-Za-z_$][\w$]*)\s*$/);
		return ident?.[1] === name;
	}
	const searchStart = Math.max(0, end - 4096);
	for (let open = end; open >= searchStart; open--) {
		if (text[open] !== '(') continue;
		if (matchingParenClose(text, open) !== end) continue;
		const params = text.slice(open + 1, end);
		return splitTopLevelArgs(params).some((param) => parameterBindsName(param, name));
	}
	return false;
}

function expressionArrowShadowsName(text, name, targetIndex) {
	const searchStart = Math.max(0, targetIndex - 8192);
	const prefix = text.slice(searchStart, targetIndex);
	for (const match of prefix.matchAll(/=>/g)) {
		const arrowIndex = searchStart + match.index;
		let bodyStart = arrowIndex + 2;
		while (bodyStart < targetIndex && /\s/.test(text[bodyStart])) bodyStart++;
		if (text[bodyStart] === '{') continue;
		if (!arrowExpressionContainsTarget(text, arrowIndex, targetIndex)) continue;
		if (arrowParameterBindsName(text, arrowIndex, name)) return true;
	}
	return false;
}

function topLevelReferenceIsAuthorized(text, name, targetIndex) {
	if (expressionArrowShadowsName(text, name, targetIndex)) return false;
	if (isTopLevelCodePosition(text, targetIndex)) return true;
	const activeScopes = activeCodeScopeOpeningsAt(text, targetIndex);
	for (const openIndex of activeScopes) {
		if (scopeHeaderShadowsName(text, openIndex, name)) return false;
		if (scopeDirectlyDeclaresName(text, openIndex, name)) return false;
	}
	for (const openIndex of activeScopes) {
		if (scopeIsFunctionLike(text, openIndex) && functionScopeDeclaresVarName(text, openIndex, name)) return false;
	}
	return true;
}
function routerBindingAt(text, name, targetIndex) {
	if (expressionArrowShadowsName(text, name, targetIndex)) return null;
	const callScopes = activeCodeScopeOpeningsAt(text, targetIndex);
	for (const openIndex of callScopes) {
		if (scopeHeaderShadowsName(text, openIndex, name)) return null;
	}

	let best = null;
	for (const declaration of routerDeclarations(text, name)) {
		const declarationIndex = declaration.index;
		if (declarationIndex >= targetIndex || !isCodePosition(text, declarationIndex)) continue;
		let declarationScopes = activeCodeScopeOpeningsAt(text, declarationIndex);
		if (declaration.declarationKind === 'var') {
			const functionOpen = nearestFunctionScopeOpenAt(text, declarationIndex);
			if (functionOpen === null) declarationScopes = [];
			else {
				const functionScopeIndex = declarationScopes.indexOf(functionOpen);
				if (functionScopeIndex !== -1) declarationScopes = declarationScopes.slice(0, functionScopeIndex + 1);
			}
		}
		if (declarationScopes.length > callScopes.length) continue;
		let sameChain = true;
		for (let i = 0; i < declarationScopes.length; i++) {
			if (declarationScopes[i] !== callScopes[i]) { sameChain = false; break; }
		}
		if (!sameChain) continue;
		if (!best || declarationScopes.length > best.depth ||
			(declarationScopes.length === best.depth && declarationIndex > best.index)) {
			best = { index: declarationIndex, depth: declarationScopes.length, declarationKind: declaration.declarationKind };
		}
	}
	if (!best) return null;

	for (let i = best.depth; i < callScopes.length; i++) {
		if (scopeHeaderShadowsName(text, callScopes[i], name)) return null;
		if (scopeDirectlyDeclaresName(text, callScopes[i], name)) return null;
	}
	return { kind: 'router', name, declarationIndex: best.index, declarationKind: best.declarationKind };
}

function routerReferenceIsAuthorized(text, name, targetIndex) {
	return routerBindingAt(text, name, targetIndex) !== null;
}

function applicationBindings(text) {
	const out = [];
	for (const expressBinding of expressDefaultBindings(text)) {
		const declarationRe = new RegExp(
			'\\b(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)' +
			'\\s*(?::\\s*[^=;\\n]+)?\\s*=\\s*' + escapeRegex(expressBinding) + '\\s*\\(\\s*\\)',
			'g',
		);
		for (const match of text.matchAll(declarationRe)) {
			if (isTopLevelCodePosition(text, match.index)) {
				out.push({ kind: 'application', name: match[1], declarationIndex: match.index });
			}
		}
	}
	return out.sort((x, y) => x.declarationIndex - y.declarationIndex);
}

function applicationVariables(text) {
	return [...new Set(applicationBindings(text).map((binding) => binding.name))].sort();
}

function routerBindings(text) {
	const out = [];
	for (const name of routerVariables(text)) {
		for (const declaration of routerDeclarations(text, name)) {
			out.push({ kind: 'router', name, declarationIndex: declaration.index, declarationKind: declaration.declarationKind });
		}
	}
	return out.sort((x, y) => x.declarationIndex - y.declarationIndex);
}

function routeReceiverBindings(text) {
	return [...routerBindings(text), ...applicationBindings(text)]
		.sort((x, y) => x.declarationIndex - y.declarationIndex || x.name.localeCompare(y.name));
}

function routeReceiverVariables(text) {
	return [...new Set(routeReceiverBindings(text).map((binding) => binding.name))].sort();
}

function receiverBindingAt(text, name, targetIndex) {
	const router = routerBindingAt(text, name, targetIndex);
	if (router) return router;
	const application = applicationBindings(text).find((binding) => binding.name === name);
	if (application && topLevelReferenceIsAuthorized(text, name, targetIndex)) return application;
	return null;
}

function sameReceiverBinding(left, right) {
	return Boolean(left && right && left.kind === right.kind && left.name === right.name &&
		left.declarationIndex === right.declarationIndex);
}

function nodeKey(file, binding) {
	return `${file}\0${binding.kind}\0${binding.name}\0${binding.declarationIndex}`;
}

function staticPathLiteral(expression) {
	const arg = expression?.trim() ?? '';
	const match = arg.match(STRING_LITERAL_RE);
	if (!match || match[0] !== arg) return null;
	if (arg.startsWith('`') && match[1].includes('${')) return null;
	return match[1];
}

function routerMemberCallRe(routerName, memberPattern, flags = 'g') {
	return new RegExp('(?<![\\w$\\.])' + routerName + '\\.(' + memberPattern + ')\\s*\\(', flags);
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

function extractEndpoints(text, binding) {
	const endpoints = [];
	const verbCallRe = routerMemberCallRe(binding.name, VERBS.join('|'), 'gi');
	for (const m of text.matchAll(verbCallRe)) {
		if (!isCodePosition(text, m.index)) continue;
		const activeBinding = receiverBindingAt(text, binding.name, m.index);
		if (!sameReceiverBinding(activeBinding, binding)) continue;
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
	return endpoints.sort((x, y) => x._offset - y._offset).map(({ _offset, ...endpoint }) => endpoint);
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
function defaultExportedReceiverBinding(text) {
	const match = text.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
	if (!match) return null;
	return receiverBindingAt(text, match[1], match.index);
}

function buildMountEdges(files, fileTexts) {
	const edges = [];
	const fileSet = new Set(files);
	for (const file of files) {
		const text = fileTexts.get(file);
		for (const receiverName of routeReceiverVariables(text)) {
			const useRe = routerMemberCallRe(receiverName, 'use');
			for (const m of text.matchAll(useRe)) {
				if (!isCodePosition(text, m.index)) continue;
				const fromBinding = receiverBindingAt(text, receiverName, m.index);
				if (!fromBinding) continue;
				const openIdx = m.index + m[0].length - 1;
				const closeIdx = matchBalancedParens(text, openIdx);
				if (closeIdx === -1) continue;
				const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
				if (args.length < 2) continue;
				const prefix = staticPathLiteral(args[0]);
				if (prefix === null) continue;

				for (const candidate of args.slice(1)) {
					const identMatch = candidate.trim().match(/^([A-Za-z_$][\w$]*)$/);
					if (!identMatch) continue;
					const target = identMatch[1];
					const localBinding = receiverBindingAt(text, target, m.index);
					if (localBinding) {
						edges.push({ from: nodeKey(file, fromBinding), to: nodeKey(file, localBinding), prefix });
						continue;
					}

					if (!topLevelReferenceIsAuthorized(text, target, m.index)) continue;
					const importRe = new RegExp('import\\s+' + escapeRegex(target) + '\\s+from\\s*["\\x27]([^"\\x27]+)["\\x27]');
					const importMatch = text.match(importRe);
					if (!importMatch) continue;
					const toFile = resolveRelativeImport(file, importMatch[1]);
					if (!toFile || !fileSet.has(toFile)) continue;
					const toBinding = defaultExportedReceiverBinding(fileTexts.get(toFile));
					if (!toBinding) continue;
					edges.push({ from: nodeKey(file, fromBinding), to: nodeKey(toFile, toBinding), prefix });
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
		const bindings = routeReceiverBindings(text);
		const nameCounts = new Map();
		for (const binding of bindings) nameCounts.set(binding.name, (nameCounts.get(binding.name) ?? 0) + 1);
		const moduleName = path.basename(file, '.ts');
		const moduleClassBase = `${moduleName.charAt(0).toUpperCase()}${moduleName.slice(1)}`;
		for (const binding of bindings) {
			const localEndpoints = extractEndpoints(text, binding);
			if (localEndpoints.length === 0) continue;
			const prefix = prefixChainFor(nodeKey(file, binding), edges);
			const endpoints = localEndpoints.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }));
			const receiverSuffix = `${binding.name.charAt(0).toUpperCase()}${binding.name.slice(1)}`;
			const duplicateSuffix = (nameCounts.get(binding.name) ?? 0) > 1
				? `L${lineNumberAt(text, binding.declarationIndex)}`
				: '';
			const className = bindings.length === 1
				? `${moduleClassBase}Router`
				: `${moduleClassBase}${receiverSuffix}${duplicateSuffix}Router`;
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
