import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import * as lib from './baseline-record-lib.mjs';

// T21-02: the vocabulary is recomputed from the code (exports, parameters, imports, constants, schema and code literals, the keys of real
// emitted objects, the directory listings) and the RFC's tables, figures and identifiers are recomputed from the vocabulary and the record, so drift on either side fails. Lists are compared
// as exact sets, each key list against every emitted object of its kind, and an empty sample fails instead of passing. The numbered claims of the
// RFC for identity, unknown, partial and stale results run on real calls, and the negatives edit copies of the RFC, README and vocabulary.
// T21_PRINT_FACTS=1 prints the code-derived part of the vocabulary; T21_PRINT_TABLES=1 prints the RFC tables rendered from the vocabulary file.
const ROOT = lib.REPO_ROOT;
const DIRS = lib.TRACK.sourceDirs;
const VOCABULARY = 'test/perf-next/t21-interface-rfc.vocabulary.json';
const HEX = (c) => c.repeat(64);
const SPLIT = /[\s`|(),;{}[\]]+/;
const FORBIDDEN = /#\d|\/pull\/\d|\/issues\/\d|GH-\d|refs\/pull|\bPR\s*\d/;
const SCHEMA_RE = /'((?:sbf|bskel)\.[a-z0-9.-]+\/(?:draft-)?\d+)'/g;
const CODE_RE = /'([A-Z][A-Z0-9]*_[A-Z0-9_]+)'/g;
const TAG_RE = /'(t21-[a-z-]+\/\d+)'/g;
const IMPORT_RE = /\b(?:import|export)\b[^'"`;()]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3|\bimport\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g;
const OPAQUE_RE = /\bimport\s*\((?!\s*['"][^'"\n]+['"]\s*\))|\brequire\s*\(|\bcreateRequire\b/g;
const NAMED_RE = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g;
const LINE_CAP = 520;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sorted = (xs) => [...xs].sort();
const hasRg = spawnSync('rg', ['--version']).status === 0;

// Parameter lists are read from the source text (exports) or from Function.prototype.toString (handle methods), never typed by hand.
const CLOSE = { '(': ')', '[': ']', '{': '}' };
function split(text) {
	const parts = []; const stack = []; let quote = null; let from = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
		if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c in CLOSE) stack.push(CLOSE[c]);
		else if (c === stack.at(-1)) stack.pop();
		else if (c === ',' && stack.length === 0) { parts.push(text.slice(from, i)); from = i + 1; }
	}
	parts.push(text.slice(from));
	return parts.map((p) => p.trim()).filter(Boolean);
}
function endOf(text, open) {
	const stack = []; let quote = null;
	for (let i = open; i < text.length; i += 1) {
		const c = text[i];
		if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
		if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c in CLOSE) stack.push(CLOSE[c]);
		else if (c === stack.at(-1)) { stack.pop(); if (stack.length === 0) return i; }
	}
	return -1;
}
function paramList(text, start) { // text[start - 1] is the opening parenthesis of the parameter list
	const out = { positional: [], options: [], defaults: {} };
	const entry = (item, into) => {
		const m = /^([\w$]+)\s*(?:=\s*([\s\S]+))?$/.exec(item);
		if (!m) throw new Error(`cannot read the parameter ${JSON.stringify(item)}`);
		into.push(m[1]);
		if (m[2] !== undefined) out.defaults[m[1]] = m[2].replace(/\s+/g, ' ').trim();
	};
	for (const p of split(text.slice(start, endOf(text, start - 1)))) {
		if (p.startsWith('{')) split(p.slice(1, endOf(p, 0))).forEach((e) => entry(e, out.options));
		else entry(p, out.positional);
	}
	return out;
}
function exportedParameters(code, name) {
	const head = new RegExp(`export (async )?function ${name}\\(`).exec(code);
	return head ? { async: Boolean(head[1]), ...paramList(code, head.index + head[0].length) } : null;
}
function methodParameters(fn) {
	const text = fn.toString(); const head = /^(async\s+)?function\s+[\w$]*\s*\(/.exec(text);
	return head ? { async: Boolean(head[1]), ...paramList(text, head[0].length) } : null;
}
function importsOf(source) {
	const text = lib.withoutComments(source);
	return { specs: [...text.matchAll(IMPORT_RE)].map((m) => m[2] ?? m[4] ?? m[6]), opaque: [...text.matchAll(OPAQUE_RE)].map((m) => m[0]) };
}
const resolveSpec = (rel, spec) => (spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : spec);
function importMap(rel, source) { // resolved specifier -> the names imported with braces
	const out = {};
	for (const spec of importsOf(source).specs) out[resolveSpec(rel, spec)] ??= [];
	for (const m of lib.withoutComments(source).matchAll(NAMED_RE)) {
		const key = resolveSpec(rel, m[3]);
		out[key] = sorted(new Set([...(out[key] ?? []), ...m[1].split(',').map((n) => n.trim().replace(/\s+as\s+.*$/, '')).filter(Boolean)]));
	}
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const files = DIRS.flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.mjs')).sort().map((f) => ({ dir, name: f.slice(0, -4), rel: `${dir}/${f}` })));
const mods = Object.fromEntries(await Promise.all(files.map(async (f) => [f.name, await import(pathToFileURL(path.join(ROOT, f.rel)).href)])));
const { createArtifactStore } = mods.store; const { createCacheIndex } = mods['cache-index']; const { collectArtifactGarbage } = mods.gc;
const { buildScanCacheKey, digestJson, stableJson, sha256Bytes } = mods['cache-key']; const { runCachedTask } = mods['cache-runtime'];
const { buildFileIndex, portablePathIssuesForPaths, DEFAULT_EXCLUDED_DIRS } = mods['file-index']; const { computeInvalidation } = mods.invalidation;
const { evaluatePerformanceGate } = mods['performance-policy']; const { deriveMemoryAdmission } = mods['resource-budget']; const { runTaskGraph } = mods.scheduler;
const { buildProjectCachePlan, propagateProjectInvalidation } = mods['project-cache-plan']; const { runLegacyScanCached } = mods['legacy-cache']; const { runProjectGraphCached } = mods['project-cache-runner'];

// What the code says, as the same object shape as the code-derived sections of the vocabulary.
function codeFacts(from, extra = {}) {
	const text = Object.fromEntries(files.map((f) => [f.name, `${read(f.rel)}\n${extra[f.name] ?? ''}`]));
	const code = Object.fromEntries(Object.entries(text).map(([n, t]) => [n, lib.withoutComments(t)]));
	const literals = (re) => sorted(new Set(Object.values(code).flatMap((t) => [...t.matchAll(re)].map((m) => m[1]))));
	const out = { modules: {}, functions: {}, constants: {}, handles: {}, output_keys: {}, conditional_keys: {}, opaque: [], literals: { schemas: literals(SCHEMA_RE), codes: literals(CODE_RE), tags: literals(TAG_RE) }, code };
	for (const f of files) {
		out.modules[f.name] = { dir: f.dir, exports: sorted(Object.keys(mods[f.name])), imports: importMap(f.rel, text[f.name]) };
		out.opaque.push(...importsOf(text[f.name]).opaque.map((o) => `${f.name}: ${o}`));
		for (const [name, value] of Object.entries(mods[f.name])) {
			if (typeof value === 'function') out.functions[name] = { module: f.name, ...exportedParameters(code[f.name], name) };
			else out.constants[name] = { module: f.name, value };
		}
	}
	const handle = (h) => ({ fields: Object.keys(h).filter((k) => typeof h[k] !== 'function'), methods: Object.fromEntries(Object.entries(h).filter(([, x]) => typeof x === 'function').map(([k, x]) => [k, methodParameters(x)])) });
	out.handles = { artifact_store: handle(from.handles.artifact_store), cache_index: handle(from.handles.cache_index) };
	for (const [g, os] of Object.entries(from.groups)) out.output_keys[g] = os.length ? Object.keys(os[0]) : null;
	for (const [g, os] of Object.entries(from.variants)) out.conditional_keys[g] = os.length ? Object.keys(os[0]).filter((k) => !(out.output_keys[g] ?? []).includes(k)) : null;
	return out;
}

const TMP = lib.tmpDir('bskel-t21-rfc-');
const fresh = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));
const FAR = 4_102_444_800_000;
const KEY_INPUT = { sourceDigest: HEX('a'), resolverDigest: HEX('b'), configDigest: HEX('c'), parserDigest: HEX('d'), adapterDigest: HEX('e'), schemaDigest: HEX('f'), policyDigest: HEX('1'), runtimeFingerprint: 'rt' };
const FASTAPI = 'test/fixtures/python-fastapi/backend';
const ENV = { profile_id: 'p', platform: 'x', arch: 'y', node_major: 24 };
const workload = (over = {}) => ({ id: 'w', samples: 5, semantic_equivalence: true, cold_p95_ms: 10, peak_rss_bytes: 100, cache_hit_p95_ms: 1, ...over });
const gateOf = (candidate = {}, baseline = {}) => evaluatePerformanceGate({ baseline: { environment: ENV, workloads: [workload(baseline)] }, candidate: { environment: ENV, workloads: [workload(candidate)] } });
const TASKS = [{ id: 'a', estimatedBytes: 1 }, { id: 'b', dependsOn: ['a'], estimatedBytes: 1 }, { id: 'c', dependsOn: ['a'], estimatedBytes: 10 ** 12 }, { id: 'd', dependsOn: ['x2'] }, { id: 'x2', estimatedBytes: 1 }];
const boom = async (t) => { if (t.id === 'x2') throw new Error('boom'); return { v: t.id }; };
const fileSha = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const projectGraph = (markers = []) => ({
	schema: 'sbf.project-graph/draft-1',
	repo_root: '.',
	projects: [
		{ project_id: 'p1', root: 'svc', kind: 'service', facets: { http: { selected_adapter: 'python-fastapi' } }, markers },
		{ project_id: 'p2', root: 'lib', kind: 'library', facets: { http: { selected_adapter: 'python-fastapi' } }, markers: [] },
	],
	project_edges: [{ kind: 'local-package-dependency', from_project_id: 'p1', to_project_id: 'p2' }],
});
const json = { serialize: (v) => JSON.stringify(v), deserialize: (b) => JSON.parse(b.toString('utf8')) };

