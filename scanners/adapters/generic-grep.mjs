// Non-Java fallback: route-pattern grep across common frameworks. Explicitly lower confidence
// than the java-spring adapter (see scanners/index.mjs) -- this is a safety net, not a target.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROUTE_PATTERNS = [
	{ re: /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi, framework: 'express' },
	{ re: /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi, framework: 'express-router' },
	{ re: /@app\.route\(\s*["']([^"']+)["']/g, framework: 'flask' },
	{ re: /@router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/gi, framework: 'fastapi' },
];

function listCandidateFiles(repoRoot) {
	try {
		const out = execFileSync('rg', ['--files', '-g', '*.{js,ts,mjs,py}', repoRoot], { encoding: 'utf8' });
		return out.split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

export function scanGenericGrep(repoRoot) {
	const routes = [];
	for (const file of listCandidateFiles(repoRoot)) {
		const text = fs.readFileSync(file, 'utf8');
		for (const { re, framework } of ROUTE_PATTERNS) {
			for (const m of text.matchAll(re)) {
				routes.push({ framework, path: m[2] ?? m[1], file });
			}
		}
	}
	if (routes.length === 0) return { modules: [] };
	return {
		modules: [{
			module: '_generic',
			controllers: routes.map((r) => ({
				className: r.framework,
				basePath: r.path,
				operationIds: [],
				endpoints: [{ verb: '?', path: r.path, operationId: null }],
				file: r.file,
			})),
			entities: [],
			enums: [],
			dtos: [],
		}],
	};
}
