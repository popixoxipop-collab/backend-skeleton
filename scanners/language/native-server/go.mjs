import { decodeSimpleStringLiteral, joinRoutePath, lineNumberAt, maskNonCodePreserveDelimiters, stableSortRoutes } from './shared.mjs';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any']);
const SIMPLE_HANDLER = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function stringTokenAt(source, start) {
	const q = source[start];
	if (q !== '"' && q !== '`') return null;
	let i = start + 1;
	while (i < source.length) {
		if (q === '"' && source[i] === '\\') { i += 2; continue; }
		if (source[i] === q) return { raw: source.slice(start, i + 1), end: i + 1 };
		i++;
	}
	return null;
}

function firstArgAfter(masked, source, openParen) {
	let i = openParen + 1;
	while (/\s/.test(masked[i] ?? '')) i++;
	const literal = stringTokenAt(source, i);
	if (literal) return { literal: decodeSimpleStringLiteral(literal.raw), raw: literal.raw, end: literal.end };
	let end = i;
	let depth = 0;
	while (end < masked.length) {
		const c = masked[end];
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
		else if (c === ',' && depth === 0) break;
		end++;
	}
	return { literal: null, raw: source.slice(i, end).trim(), end };
}

function secondArgSimpleHandler(masked, source, from) {
	let i = from;
	while (i < masked.length && masked[i] !== ',') i++;
	if (masked[i] !== ',') return null;
	i++;
	while (/\s/.test(masked[i] ?? '')) i++;
	const m = masked.slice(i).match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/);
	return m && SIMPLE_HANDLER.test(m[1]) ? m[1] : null;
}

export function analyzeGoGinSource(source, { file = '<memory>' } = {}) {
	if (typeof source !== 'string') throw new TypeError('source must be a string');
	const masked = maskNonCodePreserveDelimiters(source);
	const routers = new Map();
	const groups = [];
	const routes = [];
	const diagnostics = [];

	const declarations = [];
	for (const m of masked.matchAll(/\b(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|=)\s*gin\.(Default|New)\s*\(\s*\)/g)) {
		declarations.push({ kind: 'root', index: m.index, variable: m[1] });
	}
	for (const m of masked.matchAll(/\b(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|=)\s*([A-Za-z_]\w*)\.Group\s*\(/g)) {
		const openParen = m.index + m[0].lastIndexOf('(');
		const arg = firstArgAfter(masked, source, openParen);
		declarations.push({ kind: 'group', index: m.index, variable: m[1], parent: m[2], arg });
	}
	for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\s*\(/g)) {
		const openParen = m.index + m[0].lastIndexOf('(');
		const arg = firstArgAfter(masked, source, openParen);
		declarations.push({ kind: 'route', index: m.index, receiver: m[1], method: m[2], arg, handler: secondArgSimpleHandler(masked, source, arg.end) });
	}
	declarations.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));

	for (const d of declarations) {
		const line = lineNumberAt(source, d.index);
		if (d.kind === 'root') {
			routers.set(d.variable, { prefix: '', parent: null });
			continue;
		}
		if (d.kind === 'group') {
			const parent = routers.get(d.parent);
			if (!parent) {
				diagnostics.push({ code: 'GO_GIN_UNKNOWN_GROUP_PARENT', severity: 'unknown', file, line, message: `cannot resolve Gin group parent ${d.parent}` });
				continue;
			}
			if (d.arg.literal == null) {
				diagnostics.push({ code: 'GO_GIN_DYNAMIC_GROUP_PATH', severity: 'unknown', file, line, message: `group ${d.variable} uses a non-literal path (${d.arg.raw || 'expression'})` });
				continue;
			}
			const prefix = joinRoutePath(parent.prefix, d.arg.literal);
			routers.set(d.variable, { prefix, parent: d.parent });
			groups.push({ variable: d.variable, parent: d.parent, prefix, path: d.arg.literal, source: { file, line, index: d.index } });
			continue;
		}
		if (d.kind === 'route') {
			const receiver = routers.get(d.receiver);
			if (!receiver) continue;
			if (!HTTP_METHODS.has(d.method)) continue;
			if (d.arg.literal == null) {
				diagnostics.push({ code: 'GO_GIN_DYNAMIC_ROUTE_PATH', severity: 'unknown', file, line, message: `${d.receiver}.${d.method} uses a non-literal route path (${d.arg.raw || 'expression'})` });
				continue;
			}
			routes.push({ method: d.method === 'Any' ? 'ANY' : d.method, path: joinRoutePath(receiver.prefix, d.arg.literal), handler: d.handler, framework: 'gin', source: { file, line, index: d.index }, confidence: 'static-literal' });
		}
	}

	return {
		language: 'go', framework: routers.size ? 'gin' : null,
		routes: stableSortRoutes(routes), groups,
		diagnostics: diagnostics.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code)),
		limitations: [
			'Only literal Gin router/group paths assigned to local variables are resolved.',
			'Computed paths, wrapper functions, generated registrations, build tags, and generic helper factories are intentionally not inferred.',
		],
	};
}
