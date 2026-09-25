import { joinRoutePath, lineNumberAt, maskCommentsPreserveStrings, stableSortRoutes } from './shared.mjs';

const HTTP_ATTRS = new Map([
	['HttpGet', 'GET'], ['HttpPost', 'POST'], ['HttpPut', 'PUT'], ['HttpPatch', 'PATCH'],
	['HttpDelete', 'DELETE'], ['HttpHead', 'HEAD'], ['HttpOptions', 'OPTIONS'],
]);
const MINIMAL_METHODS = new Map([
	['MapGet', 'GET'], ['MapPost', 'POST'], ['MapPut', 'PUT'], ['MapPatch', 'PATCH'],
	['MapDelete', 'DELETE'], ['MapMethods', null],
]);

function findMatchingBrace(masked, open) {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === '{') depth++;
		else if (masked[i] === '}' && --depth === 0) return i;
	}
	return -1;
}

function literalFromArgs(source, masked, openParen) {
	let i = openParen + 1;
	while (/\s/.test(masked[i] ?? '')) i++;
	if (source[i] !== '"') {
		let end = i; while (end < masked.length && ![',', ')'].includes(masked[end])) end++;
		return { literal: null, raw: source.slice(i, end).trim(), end };
	}
	let j = i + 1;
	while (j < source.length) {
		if (source[j] === '\\') { j += 2; continue; }
		if (source[j] === '"') break;
		j++;
	}
	if (j >= source.length) return { literal: null, raw: source.slice(i).trim(), end: source.length };
	const raw = source.slice(i, j + 1);
	try { return { literal: JSON.parse(raw), raw, end: j + 1 }; } catch { return { literal: null, raw, end: j + 1 }; }
}

function normalizeRouteTokens(route, className, actionName = null) {
	const controller = className.replace(/Controller$/, '');
	let out = route.replace(/\[controller\]/gi, controller);
	if (actionName) out = out.replace(/\[action\]/gi, actionName);
	return out;
}

function combineControllerRoute(classRoute, actionRoute) {
	if (actionRoute?.startsWith('~/')) return joinRoutePath('', actionRoute.slice(2));
	if (actionRoute?.startsWith('/')) return joinRoutePath('', actionRoute);
	if (classRoute == null) return actionRoute ? joinRoutePath('', actionRoute) : null;
	return joinRoutePath(classRoute, actionRoute ?? '');
}

function attributesBefore(masked, source, absoluteStart) {
	let cursor = absoluteStart;
	const attrs = [];
	while (cursor > 0) {
		let lineEnd = cursor;
		if (lineEnd > 0 && masked[lineEnd - 1] === '\n') lineEnd--;
		const lineStart = masked.lastIndexOf('\n', lineEnd - 1) + 1;
		const line = masked.slice(lineStart, lineEnd).trim();
		if (!line) {
			if (lineStart >= cursor) break;
			cursor = lineStart;
			continue;
		}
		const m = line.match(/^\[([A-Za-z_]\w*)(?:\s*\((.*)\))?\]\s*$/s);
		if (!m) break;
		const rawLine = source.slice(lineStart, lineEnd).trim();
		const real = rawLine.match(/^\[([A-Za-z_]\w*)(?:\s*\((.*)\))?\]\s*$/s);
		attrs.unshift({ name: real?.[1] ?? m[1], args: real?.[2] ?? m[2] ?? '', index: lineStart });
		cursor = lineStart;
	}
	return attrs;
}

function quotedArg(args) {
	const m = String(args ?? '').match(/^\s*"((?:\\.|[^"\\])*)"/s);
	if (!m) return null;
	try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

