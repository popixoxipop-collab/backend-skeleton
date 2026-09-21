// Ruby on Rails scanner adapter. The default path is deliberately static and never boots the
// target application. `bskel scan --runtime-routes` is the explicit opt-in that calls the
// framework's own `bin/rails routes --expanded`; see introspectRailsRoutes() below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { byShallowestThenName, binaryAvailable, lineNumberAt, listRgFiles } from '../text-util.mjs';

// Large Rails applications may depend on the component gems directly instead of the `rails`
// meta-gem (Discourse does this with `railties` plus action*/active*). `railties` is the precise
// boot/framework marker; the Rails::Application + routes.rb checks below still prevent a library
// that merely depends on railties from being mistaken for an application.
const RAILS_DEP_RE = /(?:^|\n)\s*(?:gem\s*[ (]?\s*["'](?:rails|railties)["']|(?:rails|railties)\s*\()/m;
const RAILS_APP_RE = /class\s+[A-Z]\w*(?:::[A-Z]\w*)*\s*<\s*Rails::Application\b/;
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const RESOURCE_ACTIONS = Object.freeze(['index', 'create', 'new', 'show', 'edit', 'update', 'destroy']);
// These are rooted at the detected Rails project. A `!**/tmp/**` form also matches an absolute
// checkout path under the operating system's /tmp directory and excludes the entire repo on
// Linux (the real oracle harness clones there), not merely Rails' own tmp/ subtree.
const EXCLUDE_GLOBS = ['!.bundle/**', '!vendor/bundle/**', '!tmp/**', '!log/**', '!node_modules/**'];

function railsFiles(root, globs) {
	return listRgFiles(root, globs, EXCLUDE_GLOBS);
}

function rubyFilesUnder(projectRoot, prefixes) {
	return railsFiles(projectRoot, ['*.rb']).filter((file) => {
		const rel = path.relative(projectRoot, file).split(path.sep).join('/');
		return prefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
	});
}

function routeFiles(projectRoot) {
	return rubyFilesUnder(projectRoot, ['config/routes.rb', 'config/routes']);
}

function railsReadFiles(projectRoot) {
	const markers = railsFiles(projectRoot, ['Gemfile', 'Gemfile.lock']);
	const ruby = rubyFilesUnder(projectRoot, ['config', 'app/controllers', 'app/models', 'lib']);
	return [...new Set([...markers, ...ruby])].sort();
}

function candidateProjectRoots(repoRoot) {
	const roots = new Set();
	for (const file of railsFiles(repoRoot, ['Gemfile', 'Gemfile.lock'])) roots.add(path.dirname(file));
	return [...roots].sort(byShallowestThenName);
}

function declaresRails(projectRoot) {
	for (const name of ['Gemfile', 'Gemfile.lock']) {
		const file = path.join(projectRoot, name);
		try {
			if (RAILS_DEP_RE.test(fs.readFileSync(file, 'utf8'))) return true;
		} catch {
			// optional marker file
		}
	}
	return false;
}

export function detectRubyRailsRoot(repoRoot) {
	for (const projectRoot of candidateProjectRoots(repoRoot)) {
		if (!declaresRails(projectRoot)) continue;
		const application = path.join(projectRoot, 'config', 'application.rb');
		const routes = path.join(projectRoot, 'config', 'routes.rb');
		if (!fs.existsSync(application) || !fs.existsSync(routes)) continue;
		try {
			if (!RAILS_APP_RE.test(fs.readFileSync(application, 'utf8'))) continue;
		} catch {
			continue;
		}
		return projectRoot;
	}
	return null;
}

function stripComment(line) {
	let quote = null;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (escaped) { escaped = false; continue; }
		if (quote && ch === '\\') { escaped = true; continue; }
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === '#') return line.slice(0, i);
	}
	return line;
}

function bracketDelta(text) {
	let delta = 0;
	let quote = null;
	let escaped = false;
	for (const ch of text) {
		if (escaped) { escaped = false; continue; }
		if (quote && ch === '\\') { escaped = true; continue; }
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if ('([{'.includes(ch)) delta++;
		else if (')]}'.includes(ch)) delta--;
	}
	return delta;
}

function logicalStatements(text) {
	const out = [];
	const lines = text.split('\n');
	let pending = '';
	let startLine = 1;
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		const code = stripComment(lines[i]).trim();
		if (!pending && !code) continue;
		if (!pending) startLine = i + 1;
		pending += `${pending ? ' ' : ''}${code}`;
		depth += bracketDelta(code);
		if (depth > 0 || /(?:,|=>|\\)\s*$/.test(code)) continue;
		out.push({ text: pending.trim(), line: startLine });
		pending = '';
		depth = 0;
	}
	if (pending) out.push({ text: pending.trim(), line: startLine });
	return out;
}

