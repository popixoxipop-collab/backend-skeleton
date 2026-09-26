import { JVM_SYNTAX_FACTS_SCHEMA } from './protocol.mjs';

const IDENT_START = /[$_\p{ID_Start}]/u;
const IDENT_PART = /[$_\u200C\u200D\p{ID_Continue}]/u;
const JAVA_IDENT_PATTERN = '[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*';
const TYPE_KEYWORDS = new Set(['class', 'record', 'interface', 'enum']);
const TYPE_MODIFIERS = new Set(['public', 'protected', 'private', 'abstract', 'final', 'sealed', 'non-sealed', 'static', 'strictfp']);

function byteOffset(text, utf16Index) {
	return Buffer.byteLength(text.slice(0, utf16Index), 'utf8');
}

function byteSpan(text, start, end) {
	return { start: byteOffset(text, start), end: byteOffset(text, end) };
}

function lineAt(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

function codePointAtBoundary(text, index) {
	if (index < 0 || index >= text.length) return null;
	let start = index;
	const unit = text.charCodeAt(start);
	if (unit >= 0xDC00 && unit <= 0xDFFF && start > 0) {
		const prev = text.charCodeAt(start - 1);
		if (prev >= 0xD800 && prev <= 0xDBFF) start--;
	}
	const cp = text.codePointAt(start);
	return cp === undefined ? null : String.fromCodePoint(cp);
}

function isBoundary(text, index) {
	const ch = codePointAtBoundary(text, index);
	return ch === null || !IDENT_PART.test(ch);
}

function startsWord(text, index, word) {
	return text.startsWith(word, index) && isBoundary(text, index - 1) && isBoundary(text, index + word.length);
}

function readIdentifier(text, index) {
	const first = codePointAtBoundary(text, index);
	if (first === null || !IDENT_START.test(first)) return null;
	let end = index + first.length;
	while (end < text.length) {
		const ch = codePointAtBoundary(text, end);
		if (ch === null || !IDENT_PART.test(ch)) break;
		end += ch.length;
	}
	return { value: text.slice(index, end), end };
}

function readQualifiedName(text, index) {
	let i = index;
	const first = readIdentifier(text, i);
	if (!first) return null;
	let value = first.value;
	i = first.end;
	while (text[i] === '.') {
		const next = readIdentifier(text, i + 1);
		if (!next) break;
		value += `.${next.value}`;
		i = next.end;
	}
	return { value, end: i };
}

function skipWhitespace(text, index) {
	let i = index;
	while (i < text.length && /\s/.test(text[i])) i++;
	return i;
}

function matchBalanced(text, openIndex, openChar, closeChar) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === openChar) depth++;
		else if (text[i] === closeChar) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// Length-preserving lexical mask. Newlines and quote delimiters are kept so later offsets/lines
