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
		if (!isCodePosition(text, match.index)) continue;
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

function splitBindingDeclaratorsWithOffsets(text) {
	const parts = [];
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let lastSignificant = null;
	let start = 0;
	const pushPart = (end) => {
		const raw = text.slice(start, end);
		const leading = raw.search(/\S/);
		if (leading !== -1) parts.push({ text: raw.trim(), offset: start + leading });
	};
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
			pushPart(i);
			start = i + 1;
			lastSignificant = ',';
			continue;
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	pushPart(text.length);
	return parts;
}

function routerDeclarationsAll(text) {
	const out = [];
	const factoryPatterns = expressRouterFactoryPatterns(text);
	for (const declaration of text.matchAll(/\b((?:await\s+)?using|const|let|var)\b/g)) {
		if (!isCodePosition(text, declaration.index)) continue;
		const clauseStart = declaration.index + declaration[0].length;
		const clause = readVariableDeclarationClause(text, clauseStart);
		for (const part of splitBindingDeclaratorsWithOffsets(clause)) {
			const assignment = topLevelBindingSeparator(part.text, '=');
			if (assignment === -1) continue;
			const lhs = part.text.slice(0, assignment).trim();
			const rhs = part.text.slice(assignment + 1).trim();
			const nameMatch = lhs.match(/^([A-Za-z_$][\w$]*)\s*(?::[\s\S]*)?$/);
			if (!nameMatch) continue;
			const isRouterFactory = factoryPatterns.some((pattern) =>
				new RegExp('^(?:' + pattern + ')\\s*\\(').test(rhs));
			if (!isRouterFactory) continue;
			out.push({
				name: nameMatch[1],
				index: clauseStart + part.offset,
				declarationKind: declaration[1],
			});
		}
	}
	return out.sort((x, y) => x.index - y.index);
}

function routerVariables(text) {
	return [...new Set(routerDeclarationsAll(text).map((declaration) => declaration.name))].sort();
}

function routerDeclarations(text, name) {
	return routerDeclarationsAll(text).filter((declaration) => declaration.name === name);
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
	const directImportRe = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]express['"]/g;
	for (const match of text.matchAll(directImportRe)) {
		if (isCodePosition(text, match.index)) out.add(match[1]);
	}
	// ESM also permits the default binding inside a named specifier list:
	// `import { default as express, Router } from 'express'`.
	const namedImportRe = /import\s*\{([^}]*)\}\s*from\s*['"]express['"]/g;
	for (const match of text.matchAll(namedImportRe)) {
		if (!isCodePosition(text, match.index)) continue;
		for (const raw of match[1].split(',')) {
			const binding = raw.trim().match(/^default\s+as\s+([A-Za-z_$][\w$]*)$/);
			if (binding) out.add(binding[1]);
		}
	}
	return [...out].sort();
}

const SCOPE_REGEX_PRECEDING_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';']);
const SCOPE_REGEX_PRECEDING_KEYWORD_RE = /\b(?:return|throw|typeof|case|in|of|new|delete|do|else|yield|await|void|instanceof)\s*$/;

function matchingOpenParenForClose(text, closeIndex) {
	const searchStart = Math.max(0, closeIndex - 4096);
	for (let open = closeIndex; open >= searchStart; open--) {
		if (text[open] !== '(') continue;
		if (matchingParenClose(text, open) === closeIndex) return open;
	}
	return -1;
}

function controlHeaderEndsAtRecentText(recentText) {
	let close = recentText.length - 1;
	while (close >= 0 && /\s/.test(recentText[close])) close--;
	if (close < 0 || recentText[close] !== ')') return false;
	const open = matchingOpenParenForClose(recentText, close);
	if (open === -1) return false;
	const before = recentText.slice(Math.max(0, open - 128), open).trimEnd();
	return /\b(?:if|while|for|with|switch|catch)\s*$/.test(before);
}

function statementBlockEndsAtRecentText(recentText) {
	let close = recentText.length - 1;
	while (close >= 0 && /\s/.test(recentText[close])) close--;
	if (close < 0 || recentText[close] !== '}') return false;
	const searchStart = Math.max(0, close - 8192);
	let open = -1;
	for (let candidate = close; candidate >= searchStart; candidate--) {
		if (recentText[candidate] !== '{') continue;
		if (matchingBraceClose(recentText, candidate) === close) { open = candidate; break; }
	}
	if (open === -1) return false;
	if (parameterListBeforeBlock(recentText, open)) return true;
	const before = recentText.slice(0, open).trimEnd();
	if (/\b(?:else|do|try|finally)\s*$/.test(before)) return true;
	if (/=>\s*$/.test(before)) return true;
	if (/\b(?:class|namespace|enum)\b[^{}]*$/.test(before)) return true;
	return before === '' || /[;{}]\s*$/.test(before);
}