function firstLiteral(args) {
	const m = args.match(/^\s*(?::([a-zA-Z_]\w*)|["']([^"']+)["'])/);
	return m ? (m[1] ?? m[2]) : null;
}

function optionLiteral(args, name) {
	const re = new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)\\s*(?:"([^"]*)"|'([^']*)'|:([a-zA-Z_]\\w*))`);
	const m = args.match(re);
	return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function optionSymbols(args, name) {
	const start = args.search(new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)`));
	if (start === -1) return null;
	const tail = args.slice(start).replace(new RegExp(`^(?:${name}\\s*:|:${name}\\s*=>)\\s*`), '');
	const percent = tail.match(/^%i[\[(]([^\])]+)[\])]/);
	if (percent) return percent[1].split(/\s+/).filter(Boolean);
	const array = tail.match(/^\[([^\]]*)\]/);
	if (array) return [...array[1].matchAll(/:([a-zA-Z_]\w*)/g)].map((m) => m[1]);
	const one = tail.match(/^:([a-zA-Z_]\w*)/);
	return one ? [one[1]] : null;
}

function joinRoute(...segments) {
	const joined = segments.filter((s) => s != null && s !== '').join('/').replace(/\/+/g, '/');
	return joined.startsWith('/') ? joined : `/${joined}`;
}

function normalizeRoute(raw) {
	if (!raw) return '/';
	if (raw.includes('*') || /\([^)]*\)/.test(raw) || raw.includes('#{')) return null;
	return joinRoute(raw).replace(/:([a-zA-Z_]\w*)/g, '{$1}').replace(/\/$/, '') || '/';
}

function regularSingular(name) {
	if (/[^a-zA-Z0-9_]/.test(name)) return null;
	if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
	if (/(?:ches|shes|xes|zes|sses)$/.test(name)) return name.slice(0, -2);
	if (/s$/.test(name) && !/ss$/.test(name)) return name.slice(0, -1);
	return null;
}

function pascal(value) {
	return String(value).split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function operationIdFor(endpoint) {
	const tuple = `${endpoint.verb}\0${endpoint.path}\0${endpoint.controllerPath}#${endpoint.action}`;
	const suffix = crypto.createHash('sha256').update(tuple).digest('hex').slice(0, 10);
	const controller = endpoint.controllerPath.replace(/\//g, '_').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
	return `rails_${endpoint.verb.toLowerCase()}_${controller}_${endpoint.action}_${suffix}`;
}

function controllerClass(controllerPath) {
	return `${controllerPath.split('/').map(pascal).join('::')}Controller`;
}

function controllerFile(projectRoot, controllerPath) {
	return path.join(projectRoot, 'app', 'controllers', `${controllerPath}_controller.rb`);
}

function commonBasePath(paths) {
	if (paths.length === 0) return '/';
	const split = paths.map((p) => p.split('/').filter(Boolean));
	const common = [];
	for (let i = 0; i < Math.min(...split.map((p) => p.length)); i++) {
		if (!split.every((p) => p[i] === split[0][i]) || split[0][i].startsWith('{')) break;
		common.push(split[0][i]);
	}
	return common.length ? `/${common.join('/')}` : '/';
}

function scopedController(raw, modulePrefix) {
	const cleaned = raw.replace(/^\//, '');
	if (!modulePrefix || cleaned.includes('/')) return cleaned;
	return `${modulePrefix}/${cleaned}`;
}

function parseTarget(args, modulePrefix) {
	const m = args.match(/(?:\bto\s*:|=>)\s*["']([^"']+)#([a-zA-Z_]\w*)["']/);
	if (!m) return null;
	return { controllerPath: scopedController(m[1], modulePrefix), action: m[2] };
}

function resourceEndpoints({ singular, actions, collectionPath, memberPath, controllerPath, line, file, label }) {
	const declaration = { rule: `ruby-rails:${singular ? 'resource' : 'resources'}`, line, label };
	const rows = singular
		? [
			['new', 'GET', joinRoute(collectionPath, 'new')], ['create', 'POST', collectionPath],
			['show', 'GET', collectionPath], ['edit', 'GET', joinRoute(collectionPath, 'edit')],
			['update', 'PATCH', collectionPath], ['update', 'PUT', collectionPath], ['destroy', 'DELETE', collectionPath],
		]
		: [
			['index', 'GET', collectionPath], ['create', 'POST', collectionPath],
			['new', 'GET', joinRoute(collectionPath, 'new')], ['show', 'GET', memberPath],
			['edit', 'GET', joinRoute(memberPath, 'edit')], ['update', 'PATCH', memberPath],
			['update', 'PUT', memberPath], ['destroy', 'DELETE', memberPath],
		];
	return rows.filter(([action]) => actions.has(action)).map(([action, verb, routePath]) => ({
		verb, path: routePath, controllerPath, action, method: action, line, routeFile: file, declaration,
	}));
}

function note(notes, file, line, kind, detail) {
	const key = `${kind}\0${path.basename(file)}`;
	const current = notes.get(key) ?? { kind, file, count: 0, examples: [] };
	current.count++;
	if (current.examples.length < 3) current.examples.push(`${file}:${line}${detail ? ` (${detail})` : ''}`);
	notes.set(key, current);
}

function finalizeNotes(notes) {
	return [...notes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file)).map((n) =>
		`ruby-rails static scan skipped ${n.count} ${n.kind} declaration(s); examples: ${n.examples.join(', ')}. Re-run with --runtime-routes to ask Rails for the computed route table.`,
	);
}

function parseStaticRouteFile(projectRoot, file) {
	const text = fs.readFileSync(file, 'utf8');
	const endpoints = [];
	const notes = new Map();
	const stack = [{ kind: 'root', pathPrefix: '', modulePrefix: '', dynamic: false }];
	const current = () => stack[stack.length - 1];

	const addExplicit = (verb, args, line, inlineContext = null) => {
		const ctx = inlineContext ?? current();
		if (ctx.dynamic) { note(notes, file, line, 'dynamic', verb); return; }
		let literal = firstLiteral(args);
		if (!literal) { note(notes, file, line, 'non-literal', verb); return; }
		const target = parseTarget(args, ctx.modulePrefix);
		let controllerPath = target?.controllerPath ?? null;
		let action = target?.action ?? null;
		const on = optionLiteral(args, 'on');
		const resourceCtx = [...stack].reverse().find((s) => s.kind === 'resource');
		const mode = on ?? ctx.routeMode ?? null;
		let base = ctx.pathPrefix;
		if (resourceCtx && (mode === 'member' || mode === 'collection')) {
			base = mode === 'member' ? resourceCtx.memberPath : resourceCtx.collectionPath;
			controllerPath ??= resourceCtx.controllerPath;
			action ??= literal.replace(/^\//, '').split('/').at(-1).replace(/[^a-zA-Z0-9_]/g, '_');
		}
		if (!controllerPath || !action) { note(notes, file, line, 'implicit-target', `${verb} ${literal}`); return; }
		const routePath = normalizeRoute(joinRoute(base, literal));
		if (!routePath) { note(notes, file, line, 'dynamic-path', `${verb} ${literal}`); return; }
		endpoints.push({ verb: verb.toUpperCase(), path: routePath, controllerPath, action, method: action, line, routeFile: file });
	};

	for (const statement of logicalStatements(text)) {
		let src = statement.text;
		if (!src) continue;
		if (/^end\b/.test(src)) { if (stack.length > 1) stack.pop(); continue; }

		const inline = src.match(/^(member|collection)\s*\{\s*(.+)\s*\}\s*$/);
		if (inline) {
			const inner = inline[2].match(/^(get|post|put|patch|delete)\b\s*(.*)$/);
			if (inner) addExplicit(inner[1], inner[2], statement.line, { ...current(), routeMode: inline[1] });
			else note(notes, file, statement.line, 'unsupported-inline-block', inline[1]);
			continue;
		}

		const dynamic = /^(?:if|unless|while|until|for)\b/.test(src) || /\.each\b[\s\S]*\bdo\s*$/.test(src);
		if (dynamic) { stack.push({ ...current(), kind: 'dynamic', dynamic: true }); continue; }
		if (/\.routes\.draw\s+do\s*$/.test(src)) { stack.push({ ...current(), kind: 'draw' }); continue; }
		if (/^(?:concern|concerns|draw|mount|direct|resolve|match)\b/.test(src)) {
			note(notes, file, statement.line, 'unsupported-dsl', src.split(/\s/)[0]);
			if (/\bdo\s*$/.test(src)) stack.push({ ...current(), kind: 'unsupported', dynamic: true });
			continue;
		}

		const namespace = src.match(/^namespace\b\s*(.*?)(?:\s+do)?$/);
		if (namespace && /\bdo\s*$/.test(src)) {
			const name = firstLiteral(namespace[1]);
			if (!name) { note(notes, file, statement.line, 'non-literal-namespace', 'namespace'); stack.push({ ...current(), kind: 'unsupported', dynamic: true }); continue; }
			stack.push({ ...current(), kind: 'namespace', pathPrefix: joinRoute(current().pathPrefix, name), modulePrefix: [current().modulePrefix, name].filter(Boolean).join('/') });
			continue;
		}

		const scope = src.match(/^scope\b\s*(.*?)(?:\s+do)?$/);
		if (scope && /\bdo\s*$/.test(src)) {
			const first = firstLiteral(scope[1]);
			const scopePath = optionLiteral(scope[1], 'path') ?? first;
			const scopeModule = optionLiteral(scope[1], 'module');
			if ((scopePath && scopePath.includes('#{')) || /\bshallow\s*:\s*true/.test(scope[1])) {
				note(notes, file, statement.line, 'dynamic-scope', 'scope');
				stack.push({ ...current(), kind: 'unsupported', dynamic: true });
				continue;
			}
			stack.push({ ...current(), kind: 'scope', pathPrefix: scopePath && scopePath !== 'nil' ? joinRoute(current().pathPrefix, scopePath) : current().pathPrefix, modulePrefix: scopeModule ? [current().modulePrefix, scopeModule].filter(Boolean).join('/') : current().modulePrefix });
			continue;
		}

		const routeMode = src.match(/^(member|collection)\b[\s\S]*\bdo\s*$/);
		if (routeMode) { stack.push({ ...current(), kind: routeMode[1], routeMode: routeMode[1] }); continue; }

		const resource = src.match(/^(resources|resource)\b\s*(.*)$/);
		if (resource) {
			if (current().dynamic) { note(notes, file, statement.line, 'dynamic', resource[1]); continue; }
			const singular = resource[1] === 'resource';
			const args = resource[2].replace(/\s+do\s*$/, '');
			const name = firstLiteral(args);
			if (!name) { note(notes, file, statement.line, 'non-literal', resource[1]); continue; }
			if (/\bshallow\s*:\s*true/.test(args) || /\bconcerns?\s*:/.test(args)) {
				note(notes, file, statement.line, 'unsupported-resource-option', name);
				if (/\bdo\s*$/.test(src)) stack.push({ ...current(), kind: 'unsupported', dynamic: true });
				continue;
			}
			const parent = [...stack].reverse().find((s) => s.kind === 'resource');
			if (parent && !parent.nestedPath) {
				note(notes, file, statement.line, 'ambiguous-nested-resource', name);
				if (/\bdo\s*$/.test(src)) stack.push({ ...current(), kind: 'unsupported', dynamic: true });
				continue;
			}
			const parentBase = parent ? parent.nestedPath : current().pathPrefix;
			const pathSegment = optionLiteral(args, 'path') ?? name;
			const collectionPath = normalizeRoute(joinRoute(parentBase, pathSegment));
			if (!collectionPath) { note(notes, file, statement.line, 'dynamic-path', name); continue; }
			const paramName = optionLiteral(args, 'param') ?? 'id';
			const memberPath = singular ? collectionPath : joinRoute(collectionPath, `{${paramName}}`);
			const controllerName = optionLiteral(args, 'controller') ?? name;
			const controllerPath = scopedController(controllerName, current().modulePrefix);
			const only = optionSymbols(args, 'only');
			const except = optionSymbols(args, 'except');
			const actions = new Set(only ?? RESOURCE_ACTIONS);
			for (const action of except ?? []) actions.delete(action);
			const invalid = [...actions].filter((a) => !RESOURCE_ACTIONS.includes(a));
			if (invalid.length) { note(notes, file, statement.line, 'unknown-resource-action', invalid.join(',')); for (const a of invalid) actions.delete(a); }
			endpoints.push(...resourceEndpoints({ singular, actions, collectionPath, memberPath, controllerPath, line: statement.line, file, label: `${resource[1]} :${name}` }));
			if (/\bdo\s*$/.test(src)) {
				const parentParam = optionLiteral(args, 'param') ?? regularSingular(name);
				const nestedPath = singular ? collectionPath : (parentParam ? joinRoute(collectionPath, `{${parentParam}_id}`) : null);
				stack.push({ ...current(), kind: 'resource', collectionPath, memberPath, nestedPath, controllerPath, resourceName: name });
			}
			continue;
		}

		const explicit = src.match(/^(get|post|put|patch|delete)\b\s*(.*)$/);
		if (explicit) { addExplicit(explicit[1], explicit[2], statement.line); continue; }
		const root = src.match(/^root\b\s*(.*)$/);
		if (root) {
			const target = parseTarget(root[1], current().modulePrefix);
			if (!target) note(notes, file, statement.line, 'implicit-target', 'root');
			else endpoints.push({ verb: 'GET', path: joinRoute(current().pathPrefix), controllerPath: target.controllerPath, action: target.action, method: target.action, line: statement.line, routeFile: file });
			continue;
		}
		if (/\bdo\s*$/.test(src)) stack.push({ ...current(), kind: 'unknown', dynamic: true });
	}

	return { endpoints, notes: finalizeNotes(notes) };
}

function parseExpandedRoutes(output, projectRoot) {
	const routes = [];
	for (const block of output.split(/(?=--\[ Route \d+ \]-+)/)) {
		const field = (name) => block.match(new RegExp(`^\\s*${name}\\s*\\|\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
		const verbs = field('Verb').split('|').map((v) => v.trim().toUpperCase()).filter(Boolean);
		const rawUri = field('URI').replace(/\(\.:format\)$/, '');
		const target = field('Controller#Action').match(/^([^\s#]+)#([a-zA-Z_]\w*)/);
		if (!target || verbs.length === 0) continue;
		const routePath = normalizeRoute(rawUri);
		if (!routePath) continue;
		const controllerPath = target[1];
		if (!fs.existsSync(controllerFile(projectRoot, controllerPath))) continue;
		const source = field('Source Location');
		const sourceMatch = source.match(/^(.*?):(\d+)$/);
		for (const verb of verbs) {
			if (!HTTP_VERBS.has(verb.toLowerCase())) continue;
			routes.push({
				verb, path: routePath, controllerPath, action: target[2], method: target[2],
				line: sourceMatch ? Number(sourceMatch[2]) : null,
				routeFile: sourceMatch && path.isAbsolute(sourceMatch[1]) ? sourceMatch[1] : path.join(projectRoot, 'config', 'routes.rb'),
			});
		}
	}
	return routes;
}

export function introspectRailsRoutes(repoRoot, projectRoot) {
	const binRails = path.join(projectRoot, 'bin', 'rails');
	if (!fs.existsSync(binRails)) {
		const err = new Error(`--runtime-routes requires ${path.relative(repoRoot, binRails)}; no Rails binstub was found`);
		err.code = 'RUNTIME_ROUTES_FAILED';
		throw err;
	}
	let stdout;
	try {
		stdout = execFileSync(binRails, ['routes', '--expanded'], {
			cwd: projectRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
			env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (cause) {
		const detail = cause.signal === 'SIGTERM' ? 'timed out after 60 seconds' : (cause.stderr?.toString().trim() || cause.message);
		const err = new Error(`Rails runtime route introspection failed: ${detail}`);
		err.code = 'RUNTIME_ROUTES_FAILED';
		throw err;
	}
	const endpoints = parseExpandedRoutes(stdout, projectRoot);
	if (endpoints.length === 0) {
		const err = new Error('Rails runtime route introspection returned no local controller routes; refusing to replace the static route set with an empty parse');
		err.code = 'RUNTIME_ROUTES_FAILED';
		throw err;
	}
	return {
		endpoints,
		metadata: {
			kind: 'rails-routes', command: ['bin/rails', 'routes', '--expanded'],
			project_root: path.relative(repoRoot, projectRoot) || '.', rails_env: process.env.RAILS_ENV || 'development', status: 'used',
		},
	};
}

function extractEntities(projectRoot) {
	const entities = [];
	for (const file of rubyFilesUnder(projectRoot, ['app/models'])) {
		const text = fs.readFileSync(file, 'utf8');
		for (const match of text.matchAll(/^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/gm)) {
			if (match[1] === 'ApplicationRecord') continue; // abstract Rails base, never a resource entity
			const after = text.slice(match.index, text.indexOf('\nend', match.index) === -1 ? text.length : text.indexOf('\nend', match.index));
			const table = after.match(/\bself\.table_name\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
			const idField = after.match(/\bself\.primary_key\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
			entities.push({ className: match[1], table, tableSource: table ? 'explicit' : null, idField, idFieldIsUuid: null, file, line: lineNumberAt(text, match.index) });
		}
	}
	return entities;
}

function endpointKey(ep) {
	return `${ep.verb}\0${ep.path}\0${ep.controllerPath}\0${ep.action}`;
}

function buildModules(projectRoot, rawEndpoints, entities, notes) {
	const modules = new Map();
	const entry = (name) => {
		if (!modules.has(name)) modules.set(name, { module: name, controllers: [], entities: [], enums: [], dtos: [] });
		return modules.get(name);
	};
	const byController = new Map();
	const seen = new Set();
	for (const raw of rawEndpoints) {
		const file = controllerFile(projectRoot, raw.controllerPath);
		if (!fs.existsSync(file)) {
			notes.push(`ruby-rails skipped ${raw.verb} ${raw.path}: local controller file ${path.relative(projectRoot, file)} was not found.`);
			continue;
		}
		const key = endpointKey(raw);
		if (seen.has(key)) continue;
		seen.add(key);
		if (!byController.has(raw.controllerPath)) byController.set(raw.controllerPath, []);
		byController.get(raw.controllerPath).push(raw);
	}

	for (const [controllerPath, rows] of [...byController.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		rows.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb) || a.action.localeCompare(b.action));
		const declarations = [];
		const declarationIndexes = new Map();
		const endpoints = rows.map((row) => {
			let declarationIndex;
			if (row.declaration) {
				const dKey = `${row.routeFile}\0${row.declaration.line}\0${row.declaration.rule}`;
				if (!declarationIndexes.has(dKey)) { declarationIndexes.set(dKey, declarations.length); declarations.push(row.declaration); }
				declarationIndex = declarationIndexes.get(dKey);
			}
			return {
				verb: row.verb, path: row.path, operationId: operationIdFor(row), operationIdSource: 'bskel-synthesized',
				method: row.method, line: row.line,
				...(declarationIndex !== undefined ? { declarationIndex } : {}),
			};
		});
		const leaf = controllerPath.split('/').at(-1).replace(/_controller$/, '');
		entry(leaf).controllers.push({
			className: controllerClass(controllerPath), basePath: commonBasePath(endpoints.map((e) => e.path)),
			operationIds: [], endpoints, file: controllerFile(projectRoot, controllerPath),
			...(declarations.length ? { declarations } : {}),
		});
	}

	for (const entity of entities) {
		const leaf = entity.className.split('::').at(-1).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
		const target = [...modules.keys()].find((name) => name === leaf || regularSingular(name) === leaf);
		entry(target ?? '_models').entities.push(entity);
	}
	return [...modules.values()].sort((a, b) => a.module.localeCompare(b.module));
}

export function scanRubyRails(repoRoot, projectRoot, { runtimeRoutes = null } = {}) {
	const discoveredRouteFiles = routeFiles(projectRoot);
	const staticEndpoints = [];
	const scanNotes = [];
	for (const file of discoveredRouteFiles) {
		const parsed = parseStaticRouteFile(projectRoot, file);
		staticEndpoints.push(...parsed.endpoints);
		scanNotes.push(...parsed.notes);
	}

	let endpoints = staticEndpoints;
	if (runtimeRoutes) {
		const staticByKey = new Map(staticEndpoints.map((ep) => [endpointKey(ep), ep]));
		endpoints = runtimeRoutes.endpoints.map((ep) => {
			const source = staticByKey.get(endpointKey(ep));
			return source?.declaration ? { ...ep, declaration: source.declaration } : ep;
		});
		scanNotes.push('Rails runtime route introspection is point-in-time and environment-dependent; changes in untracked environment variables cannot be represented in the scan gate input hash.');
	}

	const entities = extractEntities(projectRoot);
	const filesRead = railsReadFiles(projectRoot)
		.map((f) => path.relative(repoRoot, f));
	return {
		modules: buildModules(projectRoot, endpoints, entities, scanNotes),
		filesRead,
		scanNotes,
		apiSurfaceSource: runtimeRoutes
			? 'Rails-computed route table from explicit `bin/rails routes --expanded` runtime introspection; operation ids are deterministic bskel identifiers unless reconciled with --openapi-file'
			: 'conservative static analysis of literal Rails routes.rb DSL only; dynamic declarations are listed in unknowns and operation ids are deterministic bskel identifiers',
		...(runtimeRoutes ? { runtimeIntrospection: runtimeRoutes.metadata } : {}),
	};
}

export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'ruby-rails',
	title: 'Ruby / Rails',
	specificity: 95,
	confidence: 'high',
	verificationBasis: 'production-repo',
	capabilities: {
		'api.operations': true,
		'api.request-shape': false,
		'resource.fetch': false,
		'codegen.handles': false,
	},
	detect: detectRubyRailsRoot,
	scan(repoRoot, projectRoot, options) {
		return scanRubyRails(repoRoot, projectRoot, options);
	},
	introspectRoutes: introspectRailsRoutes,
	listReadSet(repoRoot) {
		const root = detectRubyRailsRoot(repoRoot);
		if (!root) return [];
		return railsReadFiles(root)
			.map((f) => path.relative(repoRoot, f));
	},
	diagnostics(repoRoot) {
		const messages = [];
		const root = detectRubyRailsRoot(repoRoot);
		if (!root) messages.push({ level: 'info', code: 'rails-app-not-detected', message: 'no project combined a Rails dependency, config/application.rb < Rails::Application, and config/routes.rb' });
		if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter cannot discover Rails project/source files without it and will degrade to generic-grep' });
		messages.push({ level: 'info', code: 'runtime-routes-hint', message: '`bskel scan --runtime-routes` runs `bin/rails routes --expanded` and therefore boots the target application and its initializers; use it only for a trusted repo when static unknowns matter.' });
		messages.push({ level: 'info', code: 'openapi-extraction-hint', message: 'Rails has no framework-native OpenAPI generator. `contract emit` works with deterministic bskel operation ids; pass an application-generated --openapi-file when the project uses rswag or another OpenAPI integration and you need source-backed schemas/security.' });
		return messages;
	},
};
