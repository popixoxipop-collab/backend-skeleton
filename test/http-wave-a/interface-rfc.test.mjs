import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { ADAPTERS } from '../../scanners/registry.mjs';
import * as L from './baseline-record-lib.mjs';

// T12-02: INTERFACE_RFC.md, its vocabulary, leaf-contract.schema.json and the code are compared with each other. The edit matrices at the end show which edits each comparison reports and list the edits that nothing reports.
// Compared with the vocabulary: the five tables, the bullet lines of sections 3 and 4 and the last line of section 7. A backticked word on any other line only has to be a word of the vocabulary.
// Not compared: headings and the other prose (limit interface-rfc-prose-is-not-compared in BASELINE.json). Each matrix lists its survivors; the last test binds that limit to the lists.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'adapters/http-wave-a';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rfcText = read(`${DIR}/INTERFACE_RFC.md`);
const vocab = JSON.parse(read('test/http-wave-a/interface-rfc.vocabulary.json'));
const schemaDoc = JSON.parse(read(`${DIR}/leaf-contract.schema.json`));
const record = L.readRecord();
const clone = (x) => structuredClone(x);
const MAX_LINES = 120;
const D = '[0-9]';
const REF_PATTERNS = [`#${D}`, `/pull/${D}`, `/issues/${D}`, `GH-${D}`, `PR ${D}`, ['refs', 'pull'].join('/')].map((p) => new RegExp(p));
const GAP_FIXTURES = ['projection-keeps-unvalidated-routes-hand-fed'];
const UNUSABLE_INPUTS = [undefined, null, 42, 'x', {}, []];

// Rendering of the machine compared parts of INTERFACE_RFC.md from the vocabulary.
// Single source for build-rfc.mjs and for the copy that is inlined into interface-rfc.test.mjs.
const q = (s) => `\`${s}\``;
const qs = (xs) => xs.map(q).join(', ');
const keys = (xs) => `\`{${xs.join(', ')}}\``;
const contractCell = (c) => (/\s/.test(c) ? c.replace(/\b(build\w*Shadow)\b/, '`$1`') : q(c));
const roleOf = (v, name) => (name === '_shared' ? 'shared' : v.leaves.some((l) => l.module === name) ? 'leaf' : 'tooling');
const gaps = (v, kind) => v.schema_gaps.filter((g) => g.kind === kind).map((g) => `${q(g.id)}: ${g.text}`).join('; ');

const TABLES = {
	scope: {
		head: ['module', 'role', 'exports', 'profile id', 'state', 'owner', 'upstream contracts'],
		rows: (v) => Object.entries(v.modules).map(([name, exports]) => {
			const leaf = v.leaves.find((l) => l.module === name);
			return [q(`${name}.mjs`), roleOf(v, name), qs(exports), leaf ? q(leaf.id) : '-', leaf ? q(leaf.state) : '-', leaf ? leaf.owner : '-', leaf ? leaf.upstream_contracts.map(contractCell).join(', ') : '-'];
		})
	},
	functions: {
		head: ['function', 'module', 'input', 'unusable input'],
		rows: (v) => [...v.leaves.map((l) => [q(l.function), q(`${l.module}.mjs`), l.input, l.unusable]), ...v.shared_functions.map((f) => [q(f.function), q('_shared.mjs'), f.input, f.unusable])]
	},
	codes: {
		head: ['code', 'group', 'leaf', 'reason', 'witness fixture'],
		rows: (v) => [...v.codes.map((c) => [q(c.code), c.group, c.leaf, c.reason === null ? 'varies' : c.reason, c.fixture]), ...v.prefixes.map((p) => [q(p.prefix), 'prefix', Object.keys(p.leaves).join(', '), 'varies', Object.values(p.leaves).join(', ')])]
	},
	gates: {
		head: ['gate', 'blocker', 'closes when', 'state', 'limits'],
		rows: (v) => v.gates.map((g) => [q(g.gate), q(g.blocker), g.closes_when, g.state, g.limits.length ? g.limits.join(', ') : '-'])
	},
	ownership: {
		head: ['paths', 'owner', 'T12 may', 'checker'],
		rows: (v) => v.ownership.map((o) => [qs(o.paths), o.owner, o.t12, o.expect.code === 'OK' ? 'OK' : q(o.expect.code)])
	}
};

const BULLETS = {
	rules: (v) => `- Leaf output ${keys(v.leaf_keys)}: ${v.key_rules.map((r) => `${q(r.key)} ${r.rule}`).join('; ')}.`,
	route: (v) => `- Route ${keys(v.route_keys)} where ${q('method')} is one of ${qs(v.methods)}; unknown made by ${q('routeOrUnknown')} ${keys(v.unknown_keys)}; profile ${keys(v.profile_keys)}.`,
	forced: (v) => `- ${q('defineProfile')} forces ${q('registration')} to ${q(v.forced.registration)}, ${q('productionDefault')} to ${q(String(v.forced.productionDefault))} and ${q('runtimeTested')} to ${q(String(v.forced.runtimeTested))}; ${q('t19Review')} is ${q(v.forced.t19Review)} unless the caller passes one; ${q('realRepoComparison')} is a plain string that may start with ${v.reserved_words.filter((w) => w !== v.forced.t19Review).map(q).join(' or ')}.`,
	stricter: (v) => `- Known differences, stricter than the code: ${gaps(v, 'stricter')}.`,
	looser: (v) => `- Known differences, looser than the code: ${gaps(v, 'looser')}; neither list is proved complete.`,
	ids: (v) => `- Leaf: ${q('profileId')} is the ${q('id')} of its profile: ${qs(v.leaves.map((l) => l.id))}.`,
	routeIdentity: (v) => `- Route: no identity is created; a route is addressed by ${q('path')}, ${q('method')} and ${q('handler')}, also its sort order, and equal routes are kept. ${q('projection')} throws TypeError for a route that owns ${qs(v.forbidden_route_keys)}, and ${q('makeRoute')} never sets it.`,
	contract: (v) => `- Contract: ${q(v.schemas.leaf)} is internal and unfrozen (suffix 0). Inputs carry ${qs([v.schemas.native_language, v.schemas.dsl_route_candidates, v.schemas.js_ts_source_facts, v.schemas.js_ts_structure])}; the T06 shadows are named by ${qs(v.upstream_functions)}.`,
	foreign: (v) => `- Foreign: the layer emits none of ${qs(v.foreign_schemas)}, no key ${qs(v.foreign_keys)} and no key named ${qs(v.forbidden_keys)}; T01 owns identity and T03 the capability vocabulary.`,
	files: (v) => `${q('adapters/http-wave-a')} holds exactly ${qs(v.owned_files)}; a new file there needs this RFC and the vocabulary updated first.`
};

const row = (cells) => `| ${cells.join(' | ')} |`;
const tableLines = (name, v) => [row(TABLES[name].head), row(TABLES[name].head.map(() => '---')), ...TABLES[name].rows(v).map(row)];
const linesOf = (text) => text.replace(/\n$/, '').split('\n');
const isObj = (x) => x !== null && typeof x === 'object';
const strings = (x, out = []) => {
	if (typeof x === 'string') out.push(x);
	else if (Array.isArray(x)) x.forEach((y) => strings(y, out));
	else if (isObj(x)) Object.values(x).forEach((y) => strings(y, out));
	return out;
};
const deepKeys = (x, acc = new Set()) => {
	if (Array.isArray(x)) x.forEach((y) => deepKeys(y, acc));
	else if (isObj(x)) for (const [k, y] of Object.entries(x)) { acc.add(k); deepKeys(y, acc); }
	return acc;
};
const codesIn = (x, acc = []) => {
	if (Array.isArray(x)) x.forEach((y) => codesIn(y, acc));
	else if (isObj(x)) { if (typeof x.code === 'string') acc.push(x.code); Object.values(x).forEach((y) => codesIn(y, acc)); }
	return acc;
};
const reasonsFor = (x, code, acc = []) => {
	if (Array.isArray(x)) x.forEach((y) => reasonsFor(y, code, acc));
	else if (isObj(x)) { if (x.code === code && typeof x.reason === 'string') acc.push(x.reason); Object.values(x).forEach((y) => reasonsFor(y, code, acc)); }
	return acc;
};
const routeObjects = (x, acc = []) => {
	if (Array.isArray(x)) x.forEach((y) => routeObjects(y, acc));
	else if (isObj(x)) {
		if (Array.isArray(x.routes)) acc.push(...x.routes.filter(isObj));
		if (isObj(x.route)) acc.push(x.route);
		Object.values(x).forEach((y) => routeObjects(y, acc));
	}
	return acc;
};
const sorted = (xs) => [...xs].sort();