function analyzeControllers(source, masked, file, routes, diagnostics) {
	for (const m of masked.matchAll(/\b(?:public\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)\s*(?::[^\{]+)?\{/g)) {
		const className = m[1];
		if (!/Controller$/.test(className)) continue;
		const open = m.index + m[0].lastIndexOf('{');
		const close = findMatchingBrace(masked, open);
		if (close < 0) continue;
		const classAttrs = attributesBefore(masked, source, m.index);
		const routeAttr = classAttrs.find((a) => a.name === 'Route');
		const classRouteRaw = routeAttr ? quotedArg(routeAttr.args) : null;
		if (routeAttr && classRouteRaw == null) {
			diagnostics.push({ code: 'CSHARP_DYNAMIC_CONTROLLER_ROUTE', severity: 'unknown', file, line: lineNumberAt(source, routeAttr.index), message: `${className} has a non-literal [Route(...)]` });
		}
		const classRoute = classRouteRaw == null ? null : normalizeRouteTokens(classRouteRaw || '', className);
		const body = masked.slice(open + 1, close);
		const memberRe = /\b(?:public|protected|internal|private)[ \t]+(?:async[ \t]+)?(?:[A-Za-z_][\w<>,.?\[\] \t]*[ \t]+)([A-Za-z_]\w*)[ \t]*\(/g;
		for (const mm of body.matchAll(memberRe)) {
			const abs = open + 1 + mm.index;
			const attrs = attributesBefore(masked, source, abs);
			const http = attrs.find((a) => HTTP_ATTRS.has(a.name));
			if (!http) continue;
			const methodPathRaw = http.args ? quotedArg(http.args) : '';
			if (http.args && methodPathRaw == null) {
				diagnostics.push({ code: 'CSHARP_DYNAMIC_ACTION_ROUTE', severity: 'unknown', file, line: lineNumberAt(source, http.index), message: `${className}.${mm[1]} has a non-literal [${http.name}(...)] route` });
				continue;
			}
			const methodRouteAttr = attrs.find((a) => a.name === 'Route');
			const methodRouteRaw = methodRouteAttr ? quotedArg(methodRouteAttr.args) : null;
			if (methodRouteAttr && methodRouteRaw == null) {
				diagnostics.push({ code: 'CSHARP_DYNAMIC_ACTION_ROUTE', severity: 'unknown', file, line: lineNumberAt(source, methodRouteAttr.index), message: `${className}.${mm[1]} has a non-literal [Route(...)]` });
				continue;
			}
			let actionRoute = methodPathRaw || methodRouteRaw || '';
			actionRoute = normalizeRouteTokens(actionRoute, className, mm[1]);
			const finalPath = combineControllerRoute(classRoute, actionRoute);
			if (finalPath == null) {
				diagnostics.push({ code: 'CSHARP_ACTION_ROUTE_UNRESOLVED', severity: 'unknown', file, line: lineNumberAt(source, http.index), message: `${className}.${mm[1]} has no literal class/action route template; conventional routing is not inferred` });
				continue;
			}
			routes.push({ method: HTTP_ATTRS.get(http.name), path: finalPath, handler: `${className}.${mm[1]}`, framework: 'aspnet-core-controller', source: { file, line: lineNumberAt(source, http.index), index: http.index }, confidence: 'static-literal' });
		}
	}
}

function analyzeMinimal(source, masked, file, routes, diagnostics, groups) {
	const prefixes = new Map([['app', '']]);
	const decls = [];
	for (const m of masked.matchAll(/\b(?:var|[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.MapGroup\s*\(/g)) {
		const open = m.index + m[0].lastIndexOf('(');
		decls.push({ kind: 'group', index: m.index, variable: m[1], parent: m[2], arg: literalFromArgs(source, masked, open) });
	}
	for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\.(MapGet|MapPost|MapPut|MapPatch|MapDelete|MapMethods)\s*\(/g)) {
		const open = m.index + m[0].lastIndexOf('(');
		decls.push({ kind: 'route', index: m.index, receiver: m[1], call: m[2], arg: literalFromArgs(source, masked, open) });
	}
	decls.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
	for (const d of decls) {
		const line = lineNumberAt(source, d.index);
		if (d.kind === 'group') {
			if (!prefixes.has(d.parent)) continue;
			if (d.arg.literal == null) {
				diagnostics.push({ code: 'CSHARP_DYNAMIC_GROUP_PATH', severity: 'unknown', file, line, message: `${d.variable} MapGroup uses a non-literal path (${d.arg.raw || 'expression'})` });
				continue;
			}
			const prefix = joinRoutePath(prefixes.get(d.parent), d.arg.literal);
			prefixes.set(d.variable, prefix);
			groups.push({ variable: d.variable, parent: d.parent, prefix, path: d.arg.literal, source: { file, line, index: d.index } });
			continue;
		}
		if (!prefixes.has(d.receiver)) continue;
		if (d.arg.literal == null) {
			diagnostics.push({ code: 'CSHARP_DYNAMIC_MINIMAL_ROUTE', severity: 'unknown', file, line, message: `${d.receiver}.${d.call} uses a non-literal route path (${d.arg.raw || 'expression'})` });
			continue;
		}
		const method = MINIMAL_METHODS.get(d.call);
		if (!method) {
			diagnostics.push({ code: 'CSHARP_MAPMETHODS_NEEDS_METHOD_SET', severity: 'unknown', file, line, message: 'MapMethods route path is known, but the HTTP method set is not parsed in the T08 pilot' });
			continue;
		}
		routes.push({ method, path: joinRoutePath(prefixes.get(d.receiver), d.arg.literal), handler: null, framework: 'aspnet-core-minimal', source: { file, line, index: d.index }, confidence: 'static-literal' });
	}
}

export function analyzeCSharpAspNetSource(source, { file = '<memory>' } = {}) {
	if (typeof source !== 'string') throw new TypeError('source must be a string');
	const masked = maskCommentsPreserveStrings(source);
	const routes = [];
	const diagnostics = [];
	const groups = [];
	analyzeMinimal(source, masked, file, routes, diagnostics, groups);
	analyzeControllers(source, masked, file, routes, diagnostics);
	return {
		language: 'csharp', framework: routes.length || groups.length ? 'aspnet-core' : null,
		routes: stableSortRoutes(routes), groups,
		diagnostics: diagnostics.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code)),
		limitations: [
			'Only literal Minimal API MapGroup/Map* routes and direct controller [Route]/[Http*] attributes are resolved.',
			'Inherited attributes, conventions, endpoint filters, ApiExplorer metadata, generated code, and MapMethods method arrays remain explicit unknowns or unsupported in this pilot.',
		],
	};
}
