import { joinRoutePath, lineNumberAt, stableSortRoutes } from './shared.mjs';

const AXUM_METHODS = new Map([
	['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['delete', 'DELETE'],
	['head', 'HEAD'], ['options', 'OPTIONS'], ['trace', 'TRACE'], ['any', 'ANY'],
]);
const ACTIX_METHODS = new Map([
	['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['delete', 'DELETE'],
	['head', 'HEAD'], ['method', null],
]);
const SIMPLE_PATH = /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;

function spacesKeepingNewlines(text) {
	return text.replace(/[^\n]/g, ' ');
}

function maskRustNonCode(source) {
	let out = '';
	let i = 0;
	let blockDepth = 0;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];

		if (blockDepth > 0) {
			if (ch === '/' && next === '*') { out += '  '; i += 2; blockDepth++; continue; }
			if (ch === '*' && next === '/') { out += '  '; i += 2; blockDepth--; continue; }
			out += ch === '\n' ? '\n' : ' '; i++; continue;
		}
		if (ch === '/' && next === '/') {
			const end = source.indexOf('\n', i + 2);
			const stop = end < 0 ? source.length : end;
			out += ' '.repeat(stop - i);
			i = stop;
			continue;
		}
		if (ch === '/' && next === '*') { out += '  '; i += 2; blockDepth = 1; continue; }

		// Rust raw strings: r"...", r#"..."#, br##"..."##. Prefix bytes stay visible,
		// bodies are blanked so route-looking text inside data cannot become code.
		const raw = source.slice(i).match(/^(?:br|r)(#{0,16})"/);
		if (raw) {
			const hashes = raw[1];
			const openLen = raw[0].length;
			const close = '"' + hashes;
			const end = source.indexOf(close, i + openLen);
			if (end < 0) {
				out += spacesKeepingNewlines(source.slice(i));
				break;
			}
			out += raw[0];
			out += spacesKeepingNewlines(source.slice(i + openLen, end));
			out += close;
			i = end + close.length;
			continue;
		}

		// Normal/byte strings. Preserve delimiters, blank content.
		if (ch === '"' || (ch === 'b' && next === '"')) {
			const prefix = ch === 'b' ? 'b"' : '"';
			out += prefix;
			i += prefix.length;
			while (i < source.length) {
				const c = source[i];
				if (c === '\n') { out += '\n'; i++; continue; }
				if (c === '\\') {
					out += ' ';
					if (i + 1 < source.length) { out += source[i + 1] === '\n' ? '\n' : ' '; i += 2; continue; }
				}
				if (c === '"') { out += '"'; i++; break; }
				out += ' '; i++;
			}
			continue;
		}

		// Character literals are short and closed; lifetimes ('a / 'static) are left as code.
		if (ch === "'") {
			let j = i + 1;
			if (source[j] === '\\') j += 2; else j += 1;
			if (source[j] === "'") {
				out += "'";
				out += spacesKeepingNewlines(source.slice(i + 1, j));
				out += "'";
				i = j + 1;
				continue;
			}
		}

		out += ch;
		i++;
	}
	return out;
}

function matchBalanced(masked, open, left = '(', right = ')') {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === left) depth++;
		else if (masked[i] === right && --depth === 0) return i;
	}
	return -1;
}

function findStatementEnd(masked, start) {
	let paren = 0, bracket = 0, brace = 0;
	for (let i = start; i < masked.length; i++) {
		const c = masked[i];
		if (c === '(') paren++;
		else if (c === ')') paren = Math.max(0, paren - 1);
		else if (c === '[') bracket++;
		else if (c === ']') bracket = Math.max(0, bracket - 1);
		else if (c === '{') brace++;
		else if (c === '}') brace = Math.max(0, brace - 1);
		else if (c === ';' && paren === 0 && bracket === 0 && brace === 0) return i;
	}
	return masked.length;
}

function splitTopLevelArgs(masked, start, end) {
	const parts = [];
	let partStart = start;
	let paren = 0, bracket = 0, brace = 0, angle = 0;
	for (let i = start; i < end; i++) {
		const c = masked[i];
		if (c === '(') paren++;
		else if (c === ')') paren--;
		else if (c === '[') bracket++;
		else if (c === ']') bracket--;
		else if (c === '{') brace++;
		else if (c === '}') brace--;
		else if (c === '<') angle++;
		else if (c === '>') angle = Math.max(0, angle - 1);
		else if (c === ',' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
			parts.push([partStart, i]);
			partStart = i + 1;
		}
	}
	parts.push([partStart, end]);
	return parts;
}