// are stable. This deliberately handles char literals too: a literal '{' must never increase the
// top-level brace depth. It is still a lexer, not a Java parser.
export function maskJavaNonCode(text) {
	const chars = text.split('');
	let i = 0;
	const blank = (start, end, keep = new Set()) => {
		for (let p = start; p < end; p++) {
			if (text[p] !== '\n' && !keep.has(p)) chars[p] = ' ';
		}
	};
	while (i < text.length) {
		if (text.startsWith('//', i)) {
			const end = text.indexOf('\n', i + 2);
			const stop = end === -1 ? text.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (text.startsWith('/*', i)) {
			const close = text.indexOf('*/', i + 2);
			const stop = close === -1 ? text.length : close + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (text.startsWith('"""', i)) {
			const close = text.indexOf('"""', i + 3);
			const stop = close === -1 ? text.length : close + 3;
			const keep = new Set([i, i + 1, i + 2]);
			if (close !== -1) keep.add(close), keep.add(close + 1), keep.add(close + 2);
			blank(i, stop, keep);
			i = stop;
			continue;
		}
		if (text[i] === '"' || text[i] === "'") {
			const quote = text[i];
			let p = i + 1;
			let escaped = false;
			for (; p < text.length; p++) {
				if (escaped) { escaped = false; continue; }
				if (text[p] === '\\') { escaped = true; continue; }
				if (text[p] === quote) { p++; break; }
			}
			const keep = new Set([i]);
			if (p <= text.length && text[p - 1] === quote) keep.add(p - 1);
			blank(i, p, keep);
			i = p;
			continue;
		}
		i++;
	}
	return chars.join('');
}

function splitTopLevelComma(text) {
	const out = [];
	let start = 0;
	let angle = 0;
	let paren = 0;
	let bracket = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '<') angle++;
		else if (ch === '>') angle = Math.max(0, angle - 1);
		else if (ch === '(') paren++;
		else if (ch === ')') paren = Math.max(0, paren - 1);
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket = Math.max(0, bracket - 1);
		else if (ch === ',' && angle === 0 && paren === 0 && bracket === 0) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

function clause(header, keyword, stopKeywords) {
	const re = new RegExp(`\\b${keyword}\\b`);
	const m = re.exec(header);
	if (!m) return [];
	let end = header.length;
	for (const stop of stopKeywords) {
		const sm = new RegExp(`\\b${stop}\\b`).exec(header.slice(m.index + m[0].length));
		if (sm) end = Math.min(end, m.index + m[0].length + sm.index);
	}
	return splitTopLevelComma(header.slice(m.index + m[0].length, end));
}

function findBodyOpen(masked, start) {
	let angle = 0;
	let paren = 0;
	let bracket = 0;
	for (let i = start; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === '<') angle++;
		else if (ch === '>') angle = Math.max(0, angle - 1);
		else if (ch === '(') paren++;
		else if (ch === ')') paren = Math.max(0, paren - 1);
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket = Math.max(0, bracket - 1);
		else if (ch === '{' && angle === 0 && paren === 0 && bracket === 0) return i;
		else if (ch === ';' && angle === 0 && paren === 0 && bracket === 0) return -1;
	}
	return -1;
}

function readAnnotation(original, masked, index) {
	if (masked[index] !== '@' || startsWord(masked, index, '@interface')) return null;
	const name = readQualifiedName(masked, index + 1);
	if (!name) return null;
	let end = skipWhitespace(masked, name.end);
	let argsText = null;
	if (masked[end] === '(') {
		const close = matchBalanced(masked, end, '(', ')');
		if (close === -1) return { name: name.value, argsText: null, start: index, end: name.end, malformed: true };
		argsText = original.slice(end + 1, close);
		end = close + 1;
	}
	return { name: name.value, argsText, start: index, end, malformed: false };
}

function parsePackageAndImports(text, masked) {
	const packageRe = new RegExp(`(?:^|\\n)\\s*package\\s+(${JAVA_IDENT_PATTERN}(?:\\.${JAVA_IDENT_PATTERN})*)\\s*;`, 'mu');
	const packageMatch = packageRe.exec(masked);
	const packageName = packageMatch?.[1] ?? null;
	const imports = [];
	const importRe = new RegExp(`(?:^|\\n)\\s*import\\s+(static\\s+)?(${JAVA_IDENT_PATTERN}(?:\\.(?:${JAVA_IDENT_PATTERN}|\\*))*)\\s*;`, 'gmu');
	let m;
	while ((m = importRe.exec(masked))) {
		const statementOffset = m.index + m[0].indexOf('import');
		imports.push({
			name: m[2],
			static: Boolean(m[1]),
			wildcard: m[2].endsWith('.*'),
			byteSpan: byteSpan(text, statementOffset, m.index + m[0].length),
		});
	}
	return { packageName, imports };
}

function normalizeKind(token) {
	return token === '@interface' ? 'annotation' : token;
}

function parseTopLevelTypes(text, masked, diagnostics) {
	const types = [];
	let depth = 0;
	let i = 0;
	let pendingAnnotations = [];
	let pendingModifiers = [];

	while (i < masked.length) {
		const ch = masked[i];
		if (ch === '{') { depth++; i++; continue; }
		if (ch === '}') { depth = Math.max(0, depth - 1); if (depth === 0) { pendingAnnotations = []; pendingModifiers = []; } i++; continue; }
		if (depth !== 0) { i++; continue; }
		if (/\s/.test(ch)) { i++; continue; }

		if (ch === '@') {
			if (masked.startsWith('@interface', i) && isBoundary(masked, i + '@interface'.length)) {
				// handled below as a declaration token
			} else {
				const annotation = readAnnotation(text, masked, i);
				if (annotation) {
					pendingAnnotations.push({
						name: annotation.name,
						argsText: annotation.argsText,
						byteSpan: byteSpan(text, annotation.start, annotation.end),
					});
					if (annotation.malformed) diagnostics.push({ code: 'JVM_UNTERMINATED_ANNOTATION', line: lineAt(text, i), message: `unterminated annotation @${annotation.name}` });
					i = annotation.end;
					continue;
				}
			}
		}

		let token = null;
		let tokenEnd = i;
		if (masked.startsWith('@interface', i) && isBoundary(masked, i + '@interface'.length)) {
			token = '@interface';
			tokenEnd = i + token.length;
		} else if (masked.startsWith('non-sealed', i) && isBoundary(masked, i - 1) && isBoundary(masked, i + 'non-sealed'.length)) {
			token = 'non-sealed';
			tokenEnd = i + token.length;
		} else {
			const ident = readIdentifier(masked, i);
			if (ident) { token = ident.value; tokenEnd = ident.end; }
		}
		if (!token) { pendingAnnotations = []; pendingModifiers = []; i++; continue; }

		if (TYPE_MODIFIERS.has(token)) {
			pendingModifiers.push(token);
			i = tokenEnd;
			continue;
		}

		if (TYPE_KEYWORDS.has(token) || token === '@interface') {
			let p = skipWhitespace(masked, tokenEnd);
			const name = readIdentifier(masked, p);
			if (!name) {
				diagnostics.push({ code: 'JVM_TYPE_NAME_UNRESOLVED', line: lineAt(text, i), message: `could not read top-level ${token} name` });
				pendingAnnotations = []; pendingModifiers = []; i = tokenEnd; continue;
			}
			const bodyOpen = findBodyOpen(masked, name.end);
			if (bodyOpen === -1) {
				diagnostics.push({ code: 'JVM_TYPE_BODY_UNRESOLVED', line: lineAt(text, i), message: `could not locate body for top-level ${name.value}` });
				pendingAnnotations = []; pendingModifiers = []; i = name.end; continue;
			}
			const headerText = text.slice(name.end, bodyOpen).trim();
			const headerMasked = masked.slice(name.end, bodyOpen);
			let recordComponentsText = null;
			if (token === 'record') {
				const open = masked.indexOf('(', name.end);
				if (open !== -1 && open < bodyOpen) {
					const close = matchBalanced(masked, open, '(', ')');
					if (close !== -1 && close < bodyOpen) recordComponentsText = text.slice(open + 1, close);
				}
			}
			types.push({
				kind: normalizeKind(token),
				name: name.value,
				annotations: pendingAnnotations,
				modifiers: pendingModifiers,
				headerText,
				extendsTypes: clause(headerMasked, 'extends', ['implements', 'permits']),
				implementsTypes: clause(headerMasked, 'implements', ['permits']),
				permitsTypes: clause(headerMasked, 'permits', []),
				recordComponentsText,
				line: lineAt(text, i),
				byteSpan: byteSpan(text, i, bodyOpen + 1),
			});
			pendingAnnotations = [];
			pendingModifiers = [];
			i = bodyOpen; // normal loop increments brace depth on the next iteration
			continue;
		}

		// package/import/other top-level tokens break an annotation/modifier stack: only a directly
		// preceding declaration stack may be associated with a type.
		pendingAnnotations = [];
		pendingModifiers = [];
		i = tokenEnd;
	}
	return types;
}

export function analyzeJavaSyntax(text, { path = 'Unknown.java' } = {}) {
	if (typeof text !== 'string') throw new TypeError('text must be a string');
	if (typeof path !== 'string' || path.length === 0) throw new TypeError('path must be a non-empty repository-relative string');
	const masked = maskJavaNonCode(text);
	const diagnostics = [];
	const { packageName, imports } = parsePackageAndImports(text, masked);
	const topLevelTypes = parseTopLevelTypes(text, masked, diagnostics);
	return {
		schema: JVM_SYNTAX_FACTS_SCHEMA,
		language: 'java',
		path,
		packageName,
		imports,
		topLevelTypes,
		diagnostics,
	};
}