function scopeRegexStarts(lastSignificant, recentText) {
	if (lastSignificant === null) return true;
	if (SCOPE_REGEX_PRECEDING_CHARS.has(lastSignificant)) return true;
	if (/=>\s*$/.test(recentText)) return true;
	if (lastSignificant === ')' && controlHeaderEndsAtRecentText(recentText)) return true;
	if (lastSignificant === '}' && statementBlockEndsAtRecentText(recentText)) return true;
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

function stripLeadingParameterDecorators(text) {
	let value = text.trimStart();
	while (value.startsWith('@')) {
		let i = 1;
		const name = value.slice(i).match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
		if (!name) break;
		i += name[1].length;
		while (/\s/.test(value[i] ?? '')) i++;
		if (value[i] === '<') {
			let depth = 0;
			let quote = null;
			for (; i < value.length; i++) {
				const ch = value[i];
				if (quote) {
					if (ch === '\\') { i++; continue; }
					if (ch === quote) quote = null;
					continue;
				}
				if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
				if (ch === '<') depth++;
				else if (ch === '>' && --depth === 0) { i++; break; }
			}
			while (/\s/.test(value[i] ?? '')) i++;
		}
		if (value[i] === '(') {
			const close = matchingParenClose(value, i);
			if (close === -1) break;
			i = close + 1;
		}
		value = value.slice(i).trimStart();
	}
	return value;
}
function leadingBindingPattern(text) {
	let value = stripLeadingParameterDecorators(text);
	value = value.replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '');
	value = value.replace(/^\.\.\.\s*/, '');
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
			let nextIndex = i + 1;
			while (nextIndex < limitIndex && /[\t\r ]/.test(text[nextIndex])) nextIndex++;
			const nextSignificant = text[nextIndex] ?? '';
			const continuesFromPrevious = lastSignificant != null && ',=.?+-*/%&|^!:'.includes(lastSignificant);
			// Semicolonless declarations may continue from the NEXT line too, especially member,
			// call and index chains after an initializer.
			const continuesFromNext = ['.', '[', '(', '?'].includes(nextSignificant);
			if (!continuesFromPrevious && !continuesFromNext) return text.slice(startIndex, i);
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
	for (const match of text.matchAll(/\b(?:(?:await\s+)?using|const|let|var)\b/g)) {
		if (!isCodePosition(text, match.index)) continue;
		const clause = readVariableDeclarationClause(text, match.index + match[0].length);
		if (variableClauseBindsName(clause, name)) return true;
	}
	return false;
}

function matchingParenClose(text, openIndex) {
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
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
		if (!/\s/.test(ch)) lastSignificant = ch;
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
	let namedClass = null;
	for (const match of header.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
		if (!isCodePosition(header, match.index)) continue;
		if (/^[^{}]*$/.test(header.slice(match.index + match[0].length))) namedClass = match[1];
	}
	if (namedClass === name) return true;

	const list = parameterListBeforeBlock(text, openIndex);
	if (!list) return false;
	const before = text.slice(Math.max(0, list.open - 256), list.open).trimEnd();
	const leader = before.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? '';
	const functionHeader = stripTrailingTypeParameters(before);
	const namedFunction = functionHeader.match(/\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? null;
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

function skipStatementWhitespace(text, index) {
	let i = index;
	while (i < text.length && /\s/.test(text[i])) i++;
	return i;
}

function singleStatementEnd(text, startIndex) {
	const start = skipStatementWhitespace(text, startIndex);
	if (text[start] === '{') {
		const close = matchingBraceClose(text, start);
		return close === -1 ? text.length : close + 1;
	}

	if (/^if\b/.test(text.slice(start))) {
		let open = start + 2;
		while (open < text.length && /\s/.test(text[open])) open++;
		if (text[open] === '(') {
			const close = matchingParenClose(text, open);
			if (close !== -1) {
				const consequentStart = skipStatementWhitespace(text, close + 1);
				const consequentEnd = singleStatementEnd(text, consequentStart);
				let next = skipStatementWhitespace(text, consequentEnd);
				if (/^else\b/.test(text.slice(next))) {
					next = skipStatementWhitespace(text, next + 4);
					return singleStatementEnd(text, next);
				}
				return consequentEnd;
			}
		}
	}

	if (/^do\b/.test(text.slice(start))) {
		const bodyStart = skipStatementWhitespace(text, start + 2);
		const bodyEnd = singleStatementEnd(text, bodyStart);
		let next = skipStatementWhitespace(text, bodyEnd);
		if (/^while\b/.test(text.slice(next))) {
			next = skipStatementWhitespace(text, next + 5);
			if (text[next] === '(') {
				const close = matchingParenClose(text, next);
				if (close !== -1) {
					let end = skipStatementWhitespace(text, close + 1);
					if (text[end] === ';') end++;
					return end;
				}
			}
		}
		return bodyEnd;
	}

	if (/^try\b/.test(text.slice(start))) {
		let bodyStart = skipStatementWhitespace(text, start + 3);
		if (text[bodyStart] === '{') {
			let close = matchingBraceClose(text, bodyStart);
			if (close !== -1) {
				let end = close + 1;
				let next = skipStatementWhitespace(text, end);
				if (/^catch\b/.test(text.slice(next))) {
					next = skipStatementWhitespace(text, next + 5);
					if (text[next] === '(') {
						const catchClose = matchingParenClose(text, next);
						if (catchClose === -1) return text.length;
						next = skipStatementWhitespace(text, catchClose + 1);
					}
					if (text[next] !== '{') return text.length;
					close = matchingBraceClose(text, next);
					if (close === -1) return text.length;
					end = close + 1;
					next = skipStatementWhitespace(text, end);
				}
				if (/^finally\b/.test(text.slice(next))) {
					next = skipStatementWhitespace(text, next + 7);
					if (text[next] !== '{') return text.length;
					close = matchingBraceClose(text, next);
					if (close === -1) return text.length;
					end = close + 1;
				}
				return end;
			}
		}
	}

	const headerStatement = text.slice(start).match(/^(?:switch|while|with|for(?:\s+await)?)\b/);
	if (headerStatement) {
		let open = start + headerStatement[0].length;
		while (open < text.length && /\s/.test(text[open])) open++;
		if (text[open] === '(') {
			const close = matchingParenClose(text, open);
			if (close !== -1) {
				const bodyStart = skipStatementWhitespace(text, close + 1);
				return singleStatementEnd(text, bodyStart);
			}
		}
	}

	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let lastSignificant = null;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = null; lastSignificant = ch; }
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(start, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > i) { i = next - 1; lastSignificant = '/'; continue; }
		}
		if (ch === '(') round++;
		else if (ch === ')') round = Math.max(0, round - 1);
		else if (ch === '[') square++;
		else if (ch === ']') square = Math.max(0, square - 1);
		else if (ch === '{') curly++;
		else if (ch === '}') { if (curly > 0) curly--; else return i; }
		else if (ch === ';' && round === 0 && square === 0 && curly === 0) return i + 1;
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	return text.length;
}