function trimRange(masked, start, end) {
	while (start < end && /\s/.test(masked[start])) start++;
	while (end > start && /\s/.test(masked[end - 1])) end--;
	return [start, end];
}

function rustStringLiteral(source, masked, start, end) {
	[start, end] = trimRange(masked, start, end);
	if (source[start] !== '"') return null;
	let i = start + 1;
	while (i < end) {
		if (source[i] === '\\') { i += 2; continue; }
		if (source[i] === '"') {
			if (i + 1 !== end) return null;
			const raw = source.slice(start, i + 1);
			try { return JSON.parse(raw); } catch { return null; }
		}
		i++;
	}
	return null;
}

function simpleIdentifier(source, masked, start, end) {
	[start, end] = trimRange(masked, start, end);
	const raw = source.slice(start, end).trim();
	return SIMPLE_PATH.test(raw) ? raw : null;
}

function parseAxumMethodRouter(source, masked, start, end) {
	const text = masked.slice(start, end);
	const methods = [];
	const re = /(?:^|\.)\s*(get|post|put|patch|delete|head|options|trace|any)\s*\(/g;
	for (const m of text.matchAll(re)) {
		const methodName = m[1];
		const localOpen = m.index + m[0].lastIndexOf('(');
		const open = start + localOpen;
		const close = matchBalanced(masked, open);
		if (close < 0 || close > end) continue;
		const args = splitTopLevelArgs(masked, open + 1, close);
		const handler = args.length ? simpleIdentifier(source, masked, args[0][0], args[0][1]) : null;
		methods.push({ method: AXUM_METHODS.get(methodName), handler });
	}
	return methods;
}

function parseActixHandler(source, masked, start, end) {
	const text = masked.slice(start, end);
	const m = text.match(/\bweb::(get|post|put|patch|delete|head|method)\s*\(\s*\)\s*\.to\s*\(/);
	if (!m) return null;
	const method = ACTIX_METHODS.get(m[1]);
	if (!method) return { method: null, handler: null, unsupported: 'method' };
	const open = start + m.index + m[0].lastIndexOf('(');
	const close = matchBalanced(masked, open);
	if (close < 0 || close > end) return { method, handler: null };
	const handler = simpleIdentifier(source, masked, open + 1, close);
	return { method, handler };
}

function parseCallArgs(source, masked, open) {
	const close = matchBalanced(masked, open);
	if (close < 0) return null;
	return { close, parts: splitTopLevelArgs(masked, open + 1, close) };
}

function cloneRouterState(state) {
	return {
		localRoutes: state ? state.localRoutes.map((r) => ({ ...r })) : [],
		nests: state ? state.nests.map((n) => ({ ...n })) : [],
	};
}

function parseAxum(source, masked, file, diagnostics) {
	const routers = new Map();
	const declarations = [];
	const letRe = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]+)?=\s*/g;
	for (const m of masked.matchAll(letRe)) {
		const exprStart = m.index + m[0].length;
		const end = findStatementEnd(masked, exprStart);
		const expr = masked.slice(exprStart, end);
		if (!/\bRouter(?:(?:::\s*)?<[^;=]+>)?::new\s*\(\s*\)/.test(expr) && !/^[A-Za-z_]\w*\s*\./.test(expr.trim())) continue;
		declarations.push({ variable: m[1], index: m.index, exprStart, end });
	}

	for (const d of declarations) {
		const exprMasked = masked.slice(d.exprStart, d.end);
		const exprOriginal = source.slice(d.exprStart, d.end);
		const rootMatch = exprMasked.match(/^\s*Router(?:(?:::\s*)?<[^>]+>)?::new\s*\(\s*\)/);
		const baseMatch = rootMatch ? null : exprMasked.match(/^\s*([A-Za-z_]\w*)\b/);
		let state = rootMatch ? cloneRouterState(null) : cloneRouterState(baseMatch ? routers.get(baseMatch[1]) : null);
		if (!rootMatch && (!baseMatch || !routers.has(baseMatch[1]))) {
			diagnostics.push({ code: 'RUST_AXUM_UNKNOWN_ROUTER_BASE', severity: 'unknown', file, line: lineNumberAt(source, d.index), message: `${d.variable} is derived from an unresolved Axum router expression` });
			continue;
		}
		const chainRe = /\.(route|nest|merge)\s*\(/g;
		for (const c of exprMasked.matchAll(chainRe)) {
			const open = d.exprStart + c.index + c[0].lastIndexOf('(');
			const parsed = parseCallArgs(source, masked, open);
			if (!parsed || parsed.close > d.end) continue;
			const line = lineNumberAt(source, d.exprStart + c.index);
			if (c[1] === 'merge') {
				if (!parsed.parts.length) continue;
				const child = simpleIdentifier(source, masked, parsed.parts[0][0], parsed.parts[0][1]);
				if (!child || !routers.has(child)) {
					diagnostics.push({ code: 'RUST_AXUM_UNKNOWN_MERGE', severity: 'unknown', file, line, message: 'Axum merge() target is not a previously resolved router variable' });
					continue;
				}
				state.localRoutes.push(...routers.get(child).localRoutes.map((r) => ({ ...r })));
				state.nests.push(...routers.get(child).nests.map((n) => ({ ...n })));
				continue;
			}
			if (parsed.parts.length < 2) continue;
			const routePath = rustStringLiteral(source, masked, parsed.parts[0][0], parsed.parts[0][1]);
			if (routePath == null) {
				diagnostics.push({ code: c[1] === 'nest' ? 'RUST_AXUM_DYNAMIC_NEST_PATH' : 'RUST_AXUM_DYNAMIC_ROUTE_PATH', severity: 'unknown', file, line, message: `Axum .${c[1]}() uses a non-literal path` });
				continue;
			}
			if (c[1] === 'nest') {
				const child = simpleIdentifier(source, masked, parsed.parts[1][0], parsed.parts[1][1]);
				if (!child || !routers.has(child)) {
					diagnostics.push({ code: 'RUST_AXUM_UNKNOWN_NEST_TARGET', severity: 'unknown', file, line, message: `Axum nest ${routePath} targets an unresolved router expression` });
					continue;
				}
				state.nests.push({ prefix: routePath, child, source: { file, line, index: d.exprStart + c.index } });
				continue;
			}
			const methods = parseAxumMethodRouter(source, masked, parsed.parts[1][0], parsed.parts[1][1]);
			if (!methods.length) {
				diagnostics.push({ code: 'RUST_AXUM_UNKNOWN_METHOD_ROUTER', severity: 'unknown', file, line, message: `Axum route ${routePath} uses an unsupported/non-literal MethodRouter expression` });
				continue;
			}
			for (const method of methods) state.localRoutes.push({
				method: method.method, path: routePath, handler: method.handler, framework: 'axum',
				source: { file, line, index: d.exprStart + c.index }, confidence: 'static-literal',
			});
		}
		routers.set(d.variable, state);
	}

	const referenced = new Set();
	for (const state of routers.values()) for (const n of state.nests) referenced.add(n.child);
	const roots = [...routers.keys()].filter((name) => !referenced.has(name));
	const routes = [];
	const expand = (name, prefix, stack = new Set()) => {
		if (stack.has(name)) {
			diagnostics.push({ code: 'RUST_AXUM_NEST_CYCLE', severity: 'unknown', file, line: null, message: `Axum router nesting cycle includes ${name}` });
			return;
		}
		const state = routers.get(name);
		if (!state) return;
		const next = new Set(stack); next.add(name);
		for (const r of state.localRoutes) routes.push({ ...r, path: joinRoutePath(prefix, r.path) });
		for (const n of state.nests) expand(n.child, joinRoutePath(prefix, n.prefix), next);
	};
	for (const root of roots) expand(root, '');
	return { routes, routers: [...routers.keys()].sort() };
}

function chainEnd(masked, start) {
	let i = start;
	let paren = 0, bracket = 0, brace = 0;
	for (; i < masked.length; i++) {
		const c = masked[i];
		if (c === '(') paren++;
		else if (c === ')') {
			if (paren === 0) break;
			paren--;
		}
		else if (c === '[') bracket++;
		else if (c === ']') bracket = Math.max(0, bracket - 1);
		else if (c === '{') brace++;
		else if (c === '}') {
			if (brace === 0 && paren === 0 && bracket === 0) break;
			brace = Math.max(0, brace - 1);
		}
		else if ((c === ',' || c === ';') && paren === 0 && bracket === 0 && brace === 0) break;
	}
	return i;
}

function parseActixRouteCalls(source, masked, start, end, prefix, file, diagnostics, skipRanges = []) {
	const routes = [];
	const slice = masked.slice(start, end);
	const re = /\.route\s*\(/g;
	for (const m of slice.matchAll(re)) {
		const absolute = start + m.index;
		if (skipRanges.some(([a, b]) => absolute >= a && absolute < b)) continue;
		const open = absolute + m[0].lastIndexOf('(');
		const parsed = parseCallArgs(source, masked, open);
		if (!parsed || parsed.close > end || parsed.parts.length < 2) continue;
		const line = lineNumberAt(source, absolute);
		const routePath = rustStringLiteral(source, masked, parsed.parts[0][0], parsed.parts[0][1]);
		if (routePath == null) {
			diagnostics.push({ code: 'RUST_ACTIX_DYNAMIC_ROUTE_PATH', severity: 'unknown', file, line, message: 'Actix .route() uses a non-literal path' });
			continue;
		}
		const handlerSlice = masked.slice(parsed.parts[1][0], parsed.parts[1][1]).trim();
		if (!handlerSlice.startsWith('web::')) continue; // another framework's .route(), not an Actix claim
		const handler = parseActixHandler(source, masked, parsed.parts[1][0], parsed.parts[1][1]);
		if (!handler || !handler.method) {
			diagnostics.push({ code: 'RUST_ACTIX_UNKNOWN_ROUTE_HANDLER', severity: 'unknown', file, line, message: `Actix route ${routePath} uses an unsupported route handler/method expression` });
			continue;
		}
		routes.push({ method: handler.method, path: joinRoutePath(prefix, routePath), handler: handler.handler, framework: 'actix-web', source: { file, line, index: absolute }, confidence: 'static-literal' });
	}
	return routes;
}

function parseActix(source, masked, file, diagnostics) {
	const routes = [];
	if (!/\b(?:App::new|web::scope|web::(?:get|post|put|patch|delete|head|method)\s*\()/.test(masked)) return { routes };
	const scopeRanges = [];
	for (const m of masked.matchAll(/\bweb::scope\s*\(/g)) {
		const open = m.index + m[0].lastIndexOf('(');
		const parsed = parseCallArgs(source, masked, open);
		if (!parsed || !parsed.parts.length) continue;
		const prefix = rustStringLiteral(source, masked, parsed.parts[0][0], parsed.parts[0][1]);
		const line = lineNumberAt(source, m.index);
		if (prefix == null) {
			diagnostics.push({ code: 'RUST_ACTIX_DYNAMIC_SCOPE_PATH', severity: 'unknown', file, line, message: 'Actix web::scope() uses a non-literal path' });
			continue;
		}
		const end = chainEnd(masked, parsed.close + 1);
		scopeRanges.push([m.index, end]);
		routes.push(...parseActixRouteCalls(source, masked, parsed.close + 1, end, prefix, file, diagnostics));
	}
	// Direct App/resource-builder route calls outside already parsed scope expressions.
	routes.push(...parseActixRouteCalls(source, masked, 0, masked.length, '', file, diagnostics, scopeRanges));
	return { routes };
}

export function analyzeRustServerSource(source, { file = '<memory>' } = {}) {
	if (typeof source !== 'string') throw new TypeError('source must be a string');
	const masked = maskRustNonCode(source);
	const diagnostics = [];
	const axum = parseAxum(source, masked, file, diagnostics);
	const actix = parseActix(source, masked, file, diagnostics);
	const routes = stableSortRoutes([...axum.routes, ...actix.routes]);
	const frameworks = [...new Set(routes.map((r) => r.framework))].sort();
	return {
		language: 'rust',
		framework: frameworks.length === 1 ? frameworks[0] : (frameworks.length > 1 ? 'rust-mixed-http' : null),
		routes,
		groups: [],
		diagnostics: diagnostics.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code)),
		limitations: [
			'Only literal Axum Router::new() let-bindings with route/nest/merge and literal Actix .route()/web::scope() forms are considered.',
			'Macros, generated code, proc-macro expansion, build scripts, arbitrary tower layers, Actix resource/configure factories, and compiler/type semantics are not executed or inferred.',
			'Raw/normal string contents and comments are masked before structural matching so route-looking data cannot become code.',
		],
	};
}