// Real objects from real calls: every key list in the vocabulary is compared with these, and a group with no object fails.
async function buildSamples() {
	const root = fresh('samples');
	const groups = {}; const variants = {};
	const add = (g, ...os) => { (groups[g] ??= []).push(...os); };
	const vary = (g, ...os) => { (variants[g] ??= []).push(...os); };
	const store = createArtifactStore(path.join(root, 'store'));
	const ref = store.put('hello');
	add('store_ref', ref, store.put('world'));
	const key = buildScanCacheKey(KEY_INPUT);
	add('cache_key', key); add('cache_key_material', key.material);

	const repo = path.join(root, 'repo');
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x'); fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'y');
	fs.symlinkSync(path.join(repo, 'src', 'a.js'), path.join(repo, 'link.js'));
	const index = createCacheIndex(repo);
	index.set(key.digest, ref, { dependencies: ['src/b.js', 'src/a.js'] });
	const keyMeta = buildScanCacheKey({ ...KEY_INPUT, sourceDigest: HEX('9') });
	index.set(keyMeta.digest, ref, { dependencies: ['src/a.js'], metadata: { note: 'x' } });
	add('cache_index_entry', index.get(key.digest));
	vary('cache_index_entry', index.get(keyMeta.digest));
	add('cache_index_listing_item', index.list().find((e) => e.cache_key === key.digest));
	vary('cache_index_listing_item', index.list().find((e) => e.cache_key === keyMeta.digest));
	add('cache_index_listing_item', ...index.invalidateDependencies(['src/b.js']));

	const before = buildFileIndex(repo);
	add('file_index', before); add('file_index_entry', ...before.entries); add('file_index_stats', before.stats);
	// Errors thrown on purpose: the kind of INDEX_BUDGET_EXCEEDED is a status field that no emitted object carries.
	const budgetError = (options) => { try { buildFileIndex(repo, options); } catch (e) { return e; } return assert.fail('expected a budget error'); };
	const thrownErrors = { index_budget_error: [budgetError({ maxFiles: 1 }), budgetError({ maxBytes: 1 })] };
	add('portable_path_issue', ...portablePathIssuesForPaths(['A.txt', 'a.txt']), ...portablePathIssuesForPaths([`caf${String.fromCharCode(0xe9)}.txt`, `cafe${String.fromCharCode(0x301)}.txt`]));
	const after = buildFileIndex(repo);
	add('invalidation', computeInvalidation({ previousIndex: before, nextIndex: after }), computeInvalidation({ previousIndex: before, nextIndex: after, dependencyEdges: [{ dependent: 'src/a.js', dependency: 'src/b.js' }], globalInputsChanged: true }));
	add('memory_admission', deriveMemoryAdmission({ totalBytes: 64 * 1024 ** 3 }));
	vary('memory_admission', deriveMemoryAdmission({ totalBytes: 4 * 1024 ** 3 }));

	const scheduled = await runTaskGraph(TASKS, boom, { maxConcurrency: 2 });
	add('scheduler_result', scheduled); add('scheduler_metrics', scheduled.metrics);
	add('task_passed', ...scheduled.results.filter((r) => r.status === 'passed'));
	add('task_failed', ...scheduled.results.filter((r) => r.status === 'failed'));
	add('task_blocked_dependency', ...scheduled.results.filter((r) => r.reason === 'DEPENDENCY_NOT_PASSED'));
	add('task_blocked_budget', ...scheduled.results.filter((r) => r.reason === 'RESOURCE_BUDGET_EXCEEDED'));

	createArtifactStore(path.join(root, 'store')).put('garbage');
	const dry = collectArtifactGarbage(path.join(root, 'store'), { reachable: [ref], dryRun: true, nowMs: FAR });
	const store2 = createArtifactStore(path.join(root, 'store2'));
	const keep = store2.put('keep'); store2.put('drop');
	const applied = collectArtifactGarbage(path.join(root, 'store2'), { reachable: [keep], dryRun: false, nowMs: FAR });
	add('gc_result', dry, applied); add('gc_item', ...dry.candidates, ...applied.deleted);

	const pass = gateOf(); const fail = gateOf({ cold_p95_ms: 100 }); const early = evaluatePerformanceGate({});
	add('performance_gate', pass, fail); add('performance_policy', pass.policy); add('performance_check', ...pass.checks, ...fail.checks, ...early.checks);
	add('performance_gate_early', early);

	const cache2 = createCacheIndex(path.join(root, 'repo2'));
	const cached = (compute) => runCachedTask({ cacheKey: key.digest, cacheIndex: cache2, artifactStore: store, compute, ...json });
	add('cached_task_result', await cached(async () => ({ a: 1 })), await cached(async () => ({ a: 2 })));

	const plan = buildProjectCachePlan(projectGraph([{ path: 'svc/pyproject.toml', kind: 'manifest', digest: `sha256:${HEX('a')}` }]));
	add('project_plan', plan); add('project_plan_item', ...plan.projects); add('project_marker', ...plan.projects.flatMap((p) => p.markers));
	const fallbackPlan = buildProjectCachePlan({ ...projectGraph(), projects: [{ project_id: 'p3', root: 'fb', kind: 'service', facets: {}, fallback_adapter: 'python-fastapi', markers: [] }], project_edges: [] }, { includeFallback: true });
	add('project_plan_item', ...fallbackPlan.projects);

	if (hasRg) {
		const adapter = ADAPTERS.find((a) => a.id === 'python-fastapi');
		const legacyRoot = path.join(root, 'legacy');
		fs.cpSync(path.join(ROOT, FASTAPI), legacyRoot, { recursive: true });
		const call = () => runLegacyScanCached({ repoRoot: legacyRoot, adapter, terms: [], implementationDigest: HEX('a'), runtimeFingerprint: 'rt' });
		add('legacy_result', await call(), await call());
		add('legacy_index_metadata', createCacheIndex(legacyRoot).list()[0].metadata);
		const projectRoot = path.join(root, 'proj');
		fs.mkdirSync(projectRoot);
		fs.cpSync(path.join(ROOT, FASTAPI), path.join(projectRoot, 'svc'), { recursive: true });
		const run = await runProjectGraphCached({ repoRoot: projectRoot, graph: { ...projectGraph([{ path: 'svc/pyproject.toml', kind: 'manifest', digest: fileSha(path.join(projectRoot, 'svc', 'pyproject.toml')) }]), projects: [{ project_id: 'p1', root: 'svc', kind: 'service', facets: { http: { selected_adapter: 'python-fastapi' } }, markers: [{ path: 'svc/pyproject.toml', kind: 'manifest', digest: fileSha(path.join(projectRoot, 'svc', 'pyproject.toml')) }] }], project_edges: [] }, adapters: ADAPTERS, implementationDigests: { 'python-fastapi': HEX('b') }, useCache: false });
		add('project_run', run); add('project_run_value', run.results[0].value); add('task_passed', run.results[0]); add('scheduler_metrics', run.metrics);
	}
	return { groups, variants, thrown: thrownErrors, handles: { artifact_store: store, cache_index: index } };
}

const samples = await buildSamples();
const facts = codeFacts(samples);
if (process.env.T21_PRINT_FACTS) {
	const { code, ...part } = facts;
	process.stdout.write(`${JSON.stringify(part, null, 1)}\n`);
	process.exit(0);
}

const baseline = JSON.parse(read(lib.TRACK.recordFile));
const vocabulary = JSON.parse(read(VOCABULARY));
const ownershipMap = JSON.parse(read('next/t00/ownership-map.json'));
const commandOf = (id) => baseline.commands.find((c) => c.id === id);
const SECTIONS = ['codes', 'conditional_keys', 'constants', 'contract_tags', 'foreign_keys', 'foreign_schemas', 'functions', 'gates', 'handles', 'identity', 'input_schemas', 'limit_statuses', 'modules', 'non_gate_limits', 'output_keys', 'owned_files', 'ownership', 'pinned_tests', 'policy_defaults', 'record_schema', 'roles', 'runner_line', 'schema', 'schemas', 'statuses'];
// Which sample groups carry each status field. A group is read from the emitted objects, from their variants and from the errors thrown on purpose;
// the whole observed set must equal the declared set, so a value outside it fails and so does a declared value that nothing observed.
const OBSERVED = { scheduler_task_status: ['task_passed', 'task_failed', 'task_blocked_dependency', 'task_blocked_budget'], memory_admission_status: ['memory_admission'], performance_gate_status: ['performance_gate', 'performance_gate_early'], performance_check_status: ['performance_check'], project_plan_mode: ['project_plan_item'], portable_issue_kind: ['portable_path_issue'], index_budget_kind: ['index_budget_error'] };
const observedIn = (from, g) => [...(from.groups[g] ?? []), ...(from.variants[g] ?? []), ...(from.thrown?.[g] ?? [])];
const SCHEMA_GROUPS = { performance_gate: ['performance_gate', 'performance_gate_early'] };
const CARRIED = { cache_key_namespace: (s) => (s.groups.cache_key ?? []).map((k) => k.material.namespace), cache_index: (s) => [s.handles.cache_index.schema] };

function ownerOf(p, map = ownershipMap) {
	const covers = (scope) => (scope.endsWith('/**') ? p === scope.slice(0, -3) || p.startsWith(scope.slice(0, -2)) : p === scope);
	if (map.reserved_hot_paths.some((h) => h.repository === 'bskel' && covers(h.path))) return 'reserved';
	const ids = map.tracks.filter((t) => t.repository === 'bskel' && [...t.plan_scopes, ...t.suite_scopes, ...t.extra_scopes].some(covers)).map((t) => t.track);
	return ids.length ? ids.join('+') : 'none';
}
function walkFiles(rel) { // every file below a directory, repo-relative to it, posix, sorted
	const out = [];
	const visit = (dir) => { for (const e of fs.readdirSync(path.join(ROOT, rel, dir), { withFileTypes: true })) (e.isDirectory() ? visit : (d) => out.push(d))(path.posix.join(dir, e.name)); };
	visit('');
	return sorted(out);
}

// Vocabulary against the code: everything in the code-derived sections, the literals, and the carried schema strings.
function sourceProblems(v, from = samples, extra = {}) {
	const f = codeFacts(from, extra); const out = [];
	const eq = (what, expected, actual) => { if (!isDeepStrictEqual(expected, actual)) out.push(`${what}: vocabulary ${JSON.stringify(expected)} but code ${JSON.stringify(actual)}`); };
	const each = (section, expected = {}, actual = {}) => { for (const k of sorted(new Set([...Object.keys(expected), ...Object.keys(actual)]))) eq(`${section}.${k}`, expected[k], actual[k]); };
	eq('sections', SECTIONS, sorted(Object.keys(v)));
	eq('policy_defaults', v.policy_defaults, from.groups.performance_policy?.[0]);
	for (const s of ['modules', 'functions', 'constants', 'handles', 'conditional_keys']) each(s, v[s], f[s]);
	for (const k of sorted(new Set([...Object.keys(v.output_keys ?? {}), ...Object.keys(f.output_keys)]))) {
		if (f.output_keys[k] === null) out.push(`output_keys.${k}: no emitted sample, so nothing was compared`);
		else eq(`output_keys.${k}`, v.output_keys?.[k], f.output_keys[k]);
	}
	for (const [g, os] of Object.entries(from.groups)) os.slice(1).forEach((o, i) => eq(`output_keys.${g}[${i + 1}]`, Object.keys(os[0]), Object.keys(o)));
	for (const [g, os] of Object.entries(from.variants)) os.slice(1).forEach((o, i) => eq(`conditional_keys.${g}[${i + 1}]`, Object.keys(os[0]), Object.keys(o)));
	for (const [g, os] of Object.entries(from.variants)) os.forEach((o, i) => eq(`conditional_keys.${g}[${i}] with its base keys`, [...(v.output_keys?.[g] ?? []), ...(v.conditional_keys?.[g] ?? [])], Object.keys(o)));
	eq('roles', sorted(Object.keys(v.roles ?? {})), sorted(Object.keys(f.modules)));
	eq('literals.schemas', sorted(new Set([...Object.values(v.schemas ?? {}), ...Object.values(v.input_schemas ?? {})])), f.literals.schemas);
	eq('literals.codes', sorted([...Object.keys(v.codes?.errors ?? {}), ...Object.keys(v.codes?.reasons ?? {}), ...Object.keys(v.codes?.checks ?? {})]), f.literals.codes);
	eq('literals.tags', sorted(Object.values(v.contract_tags ?? {})), f.literals.tags);
	eq('opaque imports (dynamic import, require, createRequire)', [], f.opaque);
	for (const s of v.foreign_schemas ?? []) if (Object.values(f.code).some((t) => t.includes(s))) out.push(`foreign_schemas: ${s} appears in the code`);
	for (const [g, schema] of Object.entries(v.schemas ?? {})) {
		const carried = CARRIED[g] ? CARRIED[g](from) : (SCHEMA_GROUPS[g] ?? [g]).flatMap((x) => (from.groups[x] ?? []).map((o) => o.schema));
		if (carried.length === 0) out.push(`schemas.${g}: no emitted object carries it`);
		carried.forEach((c, i) => eq(`schemas.${g}[${i}]`, schema, c));
	}
	for (const [id, s] of Object.entries(v.statuses ?? {})) {
		for (const value of s.values ?? []) if (!(f.code[s.module] ?? '').includes(`'${value}'`)) out.push(`statuses.${id}: ${value} is not a quoted literal in ${s.module}.mjs`);
		const seen = new Set();
		for (const g of OBSERVED[id] ?? []) for (const o of observedIn(from, g)) { seen.add(o[s.field]); if (!(s.values ?? []).includes(o[s.field])) out.push(`statuses.${id}: ${JSON.stringify(o[s.field])} observed in ${g} is not in the vocabulary`); }
		for (const value of s.values ?? []) if (!seen.has(value)) out.push(`statuses.${id}: ${value} is declared but no sample of ${(OBSERVED[id] ?? []).join(', ') || 'no group'} carries it`);
	}
	eq('statuses ids', sorted(Object.keys(OBSERVED)), sorted(Object.keys(v.statuses ?? {})));
	return out;
}

// Vocabulary against the record, the directory listings and the ownership map.
function vocabProblems(v, base = baseline) {
	const out = [];
	const eq = (what, expected, actual) => { if (!isDeepStrictEqual(expected, actual)) out.push(`${what}: vocabulary ${JSON.stringify(actual)} but expected ${JSON.stringify(expected)}`); };
	eq('limit_statuses', lib.LIMIT_STATUSES, v.limit_statuses);
	eq('record_schema', base.schema, v.record_schema);
	eq('runner_line', base.commands.find((c) => c.id === 'nested-runner')?.first_line, v.runner_line);
	eq('pinned_tests', sorted(base.files.filter((x) => x.role === 'test').map((x) => path.posix.basename(x.path))), sorted(Object.keys(v.pinned_tests ?? {})));
	eq('owned_files directories', sorted([...DIRS, lib.TRACK.testDir]), sorted(Object.keys(v.owned_files ?? {})));
	for (const dir of DIRS) eq(`owned_files.${dir}`, sorted(fs.readdirSync(path.join(ROOT, dir))), v.owned_files?.[dir]);
	eq(`owned_files.${lib.TRACK.testDir}`, walkFiles(lib.TRACK.testDir), v.owned_files?.[lib.TRACK.testDir]);
	const ids = base.limits.map((l) => l.id);
	const placed = [...Object.values(v.gates ?? {}).flatMap((g) => g.limits), ...Object.keys(v.non_gate_limits ?? {})];
	eq('gates and non_gate_limits cover each limit of the record exactly once', sorted(ids), sorted(placed));
	for (const g of Object.keys(v.gates ?? {})) if (g.includes('-not-')) out.push(`gates: the name ${g} contains -not-, which is reserved for limit ids`);
	const pinned = base.files.filter((x) => x.role === 'external_dependency' || x.role === 'runner').map((x) => x.path);
	const under = (p, d) => p === d || p.startsWith(`${d}/`);
	const pinnedRows = (v.ownership ?? []).filter((r) => r.t21.includes('pinned by BASELINE.json')).flatMap((r) => r.paths);
	for (const p of pinned) if (!pinnedRows.some((d) => under(p, d))) out.push(`ownership: the pinned file ${p} is under no row marked pinned by BASELINE.json`);
	for (const d of pinnedRows) if (!pinned.some((p) => under(p, d))) out.push(`ownership: ${d} is marked pinned but no pinned file lies under it`);
	for (const r of v.ownership ?? []) {
		if ((r.owner === 'T21') !== (r.t21 === 'edit')) out.push(`ownership: ${r.paths.join(', ')} owner ${r.owner} but T21 may ${r.t21}`);
		for (const p of r.paths) {
			if (ownerOf(p) !== r.owner) out.push(`ownership: ${p} is owned by ${ownerOf(p)} in next/t00/ownership-map.json, not ${r.owner}`);
			if (!fs.existsSync(path.join(ROOT, p))) out.push(`ownership: ${p} does not exist`);
		}
	}
	eq('ownership edit rows', sorted([...DIRS, lib.TRACK.testDir]), sorted((v.ownership ?? []).filter((r) => r.t21 === 'edit').flatMap((r) => r.paths)));
	return out;
}