const LITERAL_WORDS = ['undefined', 'null', 'true', 'false', 'limits', '--track'];
function knownWords(v) {
	const known = new Set(LITERAL_WORDS);
	for (const s of strings(v)) {
		if (!/\s/.test(s)) known.add(s);
		for (const m of s.matchAll(/`([^`]+)`/g)) for (const w of m[1].split(/[\s,{}]+/).filter(Boolean)) known.add(w);
	}
	return known;
}
const keyLists = (v) => [v.leaf_keys, v.route_keys, v.unknown_keys, v.profile_keys, ...Object.values(v.input_keys)].map((k) => k.join(', '));
function spanProblem(span, known, lists) {
	if (span.startsWith('{') && span.endsWith('}')) {
		const inner = span.slice(1, -1);
		return !inner || lists.includes(inner) ? null : `${span} is no key list of the vocabulary`;
	}
	const unknown = span.split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !known.has(w));
	return unknown.length ? `${unknown.join(' ')} is not a word of the vocabulary` : null;
}
const mustAppear = (v) => [
	...Object.keys(v.modules), ...Object.values(v.modules).flat(),
	...v.leaves.flatMap((l) => [l.id, l.profile, l.function]),
	...v.codes.map((c) => c.code), ...v.prefixes.map((p) => p.prefix),
	...v.gates.flatMap((g) => [g.gate, g.blocker, ...g.limits]),
	...v.leaf_keys, ...v.route_keys, ...v.unknown_keys, ...v.profile_keys,
	...Object.values(v.schemas), ...v.foreign_schemas, ...v.foreign_keys, ...v.forbidden_keys, ...v.forbidden_route_keys,
	...v.methods, ...v.statuses, ...v.profile_states, ...v.reserved_words, ...Object.values(v.forced).map(String),
	...v.schema_gaps.map((g) => g.id), ...v.owned_files, ...v.upstream_functions, v.prose_limit
];

// Text against vocabulary. Returns the problems found; an empty list means the text agrees.
function rfcProblems(text, v) {
	const out = [];
	const lines = linesOf(text);
	if (lines.length > MAX_LINES) out.push(`line count: ${lines.length} lines, at most ${MAX_LINES} allowed`);
	const compared = new Set();
	let wantTableLines = 0;
	for (const name of Object.keys(TABLES)) {
		const want = tableLines(name, v);
		wantTableLines += want.length;
		want.forEach((l) => compared.add(l));
		const at = lines.indexOf(want[0]);
		if (at < 0) { out.push(`table ${name}: header line not found`); continue; }
		const have = [];
		for (let i = at; i < lines.length && lines[i].startsWith('|'); i++) have.push(lines[i]);
		if (have.length !== want.length) out.push(`table ${name}: ${have.length} lines, ${want.length} expected`);
		want.forEach((l, i) => { if (have[i] !== l) out.push(`table ${name}: line ${i + 1} differs from the vocabulary`); });
	}
	const haveTableLines = lines.filter((l) => l.startsWith('|')).length;
	if (haveTableLines !== wantTableLines) out.push(`table lines: ${haveTableLines} in the text, ${wantTableLines} expected`);
	const bullets = Object.entries(BULLETS).map(([name, f]) => [name, f(v)]);
	for (const [name, line] of bullets) {
		compared.add(line);
		const n = lines.filter((l) => l === line).length;
		if (n !== 1) out.push(`bullet ${name}: ${n} identical lines, 1 expected`);
	}
	const wantBullets = bullets.map(([, l]) => l).filter((l) => l.startsWith('- '));
	const haveBullets = lines.filter((l) => l.startsWith('- '));
	if (!isDeepStrictEqual(haveBullets, wantBullets)) out.push(`bullet lines: ${haveBullets.length} in the text, ${wantBullets.length} expected, or in another order`);
	if (lines.at(-1) !== BULLETS.files(v)) out.push('last line is not the files line');
	const known = knownWords(v);
	const lists = keyLists(v);
	for (const line of lines.filter((l) => !compared.has(l))) {
		if (line.split('`').length % 2 === 0) out.push(`unbalanced backtick in: ${line.slice(0, 50)}`);
		for (const m of line.matchAll(/`([^`]+)`/g)) { const p = spanProblem(m[1], known, lists); if (p) out.push(`backticked ${p}`); }
	}
	for (const w of mustAppear(v)) if (!text.includes(w)) out.push(`vocabulary word ${w} is not in the text`);
	for (const re of REF_PATTERNS) if (re.test(text)) out.push(`reference text ${re.source}`);
	return out;
}

// Facts read from the code, the replayed fixtures, the baseline record and the T00 ownership checker; computed once.
const walkMjs = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
	.sort((a, b) => (a.name < b.name ? -1 : 1))
	.flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walkMjs(dir, path.posix.join(rel, e.name))) : e.name.endsWith('.mjs') ? [path.posix.join(rel, e.name)] : []));
const noComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

// Fields computed from f.outputs; mutation tests call derive on a shallow copy with edited outputs.
function derive(f) {
	f.witnesses = Object.fromEntries(Object.entries(f.outputs).map(([id, o]) => {
		const codes = sorted(new Set(codesIn(o)));
		return [id, { module: f.fixtureModules[id], codes, reasons: Object.fromEntries(codes.map((c) => [c, reasonsFor(o, c)])) }];
	}));
	const clean = Object.entries(f.outputs).filter(([id]) => !GAP_FIXTURES.includes(id)).map(([, o]) => o);
	f.allKeys = sorted(deepKeys(clean));
	f.routeKeySets = sorted(new Set(routeObjects(clean).map((r) => Object.keys(r).join(','))));
	f.outputsText = JSON.stringify(clean);
	return f;
}

async function collectFacts() {
	const dir = path.join(ROOT, DIR);
	const names = walkMjs(dir).map((n) => n.slice(0, -4));
	const sources = Object.fromEntries(names.map((n) => [n, noComments(fs.readFileSync(path.join(dir, `${n}.mjs`), 'utf8'))]));
	const mods = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await import(pathToFileURL(path.join(dir, `${n}.mjs`)).href)])));
	const f = { exports: {}, functions: {}, profiles: {}, usesRouteOrUnknown: {}, literals: {}, prefixes: {}, leafCodes: {} };
	f.sourceText = Object.values(sources).join('\n');
	f.params = {};
	for (const n of names) for (const m of sources[n].matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) f.params[m[1]] = m[2];
	f.mods = mods;
	f.ns = mods._shared;
	f.topLevel = fs.readdirSync(dir).sort();
	f.contract = mods._shared.HTTP_WAVE_A_LEAF_CONTRACT;
	const schemaIds = new Set();
	for (const n of names) {
		const mod = mods[n];
		f.exports[n] = sorted(Object.keys(mod));
		f.functions[n] = f.exports[n].filter((k) => typeof mod[k] === 'function');
		const prof = f.exports[n].filter((k) => k.endsWith('_PROFILE'));
		if (prof.length === 1) {
			const p = mod[prof[0]];
			f.profiles[n] = { export: prof[0], id: p.id, state: p.state, upstreamOwner: p.upstreamOwner, upstreamContracts: p.upstreamContracts, registration: p.registration, productionDefault: p.productionDefault, runtimeTested: p.runtimeTested, t19Review: p.t19Review, realRepoComparison: p.realRepoComparison, keys: Object.keys(p), frozen: Object.isFrozen(p) };
		}
		f.usesRouteOrUnknown[n] = n !== '_shared' && /\brouteOrUnknown\s*\(/.test(sources[n]);
		if (n.includes('/')) continue;
		const codes = new Set();
		const prefixes = new Set();
		for (const m of sources[n].matchAll(/(['"`])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\1/g)) codes.add(m[2]);
		for (const m of sources[n].matchAll(/(['"`])([A-Z][A-Z0-9]*_)\1/g)) prefixes.add(m[2]);
		for (const c of codes) (f.literals[c] ||= []).push(n);
		for (const p of prefixes) (f.prefixes[p] ||= []).push(n);
		f.leafCodes[n] = sorted([...codes, ...prefixes]);
		for (const m of sources[n].matchAll(/(['"`])((?:bskel|sbf)\.[a-z0-9.-]+\/\d+)\1/g)) schemaIds.add(m[2]);
	}
	f.schemaLiterals = sorted(schemaIds);
	f.importsBridge = names.some((n) => /(?:from|import\()\s*['"][^'"]*(?:contracts\/next|capability-next)/.test(sources[n]));
	const ctx = L.fixtureContext(ROOT);
	f.outputs = {};
	f.fixtureModules = {};
	for (const x of record.fixtures.filter((y) => !y.call.module.includes('python-scope'))) {
		f.outputs[x.id] = await L.runFixture(x, ctx);
		f.fixtureModules[x.id] = x.call.module;
	}
	derive(f);
	const probes = [...new Set(vocab.ownership.flatMap((o) => o.probes))];
	const run = spawnSync(process.execPath, ['next/t00/check-ownership.mjs', 'paths', '--track', 'T12', ...probes], { cwd: ROOT, encoding: 'utf8' });
	f.ownershipStatus = run.status;
	f.ownership = Object.fromEntries(probes.map((p) => [p, { code: 'OK', owner: 'T12' }]));
	for (const m of (run.stdout ?? '').matchAll(/^FAIL (\S+) (\S+) (.*)$/gm)) f.ownership[m[2]] = { code: m[1], owner: m[3].match(/owned by (\w+)/)?.[1] ?? null };
	f.limitIds = record.limits.map((l) => l.id);
	const consumer = record.limits.find((l) => l.id === 'leaf-contract-has-no-consumer-outside-the-layer');
	const P = Object.values(f.profiles);
	const state = (open) => (open ? 'open' : 'closed');
	f.gateStates = {
		leaves_registered: state(!P.some((p) => ADAPTERS.some((a) => a.id === p.id))),
		runtime_tested: state(P.every((p) => p.runtimeTested === false)),
		review_accepted: state(P.every((p) => p.t19Review === 'NOT_REVIEWED')),
		blocked_leaves_unblocked: state(P.some((p) => p.state === 'blocked-upstream-fact-gap')),
		real_repo_evidence_structured: state(P.some((p) => typeof p.realRepoComparison === 'string')),
		bridges_built: state(!f.importsBridge),
		schema_frozen: state(/\/0$/.test(f.contract)),
		consumer_exists: state(Array.isArray(consumer?.references?.paths) && consumer.references.paths.length === 0)
	};
	return f;
}

// Vocabulary against facts. An empty list means the vocabulary describes the code.
function codeProblems(v, f) {
	const out = [];
	const eq = (label, want, have) => { if (!isDeepStrictEqual(want, have)) out.push(`${label}: vocabulary ${JSON.stringify(want)}, code ${JSON.stringify(have)}`); };
	const reserved = new Set(v.reserved_words);
	for (const [fn, keys] of Object.entries(v.input_keys)) for (const k of keys) if (!new RegExp('\\b' + k + '\\b').test(f.params[fn] ?? '')) out.push('input key ' + k + ' is not a parameter name of ' + fn);
	for (const fn of v.upstream_functions) if (!new RegExp('\\b' + fn + '\\b').test(f.sourceText)) out.push('upstream function ' + fn + ' is not used by the layer');
	for (const s of v.shared_functions) if (!(f.functions._shared ?? []).includes(s.function)) out.push('shared function ' + s.function + ' is not exported by _shared');
	if (!isDeepStrictEqual(v.shared_functions.map((s) => s.function), ['routeOrUnknown', 'makeRoute', 'defineProfile', 'projection', 'blockedProjection'])) out.push('the shared functions with a documented behaviour are not the five that the behaviour check calls');
	const codeSet = new Set(v.codes.map((c) => c.code));
	eq('modules and exports', v.modules, f.exports);
	eq('top-level entries', v.owned_files, f.topLevel);
	eq('key rules name the leaf keys', v.leaf_keys, v.key_rules.map((r) => r.key));
	eq('modules with a profile', sorted(v.leaves.map((l) => l.module)), sorted(Object.keys(f.profiles)));
	for (const l of v.leaves) {
		const p = f.profiles[l.module];
		if (!p) { out.push(`leaf ${l.module}: no profile in the code`); continue; }
		eq(`leaf ${l.module} profile`, { export: l.profile, id: l.id, state: l.state, owner: l.owner, contracts: l.upstream_contracts }, { export: p.export, id: p.id, state: p.state, owner: p.upstreamOwner, contracts: p.upstreamContracts });
		eq(`leaf ${l.module} has its function`, true, (f.functions[l.module] ?? []).includes(l.function));
		eq(`leaf ${l.module} uses routeOrUnknown`, l.route_or_unknown, f.usesRouteOrUnknown[l.module]);
		eq(`leaf ${l.module} codes`, sorted(l.codes), (f.leafCodes[l.module] ?? []).filter((c) => !reserved.has(c)));
	}
	for (const [m, p] of Object.entries(f.profiles)) {
		eq(`profile ${m} forced values`, v.forced, { registration: p.registration, productionDefault: p.productionDefault, runtimeTested: p.runtimeTested, t19Review: p.t19Review });
		eq(`profile ${m} keys`, v.profile_keys, p.keys);
		if (!p.frozen || typeof p.realRepoComparison !== 'string') out.push(`profile ${m}: not frozen or realRepoComparison is not a string`);
	}
	const used = new Set(Object.values(f.profiles).map((p) => String(p.realRepoComparison).match(/^[A-Z][A-Z_]+/)?.[0]).filter(Boolean));
	eq('reserved words that realRepoComparison starts with', sorted(v.reserved_words.filter((w) => w !== v.forced.t19Review)), sorted(used));
	for (const [c, where] of Object.entries(f.literals)) if (!codeSet.has(c) && !reserved.has(c)) out.push(`literal ${c} in ${where.join(', ')} is not in the vocabulary`);
	for (const c of v.codes) {
		if (!(f.literals[c.code] ?? []).includes(c.leaf)) out.push(`code ${c.code}: no literal in ${c.leaf}`);
		const w = f.witnesses[c.fixture];
		if (!w) { out.push(`code ${c.code}: witness fixture ${c.fixture} was not replayed`); continue; }
		if (!w.codes.includes(c.code)) out.push(`code ${c.code}: not in the output of ${c.fixture}`);
		else if (c.reason !== null && !(w.reasons[c.code] ?? []).includes(c.reason)) out.push(`code ${c.code}: reason differs in the output of ${c.fixture}`);
		if (path.posix.basename(w.module ?? '', '.mjs') !== c.leaf) out.push(`code ${c.code}: ${c.fixture} is a fixture of ${w.module}, not of ${c.leaf}`);
		const o = f.outputs[c.fixture];
		if (c.group === 'blocked' && !(o?.status === 'blocked' && o.unknowns?.[0]?.code === c.code)) out.push(`code ${c.code}: not the first unknown of a blocked output in ${c.fixture}`);
	}
	eq('prefixes in the code', sorted(v.prefixes.map((p) => p.prefix)), sorted(Object.keys(f.prefixes)));
	for (const p of v.prefixes) {
		eq(`prefix ${p.prefix} modules`, sorted(Object.keys(p.leaves)), sorted(f.prefixes[p.prefix] ?? []));
		for (const [leaf, fixture] of Object.entries(p.leaves)) {
			const w = f.witnesses[fixture];
			if (!w || !w.codes.some((c) => c.startsWith(p.prefix) && !codeSet.has(c))) out.push(`prefix ${p.prefix}: no prefixed code in the output of ${fixture}`);
			else if (path.posix.basename(w.module ?? '', '.mjs') !== leaf) out.push(`prefix ${p.prefix}: ${fixture} is not a fixture of ${leaf}`);
		}
	}
	eq('schema ids in the code', sorted(Object.values(v.schemas)), f.schemaLiterals);
	eq('leaf contract', [v.contract, v.schemas.leaf], [f.contract, f.contract]);
	for (const s of v.foreign_schemas) if (f.outputsText.includes(s) || f.schemaLiterals.includes(s)) out.push(`foreign schema ${s} is emitted or named by the layer`);
	for (const k of [...v.foreign_keys, ...v.forbidden_keys]) if (f.allKeys.includes(k)) out.push(`key ${k} appears in a replayed output`);
	for (const k of v.forbidden_route_keys) if (f.routeKeySets.some((s) => s.split(',').includes(k))) out.push(`route key ${k} appears in a replayed route`);
	eq('gate states', Object.fromEntries(v.gates.map((g) => [g.gate, g.state])), f.gateStates);
	for (const g of v.gates) for (const id of g.limits) if (!f.limitIds.includes(id)) out.push(`gate ${g.gate}: limit ${id} is not a limit of BASELINE.json`);
	if (!f.limitIds.includes(v.prose_limit)) out.push(`prose limit ${v.prose_limit} is not a limit of BASELINE.json`);
	for (const o of v.ownership) {
		for (const probe of o.probes) {
			if (!o.paths.some((x) => probe === x || probe.startsWith(`${x}/`))) out.push(`ownership: ${probe} is not under the paths of its row`);
			eq(`ownership of ${probe}`, o.expect, f.ownership[probe]);
		}
	}
	return out;
}

// Behaviour of the live modules. ns is the _shared namespace (or a doctored copy of it), mods the leaf namespaces by module name.
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const route = (o = {}) => ({ method: 'GET', path: '/a', handler: 'h', source: null, provenance: 'p', ...o });
const canon = (x) => (Array.isArray(x) ? x.map(canon) : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const stable = (x) => JSON.stringify(canon(x));
const cmpText = (a, b) => { const [x, y] = [String(a), String(b)]; return x < y ? -1 : x > y ? 1 : 0; };
const routeOrder = (a, b) => cmpText(a.path, b.path) || cmpText(a.method, b.method) || cmpText(a.handler ?? '', b.handler ?? '');
const isSorted = (xs, cmp) => xs.every((x, i) => i === 0 || cmp(xs[i - 1], x) <= 0);
const UNUSABLE_KINDS = { TypeError: 'TypeError', 'blocked output': 'blocked output', 'ignored, always blocked': 'blocked output' };
const profileOf = (mods, v, state) => { const l = v.leaves.find((x) => x.state === state); return l ? mods[l.module]?.[l.profile] : undefined; };

function behaviourProblems(ns, mods, v) {
	const out = [];
	const bad = (m) => out.push(m);
	const cand = profileOf(mods, v, 'candidate');
	const blk = profileOf(mods, v, 'blocked-upstream-fact-gap');
	if (!cand || !blk) return ['no candidate or no blocked leaf profile'];
	const ok = ns.routeOrUnknown(route({ method: 'get' }), { extra: 1 });
	if (!ok.route || ok.unknown || ok.route.method !== 'GET' || !isDeepStrictEqual(Object.keys(ok.route), v.route_keys)) bad('routeOrUnknown: a valid route is not {route} with the route keys and an upper-cased method');
	for (const w of v.route_witnesses) {
		const r = ns.routeOrUnknown(route({ method: w.method, path: w.path }), { extra: 1 });
		const want = v.codes.find((c) => c.code === w.code);
		const u = r.unknown;
		if (!u || r.route || !want || u.code !== w.code || u.reason !== want.reason || u.extra !== 1) bad(`routeOrUnknown ${w.method} ${w.path}: not the unknown ${w.code} with its reason and the context`);
		else if (!isDeepStrictEqual(Object.keys(u).filter((k) => k !== 'extra'), v.unknown_keys)) bad(`routeOrUnknown ${w.method} ${w.path}: unknown keys differ from the vocabulary`);
	}
	const faults = [['handler 5', { handler: 5 }], ['empty handler', { handler: '' }], ['no provenance', { provenance: undefined }]];
	for (const [label, over] of faults) if (!(thrown(() => ns.routeOrUnknown(route(over))) instanceof TypeError)) bad(`routeOrUnknown: ${label} does not throw TypeError`);
	const made = ns.makeRoute(route({ method: 'post' }));
	if (made.method !== 'POST' || !isDeepStrictEqual(Object.keys(made), v.route_keys)) bad('makeRoute: the result is not the route keys with an upper-cased method');
	for (const m of v.methods) if (thrown(() => ns.makeRoute(route({ method: m }))) !== null) bad(`makeRoute: ${m} is refused`);
	for (const [label, over] of [['method TRACE', { method: 'TRACE' }], ['method ANY', { method: 'ANY' }], ['relative path', { path: 'a' }], ...faults, ['provenance 7', { provenance: 7 }]]) if (!(thrown(() => ns.makeRoute(route(over))) instanceof TypeError)) bad(`makeRoute: ${label} does not throw TypeError`);
	if (thrown(() => ns.makeRoute(route({ source: 5 }))) !== null) bad('makeRoute: source is checked');
	const base = { id: 'x', title: 't', state: 'candidate' };
	for (const [label, p] of [['undefined', undefined], ['null', null], ['a number', 42], ['no id', { state: 'candidate' }], ['empty id', { id: '', state: 'candidate' }], ['a state outside the two', { id: 'x', state: 'ready' }]]) if (!(thrown(() => ns.defineProfile(p)) instanceof TypeError)) bad(`defineProfile: ${label} does not throw TypeError`);
	for (const s of v.profile_states) if (thrown(() => ns.defineProfile({ ...base, state: s })) !== null) bad(`defineProfile: state ${s} is refused`);
	const claimed = ns.defineProfile({ ...base, registration: 'registered', productionDefault: true, runtimeTested: true });
	if (!isDeepStrictEqual({ registration: claimed.registration, productionDefault: claimed.productionDefault, runtimeTested: claimed.runtimeTested, t19Review: claimed.t19Review }, v.forced)) bad('defineProfile: claimed values are not forced');
	if (ns.defineProfile({ ...base, t19Review: 'ACCEPTED' }).t19Review !== 'ACCEPTED') bad('defineProfile: a review state passed by the caller is not kept');
	if (!Object.isFrozen(claimed)) bad('defineProfile: the result is not frozen');
	const input = () => ({ sourceContracts: ['c1'], routes: [route({ path: '/b' }), route({ path: '/a', method: 'POST' }), route({ path: '/a' }), route({ path: '/a' })], unknowns: [{ code: 'Z' }, { code: 'A' }], observations: [{ k: 2 }, { k: 1 }], evidence: { e: 1 } });
	const given = input();
	const o = ns.projection(cand, given);
	if (!isDeepStrictEqual(Object.keys(o), v.leaf_keys)) bad('projection: the output keys differ from the leaf keys');
	if (o.contract !== v.contract || o.profileId !== cand.id || o.registration !== v.forced.registration || o.productionDefault !== v.forced.productionDefault || o.status !== 'candidate') bad('projection: the fixed values differ');
	if (!isDeepStrictEqual(o.routes.map((r) => `${r.method} ${r.path}`), ['GET /a', 'GET /a', 'POST /a', 'GET /b'])) bad('projection: routes are not sorted by path, method, handler with equal routes kept');
	if (!isDeepStrictEqual(o.unknowns, [{ code: 'A' }, { code: 'Z' }]) || !isDeepStrictEqual(o.observations, [{ k: 1 }, { k: 2 }])) bad('projection: unknowns or observations are not sorted');
	if (o.evidence !== given.evidence) bad('projection: evidence is not passed by reference');
	if (o.sourceContracts === given.sourceContracts || !isDeepStrictEqual(o.sourceContracts, ['c1'])) bad('projection: sourceContracts is not a copy');
	const blocked = ns.projection(blk, input());
	if (blocked.status !== 'blocked' || blocked.routes.length !== 4) bad('projection: a blocked profile does not give status blocked, or routes are checked');
	for (const k of v.forbidden_route_keys) {
		if (!(thrown(() => ns.projection(cand, { routes: [route({ [k]: 'o' })] })) instanceof TypeError)) bad('projection: a route with ' + k + ' does not throw TypeError');
		if (thrown(() => ns.projection(cand, { observations: [{ [k]: 'o' }] })) !== null) bad('projection: ' + k + ' in an observation is refused');
	}
	const bp = ns.blockedProjection(blk, 'C1', 'R1', { e: 2 });
	if (bp.status !== 'blocked' || bp.routes.length !== 0 || !isDeepStrictEqual(bp.unknowns, [{ code: 'C1', reason: 'R1' }]) || !isDeepStrictEqual(bp.evidence, { e: 2 })) bad('blockedProjection: not a blocked output with one unknown');
	const blockedCodes = new Set(v.codes.filter((c) => c.group === 'blocked').map((c) => c.code));
	for (const l of v.leaves) {
		const fn = mods[l.module]?.[l.function];
		if (typeof fn !== 'function') { bad(`leaf ${l.module}: no function ${l.function}`); continue; }
		const kinds = new Set(UNUSABLE_INPUTS.map((x) => {
			try {
				const r = fn(x);
				return r?.status === 'blocked' && r.routes?.length === 0 && blockedCodes.has(r.unknowns?.[0]?.code) ? 'blocked output' : 'other output';
			} catch (e) { return e instanceof TypeError ? 'TypeError' : 'other error'; }
		}));
		const want = UNUSABLE_KINDS[l.unusable];
		if (!want) bad('leaf ' + l.module + ': unusable text ' + l.unusable + ' is none of ' + Object.keys(UNUSABLE_KINDS).join(', '));
		else if (l.unusable === 'ignored, always blocked' && new Set(UNUSABLE_INPUTS.map((x) => { try { return stable(fn(x)); } catch (e) { return e.name; } })).size !== 1) bad('leaf ' + l.module + ': the output depends on the unusable input');
		if (want && (kinds.size !== 1 || !kinds.has(want))) bad(`leaf ${l.module}: unusable input gives ${[...kinds].join(' and ')}, the vocabulary says ${l.unusable}`);
	}
	return out;
}

// Invariants of the RFC for outputs; entries are {id, output, leaf}. Used for real outputs and for the looser schema proofs.
function outputProblems(entries, v) {
	const out = [];
	const leafById = Object.fromEntries(v.leaves.map((l) => [l.id, l]));
	const blockedCodes = new Set(v.codes.filter((c) => c.group === 'blocked').map((c) => c.code));
	const routeCodes = new Set(v.codes.filter((c) => c.group === 'route').map((c) => c.code));
	for (const { id, output: o, leaf } of entries) {
		const bad = (m) => out.push(`${id}: ${m}`);
		if (!isDeepStrictEqual(Object.keys(o), v.leaf_keys)) bad('keys differ from the leaf keys');
		if (o.contract !== v.contract) bad('contract differs');
		if (o.registration !== v.forced.registration || o.productionDefault !== v.forced.productionDefault) bad('registration or productionDefault differs');
		if (!v.statuses.includes(o.status)) bad('status is not one of the statuses');
		if (leaf) {
			const l = leafById[o.profileId];
			if (!l) bad(`profileId ${o.profileId} is no leaf id`);
			else if (o.status !== (l.state === 'blocked-upstream-fact-gap' ? 'blocked' : 'candidate')) bad('status does not follow the profile state');
		}
		if (!Array.isArray(o.routes) || !isSorted(o.routes, routeOrder)) bad('routes are not sorted by path, method, handler');
		for (const r of o.routes ?? []) {
			if (!isDeepStrictEqual(Object.keys(r), v.route_keys) || !v.methods.includes(r.method) || typeof r.path !== 'string' || !r.path.startsWith('/')) bad('a route does not have the route keys, a method of the seven and an absolute path');
			if (v.forbidden_route_keys.some((k) => k in r)) bad('a route owns a forbidden key');
		}
		if (o.status === 'blocked') {
			if (o.routes?.length) bad('a blocked output has routes');
			if (!blockedCodes.has(o.unknowns?.[0]?.code)) bad('the first unknown of a blocked output is not of the blocked group');
		} else if (!isSorted(o.unknowns ?? [], (a, b) => cmpText(stable(a), stable(b)))) bad('unknowns are not sorted');
		if (!isSorted(o.observations ?? [], (a, b) => cmpText(stable(a), stable(b)))) bad('observations are not sorted');
		for (const u of o.unknowns ?? []) {
			if (typeof u?.code !== 'string' || !u.code) bad('an unknown has no code');
			else if (routeCodes.has(u.code) && !v.unknown_keys.every((k) => k in u)) bad(`unknown ${u.code} lacks keys of ${v.unknown_keys.join(', ')}`);
		}
		const keys = deepKeys(o);
		for (const k of [...v.forbidden_keys, ...v.foreign_keys]) if (keys.has(k)) bad(`key ${k} appears`);
	}
	return out;
}

// leaf-contract.schema.json against the vocabulary, the replayed outputs and single-fault proofs of every listed difference.
const compileSchema = (doc) => new Ajv2020({ allErrors: true, strict: true }).compile(doc);
const ajvText = (errors) => (errors ?? []).slice(0, 2).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
const pointerEdit = (doc, pointer, value) => {
	const d = clone(doc);
	const keys = pointer.split('/').slice(1);
	let at = d;
	for (const k of keys.slice(0, -1)) at = at[k];
	const last = keys.at(-1);
	if (value === undefined) { if (Array.isArray(at)) at.splice(Number(last), 1); else delete at[last]; } else if (last === '-' && Array.isArray(at)) at.push(value); else at[last] = value;
	return d;
};
const leafEntries = (f, v) => Object.entries(f.outputs)
	.filter(([id, o]) => !GAP_FIXTURES.includes(id) && isObj(o) && o.contract === f.contract)
	.map(([id, output]) => ({ id, output, leaf: v.leaves.some((l) => l.id === output.profileId) }));

// Each difference is proved by inputs that the code accepts (stricter) or outputs that the schema accepts (looser), one fault at a time.
function gapProblems(validate, v, f) {
	const out = [];
	const { ns, mods } = f;
	const cand = profileOf(mods, v, 'candidate');
	const blk = profileOf(mods, v, 'blocked-upstream-fact-gap');
	const good = () => ({ sourceContracts: ['c'], routes: [route()], unknowns: [{ code: 'X' }], observations: [{ k: 1 }], evidence: { e: 1 } });
	const build = (profile, over) => { try { return ns.projection(profile, { ...good(), ...over }); } catch (e) { return { threw: e.name }; } };
	if (!cand || !blk) return ['no candidate or no blocked leaf profile'];
	const plain = build(cand, {});
	if (plain.threw || !validate(plain)) out.push('the fault-free output is rejected by the schema');
	const verdict = (profile, over) => { const o = build(profile, over); return o.threw ? `a ${o.threw} from the code` : validate(o) ? 'acceptance by both' : 'rejection by the schema'; };
	const names = v.forbidden_keys;
	const nest = (k) => [['evidence', { evidence: { [k]: 1 } }], ['nested evidence', { evidence: { a: { [k]: 1 } } }], ['an observation', { observations: [{ [k]: 1 }] }], ['a nested observation', { observations: [{ a: [{ [k]: 1 }] }] }], ['an unknown', { unknowns: [{ code: 'X', [k]: 1 }] }]];
	const STRICTER = {
		'route-fields': [['method', { method: 'TRACE' }], ['path', { path: 'a' }], ['handler 5', { handler: 5 }], ['empty handler', { handler: '' }], ['source 5', { source: 5 }], ['provenance 7', { provenance: 7 }], ['extra key', { extra: 1 }]].map(([l, r]) => [l, cand, { routes: [route(r)] }]),
		'blocked-without-routes': [['a route in a blocked output', blk, { routes: [route()], unknowns: [{ code: 'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING' }] }]],
		'unknown-code': [['no code', {}], ['empty code', { code: '' }], ['code 5', { code: 5 }], ['an unknown that is no object', 'x']].map(([l, u]) => [l, cand, { unknowns: [u] }]),
		'support-keys': names.flatMap((k) => nest(k).map(([l, o]) => [`${k} in ${l}`, cand, o])),
		'plain-contents': [['sourceContracts number', { sourceContracts: [5] }], ['sourceContracts empty string', { sourceContracts: [''] }], ['observation number', { observations: [5] }], ['observation array', { observations: [[1]] }], ['evidence string', { evidence: 'x' }], ['evidence null', { evidence: null }]].map(([l, o]) => [l, cand, o])
	};
	const proved = {};
	for (const [id, faults] of Object.entries(STRICTER)) {
		const bad = faults.map(([l, p, o]) => [l, verdict(p, o)]).filter(([, x]) => x !== 'rejection by the schema');
		proved[id] = bad.length ? 'unproved' : 'stricter';
		for (const [l, x] of bad) out.push(`${id}: ${l} gives ${x}, rejection by the schema expected`);
	}
	const open = { zz_open_key: { deep: [1, 'a', null, { z: true }] } };
	const LOOSER = {
		'order-and-ties': [
			['routes out of order', { ...plain, routes: [route({ path: '/b' }), route({ path: '/a' })] }, () => !isDeepStrictEqual(build(cand, { routes: [route({ path: '/b' }), route({ path: '/a' })] }).routes, [route({ path: '/b' }), route({ path: '/a' })])],
			['unknowns out of order', { ...plain, unknowns: [{ code: 'Z' }, { code: 'A' }] }, () => !isDeepStrictEqual(build(cand, { unknowns: [{ code: 'Z' }, { code: 'A' }] }).unknowns, [{ code: 'Z' }, { code: 'A' }])],
			['status not tied to the profile', { ...plain, status: 'blocked', routes: [] }, () => build(cand, {}).status === 'candidate']
		],
		'open-contents': [
			['an unknown with only a code', { ...plain, unknowns: [{ code: 'ROUTE_PATH_UNKNOWN' }] }, () => [{ method: 'ANY' }, { method: 'TRACE' }, { path: 'a' }].every((o) => isDeepStrictEqual(Object.keys(ns.routeOrUnknown(route(o)).unknown ?? {}), v.unknown_keys))]
		]
	};
	for (const [id, samples] of Object.entries(LOOSER)) {
		let ok = true;
		for (const [l, sample, codeSide] of samples) {
			const accepted = validate(sample) === true;
			const flagged = outputProblems([{ id: l, output: sample, leaf: true }], v).length > 0;
			if (!accepted) { ok = false; out.push(`${id}: ${l} is rejected by the schema`); }
			if (!codeSide()) { ok = false; out.push(`${id}: ${l} is something the code can produce`); }
			if (id === 'order-and-ties' && !flagged) { ok = false; out.push(`${id}: ${l} is not caught by the output invariants either`); }
		}
		proved[id] = ok ? 'looser' : 'unproved';
	}
	// Not a difference, checked with the producer: projection passes open observations and evidence through and the schema accepts that output.
	// The four support key names are refused by the schema only (support-keys above); a forbidden route key is refused by projection and by the schema.
	const same = build(cand, { observations: [open], evidence: open });
	if (same.threw || !validate(same)) out.push('open contents: the schema rejects the output of projection for open observations and evidence');
	else if (!isDeepStrictEqual(same.observations, [open]) || same.evidence !== open) out.push('open contents: projection does not pass open observations and evidence through');
	for (const k of v.forbidden_route_keys) {
		const owner = route({ [k]: 'x' });
		if (build(cand, { routes: [owner] }).threw !== 'TypeError' || validate({ ...plain, routes: [owner] })) out.push(`forbidden route key ${k}: projection and the schema do not both refuse it`);
	}
	const want = Object.fromEntries(v.schema_gaps.map((g) => [g.id, g.kind]));
	const have = Object.fromEntries(Object.keys(want).map((k) => [k, proved[k] ?? 'not proved']));
	for (const k of Object.keys(proved)) if (!(k in want)) have[k] = `${proved[k]}, but not in the vocabulary`;
	if (!isDeepStrictEqual(sorted(Object.entries(want).map((e) => e.join(':'))), sorted(Object.entries(have).map((e) => e.join(':'))))) out.push(`gap kinds: vocabulary ${JSON.stringify(want)}, proofs ${JSON.stringify(have)}`);
	return out;
}

function schemaProblems(doc, v, f) {
	let validate;
	try { validate = compileSchema(doc); } catch (e) { return [`schema does not compile: ${String(e.message).slice(0, 80)}`]; }
	const out = [];
	const eq = (label, want, have) => { if (!isDeepStrictEqual(want, have)) out.push(`${label}: vocabulary ${JSON.stringify(want)}, schema ${JSON.stringify(have)}`); };
	const route$ = doc.$defs?.route ?? {};
	eq('required keys', v.leaf_keys, doc.required);
	eq('property keys', v.leaf_keys, Object.keys(doc.properties ?? {}));
	eq('contract', v.contract, doc.properties?.contract?.const);
	eq('registration', v.forced.registration, doc.properties?.registration?.const);
	eq('productionDefault', v.forced.productionDefault, doc.properties?.productionDefault?.const);
	eq('statuses', v.statuses, doc.properties?.status?.enum);
	eq('route keys', v.route_keys, route$.required);
	eq('route property keys', v.route_keys, Object.keys(route$.properties ?? {}));
	eq('route methods', v.methods, route$.properties?.method?.enum);
	eq('support key names', v.forbidden_keys, doc.$defs?.plainObject?.propertyNames?.not?.enum);
	const entries = leafEntries(f, v);
	if (new Set(entries.filter((e) => e.leaf).map((e) => e.output.profileId)).size < v.leaves.length) out.push('replayed outputs do not cover every leaf');
	for (const e of entries) if (!validate(e.output)) out.push(`${e.id}: rejected by the schema, ${ajvText(validate.errors)}`);
	if (entries.length) {
		const o = entries[0].output;
		if (validate({ ...o, extra: 1 })) out.push('an output with an extra key is accepted by the schema');
		for (const k of v.leaf_keys) if (validate(Object.fromEntries(Object.entries(o).filter(([x]) => x !== k)))) out.push('an output without ' + k + ' is accepted by the schema');
	}
	if (validate(f.outputs[GAP_FIXTURES[0]])) out.push(`${GAP_FIXTURES[0]}: accepted by the schema`);
	return [...out, ...gapProblems(validate, v, f)];
}

// Vocabulary self-checks.
const VOCAB_KEYS = sorted(['schema', 'contract', 'schemas', 'foreign_schemas', 'foreign_keys', 'forbidden_keys', 'forbidden_route_keys', 'modules', 'leaves', 'upstream_functions', 'leaf_keys', 'route_keys', 'profile_keys', 'unknown_keys', 'input_keys', 'profile_states', 'statuses', 'methods', 'forced', 'reserved_words', 'route_witnesses', 'prose_limit', 'codes', 'prefixes', 'gates', 'schema_gaps', 'ownership', 'key_rules', 'shared_functions', 'owned_files']);
function vocabProblems(v) {
	const out = [];
	if (v.schema !== 'bskel.t12-interface-vocabulary/1') out.push('schema id differs');
	if (!isDeepStrictEqual(sorted(Object.keys(v)), VOCAB_KEYS)) out.push('top-level keys differ');
	const uniq = (label, xs) => { if (new Set(xs).size !== xs.length) out.push(`${label} are not unique`); };
	uniq('leaf ids', v.leaves.map((l) => l.id));
	uniq('leaf modules', v.leaves.map((l) => l.module));
	uniq('codes', v.codes.map((c) => c.code));
	uniq('prefixes', v.prefixes.map((p) => p.prefix));
	uniq('gates', v.gates.map((g) => g.gate));
	uniq('gap ids', v.schema_gaps.map((g) => g.id));
	uniq('key rules', v.key_rules.map((r) => r.key));
	uniq('ownership paths', v.ownership.flatMap((o) => o.paths));
	uniq('ownership probes', v.ownership.flatMap((o) => o.probes));
	for (const s of strings(v)) if (/[|\n]/.test(s)) out.push(`a vocabulary string holds a pipe or a newline: ${s.slice(0, 30)}`);
	for (const re of REF_PATTERNS) if (re.test(JSON.stringify(v))) out.push(`reference text ${re.source}`);
	return out;
}

const facts = await collectFacts();

test('RFC text equals the tables and bullet lines built from the vocabulary, stays within 120 lines and uses only vocabulary words in backticks', () => {
	assert.deepEqual(rfcProblems(rfcText, vocab), []);
});

test('vocabulary values that are compared equal the code, the replayed fixtures, BASELINE.json and the ownership answers of T00', () => {
	assert.deepEqual(codeProblems(vocab, facts), []);
	assert.equal(facts.ownershipStatus, 2, 'the checker refuses the probes of other tracks');
});

test('shared functions behave as the test encodes them and each of the seven leaves answers an unusable input as the vocabulary says', () => {
	assert.deepEqual(behaviourProblems(facts.ns, facts.mods, vocab), []);
});

test('replayed leaf outputs satisfy the invariants of sections 3, 4 and 5', () => {
	const entries = leafEntries(facts, vocab);
	assert.deepEqual(sorted(new Set(entries.filter((e) => e.leaf).map((e) => e.output.profileId))), sorted(vocab.leaves.map((l) => l.id)));
	assert.deepEqual(outputProblems(entries, vocab), []);
});

test('leaf-contract.schema.json matches the vocabulary, accepts the replayed leaf outputs, proves each listed difference by single faults and shows that open observations and evidence are no difference', () => {
	assert.deepEqual(schemaProblems(schemaDoc, vocab, facts), []);
});

test('vocabulary is well formed: schema id, closed key set, unique ids, no pipe, newline or reference text in a value', () => {
	assert.deepEqual(vocabProblems(vocab), []);
});

// ---- Negatives: each check has to be able to fail. Edits are made to the text only (vocabulary and code unchanged). ----
const L0 = linesOf(rfcText);
const nl = (ls) => `${ls.join('\n')}\n`;
const at = (line) => { const i = L0.indexOf(line); assert.ok(i >= 0, `line not found: ${line.slice(0, 40)}`); return i; };
const edit = (i, fn) => { const ls = [...L0]; const r = fn(ls[i]); if (r === null) ls.splice(i, 1); else if (Array.isArray(r)) ls.splice(i, 1, ...r); else ls[i] = r; return nl(ls); };
function plainWordEdit(line, v, fn) {
	const segs = line.split('`');
	const rel = mustAppear(v).map(String);
	for (let i = 0; i < segs.length; i += 2) {
		for (const m of segs[i].matchAll(/\b[a-z]{5,}\b/g)) {
			if (rel.some((w) => w.includes(m[0]) || m[0].includes(w))) continue;
			segs[i] = segs[i].slice(0, m.index) + fn(m[0]) + segs[i].slice(m.index + m[0].length);
			return segs.join('`');
		}
	}
	return null;
}
const REFERENCE_EDITS = [`#${1}`, ['PR', 1].join(' '), ['', 'issues', 1].join('/'), ['GH', 1].join('-'), ['refs', 'pull'].join('/')];

function textEdits(v) {
	const e = [];
	const T = /^table /;
	const B = /^(bullet|last line)/;
	const compared = new Set([...Object.keys(TABLES).flatMap((n) => tableLines(n, v)), ...Object.values(BULLETS).map((f) => f(v))]);
	for (const name of Object.keys(TABLES)) {
		const rows = tableLines(name, v);
		const cells = TABLES[name].rows(v)[0];
		const i = at(rows[2]);
		e.push([`table ${name}: header cell replaced`, edit(at(rows[0]), (l) => l.replace(TABLES[name].head[0], 'Zzz')), T]);
		e.push([`table ${name}: separator changed`, edit(at(rows[1]), (l) => l.replace('---', '--')), T]);
		e.push([`table ${name}: first cell replaced`, edit(i, () => row(['zzz', ...cells.slice(1)])), T]);
		e.push([`table ${name}: last cell appended`, edit(i, () => row([...cells.slice(0, -1), `${cells.at(-1)} x`])), T]);
		e.push([`table ${name}: row removed`, edit(i, () => null), T]);
		e.push([`table ${name}: row duplicated`, edit(i, (l) => [l, l]), T]);
		e.push([`table ${name}: row added after the table`, edit(at(rows.at(-1)), (l) => [l, row(cells)]), T]);
	}
	for (const [name, f] of Object.entries(BULLETS)) {
		const line = f(v);
		const i = at(line);
		e.push([`bullet ${name}: word replaced`, edit(i, (l) => l.replace(/[a-z]{4,}/, 'zzzz')), B]);
		e.push([`bullet ${name}: text appended`, edit(i, (l) => `${l} x`), B]);
		e.push([`bullet ${name}: line removed`, edit(i, () => null), B]);
		if (line.startsWith('- ')) e.push([`bullet ${name}: line duplicated`, edit(i, (l) => [l, l]), B]);
	}
	const s = L0.findIndex((l) => l.startsWith('Status: '));
	const status = L0[s];
	e.push(['status line: unknown backticked word replaced', edit(s, (l) => l.replace('`adapters/http-wave-a`', '`zzzUnknown`')), /^backticked/]);
	e.push(['status line: unknown backticked word appended', edit(s, (l) => `${l} \`zzzUnknown\``), /^backticked/]);
	e.push(['status line: known backticked word swapped for another known word', edit(s, (l) => l.replace('`adapters/http-wave-a`', '`BASELINE.json`')), null]);
	e.push(['status line: claim replaced', edit(s, (l) => l.replace('T12 is not declared complete', 'T12 is complete')), null]);
	e.push(['status line: claim appended', edit(s, (l) => `${l} T12 is complete.`), null]);
	e.push(['status line: one backtick removed', edit(s, (l) => l.replace('`', '')), /^(unbalanced|backticked)/]);
	REFERENCE_EDITS.forEach((r, n) => e.push([`status line: reference text ${n + 1} appended`, edit(s, (l) => `${l} ${r}`), /^reference text/]));
	e.push(['text: line appended after the last line', `${rfcText}Extra line.\n`, /^(line count|last line)/]);
	e.push(['text: blank line inserted', edit(1, () => ['', '']), /^line count/]);
	L0.forEach((line, i) => {
		const n = i + 1;
		if (line.startsWith('#')) {
			e.push([`line ${n} (${line.startsWith('# ') ? 'title' : 'heading'}): text replaced`, edit(i, (l) => l.replace(/^(#+ ).*$/, '$1Replaced')), null]);
			if (i > 0) e.push([`line ${n} (heading): line removed`, edit(i, () => null), null]);
		} else if (line.trim() && !compared.has(line) && !line.startsWith('|') && i !== s) {
			const w = plainWordEdit(line, v, (x) => `${x}zz`);
			if (w !== null) e.push([`line ${n} (prose): plain word replaced`, edit(i, () => w), /^vocabulary word/]);
			e.push([`line ${n} (prose): sentence appended`, edit(i, (l) => `${l} Appended.`), /^vocabulary word/]);
			e.push([`line ${n} (prose): line removed`, edit(i, () => null), /^(vocabulary word|backticked)/]);
		}
	});
	return e;
}

const TEXT_SURVIVORS = [
	'status line: known backticked word swapped for another known word', 'status line: claim replaced', 'status line: claim appended', 'line 1 (title): text replaced',
	...[7, 12, 27, 52, 59, 86, 101].flatMap((n) => [`line ${n} (heading): text replaced`, `line ${n} (heading): line removed`]),
	...[4, 5, 9, 10, 29, 61, 62, 88, 103].flatMap((n) => [`line ${n} (prose): plain word replaced`, `line ${n} (prose): sentence appended`, ...(n === 5 ? [] : [`line ${n} (prose): line removed`])])
];
test('text edits: every edit of a table or bullet line and every backticked word outside the vocabulary is caught, and the edits that survive (headings, prose, a known word swapped for another) are listed', () => {
	const result = {};
	for (const [label, text, tag] of textEdits(vocab)) {
		assert.notEqual(text, rfcText, `${label}: the edit changed nothing`);
		const problems = rfcProblems(text, vocab);
		result[label] = problems.length ? 'caught' : 'survives';
		if (problems.length && tag) assert.ok(problems.some((p) => tag.test(p)), `${label}: no problem matches ${tag}, first is ${problems[0]}`);
	}
	const survivors = Object.keys(result).filter((k) => result[k] === 'survives');
	const MUST_CATCH = /^(table |bullet |status line: (unknown|one backtick|reference)|text: )/;
	assert.deepEqual(Object.keys(result).filter((k) => MUST_CATCH.test(k) && result[k] !== 'caught'), [], 'an edit of a table, a bullet line, an unknown word, a backtick, a reference text or the line count survives');
	assert.ok(Object.keys(result).some((k) => MUST_CATCH.test(k)), 'no edit of a table or a bullet line was tried');
	assert.deepEqual([...survivors].sort(), [...TEXT_SURVIVORS].sort(), JSON.stringify(survivors));
});

// ---- Negatives: vocabulary edits. The text is rebuilt from the edited vocabulary (consistent) so that only the code-facing checks can object. ----
function consistentText(v2) {
	try {
		const ls = [...L0];
		for (const name of Object.keys(TABLES)) {
			const old = tableLines(name, vocab);
			ls.splice(ls.indexOf(old[0]), old.length, ...tableLines(name, v2));
		}
		for (const [name, f] of Object.entries(BULLETS)) ls[ls.indexOf(f(vocab))] = f(v2);
		return nl(ls);
	} catch { return rfcText; }
}
const CHECKERS = [
	['vocab', (v) => vocabProblems(v)],
	['text', (v, txt) => rfcProblems(txt, v)],
	['code', (v) => codeProblems(v, facts)],
	['behaviour', (v) => behaviourProblems(facts.ns, facts.mods, v)],
	['outputs', (v) => outputProblems(leafEntries(facts, v), v)],
	['schema', (v) => schemaProblems(schemaDoc, v, facts)]
];
const fires = (run, v, txt) => { try { return run(v, txt).length > 0; } catch { return true; } };
const verdictOf = (v) => {
	const drift = fires(CHECKERS[1][1], v, rfcText);
	const txt = consistentText(v);
	const names = CHECKERS.filter(([, run]) => fires(run, v, txt)).map(([n]) => n);
	return `${drift ? 'text drifts' : 'text does not drift'}; ${names.join('+') || 'nothing fires'}`;
};
const leafOf = (v, id) => v.leaves.find((l) => l.id === id);
const codeOf = (v, c) => v.codes.find((x) => x.code === c);
const VOCAB_EDITS = [
	['schema id appended', (v) => { v.schema = `${v.schema}x`; }],
	['schema id replaced', (v) => { v.schema = 'bskel.other-vocabulary/1'; }],
	['contract replaced everywhere', (v) => { v.contract += 'x'; v.schemas.leaf = v.contract; }],
	['schemas.native_language appended', (v) => { v.schemas.native_language += 'x'; }],
	['schemas.native_language replaced', (v) => { v.schemas.native_language = v.schemas.leaf; }],
	['leaf state replaced', (v) => { leafOf(v, 'go-gin').state = 'blocked-upstream-fact-gap'; }],
	['leaf owner replaced', (v) => { v.leaves[0].owner = 'T99'; }],
	['leaf function replaced', (v) => { v.leaves[0].function += 'X'; }],
	['leaf unusable replaced', (v) => { v.leaves[0].unusable = 'blocked output'; }],
	['leaf unusable appended', (v) => { v.leaves[0].unusable += ' x'; }],
	['leaf input appended', (v) => { v.leaves[0].input += ' x'; }],
	['leaf input replaced', (v) => { v.leaves[0].input = 'a string'; }],
	['leaf owner appended', (v) => { v.leaves[0].owner += 'x'; }],
	['leaf route_or_unknown flipped', (v) => { leafOf(v, 'go-gin').route_or_unknown = false; }],
	['leaf code removed', (v) => { leafOf(v, 'python-flask').codes.pop(); }],
	['leaf code added', (v) => { leafOf(v, 'python-flask').codes.push('FLASK_NEW_CODE'); }],
	['leaf upstream contract replaced', (v) => { v.leaves[0].upstream_contracts = ['x/1']; }],
	['leaf removed', (v) => { v.leaves.pop(); }],
	['code removed', (v) => { v.codes.pop(); }],
	['code group replaced', (v) => { codeOf(v, 'GIN_FOREIGN_ROUTE_FACT').group = 'blocked'; }],
	['code reason appended', (v) => { codeOf(v, 'ROUTE_PATH_UNKNOWN').reason += 'x'; }],
	['code reason replaced', (v) => { codeOf(v, 'ROUTE_PATH_UNKNOWN').reason = codeOf(v, 'ROUTE_METHOD_UNSUPPORTED').reason; }],
	['code renamed', (v) => { codeOf(v, 'GIN_FOREIGN_ROUTE_FACT').code += 'X'; }],
	['code added', (v) => { v.codes.push({ code: 'NEW_UNKNOWN_CODE', group: 'leaf', leaf: 'gin', reason: null, fixture: v.codes[0].fixture }); }],
	['code witness replaced', (v) => { codeOf(v, 'GIN_FOREIGN_ROUTE_FACT').fixture = codeOf(v, 'ASPNET_FOREIGN_ROUTE_FACT').fixture; }],
	['prefix replaced', (v) => { v.prefixes[0].prefix = 'T09_'; }],
	['prefix witness replaced', (v) => { v.prefixes[0].leaves.laravel = v.prefixes[1].leaves.gin; }],
	['gate state replaced', (v) => { v.gates[0].state = 'closed'; }],
	['gate limit replaced', (v) => { v.gates[0].limits = ['no-such-limit']; }],
	['gate limit appended', (v) => { v.gates[0].limits.push('external-program-versions-are-those-of-the-generating-machine'); }],
	['gate limit removed', (v) => { v.gates[0].limits.pop(); }],
	['gate blocker appended', (v) => { v.gates[0].blocker += 'x'; }],
	['gate blocker replaced', (v) => { v.gates[0].blocker = 'none'; }],
	['gate closes_when replaced', (v) => { v.gates[0].closes_when = 'never'; }],
	['gate closes_when appended', (v) => { v.gates[0].closes_when += ' x'; }],
	['schema gap kind replaced', (v) => { v.schema_gaps[0].kind = 'looser'; }],
	['schema gap id replaced', (v) => { v.schema_gaps[0].id += 'x'; }],
	['schema gap text appended', (v) => { v.schema_gaps[0].text += ' x'; }],
	['schema gap text replaced', (v) => { v.schema_gaps[0].text = 'none'; }],
	['schema gap removed', (v) => { v.schema_gaps.pop(); }],
	['ownership expectation replaced', (v) => { v.ownership[1].expect.owner = 'T99'; }],
	['ownership probe moved outside its paths', (v) => { v.ownership[1].probes[0] = 'contracts/next/x.json'; }],
	['ownership t12 word replaced', (v) => { v.ownership[1].t12 = 'edit'; }],
	['ownership t12 word appended', (v) => { v.ownership[1].t12 += ' x'; }],
	['key rule key replaced', (v) => { v.key_rules[0].key = 'contractX'; }],
	['key rule text appended', (v) => { v.key_rules[0].rule += ' x'; }],
	['key rule text replaced', (v) => { v.key_rules[0].rule = 'none'; }],
	['leaf_keys reversed', (v) => { v.leaf_keys.reverse(); }],
	['route_keys element removed', (v) => { v.route_keys.pop(); }],
	['route_keys element added', (v) => { v.route_keys.push('zzz'); }],
	['unknown_keys element added', (v) => { v.unknown_keys.push('zzz'); }],
	['profile_keys element added', (v) => { v.profile_keys.push('zzz'); }],
	['methods element added', (v) => { v.methods.push('TRACE'); }],
	['leaf_keys element added', (v) => { v.leaf_keys.push('zzz'); }],
	['profile_keys element removed', (v) => { v.profile_keys.pop(); }],
	['unknown_keys element removed', (v) => { v.unknown_keys.pop(); }],
	['input_keys element added', (v) => { v.input_keys.makeRoute.push('zzz'); }],
	['methods element removed', (v) => { v.methods.pop(); }],
	['statuses element added', (v) => { v.statuses.push('open'); }],
	['forced value replaced', (v) => { v.forced.registration = 'registered'; }],
	['forbidden_keys element added', (v) => { v.forbidden_keys.push('supports'); }],
	['forbidden_route_keys replaced', (v) => { v.forbidden_route_keys = ['routeId']; }],
	['foreign_schemas element added', (v) => { v.foreign_schemas.push('sbf.zzz/1'); }],
	['foreign_keys element added', (v) => { v.foreign_keys.push('zzz_key'); }],
	['foreign_schemas element removed', (v) => { v.foreign_schemas.pop(); }],
	['foreign_keys element removed', (v) => { v.foreign_keys.pop(); }],
	['foreign_schemas element replaced', (v) => { v.foreign_schemas[0] = 'sbf.zzz/1'; }],
	['reserved_words element added', (v) => { v.reserved_words.push('ZZZ_WORD'); }],
	['route witness code replaced', (v) => { v.route_witnesses[0].code = v.route_witnesses[1].code; }],
	['shared function removed', (v) => { v.shared_functions.pop(); }],
	['shared function renamed', (v) => { v.shared_functions[0].function += 'X'; }],
	['shared function unusable appended', (v) => { v.shared_functions[0].unusable += ' x'; }],
	['shared function unusable replaced', (v) => { v.shared_functions[0].unusable = 'none'; }],
	['upstream function renamed', (v) => { v.upstream_functions[0] += 'X'; }],
	['module export removed', (v) => { v.modules._shared.pop(); }],
	['owned file removed', (v) => { v.owned_files.pop(); }],
	['prose limit replaced', (v) => { v.prose_limit = 'no-such-limit'; }]
];
const VOCAB_SURVIVORS = [
	'leaf input appended', 'leaf input replaced', 'gate limit appended', 'gate limit removed', 'gate blocker appended', 'gate blocker replaced', 'gate closes_when appended', 'gate closes_when replaced',
	'schema gap text appended', 'schema gap text replaced', 'ownership t12 word appended', 'ownership t12 word replaced', 'key rule text appended', 'key rule text replaced',
	'foreign_schemas element added', 'foreign_schemas element removed', 'foreign_schemas element replaced', 'foreign_keys element added', 'foreign_keys element removed',
	'shared function unusable appended', 'shared function unusable replaced'
];
test('vocabulary edits: each edit drifts the text or fires a check, and only the listed descriptive values stay silent when the text is rebuilt', () => {
	const actual = {};
	for (const [label, mutate] of VOCAB_EDITS) {
		const v = clone(vocab);
		mutate(v);
		assert.ok(!isDeepStrictEqual(v, vocab), `${label}: the edit changed nothing`);
		actual[label] = verdictOf(v);
	}
	assert.deepEqual(Object.keys(actual).filter((k) => /; nothing fires$/.test(actual[k])).sort(), [...VOCAB_SURVIVORS].sort(), `ACTUAL=${JSON.stringify(actual)}`);
	assert.deepEqual(Object.keys(actual).filter((k) => /does not drift; nothing fires$/.test(actual[k])), [], 'an edit of the vocabulary alone is neither a text drift nor reported by a check');
});

// ---- Negatives: facts read from the code, doctored namespaces and schema edits. ----
const deepMap = (x, fn) => (Array.isArray(x) ? x.map((y) => deepMap(y, fn)) : isObj(x) ? fn(Object.fromEntries(Object.entries(x).map(([k, y]) => [k, deepMap(y, fn)]))) : x);
const withOutput = (f, id, fn) => derive({ ...f, outputs: { ...f.outputs, [id]: fn(clone(f.outputs[id])) } });
const leafFixture = (profileId) => leafEntries(facts, vocab).find((e) => e.output.profileId === profileId).id;
const swapProfile = (f, m, over) => ({ ...f, profiles: { ...f.profiles, [m]: { ...f.profiles[m], ...over } } });
const FACT_CHECKERS = [
	['code', (f) => codeProblems(vocab, f)],
	['outputs', (f) => outputProblems(leafEntries(f, vocab), vocab)],
	['schema', (f) => schemaProblems(schemaDoc, vocab, f)]
];
const FACT_EDITS = [
	['module export added', (f) => ({ ...f, exports: { ...f.exports, gin: [...f.exports.gin, 'extra'] } })],
	['top-level entry added', (f) => ({ ...f, topLevel: [...f.topLevel, 'extra.txt'] })],
	['profile state replaced', (f) => swapProfile(f, 'gin', { state: 'blocked-upstream-fact-gap' })],
	['profile claims registration', (f) => swapProfile(f, 'gin', { registration: 'registered' })],
	['profile key added', (f) => swapProfile(f, 'gin', { keys: [...f.profiles.gin.keys, 'extra'] })],
	['profile not frozen', (f) => swapProfile(f, 'gin', { frozen: false })],
	['routeOrUnknown use flipped', (f) => ({ ...f, usesRouteOrUnknown: { ...f.usesRouteOrUnknown, gin: false } })],
	['new code literal', (f) => ({ ...f, literals: { ...f.literals, NEW_UNLISTED_CODE: ['gin'] } })],
	['code literal vanishes', (f) => ({ ...f, literals: Object.fromEntries(Object.entries(f.literals).filter(([c]) => c !== 'GIN_FOREIGN_ROUTE_FACT')) })],
	['new prefix', (f) => ({ ...f, prefixes: { ...f.prefixes, T09_: ['gin'] } })],
	['schema literal added', (f) => ({ ...f, schemaLiterals: [...f.schemaLiterals, 'bskel.zzz/1'] })],
	['gate state flipped', (f) => ({ ...f, gateStates: { ...f.gateStates, bridges_built: 'closed' } })],
	['limit of a gate vanishes', (f) => ({ ...f, limitIds: f.limitIds.filter((id) => id !== 'leaves-are-unregistered-candidates') })],
	['ownership answer replaced', (f) => ({ ...f, ownership: { ...f.ownership, [vocab.ownership[1].probes[0]]: { code: 'OK', owner: 'T12' } } })],
	['upstream function unused', (f) => ({ ...f, sourceText: '' })],
	['parameter name vanishes', (f) => ({ ...f, params: { ...f.params, makeRoute: 'x' } })],
	['witness reason replaced', (f) => withOutput(f, 'route-method-any-lowercase', (o) => deepMap(o, (x) => (typeof x.reason === 'string' ? { ...x, reason: `${x.reason}.` } : x)))],
	['witness fixture module replaced', (f) => ({ ...f, witnesses: { ...f.witnesses, 'route-method-any-lowercase': { ...f.witnesses['route-method-any-lowercase'], module: 'gin.mjs' } } })],
	['forbidden key in evidence', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, evidence: { ...o.evidence, capabilities: 1 } }))],
	['ownership owner replaced', (f) => ({ ...f, ownership: { ...f.ownership, [vocab.ownership[1].probes[0]]: { code: 'PATH_OWNED_BY_OTHER_TRACK', owner: 'T09' } } })],
	['foreign schema in evidence', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, evidence: { ...o.evidence, x: 'sbf.contract-ref/1' } }))],
	['route owns operationId', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, routes: o.routes.map((r) => ({ ...r, operationId: 'x' })) }))],
	['output keys reordered', (f) => withOutput(f, leafFixture('go-gin'), (o) => Object.fromEntries(Object.entries(o).reverse()))],
	['output registration replaced', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, registration: 'registered' }))],
	['output routes unsorted', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, routes: [...o.routes].reverse() }))],
	['output status replaced', (f) => withOutput(f, leafFixture('go-gin'), (o) => ({ ...o, status: 'blocked' }))],
	['leaf output vanishes', (f) => { const g = leafFixture('go-gin'); const outputs = Object.fromEntries(Object.entries(f.outputs).filter(([id, o]) => !(isObj(o) && o.profileId === 'go-gin' && o.contract === f.contract) || id === GAP_FIXTURES[0])); return derive({ ...f, outputs }); }]
];
const FACT_EXPECT = {
	code: ['module export added', 'top-level entry added', 'profile state replaced', 'profile claims registration', 'profile key added', 'profile not frozen', 'routeOrUnknown use flipped', 'new code literal', 'code literal vanishes', 'new prefix', 'schema literal added', 'gate state flipped', 'limit of a gate vanishes', 'ownership answer replaced', 'ownership owner replaced', 'upstream function unused', 'parameter name vanishes', 'witness reason replaced', 'witness fixture module replaced', 'foreign schema in evidence'],
	outputs: ['output keys reordered', 'output routes unsorted'],
	'outputs+schema': ['output registration replaced', 'output status replaced'],
	'code+schema': ['leaf output vanishes'],
	'code+outputs+schema': ['forbidden key in evidence', 'route owns operationId']
};
test('facts edits: each listed change in the code, the outputs or the ownership answers is reported by a named check', () => {
	const actual = {};
	for (const [label, mutate] of FACT_EDITS) {
		const g = mutate(facts);
		assert.notEqual(g, facts, label);
		actual[label] = FACT_CHECKERS.filter(([, run]) => fires(run, g)).map(([n]) => n).join('+') || 'nothing fires';
	}
	assert.deepEqual(actual, Object.fromEntries(Object.entries(FACT_EXPECT).flatMap(([verdict, labels]) => labels.map((l) => [l, verdict]))), `ACTUAL=${JSON.stringify(actual)}`);
});