function activeForHeaderBindingAt(text, name, targetIndex) {
	const forRe = /\bfor(?:\s+await)?\s*\(/g;
	let best = null;
	for (const match of text.matchAll(forRe)) {
		if (match.index >= targetIndex || !isCodePosition(text, match.index)) continue;
		const openIndex = text.indexOf('(', match.index);
		const closeIndex = matchingParenClose(text, openIndex);
		if (closeIndex === -1) continue;
		const header = text.slice(openIndex + 1, closeIndex);
		for (const declaration of header.matchAll(/\b((?:await\s+)?using|const|let|var)\b/g)) {
			if (!isCodePosition(header, declaration.index)) continue;
			const clause = readVariableDeclarationClause(header, declaration.index + declaration[0].length, header.length);
			if (!variableClauseBindsName(clause, name)) continue;
			const declarationIndex = openIndex + 1 + declaration.index;
			let bodyStart = closeIndex + 1;
			while (bodyStart < text.length && /\s/.test(text[bodyStart])) bodyStart++;
			let bodyEnd;
			let bodyOpen = null;
			if (text[bodyStart] === '{') {
				bodyOpen = bodyStart;
				bodyEnd = matchingBraceClose(text, bodyStart);
				if (bodyEnd === -1) bodyEnd = text.length;
			} else {
				bodyEnd = singleStatementEnd(text, bodyStart);
			}
			const inHeader = targetIndex > declarationIndex && targetIndex < closeIndex;
			const inBody = targetIndex >= bodyStart && targetIndex < bodyEnd;
			if (!inHeader && !inBody) continue;
			const candidate = {
				declarationKind: declaration[1], declarationIndex, openIndex, closeIndex,
				bodyStart, bodyEnd, bodyOpen,
			};
			if (!best || candidate.openIndex > best.openIndex) best = candidate;
		}
	}
	return best;
}
function isInsideForHeader(text, targetIndex) {
	for (const openIndex of activeParenOpeningsAt(text, targetIndex).reverse()) {
		const closeIndex = matchingParenClose(text, openIndex);
		if (closeIndex === -1 || closeIndex < targetIndex) continue;
		const before = text.slice(Math.max(0, openIndex - 128), openIndex).trimEnd();
		if (/\bfor(?:\s+await)?\s*$/.test(before)) return true;
	}
	return false;
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
	for (const match of segment.matchAll(/\b((?:await\s+)?using|const|let|var)\b/g)) {
		if (!isCodePosition(segment, match.index) || !directlyInside(match.index)) continue;
		const absoluteIndex = segmentStart + match.index;
		if (match[1] !== 'var' && isInsideForHeader(text, absoluteIndex)) continue;
		const absoluteEnd = readVariableDeclarationClause(text, absoluteIndex + match[0].length, scopeEnd);
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
		if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(arrowIndex + 2, i - 512), i))) {
			const next = skipScopeRegexLiteral(text, i);
			if (next > i) { i = next - 1; sawBodyToken = true; lastSignificant = '/'; continue; }
		}
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

function activeParenOpeningsAt(text, targetIndex) {
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
		if (ch === '(') openings.push(i);
		else if (ch === ')') openings.pop();
		if (!/\s/.test(ch)) lastSignificant = ch;
		i++;
	}
	return openings;
}