// The RFC is rendered from the vocabulary and the record; every block below must appear in it unchanged.
const code = (xs) => xs.map((x) => `\`${x}\``).join(', ');
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');
function render(v, base = baseline) {
	const statusOf = (id) => base.limits.find((l) => l.id === id)?.status ?? 'NOT_IN_RECORD';
	const mods = Object.entries(v.modules);
	const count = (role) => base.files.filter((f) => f.role === role).length;
	return {
		modules: table(['module', 'directory', 'role'], mods.map(([n, m]) => [`\`${n}.mjs\``, `\`${m.dir}\``, v.roles[n]])),
		exports: table(['module', 'exports'], mods.map(([n, m]) => [`\`${n}.mjs\``, code(m.exports)])),
		imports: table(['module', 'imports'], mods.map(([n, m]) => [`\`${n}.mjs\``, Object.keys(m.imports).length ? Object.entries(m.imports).map(([spec, names]) => `\`${spec}\`${names.length ? ` (${names.join(', ')})` : ''}`).join(', ') : 'none'])),
		functions: table(['function', 'module', 'async', 'positional parameters', 'options object'], Object.entries(v.functions).map(([n, f]) => [`\`${n}\``, `\`${f.module}.mjs\``, f.async ? 'yes' : 'no', f.positional.length ? code(f.positional) : '-', f.options.length ? code(f.options) : '-'])),
		defaults: table(['function', 'parameter', 'default'], Object.entries(v.functions).flatMap(([n, f]) => Object.entries(f.defaults).map(([p, d]) => [`\`${n}\``, `\`${p}\``, `\`${d}\``]))),
		handles: table(['handle', 'member', 'async', 'positional parameters', 'options object', 'defaults'], Object.entries(v.handles).flatMap(([h, d]) => [
			...d.fields.map((x) => [`\`${h}\``, `\`${x}\``, 'field', '-', '-', '-']),
			...Object.entries(d.methods).map(([m, p]) => [`\`${h}\``, `\`${m}\``, p.async ? 'yes' : 'no', p.positional.length ? code(p.positional) : '-', p.options.length ? code(p.options) : '-', Object.keys(p.defaults).length ? Object.entries(p.defaults).map(([k, x]) => `${k} = \`${x}\``).join(', ') : '-']),
		])),
		constants: table(['constant', 'module', 'value'], Object.entries(v.constants).map(([n, c]) => [`\`${n}\``, `\`${c.module}.mjs\``, `\`${JSON.stringify(c.value)}\``])),
		outputs: table(['output', 'keys', 'extra keys when'], Object.entries(v.output_keys).map(([g, ks]) => [`\`${g}\``, `{${ks.join(', ')}}`, v.conditional_keys[g] ? `{${v.conditional_keys[g].join(', ')}}` : '-'])),
		schemas: table(['schema string', 'role', 'carried by'], [
			...Object.entries(v.schemas).map(([g, s]) => [`\`${s}\``, 'output', `\`${g}\``]),
			...Object.entries(v.input_schemas).map(([g, s]) => [`\`${s}\``, 'input, read and never written', `\`${g}\``]),
			...Object.entries(v.contract_tags).map(([g, s]) => [`\`${s}\``, 'contract tag stored in index metadata', `\`${g}\``]),
			...v.foreign_schemas.map((s) => [`\`${s}\``, 'foreign: neither produced nor consumed by this layer', '-']),
		]),
		codes: table(['code', 'kind', 'module', 'properties or status', 'meaning'], [
			...Object.entries(v.codes.errors).map(([c, d]) => [`\`${c}\``, 'error code', `\`${d.module}.mjs\``, d.properties.join(', '), d.meaning]),
			...Object.entries(v.codes.reasons).map(([c, d]) => [`\`${c}\``, 'reason', `\`${d.module}.mjs\``, '-', d.meaning]),
			...Object.entries(v.codes.checks).map(([c, d]) => [`\`${c}\``, 'gate check', '`performance-policy.mjs`', d.status, d.meaning]),
		]),
		statuses: table(['status set', 'applies to', 'field', 'values', 'module'], Object.entries(v.statuses).map(([id, s]) => [`\`${id}\``, s.of, `\`${s.field}\``, s.values.join(', '), `\`${s.module}.mjs\``])),
		policy: table(['policy field', 'default'], Object.entries(v.policy_defaults).map(([k, x]) => [`\`${k}\``, `\`${x}\``])),
		identity_legacy: table(['key field', 'derived from'], Object.entries(v.identity.legacy).map(([k, d]) => [`\`${k}\``, d])),
		identity_project: bullets(v.identity.project),
		identity_included: bullets(v.identity.index.included),
		identity_excluded: bullets(v.identity.index.excluded),
		record: table(['record fact', 'value'], [
			['schema', `\`${base.schema}\` (${base.schema_status})`],
			['base commit', `\`${base.base_commit}\``],
			['pinned files', `${count('source')} source, ${count('test')} test, ${count('test_support')} test support, ${count('external_dependency')} external dependency, ${count('runner')} runner`],
			['fixtures', `${base.fixtures.filter((x) => x.class === 'normal').length} normal, ${base.fixtures.filter((x) => x.class === 'negative').length} negative`],
			['limits', lib.LIMIT_STATUSES.map((s) => `${base.limits.filter((l) => l.status === s).length} ${s}`).join(', ')],
			['artifact digest', `\`${base.artifact_digest.value}\``],
		]),
		gates: table(['gate', 'limits it must close', 'lifted when'], Object.entries(v.gates).map(([g, d]) => [`\`${g}\``, d.limits.map((l) => `\`${l}\` (${statusOf(l)})`).join('; '), d.lifted])),
		non_gate: table(['limit', 'status', 'why it has no gate'], Object.entries(v.non_gate_limits).map(([l, why]) => [`\`${l}\``, statusOf(l), why])),
		tests: table(['test file', 'tests', 'what it covers'], base.files.filter((f) => f.role === 'test').map((f) => [`\`${path.posix.basename(f.path)}\``, String(f.test_count), v.pinned_tests[path.posix.basename(f.path)] ?? ''])),
		owned: table(['directory', 'files'], Object.entries(v.owned_files).map(([d, fs_]) => [`\`${d}\``, code(fs_)])),
		ownership: table(['paths', 'owner', 'T21 may'], v.ownership.map((r) => [code(r.paths), r.owner, r.t21])),
	};
}
const IDENT = /^(?:[a-z]+[A-Z]\w*|[a-z]+_\w+|[A-Z][A-Z0-9]*_\w+)$/;
const wordsOf = (s) => s.split(SPLIT).map((w) => w.replace(/[.:]+$/, '')).filter(Boolean);
function vocabularyWords(x, top = true) { // every string value, and every nested key (the section names themselves are not words)
	if (typeof x === 'string') return [x];
	if (Array.isArray(x)) return x.flatMap((y) => vocabularyWords(y, false));
	if (x && typeof x === 'object') return Object.entries(x).flatMap(([k, y]) => [...(top ? [] : [k]), ...vocabularyWords(y, false)]);
	return [];
}
const SCHEMA_WORD = /\b(?:sbf|bskel)\.[a-z0-9.-]+\/(?:draft-)?\d+/g;
const PATH_WORD = /^(?:lib|scanners|contracts|schemas|release|scripts|test|evidence|next|\.github)\//;
const fileExists = (w) => (w.includes('/') ? fs.existsSync(path.join(ROOT, w)) : [...DIRS, lib.TRACK.testDir].some((d) => fs.existsSync(path.join(ROOT, d, w))));

function rfcProblems(text, v, base = baseline) {
	const out = [];
	const blocks = new Set(text.split(/\n[ \t]*\n/).map((b) => b.trim()));
	for (const [name, block] of Object.entries(render(v, base))) if (!blocks.has(block)) out.push(`table ${name}: the RFC has no block equal to the one rendered from the vocabulary and the record`);
	const rfcLists = new Set([...text.matchAll(/\{(\w+(?:, \w+)+)\}/g)].map((m) => m[1]));
	const vocabLists = new Set([...Object.values(v.output_keys), ...Object.values(v.conditional_keys)].filter((k) => k.length > 1).map((k) => k.join(', ')));
	for (const l of rfcLists) if (!vocabLists.has(l)) out.push(`key list {${l}} is in the RFC but in no list of the vocabulary`);
	for (const l of vocabLists) if (!rfcLists.has(l)) out.push(`key list {${l}} is in the vocabulary but not in the RFC`);
	const inRfc = new Set(wordsOf(text).filter((w) => IDENT.test(w)));
	const listed = new Set(vocabularyWords(v).flatMap(wordsOf).filter((w) => IDENT.test(w)));
	for (const w of inRfc) if (!listed.has(w)) out.push(`identifier ${w} is in the RFC but not in the vocabulary`);
	for (const w of listed) if (!inRfc.has(w)) out.push(`identifier ${w} is in the vocabulary but not in the RFC`);
	const rfcSchemas = new Set(text.match(SCHEMA_WORD) ?? []);
	const listedSchemas = new Set(vocabularyWords(v).flatMap((s) => s.match(SCHEMA_WORD) ?? []));
	for (const s of rfcSchemas) if (!listedSchemas.has(s)) out.push(`schema ${s} is in the RFC but not in the vocabulary`);
	for (const s of listedSchemas) if (!rfcSchemas.has(s)) out.push(`schema ${s} is in the vocabulary but not in the RFC`);
	const limitIds = base.limits.map((l) => l.id);
	for (const w of new Set(wordsOf(text))) {
		if (w.includes('-not-') && !limitIds.includes(w)) out.push(`${w} looks like a limit id but is not one in the record`);
		if (/\.mjs$/.test(w) && !fileExists(w)) out.push(`file ${w} is named in the RFC but does not exist`);
		if (PATH_WORD.test(w) && !fs.existsSync(path.join(ROOT, w))) out.push(`path ${w} is named in the RFC but does not exist`);
	}
	if (FORBIDDEN.test(text)) out.push('the RFC contains a forbidden reference pattern');
	const lines = text.split('\n').length;
	if (lines > LINE_CAP) out.push(`the RFC has ${lines} lines, more than the cap of ${LINE_CAP}`);
	return out;
}
function readmeProblems(text) {
	const out = [];
	if (!text.includes('](../scan-scheduler-next/INTERFACE_RFC.md)')) out.push('README: no link to ../scan-scheduler-next/INTERFACE_RFC.md');
	for (const w of ['BASELINE.json', 'store.mjs', 'cache-index.mjs', 'gc.mjs', baseline.base_commit]) if (!text.includes(w)) out.push(`README: does not mention ${w}`);
	if (FORBIDDEN.test(text)) out.push('README: contains a forbidden reference pattern');
	if (text.split('\n').length > 30) out.push('README: more than 30 lines, it is a pointer');
	return out;
}
// What claims F2 and F6 must say about their scope, and the broad sentences they replaced, which must not come back in the RFC or the README.
const SCOPE = {
	F2: { says: ['only when they use the same repository root and the same lockName', 'must agree on lockName'], never: ['share one lock per repository', 'exclude each other through one lock', 'to a blob under one lock'] },
	F6: { says: ['whose normalized destination lies outside the repository is refused'], never: ['A path with a parent segment is refused'] },
	F8: { says: ['does not remove the entry of an older key', 'Two entries can name one blob', 'only when no entry refers to it'], limitSays: ['for its fixed input', 'is not a blob count', 'name the same blob'], never: ['the only collection candidate', 'a new blob', 'every distinct source state', 'stores a new entry'] },
};
const claimLine = (text, id) => text.split('\n').find((l) => l.startsWith(`- **${id}** `)) ?? '';
function scopeProblems(id, rfc, readme) {
	const out = []; const line = claimLine(rfc, id);
	for (const w of SCOPE[id].says) if (!line.includes(w)) out.push(`claim ${id} does not say "${w}"`);
	for (const [where, t] of [['the RFC', rfc], ['the README', readme]]) for (const w of SCOPE[id].never) if (t.includes(w)) out.push(`${where} still says "${w}" (claim ${id})`);
	return out;
}
const docsOf = (rfc, store) => ({ rfc, store });

if (process.env.T21_PRINT_TABLES) {
	process.stdout.write(`${JSON.stringify(render(vocabulary), null, 1)}\n`);
	process.exit(0);
}