const NS_EDITS = [
	['routeOrUnknown expands ANY', { routeOrUnknown: (fact, ctx) => facts.ns.routeOrUnknown({ ...fact, method: String(fact.method).toUpperCase() === 'ANY' ? 'GET' : fact.method }, ctx) }],
	['routeOrUnknown drops the context', { routeOrUnknown: (fact) => facts.ns.routeOrUnknown(fact) }],
	['routeOrUnknown changes a reason', { routeOrUnknown: (fact, ctx) => { const r = facts.ns.routeOrUnknown(fact, ctx); return r.unknown ? { unknown: { ...r.unknown, reason: `${r.unknown.reason}.` } } : r; } }],
	['routeOrUnknown keeps the method case', { routeOrUnknown: (fact, ctx) => { const r = facts.ns.routeOrUnknown(fact, ctx); return r.route ? { route: { ...r.route, method: fact.method } } : r; } }],
	['makeRoute keeps the method case', { makeRoute: (r) => ({ ...facts.ns.makeRoute(r), method: r.method }) }],
	['makeRoute accepts any input', { makeRoute: (r) => ({ method: r.method, path: r.path, handler: r.handler ?? null, source: r.source ?? null, provenance: r.provenance }) }],
	['makeRoute checks source', { makeRoute: (r) => { if (r.source !== null && r.source !== undefined && !isObj(r.source)) throw new TypeError('source'); return facts.ns.makeRoute(r); } }],
	['defineProfile does not force values', { defineProfile: (p) => Object.freeze({ ...facts.ns.defineProfile(p), registration: p.registration ?? 'unregistered', productionDefault: p.productionDefault ?? false, runtimeTested: p.runtimeTested ?? false }) }],
	['defineProfile does not freeze', { defineProfile: (p) => ({ ...facts.ns.defineProfile(p) }) }],
	['projection does not sort routes', { projection: (p, i) => ({ ...facts.ns.projection(p, i), routes: i.routes ?? [] }) }],
	['projection copies evidence', { projection: (p, i) => { const o = facts.ns.projection(p, i); return { ...o, evidence: { ...o.evidence } }; } }],
	['projection shares sourceContracts', { projection: (p, i) => ({ ...facts.ns.projection(p, i), sourceContracts: i.sourceContracts ?? [] }) }],
	['projection drops equal routes', { projection: (p, i) => { const o = facts.ns.projection(p, i); return { ...o, routes: o.routes.filter((r, n, all) => n === 0 || JSON.stringify(r) !== JSON.stringify(all[n - 1])) }; } }],
	['projection accepts operationId', { projection: (p, i) => facts.ns.projection(p, { ...i, routes: (i.routes ?? []).map(({ operationId, ...r }) => r) }) }],
	['blockedProjection without an unknown', { blockedProjection: (p, c, r, e) => ({ ...facts.ns.blockedProjection(p, c, r, e), unknowns: [] }) }]
];
test('doctored shared functions and leaves: each listed doctoring of the documented behaviour is reported', () => {
	for (const [label, over] of NS_EDITS) {
		const problems = behaviourProblems({ ...facts.ns, ...over }, facts.mods, vocab);
		assert.ok(problems.length > 0, `${label}: nothing is reported`);
	}
	const leaf = (m, fn) => ({ ...facts.mods, [m]: { ...facts.mods[m], [fn]: () => ({ status: 'candidate', routes: [] }) } });
	assert.ok(behaviourProblems(facts.ns, leaf('flask', 'projectFlaskShadow'), vocab).length > 0, 'a leaf that returns an output for unusable input is not reported');
	assert.ok(behaviourProblems(facts.ns, leaf('django-drf', 'projectDjangoDrfShadow'), vocab).length > 0, 'a blocked leaf that returns a candidate is not reported');
});