function stripTrailingTypeParameters(text) {
	let value = text.trimEnd();
	if (!value.endsWith('>')) return value;
	let depth = 0;
	let quote = null;
	for (let i = value.length - 1; i >= 0; i--) {
		const ch = value[i];
		if (quote) {
			if (ch === quote && value[i - 1] !== '\\') quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '>') depth++;
		else if (ch === '<') {
			depth--;
			if (depth === 0) return value.slice(0, i).trimEnd();
		}
	}
	return value;
}
function parameterScopeShadowsNameAt(text, name, targetIndex) {
	for (const openIndex of activeParenOpeningsAt(text, targetIndex).reverse()) {
		const closeIndex = matchingParenClose(text, openIndex);
		if (closeIndex === -1 || closeIndex < targetIndex) continue;
		const before = text.slice(Math.max(0, openIndex - 512), openIndex).trimEnd();
		const after = text.slice(closeIndex + 1, Math.min(text.length, closeIndex + 1024));
		const functionHeader = stripTrailingTypeParameters(before);
		const namedFunction = functionHeader.match(/\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? null;
		if (namedFunction === name) return true;
		const isFunction = /\bfunction\s*\*?(?:\s+[A-Za-z_$][\w$]*)?\s*$/.test(functionHeader);
		const isConstructor = /\bconstructor\s*$/.test(before);
		const isArrow = /^\s*(?::[\s\S]*?)?=>/.test(after);
		// Class/object methods also create a parameter environment before their body opens.
		// Requiring a following body brace avoids treating ordinary call expressions as methods.
		const methodHeader = stripTrailingTypeParameters(before);
		const methodName = /(?:^|[^\w$])(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*$/.test(methodHeader);
		const computedMethod = /\]\s*$/.test(methodHeader);
		const literalMethod = /(?:^|[^\w$])(?:async\s+)?(?:get\s+|set\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|0[xX][0-9A-Fa-f_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*n|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?)\s*$/.test(methodHeader);
		const hasMethodBody = /^\s*(?::[\s\S]*?)?\{/.test(after);
		// A control header such as `for (app of xs) {` is not a method parameter list.
		// Treating it as one hides assignment targets from the application write tracker.
		const isControlHeader = /\b(?:if|for|while|switch|with)\s*$/.test(methodHeader);
		const isMethod = !isControlHeader && (methodName || computedMethod || literalMethod) && hasMethodBody;
		if (!isFunction && !isConstructor && !isArrow && !isMethod) continue;
		const params = text.slice(openIndex + 1, closeIndex);
		if (splitTopLevelArgs(params).some((param) => parameterBindsName(param, name))) return true;
	}
	return false;
}
function classHeritageShadowsNameAt(text, name, targetIndex) {
	const classRe = new RegExp('\\bclass\\s+' + escapeRegex(name) + '\\s+extends\\b', 'g');
	for (const match of text.matchAll(classRe)) {
		if (match.index >= targetIndex || !isCodePosition(text, match.index)) continue;
		let round = 0;
		let square = 0;
		let quote = null;
		let lastSignificant = null;
		let bodyOpened = false;
		for (let i = match.index + match[0].length; i < targetIndex; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === '\\') { i++; continue; }
				if (ch === quote) { quote = null; lastSignificant = ch; }
				continue;
			}
			if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
			if (ch === '/' && scopeRegexStarts(lastSignificant, text.slice(Math.max(match.index, i - 512), i))) {
				const next = skipScopeRegexLiteral(text, i);
				if (next > i) { i = next - 1; lastSignificant = '/'; continue; }
			}
			if (ch === '(') round++;
			else if (ch === ')') round = Math.max(0, round - 1);
			else if (ch === '[') square++;
			else if (ch === ']') square = Math.max(0, square - 1);
			else if (ch === '{' && round === 0 && square === 0) { bodyOpened = true; break; }
			if (!/\s/.test(ch)) lastSignificant = ch;
		}
		if (!bodyOpened) return true;
	}
	return false;
}
function topLevelReferenceIsAuthorized(text, name, targetIndex) {
	if (!isCodePosition(text, targetIndex)) return false;
	if (classHeritageShadowsNameAt(text, name, targetIndex)) return false;
	if (parameterScopeShadowsNameAt(text, name, targetIndex)) return false;
	if (expressionArrowShadowsName(text, name, targetIndex)) return false;
	if (activeForHeaderBindingAt(text, name, targetIndex)) return false;
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
	if (!isCodePosition(text, targetIndex)) return null;
	if (classHeritageShadowsNameAt(text, name, targetIndex)) return null;
	if (parameterScopeShadowsNameAt(text, name, targetIndex)) return null;
	if (expressionArrowShadowsName(text, name, targetIndex)) return null;
	const forBinding = activeForHeaderBindingAt(text, name, targetIndex);
	if (forBinding) {
		const declaration = routerDeclarations(text, name).find((item) =>
			item.index >= forBinding.declarationIndex && item.index < forBinding.closeIndex);
		if (!declaration) return null;
		const callScopes = activeCodeScopeOpeningsAt(text, targetIndex);
		let protectedDepth = callScopes.length;
		if (forBinding.bodyOpen !== null) {
			const bodyScopeIndex = callScopes.indexOf(forBinding.bodyOpen);
			if (bodyScopeIndex !== -1) protectedDepth = bodyScopeIndex + 1;
		}
		for (let i = protectedDepth; i < callScopes.length; i++) {
			if (scopeHeaderShadowsName(text, callScopes[i], name)) return null;
			if (scopeDirectlyDeclaresName(text, callScopes[i], name)) return null;
		}
		return { kind: 'router', name, declarationIndex: declaration.index, declarationKind: declaration.declarationKind };
	}
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

function isBoundedTypeExpression(text) {
	const value = text.trim();
	if (!value || !/[A-Za-z_$0-9'"\`[{(]/.test(value)) return false;
	if (!delimitersBalanced(value)) return false;
	// Conservative assertion-type recognizer: balanced TypeScript type punctuation is allowed,
	// but top-level runtime operators prove the assertion ended before the remaining expression.
	let angle = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let sawTopLevelExtends = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '\`') { quote = ch; continue; }
		if (ch === '(') { round++; continue; }
		if (ch === ')') { round--; continue; }
		if (ch === '[') { square++; continue; }
		if (ch === ']') { square--; continue; }
		if (ch === '{') { curly++; continue; }
		if (ch === '}') { curly--; continue; }
		if (round !== 0 || square !== 0 || curly !== 0) continue;
		if (ch === '<') { angle++; continue; }
		if (ch === '>' && value[i - 1] !== '=') {
			if (angle === 0) return false;
			angle--;
			continue;
		}
		if (angle !== 0) continue;
		if (/^extends\b/.test(value.slice(i))) { sawTopLevelExtends = true; i += 'extends'.length - 1; continue; }
		if (/^(?:instanceof|in)\b/.test(value.slice(i))) return false;
		if (value.startsWith('&&', i) || value.startsWith('||', i) || value.startsWith('??', i) ||
			value.startsWith('===', i) || value.startsWith('!==', i) || value.startsWith('==', i) || value.startsWith('!=', i) ||
			value.startsWith('<=', i) || value.startsWith('>=', i)) return false;
		if (ch === ',' || ch === '+' || ch === '*' || ch === '/' || ch === '%' || ch === '^' || ch === '~') return false;
		if (ch === '=' && value[i + 1] !== '>') return false;
		if (ch === '?' && !sawTopLevelExtends) return false;
		if (ch === '-' && !(i === 0 && /[0-9]/.test(value[i + 1] ?? ''))) return false;
	}
	return angle === 0 && round === 0 && square === 0 && curly === 0;
}

function leadingTypeAssertionLength(value) {
	if (!value.startsWith('<')) return 0;
	let angle = 0;
	let quote = null;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
		if (ch === '<') angle++;
		else if (ch === '>' && value[i - 1] !== '=') {
			angle--;
			if (angle === 0) {
				const candidate = value.slice(1, i);
				return isBoundedTypeExpression(candidate) ? i + 1 : 0;
			}
		}
	}
	return 0;
}

function trailingTypeAssertionStart(value) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	const positions = [];
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
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
		if (round !== 0 || square !== 0 || curly !== 0) continue;
		for (const keyword of ['as', 'satisfies']) {
			if (value.slice(i, i + keyword.length) !== keyword) continue;
			const before = value[i - 1] ?? ' ';
			const after = value[i + keyword.length] ?? ' ';
			if (/[$A-Za-z0-9_]/.test(before) || /[$A-Za-z0-9_]/.test(after)) continue;
			positions.push({ index: i, length: keyword.length });
		}
	}
	for (let i = positions.length - 1; i >= 0; i--) {
		const entry = positions[i];
		if (isBoundedTypeExpression(value.slice(entry.index + entry.length))) return entry.index;
	}
	return -1;
}