// ---- documents, headings, claims and the conformance tests ----
const { withLockSync } = await import(pathToFileURL(path.join(ROOT, 'lib/lock.mjs')).href);
const HEADINGS = ['# T21 scan scheduler and artifact store: interface RFC', '## 1. Purpose and non-goals', '## 2. Scope', '## 3. Inputs and outputs', '## 4. Identity', '## 5. Unknown, partial and stale', '## 6. Consistency and failure', '## 7. Promotion gates', '## 8. File ownership'];
const CLAIM_RE = /^- \*\*([A-Z]\d+)\*\* /gm;
const CLAIMS = new Set();
// A claim is a numbered statement of the RFC; the test of the same id runs the behaviour it states on real calls.
const claim = (id, title, fn) => { CLAIMS.add(id); return test(`${id} ${title}`, fn); };
function claimProblems(text, ids = CLAIMS) {
	const out = []; const seen = new Set();
	for (const m of text.matchAll(CLAIM_RE)) { if (seen.has(m[1])) out.push(`claim ${m[1]} appears twice in the RFC`); seen.add(m[1]); }
	for (const id of seen) if (!ids.has(id)) out.push(`claim ${id} is in the RFC but no test registers it`);
	for (const id of ids) if (!seen.has(id)) out.push(`claim ${id} has a test but is not in the RFC`);
	return out;
}
function headingProblems(text) {
	const found = text.split('\n').filter((l) => /^#{1,2} /.test(l));
	const out = isDeepStrictEqual(found, HEADINGS) ? [] : [`headings: expected ${JSON.stringify(HEADINGS)} but found ${JSON.stringify(found)}`];
	const head = text.split('\n').slice(0, 12).join('\n');
	for (const w of ['Status:', 'Companions:', baseline.base_commit, baseline.schema, vocabulary.schema]) if (!head.includes(w)) out.push(`the header does not contain ${w}`);
	return out;
}
const walkAbs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAbs(path.join(dir, e.name)) : [path.join(dir, e.name)])).sort();
const blobsUnder = (root) => (fs.existsSync(path.join(root, 'blobs')) ? walkAbs(path.join(root, 'blobs')) : []);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('expected a throw'); };
const thrownAsync = async (fn) => { try { await fn(); } catch (e) { return e; } return assert.fail('expected a rejection'); };
const own = (e) => Object.keys(e).sort();
const has = (problems, re) => problems.some((p) => re.test(p));
const GiB = 1024 ** 3;
const REF = (c) => ({ algorithm: 'sha256', digest: HEX(c), size: 1 });

test('precondition: ripgrep is on PATH, because the scanning tests fail instead of skipping without it', () => {
	assert.equal(hasRg, true, 'rg must be installed: the legacy and project tests run real scans');
});
test('the vocabulary equals what the code exports, emits and declares', () => {
	assert.deepEqual(sourceProblems(vocabulary), []);
});
test('the vocabulary equals the record, the directory listings and the ownership map', () => {
	assert.deepEqual(vocabProblems(vocabulary), []);
});
test('the RFC equals the vocabulary and the record, table by table and word by word', () => {
	const text = read(lib.TRACK.docs.rfc);
	assert.deepEqual([...rfcProblems(text, vocabulary), ...headingProblems(text)], []);
	assert.deepEqual(lib.docProblems(baseline, lib.readDocs()), []);
});
test('the artifact store README is a short pointer to the RFC', () => {
	assert.deepEqual(readmeProblems(read(lib.TRACK.docs.store)), []);
});