const SCHEMA_EDITS = [
	['title replaced', '/title', 'Other title'],
	['description appended', '/description', `${schemaDoc.description} x`],
	['$id replaced', '/$id', 'https://bskel.internal/schemas/other/0'],
	['$comment added', '/$comment', 'a comment'],
	['profileId minLength removed', '/properties/profileId/minLength', undefined],
	['required element removed', '/required/9', undefined],
	['required element appended', '/required/-', 'zzz'],
	['property added', '/properties/zzz', { type: 'string' }],
	['unknown keyword added', '/properties/profileId/zzz', 1],
	['status enum element appended', '/properties/status/enum/-', 'open'],
	['status enum replaced', '/properties/status/enum', ['candidate']],
	['contract const replaced', '/properties/contract/const', 'x/0'],
	['registration const replaced', '/properties/registration/const', 'registered'],
	['productionDefault const replaced', '/properties/productionDefault/const', true],
	['top-level additionalProperties replaced', '/additionalProperties', true],
	['blocked rule removed', '/then', undefined],
	['route method enum element removed', '/$defs/route/properties/method/enum/6', undefined],
	['route method enum element appended', '/$defs/route/properties/method/enum/-', 'TRACE'],
	['route path pattern removed', '/$defs/route/properties/path/pattern', undefined],
	['route handler minLength removed', '/$defs/route/properties/handler/minLength', undefined],
	['route provenance type replaced', '/$defs/route/properties/provenance/type', ['string', 'number']],
	['route source replaced', '/$defs/route/properties/source', {}],
	['route additionalProperties replaced', '/$defs/route/additionalProperties', true],
	['route property added', '/$defs/route/properties/zzz', { type: 'string' }],
	['unknown code requirement removed', '/$defs/unknown/allOf/1/required', undefined],
	['unknown code minLength removed', '/$defs/unknown/allOf/1/properties/code/minLength', undefined],
	['support key name removed', '/$defs/plainObject/propertyNames/not/enum/2', undefined],
	['support key name appended', '/$defs/plainObject/propertyNames/not/enum/-', 'supports'],
	['support key rule removed', '/$defs/plainObject/propertyNames', undefined],
	['sourceContracts item minLength removed', '/properties/sourceContracts/items/minLength', undefined],
	['observations items replaced', '/properties/observations/items', {}],
	['evidence replaced', '/properties/evidence', {}],
	['value alternative removed', '/$defs/value/anyOf/1', undefined]
];
const SCHEMA_SURVIVORS = ['title replaced', 'description appended', '$id replaced', '$comment added', 'profileId minLength removed'];
test('schema edits: each listed edit is reported except the title, description, $id, $comment and the minLength of profileId, which are listed as survivors', () => {
	const survivors = [];
	for (const [label, pointer, value] of SCHEMA_EDITS) {
		const doc = pointerEdit(schemaDoc, pointer, value);
		assert.ok(!isDeepStrictEqual(doc, schemaDoc), `${label}: the edit changed nothing`);
		if (schemaProblems(doc, vocab, facts).length === 0) survivors.push(label);
	}
	assert.deepEqual(survivors, SCHEMA_SURVIVORS, JSON.stringify(survivors));
});

