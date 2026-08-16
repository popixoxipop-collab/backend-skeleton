// Non-Java fallback: route-pattern grep across common frameworks. Explicitly lower confidence
// than the java-spring adapter (see scanners/index.mjs) -- this is a safety net, not a target.
// G3: reconnaissance only -- see D-generic-grep-reconnaissance in DECISIONS.md for why this
// stays deliberately shallow (no module inference, no confidence scoring without real corpus
// data to calibrate it) rather than growing into a second real adapter.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Verb capture group index: express/express-router/fastapi all capture the HTTP verb in m[1].
// flask's `@app.route(...)` has no verb group (it defaults to GET unless a `methods=[...]`
// kwarg is present, which isn't parsed here -- that's not "cheap" the way the other three are).
//
// express-router's `router\.(get|...)\(` and fastapi's `@router\.(get|...)\(` share the bare
// `router.get(` substring -- without the `(?<!@)` negative lookbehind below, FastAPI's
// `@router.get(...)` matched BOTH patterns, double-counting every FastAPI route once as
// "express-router" and once as "fastapi" (found while grouping routes by file for the scoring
// fix below -- it was silently inflating the flat per-route list before, just less visibly).
const ROUTE_PATTERNS = [
	{ re: /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi, framework: 'express', hasVerb: true },
	{ re: /(?<!@)router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi, framework: 'express-router', hasVerb: true },
	{ re: /@app\.route\(\s*["']([^"']+)["']/g, framework: 'flask', hasVerb: false },
	{ re: /@router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/gi, framework: 'fastapi', hasVerb: true },
];

// O6: rg --files order isn't guaranteed (no --sort -- ripgrep's own docs say the default is
// unordered/parallel) -- without sorting, two runs against an unchanged repo could produce
// controllers in a different order, causing spurious output diffs. See java-spring.mjs's
// listJavaFiles for the same fix.
function listCandidateFiles(repoRoot) {
	try {
		const out = execFileSync('rg', ['--files', '-g', '*.{js,ts,mjs,py}', repoRoot], { encoding: 'utf8' });
		return out.split('\n').filter(Boolean).sort();
	} catch {
		return [];
	}
}

function lineNumberAt(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}

// Segment-aware longest common prefix -- '/users' and '/users/:id' share '/users', but '/us'
// (a naive character-wise prefix) is not a real route segment and would be a misleading
// basePath. A single route is trivially its own "common prefix". Falls back to '/' when there's
// no shared segment beyond the root.
function commonPathPrefix(paths) {
	const segmentLists = paths.map((p) => p.split('/').filter(Boolean));
	const shortest = Math.min(...segmentLists.map((s) => s.length));
	const shared = [];
	for (let i = 0; i < shortest; i++) {
		const seg = segmentLists[0][i];
		if (segmentLists.every((s) => s[i] === seg)) shared.push(seg);
		else break;
	}
	return shared.length > 0 ? `/${shared.join('/')}` : '/';
}

export function scanGenericGrep(repoRoot) {
	const routes = [];
	for (const file of listCandidateFiles(repoRoot)) {
		const text = fs.readFileSync(file, 'utf8');
		for (const { re, framework, hasVerb } of ROUTE_PATTERNS) {
			for (const m of text.matchAll(re)) {
				const verb = hasVerb ? m[1].toUpperCase() : '?';
				const routePath = hasVerb ? m[2] : m[1];
				routes.push({ framework, verb, path: routePath, file, line: lineNumberAt(text, m.index) });
			}
		}
	}
	if (routes.length === 0) return { modules: [] };

	// Group by source file -- the natural code-module boundary for this adapter, the same role a
	// controller class plays for java-spring. Before this, every matched route became its own
	// separate fake "controller", so scoreModule()'s className match (+6 per controller) was
	// counted once PER ROUTE instead of once per file -- a repo with 50 express routes would
	// score 300 on the term "express" alone, regardless of actual module relevance.
	const byFile = new Map();
	for (const r of routes) {
		if (!byFile.has(r.file)) byFile.set(r.file, []);
		byFile.get(r.file).push(r);
	}
	const controllers = [...byFile.entries()].map(([file, fileRoutes]) => ({
		className: fileRoutes[0].framework,
		basePath: commonPathPrefix(fileRoutes.map((r) => r.path)),
		operationIds: [],
		endpoints: fileRoutes.map((r) => ({ verb: r.verb, path: r.path, operationId: null, line: r.line })),
		file,
	}));

	return { modules: [{ module: '_generic', controllers, entities: [], enums: [], dtos: [] }] };
}

// G1: adapter descriptor consumed by scanners/registry.mjs -- see D-adapter-registry in
// DECISIONS.md. `id` must equal this file's stem ("generic-grep"). specificity 0: unconditional
// last-resort fallback -- detect() always returns true, even when it finds zero routes, matching
// the pre-G1 semantics where "java-spring failed to detect" always meant "generic-grep is used",
// regardless of what generic-grep itself finds. See D-generic-grep-reconnaissance for why every
// capability below is honestly false rather than a best-effort partial implementation.
export const adapter = {
	contract: 'sbf.adapter/1',
	id: 'generic-grep',
	title: 'Generic route-pattern grep (fallback)',
	specificity: 0,
	confidence: 'low',
	capabilities: {
		'api.operations': false,
		'api.request-shape': false,
		'resource.fetch': false,
		'codegen.handles': false,
	},
	detect() {
		return true;
	},
	scan(repoRoot, _detection) {
		return scanGenericGrep(repoRoot);
	},
	diagnostics() {
		return [{ level: 'info', code: 'always-detects', message: 'this is the unconditional last-resort fallback adapter (specificity 0) -- it always "detects"' }];
	},
};