// ---- identity claims ----
claim('I1', 'the key digest is the digest of the nine material fields', () => {
	const key = buildScanCacheKey(KEY_INPUT);
	const material = Object.fromEntries(Object.entries(KEY_INPUT).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
	assert.equal(key.algorithm, 'sha256');
	assert.equal(key.digest, digestJson(key.material));
	assert.deepEqual(key.material, { namespace: vocabulary.schemas.cache_key_namespace, ...material });
	assert.deepEqual(Object.keys(key.material), vocabulary.output_keys.cache_key_material);
	assert.deepEqual(Object.keys(key), vocabulary.output_keys.cache_key);
});

claim('I2', 'every dimension changes the digest, key order and unknown properties do not', () => {
	const base = buildScanCacheKey(KEY_INPUT).digest;
	for (const k of Object.keys(KEY_INPUT)) assert.notEqual(buildScanCacheKey({ ...KEY_INPUT, [k]: k === 'runtimeFingerprint' ? 'other' : HEX('0') }).digest, base, k);
	assert.notEqual(buildScanCacheKey({ ...KEY_INPUT, namespace: 'other/1' }).digest, base);
	assert.equal(buildScanCacheKey(Object.fromEntries(Object.entries(KEY_INPUT).reverse())).digest, base);
	assert.equal(buildScanCacheKey({ ...KEY_INPUT, unknownProperty: 'x' }).digest, base);
});

claim('I3', 'malformed dimensions are refused and a missing argument is a raw TypeError', () => {
	assert.throws(() => buildScanCacheKey({ ...KEY_INPUT, sourceDigest: HEX('A') }), { name: 'TypeError', message: 'sourceDigest must be a lowercase sha256 hex digest' });
	assert.throws(() => buildScanCacheKey({ ...KEY_INPUT, policyDigest: 'abc' }), { name: 'TypeError', message: 'policyDigest must be a lowercase sha256 hex digest' });
	assert.throws(() => buildScanCacheKey({ ...KEY_INPUT, runtimeFingerprint: '' }), { name: 'TypeError', message: 'runtimeFingerprint must be a non-empty string' });
	assert.throws(() => buildScanCacheKey(), TypeError);
});

claim('I4', 'canonical JSON sorts keys and refuses what it cannot encode exactly', () => {
	assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
	assert.equal(stableJson({ b: 1, a: 2, 10: 3, 9: 4 }), '{"9":4,"10":3,"a":2,"b":1}');
	for (const bad of [undefined, () => 1, Symbol('s'), 1n, NaN, Infinity]) assert.throws(() => stableJson({ a: bad }), TypeError);
	assert.throws(() => stableJson({ a: undefined }), { message: '$.a: unsupported cache-key material type undefined' });
	assert.throws(() => stableJson({ a: NaN }), { message: '$.a: cache-key material must not contain non-finite numbers' });
	assert.equal(stableJson({ d: new Date(0), m: new Map([[1, 2]]), s: new Set([1]) }), '{"d":{},"m":{},"s":{}}');
	assert.equal(stableJson({ a: -0 }), '{"a":0}');
	assert.equal(stableJson([1, , 3]), '[1,null,3]');
});

claim('I5', 'an artifact is identified by the sha256 of its exact bytes', () => {
	const store = createArtifactStore(fresh('i5'));
	const a = store.put('hello'); const b = store.put(Buffer.from('hello')); const c = store.put(new Uint8Array([104, 101, 108, 108, 111]));
	assert.deepEqual(a, { algorithm: 'sha256', digest: createHash('sha256').update('hello').digest('hex'), size: 5 });
	assert.deepEqual(b, a);
	assert.deepEqual(c, a);
	assert.deepEqual(Object.keys(a), vocabulary.output_keys.store_ref);
	assert.equal(store.pathForDigest(a.digest), path.join(store.root, 'blobs', 'sha256', a.digest.slice(0, 2), a.digest));
	assert.equal(blobsUnder(store.root).length, 1);
	assert.notEqual(store.put('hello ').digest, a.digest);
	assert.equal(store.put('').digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

claim('I6', 'the source digest covers path, size, mode and content, and not time, location, links or findings', () => {
	const make = (name) => { const r = fresh(name); fs.mkdirSync(path.join(r, 'src')); fs.writeFileSync(path.join(r, 'src', 'a.txt'), 'one'); return r; };
	const r1 = make('i6a'); const r2 = make('i6b'); const file = path.join(r1, 'src', 'a.txt');
	const first = buildFileIndex(r1);
	assert.equal(first.source_digest, digestJson(first.entries));
	assert.deepEqual(Object.keys(first.entries[0]), vocabulary.output_keys.file_index_entry);
	assert.equal(buildFileIndex(r2).source_digest, first.source_digest);
	fs.utimesSync(file, 1, 1);
	assert.equal(buildFileIndex(r1).source_digest, first.source_digest);
	fs.mkdirSync(path.join(r1, 'empty'));
	assert.equal(buildFileIndex(r1).source_digest, first.source_digest);
	fs.symlinkSync(file, path.join(r1, 'link'));
	const linked = buildFileIndex(r1);
	assert.equal(linked.source_digest, first.source_digest);
	assert.equal(linked.skipped_symlinks.length, 1);
	assert.equal(linked.stats.skipped_symlinks, 1);
	for (const dir of DEFAULT_EXCLUDED_DIRS) { fs.mkdirSync(path.join(r1, 'src', dir), { recursive: true }); fs.writeFileSync(path.join(r1, 'src', dir, 'x.js'), 'x'); }
	assert.equal(buildFileIndex(r1).source_digest, first.source_digest);
	fs.writeFileSync(path.join(r1, 'Case.txt'), 'x'); fs.writeFileSync(path.join(r1, 'case.txt'), 'y');
	const folded = buildFileIndex(r1); // on a case-insensitive volume the two names are one file, so there is nothing to find
	assert.equal(folded.source_digest, digestJson(folded.entries));
	assert.equal(folded.portable_path_issues.length > 0, folded.entries.length === first.entries.length + 2);
	assert.ok(portablePathIssuesForPaths(['Case.txt', 'case.txt']).some((i) => i.kind === 'case-fold-collision'));
	fs.rmSync(path.join(r1, 'Case.txt'), { force: true }); fs.rmSync(path.join(r1, 'case.txt'), { force: true });
	assert.equal(buildFileIndex(r1).source_digest, first.source_digest);
	fs.chmodSync(file, 0o755);
	const moded = buildFileIndex(r1);
	assert.notEqual(moded.source_digest, first.source_digest);
	assert.equal(moded.entries[0].mode, 0o755);
	fs.writeFileSync(file, 'two');
	assert.notEqual(buildFileIndex(r1).source_digest, moded.source_digest);
});

claim('I7', 'the legacy scan key is derived from the fields the identity table lists', async () => {
	assert.equal(hasRg, true, 'rg must be installed');
	const adapter = ADAPTERS.find((a) => a.id === 'python-fastapi');
	const repo = fresh('i7'); fs.cpSync(path.join(ROOT, FASTAPI), repo, { recursive: true });
	const base = { repoRoot: repo, adapter, terms: ['x'], implementationDigest: HEX('a'), cacheNamespace: HEX('8'), policyFingerprint: HEX('9'), runtimeFingerprint: 'rt' };
	const call = (over = {}) => runLegacyScanCached({ ...base, ...over });
	const first = await call();
	const descriptor = { contract: adapter.contract ?? null, id: adapter.id, title: adapter.title ?? null, specificity: adapter.specificity ?? null, confidence: adapter.confidence ?? null, verification_basis: adapter.verificationBasis ?? null, capabilities: adapter.capabilities ?? {} };
	const expected = buildScanCacheKey({
		sourceDigest: buildFileIndex(repo).source_digest,
		resolverDigest: digestJson({ mode: 'legacy-single-project', cache_namespace: HEX('8'), adapter_id: adapter.id, rg_available: true, include_db: false, runtime_routes: false }),
		configDigest: digestJson({ terms: ['x'] }),
		parserDigest: HEX('a'),
		adapterDigest: digestJson({ implementation_digest: HEX('a'), descriptor }),
		schemaDigest: digestJson({ scan_schema: vocabulary.input_schemas.scan_report }),
		policyDigest: digestJson({ cache_contract: vocabulary.contract_tags.legacy_shadow, external_policy_fingerprint: HEX('9'), db: 'disabled', runtime_routes: 'disabled', cache_corruption: 'fail-closed' }),
		runtimeFingerprint: 'rt',
	});
	assert.equal(first.cache_key, expected.digest);
	assert.equal(first.source_digest, expected.material.source_digest);
	assert.deepEqual(Object.keys(first), vocabulary.output_keys.legacy_result);
	assert.equal(first.cache_hit, false);
	const second = await call();
	assert.equal(second.cache_hit, true);
	assert.deepEqual([second.cache_key, second.artifact], [first.cache_key, first.artifact]);
	assert.deepEqual(createCacheIndex(repo).list()[0].metadata, { adapter_id: adapter.id, cache_contract: vocabulary.contract_tags.legacy_shadow, source_digest: first.source_digest });
	for (const over of [{ terms: [] }, { implementationDigest: HEX('b') }, { cacheNamespace: HEX('7') }, { policyFingerprint: HEX('6') }, { runtimeFingerprint: 'other' }, { rgAvailable: false }]) assert.notEqual((await call(over)).cache_key, first.cache_key, JSON.stringify(over));
	const off = await call({ useCache: false });
	assert.deepEqual([off.cache_used, off.artifact], [false, null]);
	assert.equal(off.cache_key, first.cache_key);
});

claim('I8', 'a project namespace is the digest of the schema, the identity, the adapter, the mode, the markers and the dependency edges', () => {
	const marker = { path: 'svc/pyproject.toml', kind: 'manifest', digest: `sha256:${HEX('a')}` };
	const graph = projectGraph([marker]);
	const plan = buildProjectCachePlan(graph);
	const item = (p, id) => p.projects.find((x) => x.project_id === id);
	assert.deepEqual(plan.projects.map((p) => p.project_id), ['p2', 'p1']);
	assert.equal(item(plan, 'p1').cache_namespace, digestJson({ graph_schema: vocabulary.input_schemas.project_graph, project_id: 'p1', project_root: 'svc', adapter_id: 'python-fastapi', mode: 'first-class', markers: [marker], dependency_project_ids: ['p2'] }));
	assert.equal(item(plan, 'p2').cache_namespace, digestJson({ graph_schema: vocabulary.input_schemas.project_graph, project_id: 'p2', project_root: 'lib', adapter_id: 'python-fastapi', mode: 'first-class', markers: [], dependency_project_ids: [] }));
	const drift = buildProjectCachePlan(projectGraph([{ ...marker, digest: `sha256:${HEX('b')}` }]));
	assert.notEqual(item(drift, 'p1').cache_namespace, item(plan, 'p1').cache_namespace);
	assert.equal(item(drift, 'p2').cache_namespace, item(plan, 'p2').cache_namespace);
	const cut = buildProjectCachePlan({ ...graph, project_edges: [] });
	assert.notEqual(item(cut, 'p1').cache_namespace, item(plan, 'p1').cache_namespace);
	assert.equal(item(cut, 'p2').cache_namespace, item(plan, 'p2').cache_namespace);
	assert.deepEqual(buildProjectCachePlan({ ...graph, projects: [...graph.projects].reverse() }), plan);
	assert.equal(plan.graph_schema, vocabulary.input_schemas.project_graph);
	assert.equal(plan.schema, vocabulary.schemas.project_plan);
});

// ---- unknown, partial and stale claims ----
claim('U1', 'a blob is trusted only after its size and digest are verified, and nothing is repaired', () => {
	const store = createArtifactStore(fresh('u1'));
	const ref = store.put('payload');
	const file = store.pathForDigest(ref.digest);
	fs.writeFileSync(file, 'pay');
	assert.equal(store.has(ref), true);
	const corrupt = thrown(() => store.read(ref));
	assert.equal(corrupt.code, 'ARTIFACT_CORRUPT');
	assert.deepEqual(own(corrupt), ['code']);
	assert.equal(fs.readFileSync(file, 'utf8'), 'pay');
	const missing = REF('c');
	assert.equal(store.has(missing), false);
	const absent = thrown(() => store.read(missing));
	assert.equal(absent.code, 'ARTIFACT_NOT_FOUND');
	assert.deepEqual(own(absent), ['code']);
	const other = store.put('other');
	assert.equal(thrown(() => store.read({ ...other, size: other.size + 1 })).code, 'ARTIFACT_CORRUPT');
	assert.throws(() => store.read({ algorithm: 'md5', digest: other.digest, size: 1 }), { name: 'TypeError', message: 'invalid sha256 artifact ref' });
	assert.throws(() => store.has({ ...other, size: '5' }), { name: 'TypeError', message: 'invalid sha256 artifact ref' });
	assert.throws(() => store.pathForDigest('../etc'), { name: 'TypeError', message: 'invalid sha256 digest' });
});

claim('U2', 'content over maxArtifactBytes is refused before anything is written', () => {
	const root = fresh('u2'); const store = createArtifactStore(root, { maxArtifactBytes: 10 });
	const refused = thrown(() => store.put('x'.repeat(11)));
	assert.equal(refused.code, 'ARTIFACT_BUDGET_EXCEEDED');
	assert.equal(refused.message, 'artifact exceeds maxArtifactBytes: 11 > 10');
	assert.deepEqual(own(refused), ['code']);
	assert.deepEqual(blobsUnder(root), []);
	assert.equal(store.put('x'.repeat(10)).size, 10);
	assert.throws(() => createArtifactStore(root, { maxArtifactBytes: 0 }), { name: 'TypeError', message: 'maxArtifactBytes must be a positive integer' });
	assert.throws(() => store.put(42), { name: 'TypeError', message: 'artifact content must be a string, Buffer or Uint8Array' });
});

claim('U3', 'a damaged index fails closed and a failed write leaves it as it was', () => {
	const repo = fresh('u3'); const index = createCacheIndex(repo);
	assert.deepEqual(index.list(), []);
	assert.equal(index.get(HEX('2')), null);
	assert.equal(fs.existsSync(index.path), false);
	index.set(HEX('2'), REF('1'));
	const good = JSON.parse(fs.readFileSync(index.path, 'utf8'));
	const damages = [
		['{not json', SyntaxError],
		[JSON.stringify({ ...good, schema: 'sbf.scan-cache-index/9' }), /invalid cache index: expected sbf.scan-cache-index\/1/],
		[JSON.stringify({ ...good, entries: { [HEX('2')]: { artifact: { algorithm: 'md5', digest: 'x', size: 1 }, dependencies: [] } } }), Error],
	];
	for (const [text, expected] of damages) {
		fs.writeFileSync(index.path, text);
		assert.throws(() => index.list(), expected);
		assert.throws(() => index.get(HEX('2')), expected);
		assert.throws(() => index.set(HEX('3'), REF('1')), expected);
		assert.equal(fs.readFileSync(index.path, 'utf8'), text);
	}
});

claim('U4', 'a hit never recomputes behind a bad blob, and a rejected value is stored nowhere', async () => {
	const store = createArtifactStore(fresh('u4s')); const index = createCacheIndex(fresh('u4i'));
	const key = buildScanCacheKey(KEY_INPUT).digest;
	let calls = 0;
	const run = (over = {}) => runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => { calls += 1; return { n: calls }; }, ...json, ...over });
	const first = await run();
	const second = await run();
	assert.deepEqual([first.cache_hit, second.cache_hit, calls, second.value], [false, true, 1, { n: 1 }]);
	assert.deepEqual(Object.keys(second), vocabulary.output_keys.cached_task_result);
	const file = store.pathForDigest(first.artifact.digest);
	fs.writeFileSync(file, 'garbage');
	assert.equal((await thrownAsync(() => run())).code, 'ARTIFACT_CORRUPT');
	fs.rmSync(file);
	assert.equal((await thrownAsync(() => run())).code, 'ARTIFACT_NOT_FOUND');
	assert.equal(calls, 1);
	const seen = [];
	const clean = { store: createArtifactStore(fresh('u4t')), index: createCacheIndex(fresh('u4j')) };
	const rejected = await thrownAsync(() => runCachedTask({ cacheKey: key, cacheIndex: clean.index, artifactStore: clean.store, compute: async () => ({ a: 1 }), validate: (value, context) => { seen.push(context); throw new Error('invalid value'); }, ...json }));
	assert.equal(rejected.message, 'invalid value');
	assert.deepEqual(seen, [{ cache_hit: false, artifact: null }]);
	assert.deepEqual([clean.index.list(), blobsUnder(clean.store.root)], [[], []]);
});

claim('U5', 'a file index over its budget fails whole and names the limit', () => {
	const r = fresh('u5'); fs.writeFileSync(path.join(r, 'a'), 'aa'); fs.writeFileSync(path.join(r, 'b'), 'bb');
	const count = thrown(() => buildFileIndex(r, { maxFiles: 1 }));
	assert.equal(count.code, 'INDEX_BUDGET_EXCEEDED');
	assert.deepEqual([count.kind, count.limit, count.actual > count.limit], ['file-count', 1, true]);
	assert.deepEqual(own(count), ['actual', 'code', 'kind', 'limit']);
	assert.equal(count.message, `scan file-index file-count budget exceeded: ${count.actual} > 1`);
	const bytes = thrown(() => buildFileIndex(r, { maxBytes: 3 }));
	assert.deepEqual([bytes.code, bytes.kind, bytes.limit], ['INDEX_BUDGET_EXCEEDED', 'byte-count', 3]);
	assert.equal(buildFileIndex(r, { maxFiles: 2, maxBytes: 4 }).stats.files, 2);
	assert.equal(buildFileIndex(r, { maxFiles: NaN, maxBytes: NaN }).stats.files, 2);
	assert.equal(thrown(() => buildFileIndex(path.join(r, 'missing'))).code, 'ENOENT');
	assert.equal(thrown(() => buildFileIndex(path.join(r, 'a'))).code, 'ENOTDIR');
});

claim('U6', 'a failed or oversized task blocks work and is never reported as passed', async () => {
	const ran = [];
	const out = await runTaskGraph(TASKS, async (t) => { ran.push(t.id); return boom(t); }, { maxConcurrency: 2 });
	assert.deepEqual(out.results.map((r) => r.id), ['a', 'b', 'c', 'd', 'x2']);
	const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
	assert.deepEqual(by.a, { id: 'a', status: 'passed', value: { v: 'a' } });
	assert.deepEqual(by.x2, { id: 'x2', status: 'failed', error: 'boom' });
	assert.deepEqual(by.d, { id: 'd', status: 'blocked', reason: 'DEPENDENCY_NOT_PASSED', dependency: 'x2' });
	assert.deepEqual(by.c, { id: 'c', status: 'blocked', reason: 'RESOURCE_BUDGET_EXCEEDED', estimated_bytes: 10 ** 12, budget_bytes: 512 * 1024 * 1024 });
	assert.deepEqual(ran.sort(), ['a', 'b', 'x2']);
	assert.deepEqual(Object.keys(out.metrics), vocabulary.output_keys.scheduler_metrics);
	assert.deepEqual([out.metrics.tasks, out.metrics.passed, out.metrics.failed, out.metrics.blocked, out.metrics.resource_budget_blocked, out.metrics.dependency_blocked], [5, 2, 1, 2, 1, 1]);
	const equal = await runTaskGraph([{ id: 'e', estimatedBytes: 5 }], async () => 1, { maxEstimatedBytesInFlight: 5 });
	assert.deepEqual(equal.results, [{ id: 'e', status: 'passed', value: 1 }]);
	for (const [thrownValue, error] of [[new Error('sync'), 'sync'], ['plain', 'plain'], [{}, '[object Object]']]) {
		const r = await runTaskGraph([{ id: 'a' }], () => { throw thrownValue; });
		assert.deepEqual(r.results, [{ id: 'a', status: 'failed', error }]);
	}
});

claim('U7', 'the gate never passes on unknown input', () => {
	const codes = (g) => g.checks.map((c) => c.code);
	const early = evaluatePerformanceGate({});
	assert.deepEqual([early.status, codes(early), Object.keys(early)], ['blocked', ['MISSING_ENVIRONMENT_IDENTITY'], vocabulary.output_keys.performance_gate_early]);
	const side = (environment) => ({ environment, workloads: [workload()] });
	for (const environment of [{ ...ENV, platform: 'z' }, { ...ENV, node_major: '24' }]) {
		const g = evaluatePerformanceGate({ baseline: side(ENV), candidate: side(environment) });
		assert.deepEqual([g.status, codes(g)], ['blocked', ['ENVIRONMENT_MISMATCH']]);
	}
	const other = evaluatePerformanceGate({ baseline: side(ENV), candidate: { environment: ENV, workloads: [workload({ id: 'other' })] } });
	assert.deepEqual([other.status, [...new Set(codes(other))]], ['blocked', ['WORKLOAD_SET_MISMATCH']]);
	const cases = [[{ samples: 4 }, 'blocked', 'INSUFFICIENT_SAMPLES'], [{ semantic_equivalence: 'yes' }, 'blocked', 'SEMANTIC_EQUIVALENCE_UNPROVEN'], [{ semantic_equivalence: undefined }, 'blocked', 'SEMANTIC_EQUIVALENCE_UNPROVEN'], [{ semantic_equivalence: false }, 'fail', 'SEMANTIC_MISMATCH'], [{ cold_p95_ms: 0 }, 'blocked', 'MISSING_OR_INVALID_METRIC'], [{ cold_p95_ms: 100 }, 'fail', 'COLD_REGRESSION_PCT']];
	const seen = [];
	for (const [over, status, code_] of cases) { const g = gateOf(over); assert.equal(g.status, status, code_); assert.ok(codes(g).includes(code_), code_); seen.push(...g.checks); }
	const good = gateOf();
	assert.deepEqual([good.status, codes(good)], ['pass', ['COLD_REGRESSION_PCT', 'PEAK_RSS_REGRESSION_PCT', 'CACHE_HIT_FRACTION_OF_COLD']]);
	for (const c of [...seen, ...good.checks, ...early.checks]) assert.ok(vocabulary.codes.checks[c.code].status.split(' or ').includes(c.status), `${c.code} ${c.status}`);
	const vacuous = evaluatePerformanceGate({ baseline: { environment: ENV, workloads: [] }, candidate: { environment: ENV, workloads: [] } });
	assert.equal(vacuous.status, 'pass');
	assert.deepEqual(vacuous.checks, []);
	assert.throws(() => evaluatePerformanceGate({ baseline: { environment: ENV, workloads: [workload(), workload()] }, candidate: side(ENV) }), { message: 'baseline contains duplicate workload id: w' });
	assert.throws(() => evaluatePerformanceGate({ baseline: { environment: ENV }, candidate: side(ENV) }), { name: 'TypeError', message: 'baseline.workloads must be an array' });
	assert.throws(() => evaluatePerformanceGate({ baseline: side(ENV), candidate: side(ENV), policy: { minSamples: 0 } }), { name: 'TypeError', message: 'policy.minSamples must be a positive integer' });
	assert.throws(() => evaluatePerformanceGate({ baseline: side(ENV), candidate: side(ENV), policy: { maxColdRegressionPct: -1 } }), { name: 'TypeError', message: 'policy.maxColdRegressionPct must be a finite non-negative number' });
	assert.deepEqual(good.policy, vocabulary.policy_defaults);
});

claim('U8', 'memory admission is blocked when nothing is left after the reserve', () => {
	const ready = deriveMemoryAdmission({ totalBytes: 64 * GiB });
	assert.deepEqual([ready.status, 'reason' in ready], ['ready', false]);
	assert.deepEqual(Object.keys(ready), vocabulary.output_keys.memory_admission);
	const exact = deriveMemoryAdmission({ totalBytes: 8 * GiB });
	assert.deepEqual([exact.status, exact.reason, exact.admission_bytes], ['blocked', 'INSUFFICIENT_MEMORY_AFTER_RESERVE', 0]);
	assert.deepEqual(Object.keys(exact), [...vocabulary.output_keys.memory_admission, ...vocabulary.conditional_keys.memory_admission]);
	assert.equal(deriveMemoryAdmission({ totalBytes: 64 * GiB, maxAdmissionBytes: 0 }).status, 'blocked');
	assert.throws(() => deriveMemoryAdmission({ totalBytes: -1 }), { name: 'TypeError', message: 'totalBytes must be a non-negative safe integer' });
	assert.throws(() => deriveMemoryAdmission({ totalBytes: 1.5 }), { name: 'TypeError', message: 'totalBytes must be a non-negative safe integer' });
	assert.throws(() => deriveMemoryAdmission({ totalBytes: GiB, reserveFraction: 1 }), { name: 'TypeError', message: 'reserveFraction must be a finite number in [0, 1)' });
});

claim('U9', 'a stale or mismatched project graph is refused before any scan, each with its own code', async () => {
	const repo = fresh('u9'); fs.mkdirSync(path.join(repo, 'svc')); const marker = path.join(repo, 'svc', 'pyproject.toml'); fs.writeFileSync(marker, 'a'); const good = fileSha(marker);
	const graphWith = (digest, extra = {}) => ({ schema: vocabulary.input_schemas.project_graph, repo_root: '.', projects: [{ project_id: 'p1', root: 'svc', kind: 'service', facets: { http: { selected_adapter: 'python-fastapi' } }, markers: [{ path: 'svc/pyproject.toml', kind: 'manifest', digest }] }], project_edges: [], ...extra });
	const run = (over = {}) => runProjectGraphCached({ repoRoot: repo, graph: graphWith(good), adapters: ADAPTERS, implementationDigests: { 'python-fastapi': HEX('b') }, ...over });
	const wrong = `sha256:${HEX('0')}`;
	const stale = await thrownAsync(() => run({ graph: graphWith(wrong) }));
	assert.deepEqual([stale.code, stale.expected_digest, stale.actual_digest, own(stale)], ['PROJECT_GRAPH_STALE', wrong, good, ['actual_digest', 'code', 'expected_digest']]);
	const root = await thrownAsync(() => run({ graph: graphWith(good, { repo_root: path.join(repo, 'elsewhere') }) }));
	assert.deepEqual([root.code, root.message, own(root)], ['PROJECT_GRAPH_ROOT_MISMATCH', 'graph repo_root does not match execution repoRoot', ['code']]);
	const unavailable = await thrownAsync(() => run({ adapters: [] }));
	assert.deepEqual([unavailable.code, own(unavailable)], ['PROJECT_ADAPTER_UNAVAILABLE', ['code']]);
	const noDigest = await thrownAsync(() => run({ implementationDigests: {} }));
	assert.deepEqual([noDigest.message, noDigest.code], ['missing implementation digest for adapter: python-fastapi', undefined]);
	fs.rmSync(marker);
	const gone = await thrownAsync(() => run());
	assert.deepEqual([gone.code, own(gone)], ['PROJECT_GRAPH_STALE', ['code']]);
	await assert.rejects(() => run({ graph: { schema: 'other' } }), { name: 'TypeError' });
});

claim('U10', 'changes are classified as added, deleted or modified and their dependents follow', () => {
	const mk = (files) => { const r = fresh('u10'); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(r, f), c); return buildFileIndex(r); };
	const previousIndex = mk({ 'a.js': '1', 'b.js': '1', 'c.js': '1' }); const nextIndex = mk({ 'a.js': '1', 'b.js': '2', 'd.js': '1' });
	const out = computeInvalidation({ previousIndex, nextIndex, dependencyEdges: [{ dependent: 'a.js', dependency: 'b.js' }, { dependent: 'e.js', dependency: 'a.js' }] });
	assert.deepEqual(Object.keys(out), vocabulary.output_keys.invalidation);
	assert.deepEqual([out.added, out.deleted, out.modified, out.changed], [['d.js'], ['c.js'], ['b.js'], ['b.js', 'c.js', 'd.js']]);
	assert.deepEqual(out.invalidated, ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);
	assert.equal(out.global_inputs_changed, false);
	const all = computeInvalidation({ previousIndex, nextIndex, globalInputsChanged: true });
	assert.deepEqual([all.invalidated, all.global_inputs_changed], [['a.js', 'b.js', 'c.js', 'd.js'], true]);
	assert.deepEqual(computeInvalidation({ previousIndex, nextIndex: previousIndex }).invalidated, []);
	assert.throws(() => computeInvalidation({ previousIndex, nextIndex, dependencyEdges: [{ dependent: 'a.js' }] }), { name: 'TypeError', message: 'dependencyEdges entries must be { dependent, dependency } strings' });
	assert.throws(() => computeInvalidation({}), { name: 'TypeError', message: 'expected sbf.scan-file-index/1' });
	const stale = createCacheIndex(fresh('u10i')); stale.set(HEX('2'), REF('1'), { dependencies: ['a.js'] }); stale.set(HEX('3'), REF('1'), { dependencies: ['b.js'] });
	assert.deepEqual(stale.invalidateDependencies(['b.js']).map((e) => e.cache_key), [HEX('3')]);
	assert.deepEqual(stale.list().map((e) => e.cache_key), [HEX('2')]);
	assert.throws(() => stale.invalidateDependencies('a.js'), { name: 'TypeError', message: 'paths must be a string array' });
});

// ---- consistency, failure and hostile-input claims ----
claim('F1', 'a blob is written privately and renamed, and an existing blob is verified, never repaired', () => {
	const root = fresh('f1'); const store = createArtifactStore(root); const ref = store.put('content');
	const file = store.pathForDigest(ref.digest);
	assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
	assert.deepEqual(blobsUnder(root).filter((f) => f.endsWith('.tmp')), []);
	const partial = `${store.pathForDigest(HEX('4'))}.1.2.tmp`;
	fs.mkdirSync(path.dirname(partial), { recursive: true }); fs.writeFileSync(partial, 'half');
	assert.equal(store.has(REF('4')), false);
	assert.equal(thrown(() => store.read(REF('4'))).code, 'ARTIFACT_NOT_FOUND');
	fs.writeFileSync(file, 'xxxxxxx');
	const e = thrown(() => store.put('content'));
	assert.deepEqual([e.code, own(e), /^artifact store corruption at /.test(e.message)], ['ARTIFACT_CORRUPT', ['code'], true]);
	assert.equal(fs.readFileSync(file, 'utf8'), 'xxxxxxx');
});

claim('F2', 'writers that use the same lock name share one lock per repository, a writer with another name is not held back, readers take none, and a stale lock is never broken', () => {
	const repo = fresh('f2'); const index = createCacheIndex(repo);
	const lock = path.join(repo, '.sbf', '.locks', 't21-cache-index.lock');
	fs.mkdirSync(lock, { recursive: true });
	assert.deepEqual([index.list(), index.get(HEX('2')), index.invalidateDependencies([])], [[], null, []]);
	const e = thrown(() => index.set(HEX('2'), REF('1')));
	assert.match(e.message, /could not acquire lock "t21-cache-index" within 5000ms/);
	assert.equal(fs.existsSync(index.path), false);
	assert.equal(fs.existsSync(lock), true);
	fs.rmdirSync(lock);
	index.set(HEX('2'), REF('1'));
	assert.equal(fs.existsSync(lock), false);
	assert.equal(index.list().length, 1);
	assert.throws(() => withLockSync(repo, 'probe', () => { throw new Error('inside'); }), /inside/);
	assert.equal(fs.existsSync(path.join(repo, '.sbf', '.locks', 'probe.lock')), false);
	assert.throws(() => withLockSync(repo, 'probe', () => withLockSync(repo, 'probe', () => {}, { timeoutMs: 50 })), /could not acquire lock "probe" within 50ms/);
	// Another lockName is another lock: while the default lock is held, a writer with that name is not held back.
	fs.mkdirSync(lock, { recursive: true });
	const other = createCacheIndex(repo, { lockName: 'other-name' });
	other.set(HEX('3'), REF('1'));
	assert.deepEqual(index.list().map((e) => e.cache_key), [HEX('2'), HEX('3')]);
	assert.equal(fs.existsSync(lock), true);
	fs.rmdirSync(lock);
	const rfc = read(lib.TRACK.docs.rfc); const readme = read(lib.TRACK.docs.store);
	assert.deepEqual(scopeProblems('F2', rfc, readme), []);
	assert.ok(scopeProblems('F2', rfc.replace('only when they use the same repository root and the same lockName', 'always'), readme).length > 0);
	assert.ok(scopeProblems('F2', `${rfc}\nAll writers of the cache index share one lock per repository.\n`, readme).length > 0);
	assert.ok(scopeProblems('F2', rfc, readme.replace('under a lock that is named by its `lockName` option', 'under one lock')).length > 0);
});

claim('F3', 'collection is a dry run by default and selects only unreachable, aged, expected blobs', () => {
	const root = fresh('f3'); const store = createArtifactStore(root);
	const keep = store.put('keep'); const drop = store.put('drop'); const young = store.put('young');
	fs.utimesSync(store.pathForDigest(young.digest), FAR / 1000, FAR / 1000);
	const tmp = `${store.pathForDigest(drop.digest)}.123.456.tmp`; fs.writeFileSync(tmp, 'partial');
	const stray = path.join(root, 'blobs', 'sha256', 'zz'); fs.writeFileSync(stray, 'x');
	const options = { reachable: [keep], nowMs: FAR, minAgeMs: 1000 };
	const dry = collectArtifactGarbage(root, options);
	assert.deepEqual(Object.keys(dry), vocabulary.output_keys.gc_result);
	assert.deepEqual([dry.dry_run, dry.reachable, dry.total_blobs, dry.candidate_bytes, dry.deleted], [true, 1, 3, 4, []]);
	assert.deepEqual(dry.candidates.map((c) => c.digest), [drop.digest]);
	assert.deepEqual(Object.keys(dry.candidates[0]), vocabulary.output_keys.gc_item);
	assert.deepEqual(dry.unexpected, [`${drop.digest.slice(0, 2)}/${path.basename(tmp)}`, 'zz'].sort());
	assert.equal(store.has(drop), true);
	const applied = collectArtifactGarbage(root, { ...options, dryRun: false });
	assert.deepEqual(applied.deleted.map((c) => c.digest), [drop.digest]);
	assert.deepEqual([store.has(drop), store.has(keep), store.has(young)], [false, true, true]);
	assert.deepEqual([fs.existsSync(tmp), fs.existsSync(stray)], [true, true]);
	assert.throws(() => collectArtifactGarbage(root, { reachable: ['nothex'] }), { name: 'TypeError', message: 'reachable entries must be sha256 digests or artifact refs' });
	assert.throws(() => collectArtifactGarbage(root, { nowMs: NaN }), { name: 'TypeError', message: 'nowMs must be finite' });
	assert.throws(() => collectArtifactGarbage(root, { maxDeleteCount: -1 }), { name: 'TypeError', message: 'maxDeleteCount must be a non-negative integer' });
});

claim('F4', 'the caller owns the hazards of collection: explicit flags, the reachable list, the clock and the lock', () => {
	const make = (name, n) => { const root = fresh(name); const s = createArtifactStore(root); return { root, s, refs: Array.from({ length: n }, (_, i) => s.put(`blob-${i}`)) }; };
	let m = make('f4a', 2);
	assert.equal(collectArtifactGarbage(m.root, { dryRun: false, nowMs: FAR }).deleted.length, 2);
	m.refs.forEach((r) => assert.equal(m.s.has(r), false));
	m = make('f4b', 1);
	assert.equal(collectArtifactGarbage(m.root, { dryRun: null, nowMs: FAR }).deleted.length, 1);
	m = make('f4c', 3);
	const cut = collectArtifactGarbage(m.root, { maxDeleteCount: 1, nowMs: FAR });
	assert.deepEqual([cut.candidates.length, cut.total_blobs, cut.deleted.length], [1, 3, 0]);
	assert.equal(collectArtifactGarbage(m.root, { nowMs: 0, minAgeMs: 1 }).candidates.length, 0);
	const none = collectArtifactGarbage(path.join(fresh('f4d'), 'no-store'), { dryRun: false });
	assert.deepEqual([none.dry_run, none.total_blobs, none.candidates, none.unexpected], [false, 0, [], []]);
	assert.ok(!/withLockSync|\.lock/.test(facts.code.gc), 'gc.mjs takes no lock');
});

claim('F5', 'no write path in the layer calls fsync, so a power loss can leave the newest write missing or truncated', () => {
	for (const [name, src] of Object.entries(facts.code)) assert.ok(!/fsync/i.test(src), `${name}.mjs mentions fsync`);
	assert.ok(!/fsync/i.test(read('lib/fsutil.mjs')), 'lib/fsutil.mjs mentions fsync');
	assert.match(facts.code.store, /flag: 'wx'/);
	assert.match(facts.code.store, /renameSync/);
	assert.match(read('lib/fsutil.mjs'), /renameSync/);
});

claim('F6', 'containment of the cache index path is lexical: the normalized destination decides, so a parent segment that ends inside is accepted and a symlinked directory inside the repository escapes', () => {
	const repo = fresh('f6'); const outside = fresh('f6out');
	assert.throws(() => createCacheIndex(repo, { relativePath: '../escape.json' }), { message: 'cache index path must stay inside repoRoot' });
	assert.throws(() => createCacheIndex(repo, { relativePath: '.sbf/../../escape.json' }), { message: 'cache index path must stay inside repoRoot' });
	createCacheIndex(repo, { relativePath: '.sbf/../.sbf/inside.json' }).set(HEX('2'), REF('1'));
	assert.equal(fs.existsSync(path.join(repo, '.sbf', 'inside.json')), true);
	assert.doesNotThrow(() => createCacheIndex(repo, { relativePath: path.join(repo, 'abs.json') }));
	fs.symlinkSync(outside, path.join(repo, 'link'));
	createCacheIndex(repo, { relativePath: 'link/index.json' }).set(HEX('2'), REF('1'));
	assert.equal(fs.existsSync(path.join(outside, 'index.json')), true);
	const rfc = read(lib.TRACK.docs.rfc); const readme = read(lib.TRACK.docs.store);
	assert.deepEqual(scopeProblems('F6', rfc, readme), []);
	assert.ok(scopeProblems('F6', rfc.replace('whose normalized destination lies outside the repository is refused', 'with a parent segment is refused'), readme).length > 0);
	assert.ok(scopeProblems('F6', `${rfc}\nA path with a parent segment is refused with an error.\n`, readme).length > 0);
});

claim('F7', 'the scheduler bounds concurrency and reserved bytes and has no timeout or cancellation', async () => {
	assert.ok(!/setTimeout|AbortSignal|AbortController|signal/i.test(facts.code.scheduler), 'scheduler.mjs has no timeout or cancellation path');
	const ids = Array.from({ length: 8 }, (_, i) => `t${i}`);
	const tasks = ids.map((id) => ({ id, estimatedBytes: 4 }));
	const watch = () => {
		const seen = { finished: [], running: 0, peak: 0 };
		seen.worker = async (task) => { seen.running += 1; seen.peak = Math.max(seen.peak, seen.running); await new Promise((resolve) => setImmediate(resolve)); seen.running -= 1; seen.finished.push(task.id); };
		return seen;
	};
	// Eight tasks of four bytes: a budget of eight bytes admits two at a time although maxConcurrency allows three.
	const byBytes = watch();
	const out = await runTaskGraph(tasks, byBytes.worker, { maxConcurrency: 3, maxEstimatedBytesInFlight: 8 });
	assert.deepEqual(out.results.map((r) => [r.id, r.status]), ids.map((id) => [id, 'passed']));
	assert.deepEqual([...byBytes.finished].sort(), ids);
	assert.deepEqual([byBytes.peak, out.metrics.peak_concurrency, out.metrics.peak_estimated_bytes_in_flight], [2, 2, 8]);
	// A budget that never binds leaves maxConcurrency as the bound.
	const byCount = watch();
	const counted = await runTaskGraph(tasks, byCount.worker, { maxConcurrency: 2, maxEstimatedBytesInFlight: 1000 });
	assert.deepEqual(counted.results.map((r) => [r.id, r.status]), ids.map((id) => [id, 'passed']));
	assert.deepEqual([...byCount.finished].sort(), ids);
	assert.deepEqual([byCount.peak, counted.metrics.peak_concurrency, counted.metrics.peak_estimated_bytes_in_flight], [2, 2, 8]);
	const empty = await runTaskGraph([], byCount.worker);
	assert.deepEqual(empty, { schema: vocabulary.schemas.scheduler_result, results: [], metrics: Object.fromEntries(vocabulary.output_keys.scheduler_metrics.map((k) => [k, 0])) });
});

claim('F8', 'superseded entries stay in the index until the caller removes them, and a blob stays reachable while any entry names it', () => {
	const store = createArtifactStore(fresh('f8s')); const index = createCacheIndex(fresh('f8i'));
	const k1 = buildScanCacheKey(KEY_INPUT).digest; const k2 = buildScanCacheKey({ ...KEY_INPUT, sourceDigest: HEX('9') }).digest;
	const r1 = store.put('old'); const r2 = store.put('new');
	index.set(k1, r1); index.set(k2, r2);
	assert.deepEqual(index.list().map((e) => e.cache_key), [k1, k2].sort());
	assert.deepEqual(index.reachableArtifactRefs().map((r) => r.digest).sort(), [r1.digest, r2.digest].sort());
	const pass = () => collectArtifactGarbage(store.root, { reachable: index.reachableArtifactRefs(), nowMs: FAR });
	assert.equal(pass().candidates.length, 0);
	assert.equal(index.remove(k1), true);
	assert.deepEqual(pass().candidates.map((c) => c.digest), [r1.digest]);
	assert.equal(index.remove(k1), false);
	// Two entries can name one blob, because the store keeps one blob per digest: a new key does not always add a blob.
	const sameStore = createArtifactStore(fresh('f8t')); const sameIndex = createCacheIndex(fresh('f8u'));
	const same = sameStore.put('same'); const again = sameStore.put('same');
	const ka = buildScanCacheKey({ ...KEY_INPUT, sourceDigest: HEX('7') }).digest; const kb = buildScanCacheKey({ ...KEY_INPUT, sourceDigest: HEX('8') }).digest;
	sameIndex.set(ka, same); sameIndex.set(kb, again);
	const sweep = () => collectArtifactGarbage(sameStore.root, { reachable: sameIndex.reachableArtifactRefs(), nowMs: FAR });
	assert.deepEqual([sameIndex.list().length, sameIndex.reachableArtifactRefs().length, sweep().total_blobs, sweep().candidates.length], [2, 2, 1, 0]);
	assert.equal(sameIndex.remove(ka), true);
	assert.deepEqual([sameIndex.list().length, sameIndex.reachableArtifactRefs().length, sweep().total_blobs, sweep().candidates.length], [1, 1, 1, 0]);
	assert.equal(sameIndex.remove(kb), true);
	assert.deepEqual(sweep().candidates.map((c) => c.digest), [same.digest]);
	// What the claim and the recorded limit may say about this, and the broad sentences they replaced.
	const rfc = read(lib.TRACK.docs.rfc); const readme = read(lib.TRACK.docs.store);
	assert.deepEqual(scopeProblems('F8', rfc, readme), []);
	assert.ok(scopeProblems('F8', rfc.replace('only when no entry refers to it', 'once its entry is removed'), readme).length > 0);
	assert.ok(scopeProblems('F8', `${rfc}\nA new key stores a new entry and a new blob for every distinct source state.\n`, readme).length > 0);
	assert.ok(scopeProblems('F8', rfc, `${readme}\nIts blob is the only collection candidate.\n`).length > 0);
	const limit = baseline.limits.find((l) => l.id === 'superseded-cache-entries-are-never-retired').statement;
	const limitProblems = (s) => [...SCOPE.F8.limitSays.filter((w) => !s.includes(w)).map((w) => `the limit does not say "${w}"`), ...SCOPE.F8.never.filter((w) => s.includes(w)).map((w) => `the limit still says "${w}"`)];
	assert.deepEqual(limitProblems(limit), []);
	assert.ok(limitProblems(limit.replace('for its fixed input', 'always')).length > 0);
	assert.ok(limitProblems(`${limit} Every key stores a new entry and a new blob.`).length > 0);
});

claim('H1', 'a malformed task graph is refused before any worker runs', async () => {
	const cases = [[[{ id: 'a' }, { id: 'a' }], /duplicate task id: a/], [[{ id: 'a', dependsOn: ['z'] }], /a: missing dependency z/], [[{ id: 'a', dependsOn: ['a'] }], /a: self dependency/], [[{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], /task dependency graph contains a cycle/], [[{ id: '' }], /every task requires a non-empty id/], [[{ id: 'a', dependsOn: 'b' }], /a: dependsOn must be a string array/], [[{ id: 'a', estimatedBytes: -1 }], /a: estimatedBytes must be a non-negative integer/], [[{ id: 'a', estimatedBytes: 1.5 }], /a: estimatedBytes must be a non-negative integer/], ['not an array', /tasks must be an array/]];
	let ran = 0; const worker = async () => { ran += 1; };
	for (const [tasks, message] of cases) await assert.rejects(runTaskGraph(tasks, worker), message);
	await assert.rejects(runTaskGraph([{ id: 'a' }], 5), /worker must be a function/);
	await assert.rejects(runTaskGraph([{ id: 'a' }], worker, { maxConcurrency: 0 }), /maxConcurrency must be a positive integer/);
	assert.equal(ran, 0);
});

claim('H2', 'hostile identifiers are plain data in the scheduler, the index, the invalidation and the plan', async () => {
	const names = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'];
	const out = await runTaskGraph(names.map((id) => ({ id })), async (t) => t.id);
	assert.deepEqual(out.results.map((r) => [r.id, r.status]), [...names].sort().map((id) => [id, 'passed']));
	await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: ['__proto__'] }], async () => 1), /a: missing dependency __proto__/);
	const r = fresh('h2'); for (const n of names) fs.writeFileSync(path.join(r, n), n);
	const built = buildFileIndex(r);
	assert.deepEqual(built.entries.map((e) => e.path), [...names].sort());
	const inv = computeInvalidation({ previousIndex: built, nextIndex: built, dependencyEdges: [{ dependent: 'ghost-file', dependency: 'constructor' }], globalInputsChanged: false });
	assert.deepEqual(inv.invalidated, []);
	assert.throws(() => createCacheIndex(r).get('__proto__'), { name: 'TypeError', message: 'cache key must be a lowercase sha256 digest' });
	const graph = projectGraph();
	graph.projects[0].project_id = '__proto__'; graph.projects[1].project_id = 'constructor';
	graph.project_edges = [{ kind: 'local-package-dependency', from_project_id: '__proto__', to_project_id: 'constructor' }];
	const plan = buildProjectCachePlan(graph);
	assert.deepEqual(plan.projects.find((p) => p.project_id === '__proto__').dependency_project_ids, ['constructor']);
	assert.deepEqual(propagateProjectInvalidation(graph, ['constructor']), ['__proto__', 'constructor']);
	assert.throws(() => propagateProjectInvalidation(graph, ['toString']), { message: 'unknown changed project: toString' });
	assert.equal({}.polluted, undefined);
});