// The prose limit of BASELINE.json names every group of edits that the matrices above leave unreported, and no group without a survivor.
const SURVIVOR_GROUPS = {
	text: [
		['the title text', /^line 1 \(title\)/],
		['the headings', /\(heading\)/],
		['the prose sentences', /\(prose\)/],
		['the claims of the Status line', /^status line: claim/],
		['a backticked word in the Status line swapped for another word of the vocabulary', /^status line: known backticked word/]
	],
	vocabulary: [
		['the input text of a leaf', /^leaf input/],
		['the blocker and closes_when text of a gate', /^gate (blocker|closes_when)/],
		['the limits named by a gate', /^gate limit/],
		['the text of a schema gap', /^schema gap text/],
		['the ownership wording for T12', /^ownership t12 word/],
		['the text of a key rule', /^key rule text/],
		['the lists of foreign schemas and foreign keys', /^foreign_(schemas|keys) element/],
		['the unusable-input wording of a shared function', /^shared function unusable/]
	],
	schema: [
		['the schema title', /^title /],
		['the schema description', /^description /],
		['the schema $id', /^\$id /],
		['a schema $comment', /^\$comment /],
		['the minLength of profileId', /^profileId minLength/]
	]
};
const survivorProblems = (statement, survivors) => {
	const out = [];
	for (const [matrix, groups] of Object.entries(SURVIVOR_GROUPS)) {
		for (const [phrase, re] of groups) {
			if (!statement.includes(phrase)) out.push(`${matrix}: the limit does not contain "${phrase}"`);
			if (!survivors[matrix].some((l) => re.test(l))) out.push(`${matrix}: no survivor belongs to "${phrase}"`);
		}
		for (const l of survivors[matrix]) if (!groups.some(([, re]) => re.test(l))) out.push(`${matrix}: the survivor "${l}" belongs to no group`);
	}
	if (!statement.includes('not proved complete')) out.push('the limit does not say that its lists are not proved complete');
	return out;
};
test('the prose limit of BASELINE.json names each group of edits that survive the matrices, and no group without a survivor', () => {
	const limit = record.limits.find((l) => l.id === vocab.prose_limit);
	assert.equal(limit?.status, 'NOT_RECORDED');
	const survivors = { text: TEXT_SURVIVORS, vocabulary: VOCAB_SURVIVORS, schema: SCHEMA_SURVIVORS };
	assert.deepEqual(survivorProblems(limit.statement, survivors), []);
	assert.ok(survivorProblems(limit.statement.replace(SURVIVOR_GROUPS.vocabulary[0][0], 'x'), survivors).length > 0, 'a group missing from the limit is not reported');
	assert.ok(survivorProblems(limit.statement, { ...survivors, schema: [...SCHEMA_SURVIVORS, 'unlisted edit'] }).length > 0, 'a survivor that belongs to no group is not reported');
	assert.ok(survivorProblems(limit.statement, { ...survivors, vocabulary: VOCAB_SURVIVORS.filter((l) => !SURVIVOR_GROUPS.vocabulary[0][1].test(l)) }).length > 0, 'a group without a survivor is not reported');
	assert.ok(survivorProblems(limit.statement.replaceAll('not proved complete', 'complete'), survivors).length > 0, 'a limit that claims completeness is not reported');
});
