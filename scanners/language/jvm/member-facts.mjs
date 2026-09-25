import { analyzeJavaSyntax, maskJavaNonCode } from './java-syntax-facts.mjs';

const ID = '[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*';
const ANNOTATION_RE = new RegExp('^@(' + ID + '(?:\\.' + ID + ')*)', 'u');
const NAME_AT_END_RE = new RegExp('(' + ID + ')(\\s*(?:\\[\\s*\\])*)\\s*$', 'u');
const FIELD_MODIFIERS = new Set([
	'public', 'protected', 'private', 'static', 'final', 'transient', 'volatile',
]);

function byteOffset(text, index) {
	return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function utf16OffsetForByte(text, offset) {
	if (!Number.isInteger(offset) || offset < 0) throw new RangeError('byte offset must be non-negative');
	const buffer = Buffer.from(text, 'utf8');
	if (offset > buffer.length) throw new RangeError('byte offset exceeds source length');
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

function consumeAnnotationsAndModifiers(source, masked, baseByte = 0) {
	let cursor = skipSpace(masked, 0);
	const annotations = [];
	const modifiers = [];

	while (masked[cursor] === '@') {
		const match = ANNOTATION_RE.exec(masked.slice(cursor));
		if (!match) break;
		const name = match[1];
		const start = cursor;
		cursor += match[0].length;
		let annotationEnd = cursor;
		const argsOpen = skipSpace(masked, cursor);
		let argsText = null;
		if (masked[argsOpen] === '(') {
			const close = balancedClose(masked, argsOpen, '(', ')');
			if (close === -1) return { cursor, annotations, modifiers, malformed: 'annotation' };
			argsText = source.slice(argsOpen + 1, close);
			cursor = close + 1;
			annotationEnd = cursor;
		}
		annotations.push({
			name,
			argsText,
			byteSpan: {
				start: baseByte + byteOffset(source, start),
				end: baseByte + byteOffset(source, annotationEnd),
			},
		});
		cursor = skipSpace(masked, cursor);
	}

	while (cursor < masked.length) {
		const word = readWord(masked, cursor);
		if (!word || !FIELD_MODIFIERS.has(word.value)) break;
		modifiers.push(word.value);
		cursor = skipSpace(masked, word.end);
	}
	return { cursor, annotations, modifiers, malformed: null };
}

function hasTopLevelComma(text) {
	let angle = 0;
	let bracket = 0;
	for (const ch of text) {
		if (ch === '<') angle++;
		else if (ch === '>') angle = Math.max(0, angle - 1);
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket = Math.max(0, bracket - 1);
		else if (ch === ',' && angle === 0 && bracket === 0) return true;
	}
	return false;
}

function parseDirectDeclaration(source, masked, baseByte, { allowInitializer }) {
	const prefix = consumeAnnotationsAndModifiers(source, masked, baseByte);
	if (prefix.malformed) return { field: null, diagnostic: 'JVM_MEMBER_ANNOTATION_UNTERMINATED' };

	const code = masked.slice(prefix.cursor).trim();
	if (!code) return { field: null, diagnostic: null };
	const eq = allowInitializer ? code.indexOf('=') : -1;
	const declaration = (eq === -1 ? code : code.slice(0, eq)).trim();
	if (!declaration || declaration.includes('(') || declaration.includes(')')) {
		return { field: null, diagnostic: null };
	}
	if (hasTopLevelComma(declaration)) {
		return { field: null, diagnostic: 'JVM_MULTI_DECLARATOR_FIELD_UNSUPPORTED' };
	}

	const nameMatch = NAME_AT_END_RE.exec(declaration);
	if (!nameMatch) return { field: null, diagnostic: null };
	const name = nameMatch[1];
	const nameArray = nameMatch[2] ?? '';
	const rawType = declaration.slice(0, nameMatch.index).trim();
	if (!rawType) return { field: null, diagnostic: null };
	const suffixDepth = (nameArray.match(/\[/gu) ?? []).length;
	const typeDepth = (rawType.match(/\[/gu) ?? []).length;

	return {
		field: {
			name,
			rawType,
			annotations: prefix.annotations,
			modifiers: prefix.modifiers,
			generic: rawType.includes('<'),
			arrayDepth: suffixDepth + typeDepth,
		},
		diagnostic: null,
	};
}

function typeRegions(source, syntaxFacts) {
	const masked = maskJavaNonCode(source);
	return syntaxFacts.topLevelTypes.map((type) => {
		const start = utf16OffsetForByte(source, type.byteSpan.start);
		const open = masked.indexOf('{', start);
		if (open === -1) return { type, start, open: -1, close: -1 };
		const close = balancedClose(masked, open, '{', '}');
		return { type, start, open, close };
	});
}

function directStatements(source, masked, open, close) {
	const out = [];
	let nested = 0;
	let start = open + 1;
	for (let i = open + 1; i < close; i++) {
		const ch = masked[i];
		if (ch === '{') {
			nested++;
			continue;
		}
		if (ch === '}') {
			nested = Math.max(0, nested - 1);
			if (nested === 0) start = i + 1;
			continue;
		}
		if (ch === ';' && nested === 0) {
			out.push({ start, end: i });
			start = i + 1;
		}
	}
	return out;
}

function splitRecordComponents(source, masked, open, close) {
	const out = [];
	let start = open + 1;
	let angle = 0;
	let paren = 0;
	let bracket = 0;
	for (let i = open + 1; i < close; i++) {
		const ch = masked[i];
		if (ch === '<') angle++;
		else if (ch === '>') angle = Math.max(0, angle - 1);
		else if (ch === '(') paren++;
		else if (ch === ')') paren = Math.max(0, paren - 1);
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket = Math.max(0, bracket - 1);
		else if (ch === ',' && angle === 0 && paren === 0 && bracket === 0) {
			out.push({ start, end: i });
			start = i + 1;
		}
	}
	if (source.slice(start, close).trim()) out.push({ start, end: close });
	return out;
}

function recordComponentRanges(source, masked, region) {
	if (region.type.kind !== 'record' || region.open === -1) return [];
	const header = masked.slice(region.start, region.open);
	const marker = 'record ' + region.type.name;
	const markerAt = header.indexOf(marker);
	if (markerAt === -1) return [];
	const afterName = region.start + markerAt + marker.length;
	const open = masked.indexOf('(', afterName);
	if (open === -1 || open >= region.open) return [];
	const close = balancedClose(masked, open, '(', ')');
	if (close === -1 || close >= region.open) return [];
	return splitRecordComponents(source, masked, open, close);
}

// Static, direct-member facts only. It does not infer inherited fields, Lombok members, JPA
// persistence semantics, access strategy, generated values or framework validation semantics.
export function analyzeJavaMemberFacts(source, { path = 'Unknown.java' } = {}) {
	const syntax = analyzeJavaSyntax(source, { path });
	const masked = maskJavaNonCode(source);
	const types = [];
	const diagnostics = [...syntax.diagnostics];

	for (const region of typeRegions(source, syntax)) {
		const fqn = syntax.packageName ? syntax.packageName + '.' + region.type.name : region.type.name;
		const fields = [];
		if (region.open !== -1 && region.close !== -1) {
			for (const statement of directStatements(source, masked, region.open, region.close)) {
				const original = source.slice(statement.start, statement.end);
				const statementMasked = masked.slice(statement.start, statement.end);
				const parsed = parseDirectDeclaration(
					original,
					statementMasked,
					byteOffset(source, statement.start),
					{ allowInitializer: true },
				);
				if (parsed.field) fields.push(parsed.field);
				if (parsed.diagnostic) diagnostics.push({
					code: parsed.diagnostic,
					type: fqn,
					byteSpan: {
						start: byteOffset(source, statement.start),
						end: byteOffset(source, statement.end),
					},
				});
			}
		}

		const recordComponents = [];
		for (const component of recordComponentRanges(source, masked, region)) {
			const original = source.slice(component.start, component.end);
			const parsed = parseDirectDeclaration(
				original,
				masked.slice(component.start, component.end),
				byteOffset(source, component.start),
				{ allowInitializer: false },
			);
			if (parsed.field) recordComponents.push(parsed.field);
			else if (parsed.diagnostic) diagnostics.push({
				code: parsed.diagnostic,
				type: fqn,
				recordComponent: true,
				byteSpan: {
					start: byteOffset(source, component.start),
					end: byteOffset(source, component.end),
				},
			});
		}

		types.push({ fqn, kind: region.type.kind, path, fields, recordComponents });
	}

	return {
		schema: 'sbf.jvm.member-facts/0-draft',
		language: 'java',
		path,
		types,
		diagnostics,
	};
}