function isEmptyExpressFactoryExpression(expression, binding) {
	let value = expression.trim();
	let changed = true;
	while (changed) {
		changed = false;
		while (value.startsWith('(')) {
			const close = matchingParenClose(value, 0);
			if (close !== value.length - 1) break;
			value = value.slice(1, -1).trim();
			changed = true;
		}
		const leadingLength = leadingTypeAssertionLength(value);
		if (leadingLength > 0) {
			value = value.slice(leadingLength).trim();
			changed = true;
		}
		const trailingStart = trailingTypeAssertionStart(value);
		if (trailingStart !== -1) {
			value = value.slice(0, trailingStart).trim();
			changed = true;
		}
	}
	const factoryRe = new RegExp('^' + escapeRegex(binding) + '\\s*\\(\\s*\\)$');
	return factoryRe.test(value);
}
function applicationBindings(text) {
	const out = [];
	const expressBindings = expressDefaultBindings(text);
	for (const declaration of text.matchAll(/\b(?:(?:await\s+)?using|const|let|var)\b/g)) {
		if (!isTopLevelCodePosition(text, declaration.index)) continue;
		const clauseStart = declaration.index + declaration[0].length;
		const clause = readVariableDeclarationClause(text, clauseStart);
		for (const part of splitBindingDeclaratorsWithOffsets(clause)) {
			const assignment = topLevelBindingSeparator(part.text, '=');
			if (assignment === -1) continue;
			const lhs = part.text.slice(0, assignment).trim();
			const rhs = part.text.slice(assignment + 1).trim();
			const nameMatch = lhs.match(/^([A-Za-z_$][\w$]*)\s*(?::[\s\S]*)?$/);
			if (!nameMatch) continue;
			const isExpressFactory = expressBindings.some((binding) => isEmptyExpressFactoryExpression(rhs, binding));
			if (!isExpressFactory) continue;
			out.push({
				kind: 'application',
				name: nameMatch[1],
				declarationIndex: clauseStart + part.offset,
				initializationEnd: clauseStart + part.offset + part.text.length,
				declarationKind: declaration[0],
			});
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

function assignmentStatementStart(text, startIndex, equalsIndex) {
	let statementStart = startIndex;
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = null;
	let lastSignificant = null;
	for (let i = startIndex; i < equalsIndex; i++) {
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
		else if (ch === '{') {
			if (round === 0 && square === 0 && (isStandaloneBlockOpen(text, i) || isFinallyBlockOpen(text, i))) statementStart = i + 1;
			curly++;
		}
		else if (ch === '}') {
			curly = Math.max(0, curly - 1);
			if (round === 0 && square === 0 && curly === 0) statementStart = i + 1;
		}
		else if (ch === ';' && round === 0 && square === 0 && curly === 0) statementStart = i + 1;
		if (!/\s/.test(ch)) lastSignificant = ch;
	}
	return statementStart;
}
function peelAssignmentGrouping(value) {
	let out = value.trim();
	while (out.startsWith('(')) {
		const close = matchingParenClose(out, 0);
		if (close === out.length - 1) {
			out = out.slice(1, -1).trim();
			continue;
		}
		// The analyzed LHS stops at `=`, so `(app = value)` appears here as `(app`.
		if (close === -1) {
			out = out.slice(1).trimStart();
			continue;
		}
		break;
	}
	return out;
}

function topLevelSequenceAssignmentTarget(lhs) {
	let value = lhs.trim();
	if (/^(?:if|for|while|with|switch)\\b/.test(value)) return value;
	value = peelAssignmentGrouping(value);
	const parts = splitTopLevelArgs(value);
	value = parts.length > 1 ? parts[parts.length - 1].trim() : value;
	return peelAssignmentGrouping(value);
}

function assignmentLhsDefinitelyWritesName(text, binding, equalsIndex) {
	const statementStart = assignmentStatementStart(text, binding.initializationEnd, equalsIndex);
	let lhs = text.slice(statementStart, equalsIndex).trim();
	if (!lhs) return false;
	lhs = topLevelSequenceAssignmentTarget(lhs);

	// Only a standalone assignment target is definite. Conditional prefixes such as `if (flag)`,
	// `flag &&`, and ternaries intentionally fail this check rather than invalidating the binding.
	let direct = lhs;
	const compoundOperators = ['&&', '**', '>>>', '<<', '>>', '+', '-', '*', '/', '%', '&', '|', '^'];
	for (const operator of compoundOperators) {
		if (direct.endsWith(operator)) {
			direct = direct.slice(0, -operator.length).trimEnd();
			break;
		}
	}
	// A same-scope `var` redeclaration is a real write to the existing binding, not a new
	// lexical shadow. Preserve the full binding-pattern parser so typed/destructured forms are
	// handled consistently with ordinary declarations.
	const varRedeclaration = direct.match(/^var\b([\s\S]*)$/);
	if (varRedeclaration && variableClauseBindsName(varRedeclaration[1], binding.name)) return true;

	while (direct.startsWith('(') && direct.endsWith(')')) {
		const close = matchingParenClose(direct, 0);
		if (close !== direct.length - 1) break;
		direct = direct.slice(1, -1).trim();
	}
	if (direct === binding.name) return true;

	// Object/array destructuring writes are definite when the selected sequence operand consists
	// only of that pattern (object assignments may have a leading parenthesis).
	while (lhs.startsWith('(')) lhs = lhs.slice(1).trimStart();
	while (lhs.endsWith(')')) lhs = lhs.slice(0, -1).trimEnd();
	if ((lhs.startsWith('{') && lhs.endsWith('}')) || (lhs.startsWith('[') && lhs.endsWith(']'))) {
		return bindingPatternBindsName(lhs, binding.name);
	}
	return false;
}

function objectMemberGuaranteesEnumerableStringKey(member) {
	const item = member.trim();
	if (!item || item.startsWith('...') || item.startsWith('[')) return false;
	// Shorthand properties always create an own enumerable string key.
	if (/^[A-Za-z_$][\w$]*$/.test(item)) return true;
	// Colon properties with __proto__ are the object-literal prototype setter, not an own key.
	const colon = item.match(/^([A-Za-z_$][\w$]*|["'][^"']+["']|\d+(?:\.\d+)?)\s*:/);
	if (colon) {
		const raw = colon[1];
		const key = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
		return key !== '__proto__';
	}
	// Methods/accessors with a noncomputed literal/identifier name create enumerable own keys,
	// including a method literally named __proto__ (only the colon form is special).
	return /^(?:(?:async|get|set)\s+|\*\s*)*([A-Za-z_$][\w$]*|["'][^"']+["']|\d+(?:\.\d+)?)\s*(?:<[^>]*>\s*)?\(/.test(item);
}

function staticallyGuaranteedNonEmptyLoop(operator, expression) {
	const value = expression.trim();
	// Stay deliberately conservative: only syntax whose iteration count is knowable without
	// evaluation can make a post-loop write definite.
	if (value.startsWith('[') && value.endsWith(']') && delimitersBalanced(value)) {
		const inner = value.slice(1, -1);
		if (!inner.trim()) return false;
		const elements = splitTopLevelArgs(inner);
		if (operator === 'of') {
			// Array iterators visit elisions as undefined, so [,] is one guaranteed iteration.
			return elements.some((item) => item.trim() === '' || !item.trim().startsWith('...'));
		}
		if (operator === 'in') {
			// for-in visits enumerable indexes only; an elision creates length but no own index.
			return elements.some((item) => item.trim() !== '' && !item.trim().startsWith('...'));
		}
	}
	if (operator === 'of') {
		const literal = value.match(STRING_LITERAL_RE);
		if (literal && literal[0].trim() === value && !(value.startsWith('`') && literal[1].includes('${'))) {
			return literal[1].length > 0;
		}
	}
	if (operator === 'in' && value.startsWith('{') && value.endsWith('}') && delimitersBalanced(value)) {
		const inner = value.slice(1, -1).trim();
		return splitTopLevelArgs(inner).some(objectMemberGuaranteesEnumerableStringKey);
	}
	return false;
}

function forHeaderWritesApplicationName(text, binding, targetIndex) {
	const re = /\bfor\s*(?:await\s*)?\(/g;
	for (const match of text.matchAll(re)) {
		if (match.index < binding.initializationEnd || match.index >= targetIndex || !isCodePosition(text, match.index)) continue;
		const openIndex = match.index + match[0].lastIndexOf('(');
		const closeIndex = matchingParenClose(text, openIndex);
		if (closeIndex === -1 || openIndex >= targetIndex) continue;
		const header = text.slice(openIndex + 1, closeIndex);
		const split = header.match(/^\s*([\s\S]*?)\s+(of|in)\s+([\s\S]*)$/);
		if (split) {
			// Header writes are definite for a call inside an iteration. For post-loop calls they
			// are definite only when the iterable is syntactically guaranteed nonempty.
			const bodyStart = skipStatementWhitespace(text, closeIndex + 1);
			const bodyEnd = singleStatementEnd(text, bodyStart);
			const insideIteration = targetIndex >= bodyStart && targetIndex < bodyEnd;
			const postLoopGuaranteed = targetIndex >= bodyEnd &&
				staticallyGuaranteedNonEmptyLoop(split[2], split[3]);
			if (!insideIteration && !postLoopGuaranteed) continue;
			let lhs = peelAssignmentGrouping(split[1].trim());
			const declaration = lhs.match(/^(const|let|var)\b([\s\S]*)$/);
			if (declaration) {
				// let/const create a loop-local shadow. var reuses the containing function/module
				// binding for an executing iteration.
				if (declaration[1] === 'var' && binding.declarationKind === 'var' &&
					variableClauseBindsName(declaration[2], binding.name)) return true;
				continue;
			}
			if (/^(?:await\s+)?using\b/.test(lhs)) continue;
			const writes = lhs === binding.name ||
				(((lhs.startsWith('{') && lhs.endsWith('}')) || (lhs.startsWith('[') && lhs.endsWith(']'))) && bindingPatternBindsName(lhs, binding.name));
			if (!writes) continue;
			const nameOffset = header.indexOf(binding.name);
			const referenceIndex = openIndex + 1 + Math.max(0, nameOffset);
			if (topLevelReferenceIsAuthorized(text, binding.name, referenceIndex)) return true;
			continue;
		}

		// Classic for initializers execute exactly once before the first condition check.
		// A var redeclaration therefore overwrites an existing function/module-scoped var binding.
		const firstSemi = topLevelBindingSeparator(header, ';');
		if (firstSemi === -1) continue;
		const initializer = header.slice(0, firstSemi).trim();
		const statementStart = assignmentStatementStart(text, binding.initializationEnd, match.index);
		const ordinaryDefinite = definiteApplicationWritePosition(text, match.index) &&
			text.slice(statementStart, match.index).trim() === '';
		const doBodyDefinite = isDirectlyInUnconditionalDoBody(text, binding, match.index);
		const unbracedDoDefinite = /^do\s*$/.test(text.slice(statementStart, match.index).trim());
		const headerDefinitelyExecutes = ordinaryDefinite || doBodyDefinite || unbracedDoDefinite;
		if (!headerDefinitelyExecutes) continue;
		const varInit = initializer.match(/^var\b([\s\S]*)$/);
		if (varInit && binding.declarationKind === 'var' && variableClauseBindsName(varInit[1], binding.name)) {
			// var redeclarations target the same function/module binding. Do not run lexical-shadow
			// authorization on the redeclaration itself; compare its function scope to the original.
			const bindingFunction = nearestFunctionScopeOpenAt(text, binding.declarationIndex);
			const headerFunction = nearestFunctionScopeOpenAt(text, match.index);
			if (bindingFunction === headerFunction) return true;
			continue;
		}
		// Existing-binding assignments in classic for initializers execute before the first test,
		// but only when this header resolves to the same application binding in a definitely-run scope.
		for (const operandPart of splitBindingDeclaratorsWithOffsets(initializer)) {
			const operand = operandPart.text;
			const assignment = topLevelBindingSeparator(operand, '=');
			if (assignment === -1) continue;
			const rawLhs = operand.slice(0, assignment);
			let lhs = peelAssignmentGrouping(rawLhs.trim());
			for (const operator of ['&&', '**', '>>>', '<<', '>>', '+', '-', '*', '/', '%', '&', '|', '^']) {
				if (lhs.endsWith(operator)) { lhs = lhs.slice(0, -operator.length).trimEnd(); break; }
			}
			const writes = lhs === binding.name ||
				(((lhs.startsWith('{') && lhs.endsWith('}')) || (lhs.startsWith('[') && lhs.endsWith(']'))) && bindingPatternBindsName(lhs, binding.name));
			if (!writes) continue;
			const localNameOffset = rawLhs.lastIndexOf(binding.name);
			if (localNameOffset === -1) continue;
			const referenceIndex = openIndex + 1 + operandPart.offset + localNameOffset;
			if (topLevelReferenceIsAuthorized(text, binding.name, referenceIndex)) return true;
		}
	}
	return false;
}

function isStandaloneBlockOpen(text, openIndex) {
	let i = openIndex - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	if (i < 0) return true;
	return text[i] === ';' || text[i] === '}' || text[i] === '{';
}

function isFinallyBlockOpen(text, openIndex) {
	const prefix = text.slice(Math.max(0, openIndex - 64), openIndex);
	return /\bfinally\s*$/.test(prefix);
}

function definiteApplicationWritePosition(text, equalsIndex) {
	if (isTopLevelCodePosition(text, equalsIndex)) return true;
	const scopes = activeCodeScopeOpeningsAt(text, equalsIndex);
	return scopes.length > 0 && scopes.every((openIndex) => isStandaloneBlockOpen(text, openIndex) || isFinallyBlockOpen(text, openIndex));
}

function isDirectlyInUnconditionalDoBody(text, binding, targetIndex) {
	const scopes = activeCodeScopeOpeningsAt(text, targetIndex);
	if (scopes.length === 0) return false;
	for (let scopeIndex = scopes.length - 1; scopeIndex >= 0; scopeIndex--) {
		const openIndex = scopes[scopeIndex];
		let i = openIndex - 1;
		while (i >= 0 && /\s/.test(text[i])) i--;
		const prefix = text.slice(Math.max(0, i - 1), i + 1);
		if (prefix !== 'do' || (i - 2 >= 0 && /[$A-Za-z0-9_]/.test(text[i - 2]))) continue;
		const doIndex = i - 1;
		const statementStart = assignmentStatementStart(text, binding.initializationEnd, doIndex);
		if (text.slice(statementStart, doIndex).trim() !== '') return false;
		for (let j = scopeIndex + 1; j < scopes.length; j++) {
			if (!isStandaloneBlockOpen(text, scopes[j])) return false;
		}
		return true;
	}
	return false;
}

function updateExpressionWritesApplicationName(text, binding, targetIndex) {
	const escaped = escapeRegex(binding.name);
	const boundary = '[$\\p{ID_Continue}\\u200C\\u200D.#]';
	const updateRe = new RegExp(
		'(?:(?<!' + boundary + ')(?:\\+\\+|--)\\s*' + escaped + '(?!' + boundary + ')' +
		'|(?<!' + boundary + ')' + escaped + '\\s*(?:\\+\\+|--)(?!' + boundary + '))',
		'gu',
	);
	for (const match of text.matchAll(updateRe)) {
		if (match.index < binding.initializationEnd || match.index >= targetIndex) continue;
		if (!isCodePosition(text, match.index)) continue;
		const ordinaryDefinite = definiteApplicationWritePosition(text, match.index);
		const doBodyDefinite = isDirectlyInUnconditionalDoBody(text, binding, match.index);
		const statementStartForDo = assignmentStatementStart(text, binding.initializationEnd, match.index);
		const unbracedDoDefinite = /^do\s*$/.test(text.slice(statementStartForDo, match.index).trim());
		if (!ordinaryDefinite && !doBodyDefinite && !unbracedDoDefinite) continue;
		// `if (flag) app++` and similar control-prefixed updates are conditional writes.
		// A plain do-body is handled separately above because its body executes at least once.
		if (!doBodyDefinite && !unbracedDoDefinite) {
			const statementStart = assignmentStatementStart(text, binding.initializationEnd, match.index);
			if (text.slice(statementStart, match.index).trim() !== '') continue;
		}
		return true;
	}
	return false;
}

function applicationBindingStillTrusted(text, binding, targetIndex) {
	if (binding.declarationKind === 'const') return true;
	if (forHeaderWritesApplicationName(text, binding, targetIndex)) return false;
	if (updateExpressionWritesApplicationName(text, binding, targetIndex)) return false;
	for (const match of text.matchAll(/=/g)) {
		const equalsIndex = match.index;
		if (equalsIndex < binding.initializationEnd || equalsIndex >= targetIndex) continue;
		if (!isCodePosition(text, equalsIndex) || !definiteApplicationWritePosition(text, equalsIndex)) continue;
		const previous = text[equalsIndex - 1] ?? '';
		const next = text[equalsIndex + 1] ?? '';
		if (next === '=' || next === '>' || previous === '=' || previous === '!') continue;
		// <= and >= are comparisons, while <<=, >>= and >>>= are writes. The repeated shift
		// character immediately before the operator distinguishes them at the '=' token.
		if ((previous === '<' || previous === '>') && text[equalsIndex - 2] !== previous) continue;
		if (assignmentLhsDefinitelyWritesName(text, binding, equalsIndex)) return false;
	}
	return true;
}
function receiverBindingAt(text, name, targetIndex) {
	const router = routerBindingAt(text, name, targetIndex);
	if (router) return router;
	let application = null;
	for (const binding of applicationBindings(text)) {
		if (binding.name === name && binding.declarationIndex < targetIndex) application = binding;
	}
	if (application && applicationBindingStillTrusted(text, application, targetIndex) &&
		topLevelReferenceIsAuthorized(text, name, targetIndex)) return application;
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
	// `\\w` is ASCII-only, so it incorrectly treats the suffix in a valid Unicode identifier
	// such as `éapp.get(...)` as a bare `app` receiver. Use ECMAScript identifier-continue
	// semantics (plus $, ZWNJ/ZWJ) for the left boundary instead.
	const unicodeFlags = flags.includes('u') ? flags : `${flags}u`;
	return new RegExp('(?<![$\\p{ID_Continue}\\u200C\\u200D.#])' + escapeRegex(routerName) +
		'\\.(' + memberPattern + ')\\s*\\(', unicodeFlags);
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
	const verbCallRe = routerMemberCallRe(binding.name, VERBS.join('|'), 'g');
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
	const directRe = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g;
	for (const match of text.matchAll(directRe)) {
		if (!isCodePosition(text, match.index)) continue;
		const binding = receiverBindingAt(text, match[1], match.index);
		if (binding) return binding;
	}

	// ESM also permits `export { router as default }`. Re-exports with `from` are excluded:
	// they do not prove a local receiver binding in this file.
	const specifierRe = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
	for (const match of text.matchAll(specifierRe)) {
		if (!isCodePosition(text, match.index)) continue;
		for (const specifier of splitTopLevelArgs(match[1])) {
			const alias = specifier.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+default$/);
			if (!alias) continue;
			const binding = receiverBindingAt(text, alias[1], match.index);
			if (binding) return binding;
		}
	}
	return null;
}

function defaultImportSourceForBinding(text, name) {
	const directRe = new RegExp('\\bimport\\s+' + escapeRegex(name) + '\\s*(?:,\\s*(?:\\{[^}]*\\}|\\*\\s+as\\s+[A-Za-z_$][\\w$]*))?\\s+from\\s*["\\x27]([^"\\x27]+)["\\x27]', 'g');
	for (const match of text.matchAll(directRe)) {
		if (isCodePosition(text, match.index)) return match[1];
	}
	const namedRe = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
	for (const match of text.matchAll(namedRe)) {
		if (!isCodePosition(text, match.index)) continue;
		for (const specifier of splitTopLevelArgs(match[1])) {
			const alias = specifier.trim().match(/^default\s+as\s+([A-Za-z_$][\w$]*)$/);
			if (alias && alias[1] === name) return match[2];
		}
	}
	return null;
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
					const importSource = defaultImportSourceForBinding(text, target);
					if (!importSource) continue;
					const toFile = resolveRelativeImport(file, importSource);
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
function prefixChainsFor(node, edges, seen = new Set()) {
	if (seen.has(node)) return [];
	const nextSeen = new Set(seen);
	nextSeen.add(node);
	const incoming = edges.filter((edge) => edge.to === node);
	if (incoming.length === 0) return [''];
	const prefixes = [];
	for (const edge of incoming) {
		for (const parentPrefix of prefixChainsFor(edge.from, edges, nextSeen)) {
			prefixes.push(joinPath(parentPrefix, edge.prefix));
		}
	}
	return [...new Set(prefixes)];
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
			const prefixes = prefixChainsFor(nodeKey(file, binding), edges);
			const receiverSuffix = `${binding.name.charAt(0).toUpperCase()}${binding.name.slice(1)}`;
			const duplicateSuffix = (nameCounts.get(binding.name) ?? 0) > 1
				? `L${lineNumberAt(text, binding.declarationIndex)}`
				: '';
			for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex++) {
				const prefix = prefixes[prefixIndex];
				const endpoints = localEndpoints.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }));
				const mountSuffix = prefixes.length > 1 ? `M${prefixIndex + 1}` : '';
				const className = bindings.length === 1 && prefixes.length === 1
					? `${moduleClassBase}Router`
					: `${moduleClassBase}${receiverSuffix}${duplicateSuffix}${mountSuffix}Router`;
				moduleEntry(moduleName).controllers.push({ className, basePath: prefix, operationIds: [], endpoints, file });
			}
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
