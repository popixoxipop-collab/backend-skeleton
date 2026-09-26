export function lineNumberAt(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}

export function joinRoutePath(base, segment) {
	const b = String(base ?? '').trim();
	const s = String(segment ?? '').trim();
	const joined = !b ? (s || '/') : (!s ? (b || '/') : `${b.replace(/\/+$/g, '')}/${s.replace(/^\/+/, '')}`);
	if (joined === '/') return '/';
	return joined.startsWith('/') ? joined : `/${joined}`;
}

export function maskNonCodePreserveDelimiters(source, { lineComment = '//', blockComments = true } = {}) {
	let out = '';
	let i = 0;
	let mode = 'code';
	let quote = null;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (mode === 'line-comment') {
			if (ch === '\n') { out += '\n'; mode = 'code'; } else out += ' ';
			i++; continue;
		}
		if (mode === 'block-comment') {
			if (ch === '*' && next === '/') { out += '  '; i += 2; mode = 'code'; continue; }
			out += ch === '\n' ? '\n' : ' '; i++; continue;
		}
		if (mode === 'string') {
			if (ch === '\n') { out += '\n'; i++; continue; }
			if (quote !== '`' && ch === '\\') {
				out += ' ';
				if (i + 1 < source.length) { out += source[i + 1] === '\n' ? '\n' : ' '; i += 2; continue; }
			}
			if (ch === quote) { out += ch; mode = 'code'; quote = null; i++; continue; }
			out += ' '; i++; continue;
		}
		if (lineComment && source.startsWith(lineComment, i)) {
			out += ' '.repeat(lineComment.length); i += lineComment.length; mode = 'line-comment'; continue;
		}
		if (blockComments && ch === '/' && next === '*') { out += '  '; i += 2; mode = 'block-comment'; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { out += ch; quote = ch; mode = 'string'; i++; continue; }
		out += ch; i++;
	}
	return out;
}

export function decodeSimpleStringLiteral(raw) {
	if (typeof raw !== 'string' || raw.length < 2) return null;
	const q = raw[0];
	if (raw.at(-1) !== q || !['"', "'", '`'].includes(q)) return null;
	if (q === '`') return raw.slice(1, -1);
	try {
		if (q === '"') return JSON.parse(raw);
	} catch { return null; }
	return null;
}

export function stableSortRoutes(routes) {
	return routes.sort((a, b) => a.source.index - b.source.index || a.method.localeCompare(b.method) || a.path.localeCompare(b.path));
}