// ---- negative cases: every edit below is made on a copy, and each must be named by the check that guards it ----
const edit = (fn) => { const v = structuredClone(vocabulary); fn(v); return v; };
const NUMBER = '12';
const PROBES = { 'number sign': `${String.fromCharCode(35)}${NUMBER}`, 'pull path': `${String.fromCharCode(47)}pull${String.fromCharCode(47)}${NUMBER}`, 'issues path': `${String.fromCharCode(47)}issues${String.fromCharCode(47)}${NUMBER}`, 'issue tag': `GH${String.fromCharCode(45)}${NUMBER}`, 'ref name': `refs${String.fromCharCode(47)}pull`, 'review label': `P${'R'} ${NUMBER}` };
const expectAll = (rows, problemsOf, label) => {
	for (const [name, input, pattern] of rows) {
		const found = problemsOf(input);
		assert.ok(has(found, pattern), `${label} ${name}: expected a problem matching ${pattern} but got ${JSON.stringify(found)}`);
	}
};

test('negative: the vocabulary fails when it drifts from the exports, constants, parameters, codes and statuses of the code', () => {
	assert.deepEqual(sourceProblems(vocabulary), []);
	const first = Object.keys(vocabulary.statuses)[0];
	const rows = [
		['an export is dropped', edit((v) => { v.modules.store.exports = v.modules.store.exports.filter((x) => x !== 'createArtifactStore'); }), /^modules\.store:/],
		['a constant changes', edit((v) => { v.constants.DEFAULT_EXCLUDED_DIRS.value = [...v.constants.DEFAULT_EXCLUDED_DIRS.value, 'extra']; }), /^constants\.DEFAULT_EXCLUDED_DIRS:/],
		['a status value the code does not quote', edit((v) => { v.statuses[first].values.push('retrying'); }), new RegExp(`statuses\\.${first}: retrying is not a quoted literal`)],
		['an observed status value is dropped from its set', edit((v) => { v.statuses.memory_admission_status.values = ['ready']; }), /^statuses\.memory_admission_status: "blocked" observed in memory_admission/],
		['a budget kind is dropped from its set', edit((v) => { v.statuses.index_budget_kind.values = ['file-count']; }), /^statuses\.index_budget_kind: "byte-count" observed in index_budget_error/],
		['a quoted literal that nothing observed is declared as a status', edit((v) => { v.statuses.index_budget_kind.values.push('INDEX_BUDGET_EXCEEDED'); }), /^statuses\.index_budget_kind: INDEX_BUDGET_EXCEEDED is declared but no sample of index_budget_error carries it/],
		['an error code is dropped', edit((v) => { delete v.codes.errors.ARTIFACT_CORRUPT; }), /^literals\.codes:/],
		['an output key is renamed', edit((v) => { v.output_keys.store_ref = ['algorithm', 'digest', 'bytes']; }), /^output_keys\.store_ref:/],
		['a default changes', edit((v) => { v.functions.runTaskGraph.defaults.maxConcurrency = '5'; }), /^functions\.runTaskGraph:/],
		['a policy default changes', edit((v) => { v.policy_defaults.minSamples = 6; }), /^policy_defaults:/],
		['a section is added', edit((v) => { v.extra = {}; }), /^sections:/],
		['a produced schema is declared foreign', edit((v) => { v.foreign_schemas.push(v.schemas.gc_result); }), /^foreign_schemas: .* appears in the code/],
		['a role is dropped', edit((v) => { delete v.roles.gc; }), /^roles:/],
		['a schema string changes', edit((v) => { v.schemas.gc_result = 'sbf.artifact-gc-result/2'; }), /^literals\.schemas:|^schemas\.gc_result\[/],
		['a contract tag changes', edit((v) => { v.contract_tags.legacy_shadow = 't21-legacy-scan-shadow/2'; }), /^literals\.tags:/],
		['a handle member is dropped', edit((v) => { delete v.handles.cache_index.methods.remove; }), /^handles\.cache_index:/],
	];
	expectAll(rows, (v) => sourceProblems(v), 'vocabulary vs code,');
	// Dropping any single value of any status set is named, wherever the value is observed (a group, a variant or a thrown error).
	for (const [id, s] of Object.entries(vocabulary.statuses)) for (const value of s.values) {
		const dropped = edit((v) => { v.statuses[id].values = v.statuses[id].values.filter((x) => x !== value); });
		assert.ok(has(sourceProblems(dropped), new RegExp(`^statuses\\.${id}: ${JSON.stringify(value)} observed in `)), `dropping ${value} from ${id} is not named`);
	}
});

test('negative: the vocabulary fails when the emitted objects stop matching it, and an empty sample group fails instead of passing', () => {
	const g = samples.groups;
	const withGroups = (patch) => ({ ...samples, groups: { ...g, ...patch } });
	const vr = samples.variants;
	const withVariants = (patch) => ({ ...samples, variants: { ...vr, ...patch } });
	const without = (o, key) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
	const rows = [
		['a key is missing', withGroups({ store_ref: [{ algorithm: 'sha256', digest: 'x' }] }), /^output_keys\.store_ref:/],
		['a group is empty', withGroups({ gc_result: [] }), /^output_keys\.gc_result: no emitted sample/],
		['a status is outside the set', withGroups({ task_failed: [{ ...g.task_failed[0], status: 'retrying' }] }), /^statuses\.scheduler_task_status: "retrying" observed in task_failed/],
		['a variant status is outside the set', withVariants({ memory_admission: [{ ...vr.memory_admission[0], status: 'retrying' }] }), /^statuses\.memory_admission_status: "retrying" observed in memory_admission/],
		['a declared status has no variant sample', withVariants({ memory_admission: [] }), /^statuses\.memory_admission_status: blocked is declared but no sample/],
		['the fallback plan mode is not sampled', withGroups({ project_plan_item: g.project_plan_item.filter((p) => p.mode !== 'fallback') }), /^statuses\.project_plan_mode: fallback is declared but no sample/],
		['a thrown budget kind is outside the set', { ...samples, thrown: { index_budget_error: [{ kind: 'depth-count' }] } }, /^statuses\.index_budget_kind: "depth-count" observed in index_budget_error/],
		['one declared budget kind is not thrown', { ...samples, thrown: { index_budget_error: samples.thrown.index_budget_error.slice(0, 1) } }, /^statuses\.index_budget_kind: .* is declared but no sample/],
		['no budget error is thrown at all', { ...samples, thrown: {} }, /^statuses\.index_budget_kind: file-count is declared but no sample/],
		['a schema string changes', withGroups({ gc_result: g.gc_result.map((o) => ({ ...o, schema: 'sbf.artifact-gc-result/2' })) }), /^schemas\.gc_result\[0\]:/],
		['a second object has other keys', withGroups({ store_ref: [...g.store_ref, { algorithm: 'sha256' }] }), /^output_keys\.store_ref\[/],
		['a variant sample lacks a required base key', withVariants({ cache_index_entry: [without(vr.cache_index_entry[0], 'artifact')] }), /^conditional_keys\.cache_index_entry\[0\] with its base keys:/],
		['a listing variant lacks its cache_key', withVariants({ cache_index_listing_item: [without(vr.cache_index_listing_item[0], 'cache_key')] }), /^conditional_keys\.cache_index_listing_item\[0\] with its base keys:/],
		['a variant sample holds only its conditional key', withVariants({ cache_index_entry: [{ metadata: {} }] }), /^conditional_keys\.cache_index_entry\[0\] with its base keys:/],
		['a variant sample has an extra key', withVariants({ memory_admission: [{ ...vr.memory_admission[0], extra: 1 }] }), /^conditional_keys\.memory_admission\[0\] with its base keys:/],
	];
	expectAll(rows, (s) => sourceProblems(vocabulary, s), 'vocabulary vs samples,');
});

test('negative: source text the vocabulary does not know fails, including an opaque import', () => {
	const rows = [
		['an unlisted error code', { store: "const added = 'NEW_CODE_X';" }, /^literals\.codes:/],
		['an unlisted schema string', { store: "const added = 'sbf.other-schema/1';" }, /^literals\.schemas:/],
		['an unlisted contract tag', { store: "const added = 't21-other-tag/1';" }, /^literals\.tags:/],
		['an unlisted import', { store: "import { added } from 'node:os';" }, /^modules\.store:/],
		['a dynamic import by name', { store: 'const added = await import(name);' }, /^opaque imports/],
		['a require call', { store: 'const added = require(name);' }, /^opaque imports/],
		['a foreign schema string', { store: `const added = '${vocabulary.foreign_schemas[0]}';` }, /^foreign_schemas: .* appears in the code/],
	];
	expectAll(rows, (extra) => sourceProblems(vocabulary, samples, extra), 'source text,');
});

test('negative: the vocabulary fails when it drifts from the record, the directory listings or the ownership map', () => {
	assert.deepEqual(vocabProblems(vocabulary), []);
	const firstGate = Object.keys(vocabulary.gates)[0];
	const storeDir = lib.TRACK.sourceDirs[0];
	const rows = [
		['the runner line changes', edit((v) => { v.runner_line = `NESTED_SUITE T21 RUN ${11 + 2} files`; }), /^runner_line:/],
		['the limit statuses are reordered', edit((v) => { v.limit_statuses = [...v.limit_statuses].reverse(); }), /^limit_statuses:/],
		['a gate loses a limit', edit((v) => { v.gates[firstGate].limits = v.gates[firstGate].limits.slice(1); }), /^gates and non_gate_limits cover each limit/],
		['a non-gate limit is listed twice', edit((v) => { v.gates[firstGate].limits.push(Object.keys(v.non_gate_limits)[0]); }), /^gates and non_gate_limits cover each limit/],
		['an owned file is removed', edit((v) => { v.owned_files[storeDir] = v.owned_files[storeDir].slice(1); }), new RegExp(`^owned_files\\.${storeDir}:`)],
		['an owned file is invented', edit((v) => { v.owned_files[lib.TRACK.testDir].push('invented.test.mjs'); }), new RegExp(`^owned_files\\.${lib.TRACK.testDir}:`)],
		['an owner changes', edit((v) => { v.ownership[0].owner = 'T99'; }), /^ownership:/],
		['a pinned test is removed', edit((v) => { delete v.pinned_tests['t21-scheduler.test.mjs']; }), /^pinned_tests:/],
		['the record schema changes', edit((v) => { v.record_schema = 'bskel.track-baseline-record/3'; }), /^record_schema:/],
		['a directory is dropped', edit((v) => { delete v.owned_files[storeDir]; }), /^owned_files directories:/],
	];
	expectAll(rows, (v) => vocabProblems(v), 'vocabulary vs record,');
	assert.ok(has(vocabProblems(vocabulary, { ...baseline, schema: 'bskel.track-baseline-record/3' }), /^record_schema:/));
});

test('negative: the RFC fails when a table, a word, a schema, a path, a key list or the size drifts', () => {
	const text = read(lib.TRACK.docs.rfc);
	assert.deepEqual(rfcProblems(text, vocabulary), []);
	const blocks = render(vocabulary);
	for (const name of ['gates', 'codes', 'ownership', 'record', 'outputs', 'statuses']) assert.ok(text.includes(blocks[name]), `the RFC lacks the ${name} block, so no negative can be built on it`);
	const missing = (name) => text.replace(blocks[name], '');
	const rows = [
		['a table is removed', missing('gates'), /^table gates:/],
		['a header cell is edited', text.replace(blocks.gates, blocks.gates.replace('lifted when', 'lifted if')), /^table gates:/],
		['a row is appended without a blank line', text.replace(blocks.codes, `${blocks.codes}\n| extra | row |`), /^table codes:/],
		['the record table is edited', text.replace(blocks.record, blocks.record.replace(baseline.base_commit, '0'.repeat(40))), /^table record:/],
		['an identifier is invented', `${text}\nUse the newHelperName function.\n`, /^identifier newHelperName is in the RFC but not in the vocabulary/],
		['an identifier is removed', text.split('maxDeleteBytes').join(''), /^identifier maxDeleteBytes is in the vocabulary but not in the RFC/],
		['a schema string changes', text.split('sbf.artifact-gc-result/1').join('sbf.artifact-gc-result/2'), /^schema sbf\.artifact-gc-result\/2 is in the RFC but not in the vocabulary/],
		['a schema string is removed', text.split('sbf.scan-invalidation/1').join(''), /^schema sbf\.scan-invalidation\/1 is in the vocabulary but not in the RFC/],
		['a file that does not exist is named', `${text}\nSee ghost-module.mjs for details.\n`, /^file ghost-module\.mjs is named in the RFC but does not exist/],
		['a path that does not exist is named', `${text}\nSee lib/ghost/none.txt here.\n`, /^path lib\/ghost\/none\.txt is named in the RFC but does not exist/],
		['a limit id is invented', `${text}\nThe cache-is-not-honest limit.\n`, /^cache-is-not-honest looks like a limit id/],
		['a key list is invented', `${text}\nKeys {alpha, beta} here.\n`, /^key list \{alpha, beta\} is in the RFC but in no list/],
		['a key list is removed', text.split(`{${vocabulary.output_keys.gc_result.join(', ')}}`).join('{}'), /^key list \{.*\} is in the vocabulary but not in the RFC/],
		['a status value is dropped from the table only', text.replace(blocks.statuses, blocks.statuses.replace('ready, blocked', 'ready')), /^table statuses:/],
		['the line cap is exceeded', `${text}${'\n'.repeat(LINE_CAP)}`, /more than the cap of/],
	];
	expectAll(rows, (t) => rfcProblems(t, vocabulary), 'RFC,');
	// A value removed from the vocabulary and from the RFC table together leaves the RFC consistent with the vocabulary, so only the comparison with the emitted objects can name it.
	const dropped = edit((v) => { v.statuses.memory_admission_status.values = ['ready']; });
	const consistent = text.replace(blocks.statuses, render(dropped).statuses);
	assert.notEqual(consistent, text);
	assert.deepEqual(rfcProblems(consistent, dropped), []);
	assert.ok(has(sourceProblems(dropped), /^statuses\.memory_admission_status: "blocked" observed in memory_admission/));
});

test('negative: a forbidden reference pattern fails in the RFC and in the README, whichever pattern it is', () => {
	const rfc = read(lib.TRACK.docs.rfc); const readme = read(lib.TRACK.docs.store);
	for (const [name, probe] of Object.entries(PROBES)) {
		assert.ok(FORBIDDEN.test(probe), `the probe ${name} is not a forbidden pattern`);
		assert.ok(has(rfcProblems(`${rfc}\nsee ${probe}\n`, vocabulary), /forbidden reference pattern/), `RFC ${name}`);
		assert.ok(has(readmeProblems(`${readme}\nsee ${probe}\n`), /forbidden reference pattern/), `README ${name}`);
	}
	assert.equal(FORBIDDEN.test(`${rfc}\n${readme}`), false);
});

test('negative: a stale test count, a missing base commit or a changed runner line fails the shared document check', () => {
	const rfc = read(lib.TRACK.docs.rfc); const store = read(lib.TRACK.docs.store);
	assert.deepEqual(lib.docProblems(baseline, docsOf(rfc, store)), []);
	const total = baseline.commands.find((c) => c.id === 'direct-tap').result.tests;
	assert.ok(rfc.includes(`${total} tests`), 'the RFC states the recorded total, so the stale figure below changes something');
	const first = baseline.commands.find((c) => c.id === 'nested-runner').first_line;
	assert.ok(rfc.includes(first), 'the RFC states the recorded runner line');
	const rows = [
		['a stale total', docsOf(rfc.split(`${total} tests`).join(`${total - 1} tests`), store), new RegExp(`${total - 1}`)],
		['no base commit in the RFC', docsOf(rfc.split(baseline.base_commit).join('0'.repeat(40)), store), /./],
		['no base commit in the README', docsOf(rfc, store.split(baseline.base_commit).join('0'.repeat(40))), /./],
		['a changed runner line', docsOf(rfc.split(first).join(first.replace(/RUN \d+/, `RUN ${11 + 2}`)), store), /./],
		['a changed per-file count', docsOf(rfc.replace(/(\| `t21-scheduler\.test\.mjs` \| )\d+/, '$1999'), store), /./],
	];
	expectAll(rows, (docs) => lib.docProblems(baseline, docs), 'documents,');
});

test('negative: the README fails when it loses the link, the commit, its size or its words', () => {
	const readme = read(lib.TRACK.docs.store);
	assert.deepEqual(readmeProblems(readme), []);
	const rows = [
		['the link is cut', readme.replace('](../scan-scheduler-next/INTERFACE_RFC.md)', ']()'), /^README: no link/],
		['the commit is cut', readme.split(baseline.base_commit).join(''), /^README: does not mention/],
		['the record name is cut', readme.split('BASELINE.json').join('RECORD'), /^README: does not mention BASELINE\.json/],
		['a module name is cut', readme.split('gc.mjs').join('collector'), /^README: does not mention gc\.mjs/],
		['it grows into a document', `${readme}${'\n'.repeat(31)}`, /^README: more than 30 lines/],
	];
	expectAll(rows, (t) => readmeProblems(t), 'README,');
});

test('negative: the claims fail when the RFC and the registered tests disagree', () => {
	const text = read(lib.TRACK.docs.rfc);
	assert.deepEqual(claimProblems(text), []);
	assert.ok(CLAIMS.size >= 20, `only ${CLAIMS.size} claims are registered`);
	const rows = [
		['a claim is removed from the RFC', text.replace('- **I1** ', '- '), /^claim I1 has a test but is not in the RFC/],
		['a claim is added to the RFC', `${text}\n- **I9** an extra statement\n`, /^claim I9 is in the RFC but no test registers it/],
		['a claim id repeats', `${text}\n- **I1** said again\n`, /^claim I1 appears twice in the RFC/],
	];
	expectAll(rows, (t) => claimProblems(t), 'claims,');
	assert.ok(has(headingProblems(text.replace('## 4. Identity', '## 4. Identities')), /^headings:/));
	assert.ok(has(headingProblems(text.split(baseline.base_commit).join('')), /the header does not contain/));
});

test('every claim of the RFC has a registered test and every registered test has a claim', () => {
	assert.deepEqual(claimProblems(read(lib.TRACK.docs.rfc)), []);
});
