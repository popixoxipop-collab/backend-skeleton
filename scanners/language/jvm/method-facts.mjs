import { analyzeJavaSyntax, maskJavaNonCode } from './java-syntax-facts.mjs';

const ID = '[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*';
const ANNOTATION_RE = new RegExp('^@(' + ID + '(?:\\.' + ID + ')*)', 'u');
const METHOD_MODIFIERS = new Set([
	'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized',
	'default', 'native', 'strictfp',
]);

function byteOffset(text, index) {
	return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function utf16OffsetForByte(text, offset) {
	const buffer = Buffer.from(text, 'utf8');
	if (!Number.isInteger(offset) || offset < 0 || offset > buffer.length) {
		throw new RangeError('invalid byte offset');
	}
	return buffer.subarray(0, offset).toString('utf8').length;
}

function skipSpace(text, start) {
	let i = start;
	while (i < text.length && /\s/u.test(text[i])) i++;
	return i;
}

function balancedClose(masked, open, openCh, closeCh) {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === openCh) depth++;
		else if (masked[i] === closeCh) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function readWord(masked, start) {
	const m = new RegExp('^(' + ID + ')', 'u').exec(masked.slice(start));
	return m ? { value: m[1], end: start + m[0].length } : null;
}

function consumeAnnotationsAndModifiers(source, masked, baseByte) {
	let cursor = skipSpace(masked, 0);
	const annotations = [];
	const modifiers = [];
	while (masked[cursor] === '@') {
		const match = ANNOTATION_RE.exec(masked.slice(cursor));
		if (!match) break;
		const start = cursor;
		const name = match[1];
		cursor += match[0].length;
		let end = cursor;
		const argsOpen = skipSpace(masked, cursor);
		let argsText = null;
		if (masked[argsOpen] === '(') {
			const close = balancedClose(masked, argsOpen, '(', ')');
			if (close === -1) return { annotations, modifiers, cursor, malformed: true };
			argsText = source.slice(argsOpen + 1, close);
			cursor = close + 1;
			end = cursor;
		}
		annotations.push({
			name, argsText,
			byteSpan: { start: baseByte + byteOffset(source, start), end: baseByte + byteOffset(source, end) },
		});
		cursor = skipSpace(masked, cursor);
	}
	while (cursor < masked.length) {
		const word = readWord(masked, cursor);
		if (!word || !METHOD_MODIFIERS.has(word.value)) break;
		modifiers.push(word.value);
		cursor = skipSpace(masked, word.end);
	}
	return { annotations, modifiers, cursor, malformed: false };
}

function findParameterOpen(masked, start) {
	let angle = 0;
	let bracket = 0;
	for (let i = start; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === '<') angle++;
		else if (ch === '>') angle = Math.max(0, angle - 1);
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket = Math.max(0, bracket - 1);
		else if (ch === '(' && angle === 0 && bracket === 0) return i;
		else if ((ch === '=' || ch === ';') && angle === 0 && bracket === 0) return -1;
	}
	return -1;
}

function parseMethodHeader(source, masked, baseByte) {
	const prefix = consumeAnnotationsAndModifiers(source, masked, baseByte);
	if (prefix.malformed) return { method: null, diagnostic: 'JVM_METHOD_ANNOTATION_UNTERMINATED' };
	const open = findParameterOpen(masked, prefix.cursor);
	if (open === -1) return { method: null, diagnostic: null };
	const close = balancedClose(masked, open, '(', ')');
	if (close === -1) return { method: null, diagnostic: 'JVM_METHOD_PARAMS_UNTERMINATED' };

	const before = masked.slice(prefix.cursor, open).trim();
	if (!before || before.includes('=') || /\b(class|record|interface|enum)\b/u.test(before)) {
		return { method: null, diagnostic: null };
	}
	const match = new RegExp('(' + ID + ')\\s*$', 'u').exec(before);
	if (!match) return { method: null, diagnostic: null };
	const name = match[1];
	const returnType = before.slice(0, match.index).trim();
	const after = masked.slice(close + 1).trimStart();
	if (!(after.startsWith('{') || after.startsWith(';') || after.startsWith('throws '))) {
		return { method: null, diagnostic: null };
	}
	return {
		method: {
			name,
			returnType: returnType || null,
			constructor: returnType === '',
			paramsText: source.slice(open + 1, close),
			annotations: prefix.annotations,
			modifiers: prefix.modifiers,
			byteSpan: { start: baseByte, end: baseByte + byteOffset(source, close + 1) },
		},
		diagnostic: null,
	};
}

function typeRegions(source, syntax) {
	const masked = maskJavaNonCode(source);
	return syntax.topLevelTypes.map((type) => {
		const start = utf16OffsetForByte(source, type.byteSpan.start);
		const open = masked.indexOf('{', start);
		const close = open === -1 ? -1 : balancedClose(masked, open, '{', '}');
		return { type, start, open, close };
	});
}

function directHeaders(source, masked, open, close) {
	const out = [];
	let start = open + 1;
	let i = start;
	while (i < close) {
		const ch = masked[i];
		if (ch === '{') {
			const bodyClose = balancedClose(masked, i, '{', '}');
			if (bodyClose === -1 || bodyClose > close) break;
			out.push({ start, end: i + 1, terminator: '{' });
			i = bodyClose + 1;
			start = i;
			continue;
		}
		if (ch === ';') {
			out.push({ start, end: i + 1, terminator: ';' });
			start = i + 1;
		}
		i++;
	}
	return out;
}

// Direct methods only: nested types and method bodies are skipped as opaque brace regions.
// No framework semantics, override resolution, generated members or inherited methods are inferred.
export function analyzeJavaMethodFacts(source, { path = 'Unknown.java' } = {}) {
	const syntax = analyzeJavaSyntax(source, { path });
	const masked = maskJavaNonCode(source);
	const diagnostics = [...syntax.diagnostics];
	const types = [];
	for (const region of typeRegions(source, syntax)) {
		const fqn = syntax.packageName ? syntax.packageName + '.' + region.type.name : region.type.name;
		const methods = [];
		if (region.open !== -1 && region.close !== -1) {
			for (const header of directHeaders(source, masked, region.open, region.close)) {
				const original = source.slice(header.start, header.end);
				const parsed = parseMethodHeader(original, masked.slice(header.start, header.end), byteOffset(source, header.start));
				if (parsed.method) methods.push(parsed.method);
				if (parsed.diagnostic) diagnostics.push({ code: parsed.diagnostic, type: fqn });
			}
		}
		types.push({ fqn, kind: region.type.kind, path, methods });
	}
	return { schema: 'sbf.jvm.method-facts/0-draft', language: 'java', path, types, diagnostics };
}