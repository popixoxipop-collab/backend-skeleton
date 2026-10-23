// T13-02: compares adapters/http-wave-bc/INTERFACE_RFC.md with interface-rfc.vocabulary.json and with the code of the layer.
// Compared: headings, tables, key lists, identifiers, schema names, cited paths and limit ids. One named check runs per claim row.
// Plain sentences are not compared (the RFC says so in its header); the change tables near the end show which edits are caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { REFERENCE_PATTERN, REGISTRY_FILES, REPO_ROOT, TRACK, UNIVERSAL, specifiersOf, tmpDir } from './baseline-record-lib.mjs';

const BC = 'adapters/http-wave-bc';
const RFC_FILE = `${BC}/INTERFACE_RFC.md`;
const VOCAB_FILE = 'test/http-wave-bc/interface-rfc.vocabulary.json';
const TITLE = '# T13 interface RFC: HTTP wave B and C adapters (Hono, Koa, Next.js)';
const LINE_CAP = 120;
const UPSTREAM = { 'node-hono': 'hono-official-readme', 'node-koa': 'koa-router-official-readme', 'typescript-nextjs': 'nextjs-official-route-handler' };
const FNS = { 'node-hono': ['detectHonoRoot', 'scanHono'], 'node-koa': ['detectKoaRouterRoot', 'scanKoaRouter'], 'typescript-nextjs': ['detectNextRoot', 'scanNext'] };
const SHOW_SAMPLE = ['GET   /v1/posts', '           [middleware]', '           namedHandler', 'router: RegExpRouter', '', 'POST  /v1/posts'].join('\n');
const HOSTILE = { undefined: () => undefined, null: () => null, 'a number': () => 5, 'an empty string': () => '', 'a missing path': (base) => path.join(base, 'missing'), 'a file path': (base) => path.join(base, 'file.txt'), 'an array': () => ['x'], 'an object': () => ({}) };
const HAND = { 'an empty object': () => ({}), 'a string': () => 'x', 'an object with a numeric projectRoot': () => ({ projectRoot: 5 }), 'an object without packageFile': (_base, root) => ({ projectRoot: root }) };
const WORD = /^[A-Za-z][\w$]*$/;
const SCHEMA = /^(?:sbf|bskel|beval)\.[a-z0-9.-]+\/\d+$/;
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const PATHLIKE = /^[\w.@()[\]/-]+$/;
const REPORTED = ['upstream-node-hono', 'next-reasons'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const BY_NUMBER = new RegExp(String.raw`#\d|\bPR\s*\d|\/pull\/\d|\/issues\/\d|GH-\d|refs\/pull`);

const code = (s) => `\`${s}\``;
const codes = (list) => (list.length ? list.map(code).join(', ') : 'no import');
const posix = (p) => p.split(path.sep).join('/');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const withoutSpans = (text) => text.replace(/`[^`\n]*`/g, '');
const claimIds = (vocab) => Object.values(vocab.claims).flatMap((group) => group.map((c) => c.id));
// The recursive option of readdirSync needs Node 18.17, and the engines field allows 18.0.
const filesUnder = (dir, prefix = '') => fs.readdirSync(dir).flatMap((name) => {
	const entry = path.join(dir, name);
	if (fs.lstatSync(entry).isDirectory()) return filesUnder(entry, `${prefix}${name}/`);
	return fs.statSync(entry).isFile() ? [`${prefix}${name}`] : [];
});

function parseTables(text) {
	const tables = [];
	let current = null;
	for (const line of text.split('\n')) {
		if (!line.startsWith('|')) {
			current = null;
			continue;
		}
		const cells = line.slice(1, line.lastIndexOf('|')).split('|').map((c) => c.trim());
		if (!current) {
			current = { header: cells, separator: null, rows: [] };
			tables.push(current);
		} else if (!current.separator) current.separator = cells;
		else current.rows.push(cells);
	}
	return tables;
}

function tableProblems(found, expected) {
	const problems = [];
	if (found.length !== expected.length) problems.push(`the text has ${found.length} tables, the code and the vocabulary give ${expected.length}`);
	for (let i = 0; i < Math.min(found.length, expected.length); i += 1) {
		const f = found[i];
		const e = expected[i];
		const at = `table ${i + 1} (${e.name})`;
		if (!f.separator || f.separator.length !== f.header.length || f.separator.some((c) => !/^-{3,}$/.test(c))) problems.push(`${at}: the separator line is not ---`);
		if (!same(f.header, e.header)) problems.push(`${at}: header is ${JSON.stringify(f.header)}, expected ${JSON.stringify(e.header)}`);
		if (f.rows.length !== e.rows.length) problems.push(`${at}: ${f.rows.length} rows, expected ${e.rows.length}`);
		for (let r = 0; r < Math.min(f.rows.length, e.rows.length); r += 1) {
			for (let c = 0; c < Math.max(f.rows[r].length, e.rows[r].length); c += 1) {
				if (f.rows[r][c] !== e.rows[r][c]) problems.push(`${at} row ${r + 1} column ${c + 1}: found ${JSON.stringify(f.rows[r][c])}, expected ${JSON.stringify(e.rows[r][c])}`);
			}
		}
	}
	return problems;
}

// BEGIN TREES
const PACKAGE = {
	'node-hono': '{"name":"sample","dependencies":{"hono":"^4"}}',
	'node-koa': '{"name":"sample","dependencies":{"koa":"^2","@koa/router":"^12"}}',
	'typescript-nextjs': '{"name":"sample","dependencies":{"next":"14"}}'
};
const lines = (rows) => (rows.length ? `${rows.join('\n')}\n` : '');
const hono = (...rows) => `import { Hono } from 'hono';\nconst app = new Hono();\n${lines(rows)}export default app;\n`;
const koa = (...rows) => `import Koa from 'koa';\nimport Router from '@koa/router';\nconst app = new Koa();\nconst router = new Router();\n${lines(rows)}app.use(router.routes());\n`;
const koaNamed = (name, ...rows) => `import Koa from 'koa';\nimport Router from '@koa/router';\nconst app = new Koa();\nconst ${name} = new Router();\n${lines(rows)}app.use(${name}.routes());\n`;
const exporting = (...names) => names.map((n) => `export async function ${n}() {}\n`).join('');
const HONO_MOUNTS = "import { Hono } from 'hono';\nimport a from './a/routes';\nimport b from './b/routes';\nconst app = new Hono();\napp.route('/a', a);\napp.route('/b', b);\nexport default app;\n";
const TREES = {
	'hono-twin': ['node-hono', { 'src/index.ts': HONO_MOUNTS, 'src/a/routes.ts': hono("app.get('/x', h);"), 'src/b/routes.ts': hono("app.get('/x', h);") }],
	'hono-dup': ['node-hono', { 'src/index.ts': hono("app.get('/a', h1);", "app.get('/a', h2);", "app.post('/a', h3);") }],
	'hono-same-line': ['node-hono', { 'src/index.ts': hono("app.get('/a', h1); app.get('/a', h2);") }],
	'hono-inline': ['node-hono', { 'src/index.ts': hono("app.get('/b', (c) => c.text('x'));") }],
	'hono-empty': ['node-hono', { 'src/index.ts': hono() }],
	'koa-twin': ['node-koa', { 'src/a/routes.js': koa("router.get('/a', h);"), 'src/b/routes.js': koa("router.get('/b', h);") }],
	'koa-mixed-vars': ['node-koa', { 'src/a/routes.js': koa("router.get('/a', h);"), 'src/b/routes.js': koaNamed('api', "api.get('/b', h);") }],
	'koa-dup': ['node-koa', { 'src/app.js': koa("router.get('/a', h1);", "router.get('/a', h2);") }],
	'koa-same-line': ['node-koa', { 'src/app.js': koa("router.get('/a', h1); router.get('/a', h2);") }],
	'koa-empty': ['node-koa', { 'src/app.js': koa() }],
	'next-three': ['typescript-nextjs', { 'app/a/route.ts': exporting('GET', 'POST'), 'app/b/route.ts': exporting('GET'), 'app/[id]/route.ts': exporting('GET') }],
	'next-both': ['typescript-nextjs', { 'app/a/route.ts': exporting('GET'), 'src/app/a/route.ts': exporting('GET') }],
	'next-dup': ['typescript-nextjs', { 'app/api/route.ts': exporting('GET', 'POST'), 'app/api/route.js': exporting('GET') }],
	'next-disjoint': ['typescript-nextjs', { 'app/api/route.js': exporting('GET'), 'app/api/route.ts': exporting('POST') }],
	'next-no-method': ['typescript-nextjs', { 'app/a/route.ts': 'export const dynamic = 1;\n' }],
	'next-slot-no-method': ['typescript-nextjs', { 'app/ok/route.ts': exporting('GET'), 'app/@slot/route.ts': 'export const dynamic = 1;\n' }],
	'next-base-path': ['typescript-nextjs', { 'app/api/route.ts': exporting('GET'), 'next.config.js': 'module.exports = { basePath: process.env.BASE_PATH };\n' }],
	'next-reasons': ['typescript-nextjs', { 'app/ok/route.ts': exporting('GET'), 'app/@slot/route.ts': exporting('GET'), 'app/_private/route.ts': exporting('GET'), 'app/[...all]/route.ts': exporting('GET'), 'app/(.)photo/route.ts': exporting('GET'), 'app/a[b]c/route.ts': exporting('GET') }],
	'next-page-only': ['typescript-nextjs', { 'app/page.tsx': 'export default function Page() { return null; }\n' }]
};
const NESTED = 'apps/api';
function materialize(base, name, prefix = '') {
	const [leaf, files] = TREES[name];
	const root = path.join(base, prefix ? `${name}-nested` : name);
	for (const [rel, text] of Object.entries({ 'package.json': PACKAGE[leaf], ...files })) {
		const file = path.join(root, prefix, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
	return { leaf, root };
}
// END TREES
Object.assign(TREES, {
	'hono-dup-shift': ['node-hono', { 'src/index.ts': hono('// extra', "app.get('/a', h1);", "app.get('/a', h2);", "app.post('/a', h3);") }],
	'koa-dup-shift': ['node-koa', { 'src/app.js': koa('// extra', "router.get('/a', h1);", "router.get('/a', h2);") }],
	'next-one': ['typescript-nextjs', { 'app/a/route.ts': exporting('GET', 'POST') }],
	'next-one-shift': ['typescript-nextjs', { 'app/a/route.ts': `// extra\n${exporting('GET', 'POST')}` }]
});
const SHIFTS = [['hono-dup', 'hono-dup-shift'], ['koa-dup', 'koa-dup-shift'], ['next-one', 'next-one-shift']];

// The sampled scans: the three upstream-example directories of the baseline fixtures, the authored trees above, one nested project,
// and per leaf a directory that the detector rejects.
function buildSamples(leaf, root) {
	const base = fs.realpathSync(tmpDir('bskel-t13-rfc-'));
	const runs = [];
	const add = (id, leafId, dir) => {
		const a = leaf[leafId].adapter;
		const detection = a.detect(dir);
		runs.push({ id, leaf: leafId, root: dir, detection, scan: a.scan(dir, detection) });
	};
	for (const [leafId, dir] of Object.entries(UPSTREAM)) add(`upstream-${leafId}`, leafId, path.join(root, 'test/http-wave-bc/fixtures', dir));
	for (const name of Object.keys(TREES)) add(name, TREES[name][0], materialize(base, name).root);
	add('hono-nested', 'node-hono', materialize(base, 'hono-dup', NESTED).root);
	const rejected = {};
	for (const leafId of Object.keys(leaf)) {
		rejected[leafId] = path.join(base, `rejected-${leafId}`);
		fs.mkdirSync(rejected[leafId]);
		fs.writeFileSync(path.join(rejected[leafId], 'package.json'), '{"name":"e"}');
	}
	fs.writeFileSync(path.join(base, 'file.txt'), 'x');
	return { base, runs, rejected };
}

// Never throws: whatever cannot be read or imported is listed in errors, and the tests fail with that list.
async function load(root = REPO_ROOT) {
	const errors = [];
	const attempt = async (label, fn) => {
		try {
			return await fn();
		} catch (error) {
			errors.push(`${label}: ${error?.message ?? error}`);
			return undefined;
		}
	};
	const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
	const importFrom = (rel) => import(pathToFileURL(path.join(root, rel)).href);
	const x = { root, errors };
	x.text = await attempt(RFC_FILE, () => readText(RFC_FILE));
	x.vocab = await attempt(VOCAB_FILE, () => JSON.parse(readText(VOCAB_FILE)));
	if (x.text === undefined || x.vocab === undefined) return x;
	x.peText = await attempt('profile-evidence.json', () => readText(`${BC}/profile-evidence.json`));
	x.t19Text = await attempt('t19-review-request.json', () => readText(`${BC}/t19-review-request.json`));
	x.pe = x.peText === undefined ? undefined : await attempt('profile-evidence.json', () => JSON.parse(x.peText));
	x.t19 = x.t19Text === undefined ? undefined : await attempt('t19-review-request.json', () => JSON.parse(x.t19Text));
	x.record = await attempt(TRACK.recordFile, () => JSON.parse(readText(TRACK.recordFile)));
	x.source = {};
	x.mod = {};
	for (const file of x.vocab.owned_files ?? []) {
		const key = file.replace(/\.mjs$/, '');
		x.source[key] = await attempt(`source ${file}`, () => readText(`${BC}/${file}`));
		x.mod[key] = await attempt(`import ${file}`, () => importFrom(`${BC}/${file}`));
	}
	x.leaf = {};
	for (const id of Object.keys(x.vocab.adapters ?? {})) {
		const mod = x.mod[`${id}/adapter`];
		const [detectName, scanName] = FNS[id] ?? [];
		if (mod?.adapter && mod[detectName] && mod[scanName]) x.leaf[id] = { adapter: mod.adapter, detect: mod[detectName], scan: mod[scanName] };
		else errors.push(`leaf ${id}: adapter, ${detectName} or ${scanName} is missing`);
	}
	const registry = await attempt('scanners/registry.mjs', () => importFrom('scanners/registry.mjs'));
	x.registered = registry?.ADAPTERS;
	x.registryText = {};
	for (const file of REGISTRY_FILES) x.registryText[file] = await attempt(file, () => readText(file));
	x.runScan = (await attempt('scanners/index.mjs', () => importFrom('scanners/index.mjs')))?.runScan;
	const own = await attempt('next/t00/ownership.mjs', () => importFrom('next/t00/ownership.mjs'));
	const map = await attempt('next/t00/ownership-map.json', () => JSON.parse(readText('next/t00/ownership-map.json')));
	x.classify = own && map ? (p) => own.classifyPath(map, 'bskel', p) : undefined;
	x.tree = await attempt('file list', () => filesUnder(path.join(root, BC)).sort());
	if (errors.length === 0) {
		x.samples = await attempt('samples', () => buildSamples(x.leaf, root));
		x.reports = {};
		for (const id of REPORTED) {
			const run = x.samples?.runs.find((r) => r.id === id);
			if (run) x.reports[id] = await attempt(`runScan ${id}`, () => x.runScan({ repoRoot: run.root, terms: [], adapters: [x.leaf[run.leaf].adapter] }));
		}
	}
	return x;
}

const LOADED = await load();
const ready = (x) => {
	assert.deepEqual(x.errors, [], 'the RFC, the vocabulary or a module could not be loaded');
	assert.ok(x.samples && x.tree && Object.keys(x.reports ?? {}).length === REPORTED.length, 'no samples were built');
	return x;
};

// ---- what the code gives ------------------------------------------------------------------------------------------------
const runOf = (x, id) => x.samples.runs.find((r) => r.id === id);
const controllersOf = (r) => r.scan.modules.flatMap((m) => m.controllers);
const endpointsOf = (r) => controllersOf(r).flatMap((c) => c.endpoints);
const rel = (from, file) => posix(path.relative(from, file));
const phrase = (labels) => `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
const words = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const DIGEST_WORDS = new Set(['hash', 'digest', 'sha', 'sha1', 'sha256', 'sha512']);
const claimOf = (x, id) => Object.values(x.vocab.claims).flat().find((c) => c.id === id)?.text ?? '';

function keysDeep(value, out = new Set()) {
	if (Array.isArray(value)) for (const item of value) keysDeep(item, out);
	else if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			out.add(key);
			keysDeep(item, out);
		}
	}
	return out;
}

function keyLists(x) {
	const runs = x.samples.runs;
	const detected = runs.filter((r) => r.detection);
	const keysOf = (o) => Object.keys(o);
	const endpointKeys = (leafId) => runs.filter((r) => r.leaf === leafId).flatMap((r) => endpointsOf(r).map(keysOf));
	const snapshot = x.mod['node-hono/show-routes-parser'].parseHonoShowRoutes(SHOW_SAMPLE);
	const reads = [];
	try {
		x.mod['node-hono/route-graph'].scanHonoProject(new Proxy({}, { get: (_target, key) => (reads.push(String(key)), undefined) }));
	} catch {
		// the function stops at the missing values; the properties it asked for are in reads
	}
	return {
		descriptor: Object.values(x.leaf).map((l) => keysOf(l.adapter)),
		detection: detected.map((r) => keysOf(r.detection)),
		scan_result: detected.map((r) => keysOf(r.scan)),
		not_detected_result: Object.entries(x.samples.rejected).map(([id, dir]) => keysOf(x.leaf[id].adapter.scan(dir, null))),
		module: detected.flatMap((r) => r.scan.modules.map(keysOf)),
		controller: detected.flatMap((r) => controllersOf(r).map(keysOf)),
		hono_endpoint: endpointKeys('node-hono'),
		koa_endpoint: endpointKeys('node-koa'),
		next_endpoint: endpointKeys('typescript-nextjs'),
		diagnostic: runs.flatMap((r) => x.leaf[r.leaf].adapter.diagnostics(r.root).map(keysOf)),
		show_routes_snapshot: [keysOf(snapshot)],
		show_route: snapshot.routes.map(keysOf),
		show_handler: snapshot.routes.flatMap((r) => r.handlers.map(keysOf)),
		show_unknown_line: snapshot.unknownLines.map(keysOf),
		scanHonoProject: [reads]
	};
}

// One key list per label; every sample must give the same list, and every label needs a sample.
function emittedKeys(x) {
	const found = {};
	const problems = [];
	for (const [label, lists] of Object.entries(keyLists(x))) {
		if (lists.length === 0) problems.push(`no sample gives keys for ${label}`);
		else found[label] = lists[0];
		lists.forEach((list, i) => {
			if (!same(list, lists[0])) problems.push(`${label}: sample ${i + 1} has keys ${JSON.stringify(list)}, sample 1 has ${JSON.stringify(lists[0])}`);
		});
	}
	return { found, problems };
}

function codeFacts(x) {
	const targets = x.mod.catalog.HTTP_WAVE_BC_TARGETS;
	const facts = { adapters: {}, exports: {}, imports: {} };
	for (const [id, { adapter }] of Object.entries(x.leaf)) {
		facts.adapters[id] = {
			specificity: adapter.specificity,
			confidence: adapter.confidence,
			verificationBasis: adapter.verificationBasis,
			flags: adapter.capabilities,
			codes: { detected: adapter.diagnostics(runOf(x, `upstream-${id}`).root)[0].code, not_detected: adapter.diagnostics(x.samples.rejected[id])[0].code }
		};
	}
	const has = (t) => Object.hasOwn(x.leaf, t.id);
	facts.catalog = { targets: targets.length, wave_b: targets.filter((t) => t.wave === 'B').length, wave_c: targets.filter((t) => t.wave === 'C').length, with_leaf: targets.filter(has).length, without_leaf: targets.filter((t) => !has(t)).length };
	for (const key of Object.keys(x.mod)) {
		facts.exports[key] = Object.keys(x.mod[key]).sort();
		facts.imports[key] = specifiersOf(x.source[key]);
	}
	const sampled = new Set();
	for (const note of runOf(x, 'next-reasons').scan.scanNotes) for (const m of note.matchAll(/ uses ([a-z-]+); no endpoint path/g)) sampled.add(m[1]);
	facts.reasons = [...sampled].sort();
	facts.schemas = { descriptor: Object.values(x.leaf).map((l) => l.adapter.contract), scan_report: Object.values(x.reports).map((r) => r.schema), show_routes_snapshot: x.mod['node-hono/show-routes-parser'].parseHonoShowRoutes('').schema };
	return facts;
}

// owner of a row of paths, as the ownership map of the repository gives it
const kindOf = (x, p) => {
	try {
		return fs.statSync(path.join(x.root, p)).isDirectory() ? 'dir' : 'file';
	} catch {
		return 'missing';
	}
};
function ownerOf(x, paths) {
	const labels = paths.map((p) => {
		if (kindOf(x, p) === 'missing') return `missing ${p}`;
		const c = x.classify(kindOf(x, p) === 'dir' ? `${p}/x.mjs` : p);
		return c.status === 'track' ? c.tracks.join('+') : c.status === 'hot' ? 'reserved' : 'unowned';
	});
	return new Set(labels).size === 1 ? labels[0] : `mixed (${labels.join(', ')})`;
}
function importsFrom(facts, paths) {
	return Object.entries(facts.imports).some(([key, specs]) => specs.some((spec) => spec.startsWith('.') && paths.some((p) => {
		const hit = path.posix.join(BC, path.posix.dirname(`${key}.mjs`), spec);
		return hit === p || hit.startsWith(`${p}/`);
	})));
}
function ownershipRows(x, facts) {
	return x.vocab.ownership.map((row) => {
		const owner = ownerOf(x, row.paths);
		return { owner, relation: owner === TRACK.suiteId ? 'edit' : importsFrom(facts, row.paths) ? 'import' : 'no import' };
	});
}

// ---- the tables the text must show --------------------------------------------------------------------------------------
function expectedTables(x) {
	const v = x.vocab;
	const facts = codeFacts(x);
	const flags = v.capability_flags;
	const claims = (group) => ({ name: `${group} claims`, header: ['id', 'claim'], rows: v.claims[group].map((c) => [code(c.id), c.text]) });
	const json = { 'profile-evidence.json': x.pe, 't19-review-request.json': x.t19 };
	const owners = ownershipRows(x, facts);
	return [
		{ name: 'adapters', header: ['adapter', 'specificity', 'confidence', 'verificationBasis', ...flags, 'diagnostic codes (detected / not detected)'], rows: Object.keys(v.adapters).map((id) => { const f = facts.adapters[id]; return [code(id), String(f.specificity), f.confidence, f.verificationBasis, ...flags.map((flag) => String(f.flags[flag])), `${code(f.codes.detected)} / ${code(f.codes.not_detected)}`]; }) },
		{ name: 'catalog', header: ['targets', 'wave B', 'wave C', 'with a leaf', 'without a leaf'], rows: [[facts.catalog.targets, facts.catalog.wave_b, facts.catalog.wave_c, facts.catalog.with_leaf, facts.catalog.without_leaf].map(String)] },
		{ name: 'modules', header: ['module', 'exports', 'imports', 'input', 'output'], rows: v.owned_files.map((file) => { const key = file.replace(/\.mjs$/, ''); return [code(file), codes(facts.exports[key]), codes(facts.imports[key]), v.module_io[key].input, v.module_io[key].output]; }) },
		claims('io'),
		claims('identity'),
		claims('unknown'),
		{ name: 'state', header: ['file', 'key', 'value'], rows: Object.entries(v.promotion).filter(([file]) => file !== 'gates').flatMap(([file, keyed]) => Object.keys(keyed).map((key) => [code(file), code(key), code(String(json[file]?.[key]))])) },
		{ name: 'gates', header: ['gate', 'owner', 'named in'], rows: v.promotion.gates.map((g) => [g.gate, g.owner, Object.keys(g.markers).map(code).join(', ')]) },
		claims('promotion'),
		{ name: 'ownership', header: ['owner', 'paths', 'relation'], rows: v.ownership.map((row, i) => [owners[i].owner, row.paths.map(code).join(', '), owners[i].relation]) },
		{ name: 'consumers', header: ['file', 'owner', 'names'], rows: v.consumers.map((c) => [code(c.file), ownerOf(x, [c.file]), code(c.token)]) },
		claims('ownership')
	];
}

function expectedLines(x) {
	const v = x.vocab;
	const { found } = emittedKeys(x);
	const facts = codeFacts(x);
	const pairs = (labels) => labels.map((label) => `${code(label)} {${(found[label] ?? []).join(', ')}}`).join('; ');
	const [descriptor] = facts.schemas.descriptor;
	const [report] = facts.schemas.scan_report;
	return [
		`Keys in emitted order, as label {keys}: ${pairs(['descriptor', 'detection', 'scan_result', 'not_detected_result', 'module', 'controller'])}.`,
		`Endpoints: ${pairs(['hono_endpoint', 'koa_endpoint', 'next_endpoint'])}. Others: ${pairs(['diagnostic', 'show_routes_snapshot', 'show_route', 'show_handler', 'show_unknown_line'])}. Input of the helper: ${pairs(['scanHonoProject'])}.`,
		`Schemas in use: ${code(descriptor)} (descriptor), ${code(report)} (report built by ${code('runScan')}), ${code(facts.schemas.show_routes_snapshot)} (snapshot). Foreign names, absent from this layer: ${[...v.foreign_schemas, ...v.foreign_keys].map(code).join(', ')}.`,
		`Reason codes in Next notes: ${v.reason_codes.map(code).join(', ')}. Limits of ${code('BASELINE.json')} that apply here: ${v.limit_ids.applies.map(code).join(', ')}.`
	];
}

// ---- problems in the text -----------------------------------------------------------------------------------------------
const PREFIXES = ['Keys in emitted order, as label {keys}:', 'Endpoints:', 'Schemas in use:', 'Reason codes in Next notes:'];

function textProblems(text) {
	const problems = [];
	const first = text.split('\n')[0];
	if (first !== TITLE) problems.push(`title: the first line is ${JSON.stringify(first)}`);
	const total = text.trimEnd().split('\n').length;
	if (total > LINE_CAP) problems.push(`line cap: ${total} lines, the cap is ${LINE_CAP}`);
	if (!text.endsWith('\n') || text.endsWith('\n\n')) problems.push('ending: the file must end with one newline');
	const found = [...withoutSpans(text).matchAll(new RegExp(UNIVERSAL.source, 'gi'))].map((m) => m[0].toLowerCase());
	if (found.length) problems.push(`universal words outside code spans: ${[...new Set(found)].join(', ')}`);
	const number = text.match(BY_NUMBER);
	if (number) problems.push(`number reference: ${JSON.stringify(number[0])}`);
	return problems;
}

function headingProblems(text, sections) {
	const found = text.split('\n').filter((l) => l.startsWith('#') && l !== TITLE);
	const expected = sections.map((s, i) => `## ${i + 1}. ${s}`);
	return same(found, expected) ? [] : [`headings: found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`];
}

function lineProblems(x) {
	const problems = [];
	const lines = x.text.split('\n');
	const expected = expectedLines(x);
	PREFIXES.forEach((prefix, i) => {
		const hits = lines.filter((l) => l.startsWith(prefix));
		if (hits.length !== 1) problems.push(`line "${prefix}": ${hits.length} lines start this way, expected 1`);
		else if (hits[0] !== expected[i]) problems.push(`line "${prefix}": found ${JSON.stringify(hits[0])}, expected ${JSON.stringify(expected[i])}`);
	});
	const goals = lines.filter((l) => l.startsWith('Non-goals:'));
	if (goals.length !== 1) problems.push(`line "Non-goals:": ${goals.length} lines start this way, expected 1`);
	else if (!same(spans(goals[0]), x.vocab.limit_ids.non_goals)) problems.push(`line "Non-goals:": limit ids are ${JSON.stringify(spans(goals[0]))}, expected ${JSON.stringify(x.vocab.limit_ids.non_goals)}`);
	return problems;
}

function knownWords(x) {
	const v = x.vocab;
	const { found } = emittedKeys(x);
	const set = new Set([...Object.keys(found), ...Object.values(found).flat(), ...Object.keys(v.input_keys), ...Object.values(v.input_keys).flat(), ...v.names, ...v.non_leaf_dirs, ...v.foreign_keys]);
	for (const m of Object.values(x.mod)) for (const k of Object.keys(m ?? {})) set.add(k);
	for (const [file, keyed] of Object.entries(v.promotion)) {
		if (file === 'gates') continue;
		for (const [k, val] of Object.entries(keyed)) set.add(k).add(val);
	}
	return set;
}

function knownIds(x) {
	const v = x.vocab;
	const diag = Object.values(v.adapters).flatMap((a) => Object.values(a.codes));
	return new Set([...(x.record?.limits ?? []).map((l) => l.id), ...Object.keys(v.adapters), ...diag, ...v.reason_codes, ...claimIds(v), ...v.non_leaf_dirs]);
}

// Every code span in the text is a schema name, a path that exists, an id of the record or the code, or an identifier of the code or the vocabulary.
function spanProblems(x) {
	const problems = [];
	const known = knownWords(x);
	const ids = knownIds(x);
	const schemas = new Set([...Object.values(x.vocab.schemas), ...x.vocab.foreign_schemas]);
	const exists = (s) => [s, `${BC}/${s}`, 'test/http-wave-bc/' + s].some((p) => fs.existsSync(path.join(x.root, p)));
	for (const s of new Set(spans(x.text))) {
		if (SCHEMA.test(s)) {
			if (!schemas.has(s)) problems.push(`span ${code(s)}: schema name that the vocabulary does not list`);
		} else if (s.startsWith('node:') || s.startsWith('.')) continue;
		else if (s.includes('/') || /\.(?:json|md|mjs|yml)$/.test(s)) {
			if (!exists(s)) problems.push(`span ${code(s)}: no such path`);
		} else if (KEBAB.test(s)) {
			if (!ids.has(s)) problems.push(`span ${code(s)}: not a limit id, adapter id, code or claim id`);
		} else if (WORD.test(s)) {
			if (!known.has(s)) problems.push(`span ${code(s)}: not an identifier of the code or the vocabulary`);
		} else problems.push(`span ${code(s)}: not a path, schema name, id or identifier`);
	}
	return problems;
}

// ---- problems in the vocabulary and the gates ---------------------------------------------------------------------------
const canon = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
const GROUP_PREFIX = { io: 'io-', identity: 'id-', unknown: 'un-', promotion: 'pg-', ownership: 'ow-' };

function vocabularyProblems(x) {
	const v = x.vocab;
	const facts = codeFacts(x);
	const { found, problems } = emittedKeys(x);
	const out = problems.map((p) => `keys: ${p}`);
	const differ = (what, got, want) => {
		if (canon(got) !== canon(want)) out.push(`vocabulary ${what}: ${JSON.stringify(got)}, the code gives ${JSON.stringify(want)}`);
	};
	differ('schema', v.schema, 'bskel.t13-interface-vocabulary/1');
	differ('adapter ids', Object.keys(v.adapters), Object.keys(x.leaf));
	for (const [id, a] of Object.entries(v.adapters)) {
		const f = facts.adapters[id];
		if (!f) continue;
		differ(`adapter ${id}`, { module: a.module, specificity: a.specificity, confidence: a.confidence, verificationBasis: a.verificationBasis, codes: a.codes }, { module: `${id}/adapter`, specificity: f.specificity, confidence: f.confidence, verificationBasis: f.verificationBasis, codes: f.codes });
		differ(`flags of ${id}`, v.capability_flags, Object.keys(f.flags));
		if (Object.values(f.flags).some((flag) => flag !== false)) out.push(`vocabulary flags: ${id} sets a capability flag to a value other than false`);
	}
	differ('catalog', v.catalog, facts.catalog);
	const one = (list) => (new Set(list).size === 1 ? list[0] : `differs: ${list.join(', ')}`);
	differ('schemas', v.schemas, { descriptor: one(facts.schemas.descriptor), scan_report: one(facts.schemas.scan_report), show_routes_snapshot: facts.schemas.show_routes_snapshot });
	const nonLeaf = (f) => v.non_leaf_dirs.some((d) => f.startsWith(`${d}/`));
	differ('owned files', [...v.owned_files].sort(), x.tree.filter((f) => f.endsWith('.mjs') && !nonLeaf(f)).sort());
	differ('exports', v.exports, facts.exports);
	differ('imports', v.imports, facts.imports);
	differ('module_io keys', Object.keys(v.module_io).sort(), v.owned_files.map((f) => f.replace(/\.mjs$/, '')).sort());
	for (const [k, io] of Object.entries(v.module_io)) if (typeof io.input !== 'string' || typeof io.output !== 'string') out.push(`vocabulary module_io ${k}: input and output must be strings`);
	differ('input_keys', v.input_keys, { scanHonoProject: found.scanHonoProject });
	differ('output_keys', v.output_keys, Object.fromEntries(Object.entries(found).filter(([label]) => label !== 'scanHonoProject')));
	differ('reason_codes against the sampled notes', [...v.reason_codes].sort(), facts.reasons);
	const literal = [...(x.source['typescript-nextjs/adapter'] ?? '').matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]);
	differ('reason_codes against the Next source', [...v.reason_codes].sort(), [...new Set(literal)].sort());
	differ('hostile_roots', v.hostile_roots, Object.keys(HOSTILE));
	differ('hand_fed', v.hand_fed, Object.keys(HAND));
	const pool = new Set([...Object.values(x.mod).flatMap((m) => Object.keys(m ?? {})), ...Object.keys(x.reports[REPORTED[0]] ?? {}), ...Object.keys(x.pe ?? {}), ...Object.keys(x.t19 ?? {}), ...(x.record?.targets ?? []).flatMap((t) => Object.keys(t)), x.runScan?.name]);
	for (const n of v.names) if (!pool.has(n)) out.push(`vocabulary names: ${n} is no export, report key, promotion key or record key`);
	const listed = [...v.limit_ids.non_goals, ...v.limit_ids.applies];
	for (const id of listed) if (!(x.record?.limits ?? []).some((l) => l.id === id)) out.push(`vocabulary limit_ids: ${id} is no limit of ${TRACK.recordFile}`);
	if (new Set(listed).size !== listed.length) out.push('vocabulary limit_ids: an id is listed twice');
	const json = { 'profile-evidence.json': x.pe, 't19-review-request.json': x.t19 };
	for (const [file, keyed] of Object.entries(v.promotion)) {
		if (file === 'gates') continue;
		for (const [k, val] of Object.entries(keyed)) if (json[file]?.[k] !== val) out.push(`vocabulary promotion: ${file} ${k} is ${JSON.stringify(json[file]?.[k])}, the vocabulary says ${JSON.stringify(val)}`);
	}
	const rows = ownershipRows(x, facts);
	v.ownership.forEach((row, i) => {
		if (row.owner !== rows[i].owner) out.push(`vocabulary ownership row ${i + 1}: owner is ${rows[i].owner} by the ownership map, the vocabulary says ${row.owner}`);
		if (row.t13 !== rows[i].relation) out.push(`vocabulary ownership row ${i + 1}: relation is ${rows[i].relation} by the imports, the vocabulary says ${row.t13}`);
	});
	for (const c of v.consumers) {
		const owner = ownerOf(x, [c.file]);
		if (owner !== c.owner) out.push(`vocabulary consumers ${c.file}: owner is ${owner}, the vocabulary says ${c.owner}`);
		let body = null;
		try {
			body = fs.readFileSync(path.join(x.root, c.file), 'utf8');
		} catch {
			out.push(`vocabulary consumers ${c.file}: cannot be read`);
		}
		if (body !== null && !body.includes(c.token)) out.push(`vocabulary consumers ${c.file}: does not contain ${c.token}`);
	}
	return out;
}

function gateProblems(x) {
	const out = [];
	const json = { 'profile-evidence.json': [x.peText, x.pe], 't19-review-request.json': [x.t19Text, x.t19] };
	for (const g of x.vocab.promotion.gates) {
		for (const [file, marker] of Object.entries(g.markers)) {
			const [body, data] = json[file] ?? [];
			if (!body?.includes(marker)) {
				out.push(`gate "${g.gate}": ${file} does not contain ${JSON.stringify(marker)}`);
				continue;
			}
			const entries = [];
			const walk = (value) => {
				if (typeof value === 'string') {
					if (value.includes(marker)) entries.push(value);
				} else if (value && typeof value === 'object') Object.values(value).forEach(walk);
			};
			walk(data);
			if (!entries.some((e) => e.replace(/-/g, ' ').includes(g.owner.replace(/-/g, ' ')))) out.push(`gate "${g.gate}": no entry of ${file} holds the marker and names ${g.owner}`);
		}
	}
	return out;
}

function claimProblems(x) {
	const out = [];
	const ids = claimIds(x.vocab);
	if (new Set(ids).size !== ids.length) out.push('claims: an id is used twice');
	for (const [group, list] of Object.entries(x.vocab.claims)) {
		for (const c of list) {
			if (!c.id.startsWith(GROUP_PREFIX[group] ?? '?')) out.push(`claims: ${c.id} does not start with ${GROUP_PREFIX[group]} in group ${group}`);
			if (typeof c.text !== 'string' || c.text.length < 20) out.push(`claims: ${c.id} has no text`);
		}
	}
	for (const id of ids) if (!CHECKS[id]) out.push(`claims: ${id} has no check`);
	for (const id of Object.keys(CHECKS)) if (!ids.includes(id)) out.push(`claims: check ${id} has no claim row`);
	return out;
}

function rfcProblems(x) {
	return [
		...textProblems(x.text),
		...headingProblems(x.text, x.vocab.sections),
		...tableProblems(parseTables(x.text), expectedTables(x)),
		...lineProblems(x),
		...spanProblems(x),
		...vocabularyProblems(x),
		...gateProblems(x),
		...claimProblems(x)
	];
}

// ---- one check per claim row; each returns the reasons why the claim does not hold ---------------------------------------
const NOT_DETECTED_KEYS = ['modules', 'filesRead', 'scanNotes'];
const leafRuns = (x, leafId) => x.samples.runs.filter((r) => r.leaf === leafId);
const outcome = (fn) => {
	try {
		return { value: fn() };
	} catch (error) {
		return { error };
	}
};
const isNotDetected = (r) => Boolean(r) && same(Object.keys(r), NOT_DETECTED_KEYS) && same(r.modules, []) && same(r.filesRead, []) && Array.isArray(r.scanNotes) && r.scanNotes.length === 1 && typeof r.scanNotes[0] === 'string';
const rootsOf = (x, id) => [...leafRuns(x, id).map((r) => ({ label: r.id, root: r.root, detection: r.detection })), { label: 'rejected', root: x.samples.rejected[id], detection: null }];

const CHECKS = {
	'io-legacy': (x) => {
		const p = [];
		const foreign = [...x.vocab.foreign_schemas, ...x.vocab.foreign_keys];
		for (const [id, l] of Object.entries(x.leaf)) if (l.adapter.contract !== x.vocab.schemas.descriptor) p.push(`${id}: contract is ${l.adapter.contract}`);
		const outputs = x.samples.runs.flatMap((r) => [r.detection, r.scan, x.leaf[r.leaf].adapter.diagnostics(r.root)]);
		const emitted = JSON.stringify(outputs);
		for (const f of foreign) if (emitted.includes(f)) p.push(`a sampled output holds ${f}`);
		const keys = new Set([...keysDeep(outputs), ...Object.values(x.leaf).flatMap((l) => [...keysDeep(l.adapter)])]);
		for (const f of x.vocab.foreign_keys) if (keys.has(f)) p.push(`a sampled output has the key ${f}`);
		for (const [key, body] of Object.entries(x.source)) for (const f of foreign) if (body?.includes(f)) p.push(`the module ${key} holds ${f}`);
		if (outputs.length === 0 || Object.keys(x.source).length !== x.vocab.owned_files.length) p.push('the sample or the module list is empty');
		return p;
	},
	'io-methods': (x) => {
		const p = [];
		let compared = 0;
		for (const [id, l] of Object.entries(x.leaf)) {
			const a = l.adapter;
			for (const d of rootsOf(x, id)) {
				compared += 1;
				const at = `${id} ${d.label}`;
				if (!same(a.detect(d.root), l.detect(d.root))) p.push(`${at}: detect differs from the exported function`);
				if (!same(a.scan(d.root, d.detection), l.scan(d.root, d.detection))) p.push(`${at}: scan differs from the exported function`);
				if (!same(a.scan(d.root, null), l.scan(d.root, null))) p.push(`${at}: scan with a null detection differs from the exported function`);
				if (d.detection && l.scan(d.root, d.detection).modules.length > 0 && !isNotDetected(a.scan(d.root, null))) p.push(`${at}: a null detection does not select the not-detected result`);
				const want = d.detection ? l.scan(d.root, d.detection).filesRead : [];
				if (!same(a.listReadSet(d.root), want)) p.push(`${at}: listReadSet is not the filesRead of the scan`);
				if (!same(a.listReadSet(d.root, null), [])) p.push(`${at}: listReadSet with a null detection is not an empty list`);
				const diag = a.diagnostics(d.root);
				if (diag.length !== 1 || diag[0].level !== 'info') p.push(`${at}: diagnostics does not return one info entry`);
			}
		}
		if (compared < 10) p.push(`only ${compared} roots were compared`);
		return p;
	},
	'io-input': (x) => {
		const p = [];
		const text = claimOf(x, 'io-input');
		const v = x.vocab;
		if (!text.includes(`A root that is ${phrase(v.hostile_roots)} gives`)) p.push('the claim does not list the roots as the vocabulary does');
		if (!text.includes(`does not throw for these ${NUMBER_WORDS[v.hostile_roots.length]} roots`)) p.push('the claim does not state the number of roots');
		if (!text.includes(`A detection passed by hand that is ${phrase(v.hand_fed)} makes`)) p.push('the claim does not list the detections as the vocabulary does');
		if (!same(Object.keys(HOSTILE), v.hostile_roots) || !same(Object.keys(HAND), v.hand_fed)) p.push('the vocabulary and the test use different labels');
		for (const [id, l] of Object.entries(x.leaf)) {
			const a = l.adapter;
			const code = v.adapters[id].codes.not_detected;
			for (const [label, make] of Object.entries(HOSTILE)) {
				const root = make(x.samples.base);
				const at = `${id} root ${label}`;
				const got = outcome(() => ({ detect: a.detect(root), scan: a.scan(root, a.detect(root)), read: a.listReadSet(root), diag: a.diagnostics(root) }));
				if (got.error) p.push(`${at}: throws ${got.error.constructor.name}`);
				else {
					if (got.value.detect !== null) p.push(`${at}: detect is not null`);
					if (!isNotDetected(got.value.scan)) p.push(`${at}: scan is not the not-detected result`);
					if (!same(got.value.read, [])) p.push(`${at}: the read set is not empty`);
					if (got.value.diag.length !== 1 || got.value.diag[0].code !== code) p.push(`${at}: the diagnostic is not ${code}`);
				}
			}
			const known = runOf(x, `upstream-${id}`).root;
			for (const [label, make] of Object.entries(HAND)) {
				const detection = make(x.samples.base, known);
				if (!(outcome(() => a.scan(known, detection)).error instanceof TypeError)) p.push(`${id} detection ${label}: scan does not throw TypeError`);
				if (!(outcome(() => a.listReadSet(known, detection)).error instanceof TypeError)) p.push(`${id} detection ${label}: listReadSet does not throw TypeError`);
			}
			if (!isNotDetected(a.scan(known, null))) p.push(`${id}: a null detection does not select the not-detected result`);
		}
		return p;
	},
	'io-run-scan': (x) => {
		const p = [];
		let modules = 0;
		let notes = 0;
		for (const id of REPORTED) {
			const report = x.reports[id];
			const run = runOf(x, id);
			if (!report || !run) {
				p.push(`${id}: no report`);
				continue;
			}
			modules += run.scan.modules.length;
			notes += run.scan.scanNotes.length;
			if (report.schema !== x.vocab.schemas.scan_report) p.push(`${id}: schema is ${report.schema}`);
			if (!same(report.related_modules, run.scan.modules)) p.push(`${id}: related_modules differs from modules`);
			if (!same(report.files_read, run.scan.filesRead)) p.push(`${id}: files_read differs from filesRead`);
			if (report.api_surface_source !== run.scan.apiSurfaceSource) p.push(`${id}: api_surface_source differs from apiSurfaceSource`);
			const scanNotes = run.scan.scanNotes;
			if (report.unknowns.length !== scanNotes.length + 2) p.push(`${id}: unknowns hold ${report.unknowns.length} entries, expected ${scanNotes.length + 2}`);
			if (!same(report.unknowns.slice(report.unknowns.length - scanNotes.length), scanNotes)) p.push(`${id}: the unknowns do not end with the scanNotes`);
			if (report.unknowns.slice(0, 2).some((u) => scanNotes.includes(u))) p.push(`${id}: a scan note is among the first two unknowns`);
		}
		if (modules === 0 || notes === 0) p.push('the sampled reports hold no module or no scan note');
		return p;
	},
	'io-registry': (x) => {
		if (!Array.isArray(x.registered) || x.registered.length === 0) return ['the ADAPTERS list is missing or empty'];
		const p = [];
		for (const id of Object.keys(x.leaf)) {
			if (x.registered.some((a) => a?.id === id)) p.push(`${id} is an id in the ADAPTERS list`);
		}
		for (const file of REGISTRY_FILES) {
			const body = x.registryText[file];
			if (typeof body !== 'string' || body.length === 0) p.push(`${file} could not be read`);
			else if (new RegExp(REFERENCE_PATTERN).test(body)) p.push(`${file} names a path of this layer`);
		}
		return p;
	},
	'io-catalog': (x) => {
		const p = [];
		const { HTTP_WAVE_BC_TARGETS: targets, validateWaveBcCatalog: validate } = x.mod.catalog;
		if (!Array.isArray(targets) || !Object.isFrozen(targets)) p.push('HTTP_WAVE_BC_TARGETS is not a frozen array');
		const listed = outcome(() => validate(targets));
		if (listed.error || !same(listed.value, [])) p.push('validateWaveBcCatalog(HTTP_WAVE_BC_TARGETS) does not return an empty list');
		if (!(outcome(() => validate([null])).error instanceof TypeError)) p.push('validateWaveBcCatalog([null]) does not throw TypeError');
		if (!(x.record?.fixtures ?? []).some((f) => f.id === 'catalog-throws-on-a-null-entry')) p.push('BASELINE.json has no fixture catalog-throws-on-a-null-entry');
		return p;
	},
	'id-operation': (x) => {
		const p = [];
		let endpoints = 0;
		for (const r of x.samples.runs) {
			for (const c of controllersOf(r)) {
				if (!same(c.operationIds, [])) p.push(`${r.id}: operationIds of ${c.className} is not an empty list`);
				for (const e of c.endpoints) {
					endpoints += 1;
					if (e.operationId !== null) p.push(`${r.id}: operationId of ${e.verb} ${e.path} is not null`);
					if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(e.verb)) p.push(`${r.id}: verb ${e.verb} is no HTTP method`);
				}
			}
		}
		const methods = (id) => endpointsOf(runOf(x, id)).map((e) => e.method);
		if (!same(methods('hono-dup'), ['h1', 'h2', 'h3'])) p.push('hono-dup: method is not the handler name');
		if (!same(methods('koa-dup'), ['h1', 'h2'])) p.push('koa-dup: method is not the handler name');
		if (!same(methods('hono-inline'), [null])) p.push('hono-inline: method of an inline handler is not null');
		if (!endpointsOf(runOf(x, 'next-one')).every((e) => e.method === e.verb)) p.push('next-one: method is not the exported function name');
		if (endpoints < 12) p.push(`only ${endpoints} endpoints were sampled`);
		return p;
	},
	'id-class-name': (x) => {
		const p = [];
		const form = { 'node-hono': /^Hono\((.+):[^:()]+\)$/, 'node-koa': /^KoaRouter\(([^/:()]+):[^:()]+\)$/, 'typescript-nextjs': /^NextRoute\((.+)\)$/ };
		for (const r of x.samples.runs.filter((q) => q.detection)) {
			for (const c of controllersOf(r)) {
				const m = form[r.leaf].exec(c.className);
				const want = r.leaf === 'node-koa' ? path.basename(c.file) : rel(r.detection.projectRoot, c.file);
				if (!m) p.push(`${r.id}: className ${c.className} does not have the form of ${r.leaf}`);
				else if (m[1] !== want) p.push(`${r.id}: className ${c.className} names ${m[1]}, the file gives ${want}`);
			}
		}
		const names = (id) => controllersOf(runOf(x, id)).map((c) => c.className);
		const files = controllersOf(runOf(x, 'koa-twin')).map((c) => rel(runOf(x, 'koa-twin').root, c.file));
		const koa = names('koa-twin');
		if (koa.length !== 2 || koa[0] !== koa[1] || new Set(files).size !== 2 || new Set(files.map((f) => path.posix.basename(f))).size !== 1) p.push('koa-twin: two router files of one basename do not give two equal classNames');
		const mixed = controllersOf(runOf(x, 'koa-mixed-vars'));
		if (mixed.length !== 2 || mixed[0].className === mixed[1].className || new Set(mixed.map((c) => path.posix.basename(c.file))).size !== 1) p.push('koa-mixed-vars: the router variable must distinguish same-basename controllers');
		for (const id of ['hono-twin', 'next-three']) {
			const list = names(id);
			if (list.length < 2 || new Set(list).size !== list.length) p.push(`${id}: classNames are not pairwise different`);
		}
		return p;
	},
	'id-duplicate': (x) => {
		const p = [];
		const eps = (id) => endpointsOf(runOf(x, id));
		for (const id of ['hono-dup', 'koa-dup']) {
			const n = eps(id).filter((e) => e.path === '/a' && /^get$/i.test(e.verb)).length;
			if (n !== 2) p.push(`${id}: ${n} endpoints for GET /a, expected 2`);
		}
		for (const id of ['hono-same-line', 'koa-same-line']) {
			const list = eps(id);
			if (list.length !== 2) {
				p.push(`${id}: expected two endpoints`);
				continue;
			}
			const [{ method: ma, ...ra }, { method: mb, ...rb }] = list;
			if (!same(ra, rb)) p.push(`${id}: the two endpoints differ in more than method`);
			if (ma === mb) p.push(`${id}: method does not differ`);
		}
		const run = runOf(x, 'next-dup');
		const same_path = controllersOf(run).filter((c) => c.basePath === '/api');
		if (same_path.length !== 2) p.push(`next-dup: ${same_path.length} controllers for /api, expected 2`);
		const files = same_path.map((c) => rel(run.detection.projectRoot, c.file));
		if (new Set(files).size !== 2 || !run.scan.scanNotes.some((note) => files.every((f) => note.includes(f)))) p.push('next-dup: no scan note names both files');
		const apart = runOf(x, 'next-disjoint');
		const pair = controllersOf(apart).filter((c) => c.basePath === '/api');
		if (pair.length !== 2) p.push(`next-disjoint: ${pair.length} controllers for /api, expected 2`);
		if (apart.scan.scanNotes.some((note) => pair.some((c) => note.includes(rel(apart.detection.projectRoot, c.file))))) p.push('next-disjoint: a scan note names one of the files');
		return p;
	},
	'id-line': (x) => {
		const p = [];
		let checked = 0;
		for (const r of x.samples.runs.filter((q) => !q.id.startsWith('upstream-'))) {
			for (const c of controllersOf(r)) {
				const lines = fs.readFileSync(c.file, 'utf8').split('\n');
				for (const e of c.endpoints) {
					if (r.leaf !== 'typescript-nextjs' && e.method === null) continue;
					const needle = r.leaf === 'typescript-nextjs' ? `function ${e.verb}(` : `${e.method})`;
					const at = lines.findIndex((l) => l.includes(needle)) + 1;
					checked += 1;
					if (at === 0 || e.line !== at) p.push(`${r.id}: line of ${e.verb} ${e.path} is ${e.line}, the source has it at ${at}`);
				}
			}
		}
		if (checked < 15) p.push(`only ${checked} lines were compared with the source`);
		for (const [a, b] of SHIFTS) {
			const ca = controllersOf(runOf(x, a));
			const cb = controllersOf(runOf(x, b));
			if (ca.length === 0 || ca.length !== cb.length) p.push(`${a} and ${b}: the controller counts differ`);
			ca.forEach((c, i) => {
				if (c.className !== cb[i]?.className) p.push(`${a} and ${b}: className changed`);
				if (c.endpoints.length !== cb[i]?.endpoints.length) p.push(`${a} and ${b}: the endpoint count changed`);
				c.endpoints.forEach((e, j) => {
					const f = cb[i]?.endpoints[j];
					if (f && (e.verb !== f.verb || e.path !== f.path)) p.push(`${a} and ${b}: verb or path changed`);
					if (f && f.line !== e.line + 1) p.push(`${a} and ${b}: line moved by ${f.line - e.line}, expected 1`);
				});
			});
		}
		return p;
	},
	'id-location': (x) => {
		const p = [];
		for (const r of x.samples.runs.filter((q) => q.detection)) {
			for (const c of controllersOf(r)) if (!path.isAbsolute(c.file) || !fs.existsSync(c.file)) p.push(`${r.id}: file ${c.file} is not an existing absolute path`);
			for (const f of r.scan.filesRead) if (path.isAbsolute(f) || !fs.existsSync(path.join(r.root, f))) p.push(`${r.id}: filesRead entry ${f} is not an existing path below the scan root`);
		}
		for (const id of ['hono-dup', 'koa-dup', 'next-one']) {
			const r = runOf(x, id);
			const adapter = x.leaf[r.leaf].adapter;
			const given = path.relative(process.cwd(), r.root);
			if (given === '' || path.isAbsolute(given)) {
				p.push(`${id}: the scan root has no relative form from ${process.cwd()}`);
				continue;
			}
			const detection = adapter.detect(given);
			const scan = detection ? adapter.scan(given, detection) : null;
			const found = scan ? scan.modules.flatMap((m) => m.controllers) : [];
			const want = controllersOf(r);
			if (found.length === 0 || found.length !== want.length) {
				p.push(`${id}: a relative scan root gives ${found.length} controllers, expected ${want.length}`);
				continue;
			}
			found.forEach((c, i) => {
				if (path.isAbsolute(c.file) || path.resolve(c.file) !== want[i].file) p.push(`${id}: with a relative scan root file is ${c.file}, expected a relative path to ${want[i].file}`);
				if (c.className !== want[i].className) p.push(`${id}: className depends on the form of the scan root`);
			});
			if (!same(scan.filesRead, r.scan.filesRead)) p.push(`${id}: filesRead depends on the form of the scan root`);
		}
		const run = runOf(x, 'hono-nested');
		if (!run?.detection) return [...p, 'hono-nested was not detected'];
		const project = run.detection.projectRoot;
		if (rel(run.root, project) !== NESTED) p.push(`the project is at ${rel(run.root, project)}, expected ${NESTED}`);
		if (controllersOf(run).length === 0) p.push('hono-nested: no controller was sampled');
		for (const c of controllersOf(run)) {
			const named = /^Hono\((.+):[^:()]+\)$/.exec(c.className)?.[1];
			if (named !== rel(project, c.file)) p.push(`className ${c.className} is not relative to the project root`);
			if (named === rel(run.root, c.file)) p.push('className and the path below the scan root do not differ');
		}
		if (!run.scan.filesRead.every((f) => f.startsWith(`${NESTED}/`))) p.push('filesRead entries do not start with the nested folder');
		return p;
	},
	'id-no-digest': (x) => {
		const p = [];
		const snapshot = x.mod['node-hono/show-routes-parser'].parseHonoShowRoutes(SHOW_SAMPLE);
		const outputs = x.samples.runs.flatMap((r) => [r.detection, r.scan, x.leaf[r.leaf].adapter.diagnostics(r.root)]);
		const keys = new Set([...keysDeep(outputs), ...keysDeep(snapshot), ...Object.values(x.leaf).flatMap((l) => [...keysDeep(l.adapter)])]);
		for (const k of keys) if (words(k).some((w) => DIGEST_WORDS.has(w))) p.push(`the key ${k} has hash, digest or sha as a word`);
		for (const r of x.samples.runs) {
			for (const c of controllersOf(r)) {
				if (typeof c.className !== 'string') p.push(`${r.id}: a controller has no className`);
				for (const e of c.endpoints) for (const k of ['verb', 'path', 'line']) if (!(k in e)) p.push(`${r.id}: an endpoint has no ${k}`);
			}
		}
		const tuples = (id) => controllersOf(runOf(x, id)).flatMap((c) => c.endpoints.map((e) => [c.className, e.verb, e.path, e.line].join('|')));
		for (const id of ['hono-same-line', 'koa-same-line']) {
			const t = tuples(id);
			if (t.length !== 2 || t[0] !== t[1]) p.push(`${id}: the two registrations on one line do not carry equal values`);
		}
		for (const [a, b] of SHIFTS) if (same(tuples(a), tuples(b))) p.push(`${a} and ${b}: the values do not change when a line is inserted`);
		return p;
	},
	'un-empty-lists': (x) => {
		const p = [];
		let modules = 0;
		for (const r of x.samples.runs) {
			for (const m of r.scan.modules) {
				modules += 1;
				for (const k of ['entities', 'enums', 'dtos']) if (!same(m[k], [])) p.push(`${r.id}: ${k} is not an empty list`);
			}
		}
		if (modules < 5) p.push(`only ${modules} modules were sampled`);
		for (const key of ['node-hono/route-graph', 'node-koa/adapter', 'typescript-nextjs/adapter']) {
			if (!/entities: \[\], enums: \[\], dtos: \[\]/.test(x.source[key] ?? '')) p.push(`${key}: no literal entities: [], enums: [], dtos: []`);
		}
		return p;
	},
	'un-not-detected': (x) => {
		const p = [];
		for (const [id, l] of Object.entries(x.leaf)) {
			const dir = x.samples.rejected[id];
			if (l.adapter.detect(dir) !== null) p.push(`${id}: the rejected tree is detected`);
			if (!isNotDetected(l.adapter.scan(dir, l.adapter.detect(dir)))) p.push(`${id}: the rejected tree does not give the not-detected result`);
		}
		for (const id of ['hono-empty', 'koa-empty', 'next-no-method']) {
			const r = runOf(x, id);
			if (!r.detection) p.push(`${id}: not detected`);
			else if (!same(r.scan.modules, []) || r.scan.filesRead.length === 0) p.push(`${id}: a detected tree without routes does not give empty modules and a non-empty filesRead`);
		}
		return p;
	},
	'un-reason-codes': (x) => {
		const p = [];
		const run = runOf(x, 'next-reasons');
		const found = run.scan.scanNotes.map((n) => /^Next\.js Route Handler at (\S+) uses ([a-z-]+); no endpoint path was emitted\.$/.exec(n)).filter(Boolean);
		if (found.length !== x.vocab.reason_codes.length) p.push(`next-reasons: ${found.length} notes with a reason, expected ${x.vocab.reason_codes.length}`);
		if (!same(found.map((m) => m[2]).sort(), [...x.vocab.reason_codes].sort())) p.push('next-reasons: the reason codes of the notes differ from the vocabulary');
		for (const m of found) if (!fs.existsSync(path.join(run.detection.projectRoot, m[1]))) p.push(`a note names ${m[1]}, which is no file of the tree`);
		const eps = endpointsOf(run);
		if (eps.length !== 1 || eps[0].path !== '/ok') p.push('next-reasons: a file without a built path emitted an endpoint');
		const named = (note) => x.vocab.reason_codes.some((c) => note.includes(c));
		const quiet = runOf(x, 'next-slot-no-method');
		const quietEps = endpointsOf(quiet);
		if (quietEps.length !== 1 || quietEps[0].path !== '/ok') p.push('next-slot-no-method: the sample does not give one endpoint, for /ok');
		if (quiet.scan.scanNotes.some(named)) p.push('next-slot-no-method: a note names a reason code for a file without a supported method');
		const held = runOf(x, 'next-base-path');
		if (!held.detection || controllersOf(held).length !== 0) p.push('next-base-path: the tree is not detected or gives a controller');
		if (!held.scan.scanNotes.some((n) => n.includes('app/api/route.ts'))) p.push('next-base-path: no note names the withheld file');
		if (held.scan.scanNotes.some(named)) p.push('next-base-path: a note names a reason code');
		for (const r of x.samples.runs.filter((q) => q.leaf !== 'typescript-nextjs')) {
			if (r.scan.scanNotes.some((n) => x.vocab.reason_codes.some((c) => n.includes(c)))) p.push(`${r.id}: a note names a reason code`);
		}
		const keys = new Set(x.samples.runs.flatMap((r) => endpointsOf(r).flatMap((e) => Object.keys(e))));
		for (const k of ['status', 'reason']) if (keys.has(k)) p.push(`an endpoint has the key ${k}`);
		return p;
	},
	'un-show-routes': (x) => {
		const p = [];
		const parse = x.mod['node-hono/show-routes-parser'].parseHonoShowRoutes;
		const schema = x.vocab.schemas.show_routes_snapshot;
		const want = {
			schema,
			routes: [
				{ method: 'GET', path: '/v1/posts', line: 1, handlers: [{ name: '[middleware]', line: 2 }, { name: 'namedHandler', line: 3 }] },
				{ method: 'POST', path: '/v1/posts', line: 6, handlers: [] }
			],
			unknownLines: [{ line: 4, text: 'router: RegExpRouter' }]
		};
		if (!same(parse(SHOW_SAMPLE), want)) p.push('the sample listing does not give the snapshot of the oracle');
		for (const [label, value] of [['an empty string', ''], ['null', null], ['no argument', undefined]]) {
			if (!same(parse(value), { schema, routes: [], unknownLines: [] })) p.push(`${label} does not give empty lists`);
		}
		return p;
	},
	'un-absent': (x) => {
		const p = [];
		for (const defect of ['silent-drop', 'undetected-router']) {
			if (!(x.record?.fixtures ?? []).some((f) => f.defect === defect)) p.push(`BASELINE.json holds no fixture with the defect ${defect}`);
			if (!(x.record?.limits ?? []).some((l) => l.id === defect)) p.push(`BASELINE.json holds no limit ${defect}`);
		}
		return p;
	},
	'pg-no-contracts-next': (x) => {
		const p = [];
		for (const [file, body] of [['profile-evidence.json', x.peText], ['t19-review-request.json', x.t19Text]]) {
			if (typeof body !== 'string' || body.length === 0) p.push(`${file} could not be read`);
			else if (/(?:contracts|schemas)[/\\-]next/i.test(body)) p.push(`${file} mentions contracts/next`);
		}
		const gates = x.vocab.promotion.gates.map((g) => g.gate).filter((g) => /contracts|schemas|\bnext\b/i.test(g));
		if (gates.length) p.push(`the vocabulary lists a gate for contracts/next: ${gates.join(', ')}`);
		return p;
	},
	'ow-non-leaf-dirs': (x) => {
		const p = [];
		const dirs = x.vocab.non_leaf_dirs;
		for (const d of dirs) {
			if (!fs.existsSync(path.join(x.root, BC, d))) p.push(`${d} is not a directory of the layer`);
			if (x.tree.some((f) => f.startsWith(`${d}/`) && path.posix.basename(f) === 'adapter.mjs')) p.push(`${d} holds a file named adapter.mjs`);
		}
		const scoped = (x.record?.targets ?? []).filter((t) => t.scope_record);
		if (scoped.length === 0) p.push('no target has a scope_record');
		for (const t of scoped) {
			if (!dirs.some((d) => t.scope_record.startsWith(`${BC}/${d}/`))) p.push(`${t.id}: scope_record ${t.scope_record} is outside these directories`);
			if (!fs.existsSync(path.join(x.root, t.scope_record))) p.push(`${t.id}: scope_record ${t.scope_record} does not exist`);
		}
		return p;
	}
};

// ---- negative cases: a doctored context must make the named check fail for the named reason -----------------------------
const patchAdapter = (x, id, patch) => ({ ...x, leaf: { ...x.leaf, [id]: { ...x.leaf[id], adapter: { ...x.leaf[id].adapter, ...patch } } } });
const patchModule = (x, key, patch) => ({ ...x, mod: { ...x.mod, [key]: { ...x.mod[key], ...patch } } });
const patchSource = (x, key, fn) => ({ ...x, source: { ...x.source, [key]: fn(x.source[key]) } });
const patchReport = (x, id, patch) => ({ ...x, reports: { ...x.reports, [id]: { ...x.reports[id], ...patch } } });
const patchClaim = (x, id, fn) => ({ ...x, vocab: { ...x.vocab, claims: Object.fromEntries(Object.entries(x.vocab.claims).map(([g, list]) => [g, list.map((c) => (c.id === id ? { ...c, text: fn(c.text) } : c))])) } });
const patchRuns = (x, fn) => {
	const runs = structuredClone(x.samples.runs);
	fn(Object.fromEntries(runs.map((r) => [r.id, r])));
	return { ...x, samples: { ...x.samples, runs } };
};
const patchRecord = (x, fn) => {
	const record = structuredClone(x.record);
	fn(record);
	return { ...x, record };
};
const first = (run) => controllersOf(run)[0];
const firstEp = (run) => endpointsOf(run)[0];
const PARSER = 'node-hono/show-routes-parser';

const NEG = [
	{ id: 'io-legacy', when: 'a descriptor carries another contract', make: (x) => patchAdapter(x, 'node-koa', { contract: 'sbf.adapter/3' }), expect: /node-koa: contract is sbf\.adapter\/3/ },
	{ id: 'io-legacy', when: 'a sampled scan has a foreign key', make: (x) => patchRuns(x, (r) => { r['hono-dup'].scan.contract_hash = 'x'; }), expect: /a sampled output holds contract_hash/ },
	{ id: 'io-legacy', when: 'a module names a foreign schema', make: (x) => patchSource(x, 'node-koa/adapter', (s) => `${s}\n// sbf.contract-ref/1\n`), expect: /the module node-koa\/adapter holds sbf\.contract-ref\/1/ },
	{ id: 'io-methods', when: 'listReadSet returns another list', make: (x) => patchAdapter(x, 'node-hono', { listReadSet: () => ['x'] }), expect: /listReadSet is not the filesRead of the scan/ },
	{ id: 'io-methods', when: 'scan returns another result', make: (x) => patchAdapter(x, 'node-koa', { scan: () => ({ modules: [], filesRead: [], scanNotes: ['n'] }) }), expect: /scan differs from the exported function/ },
	{ id: 'io-methods', when: 'scan ignores the detection it is given', make: (x) => patchAdapter(x, 'node-hono', { scan: (root) => x.leaf['node-hono'].scan(root, x.leaf['node-hono'].detect(root)) }), expect: /scan with a null detection differs from the exported function/ },
	{ id: 'io-methods', when: 'diagnostics returns no entry', make: (x) => patchAdapter(x, 'typescript-nextjs', { diagnostics: () => [] }), expect: /diagnostics does not return one info entry/ },
	{ id: 'io-methods', when: 'detect returns another detection', make: (x) => patchAdapter(x, 'node-koa', { detect: () => null }), expect: /detect differs from the exported function/ },
	{ id: 'io-input', when: 'detect returns a detection for a number', make: (x) => { const real = x.leaf['node-hono'].adapter; const found = real.detect(runOf(x, 'upstream-node-hono').root); return patchAdapter(x, 'node-hono', { detect: (root) => (root === 5 ? found : real.detect(root)), scan: (root, d) => (root === 5 ? { modules: [], filesRead: [], scanNotes: ['n'] } : real.scan(root, d)) }); }, expect: /node-hono root a number: detect is not null/ },
	{ id: 'io-input', when: 'listReadSet throws for an empty string', make: (x) => patchAdapter(x, 'node-koa', { listReadSet: (root, d) => { if (root === '') throw new Error('boom'); return x.leaf['node-koa'].adapter.listReadSet(root, d); } }), expect: /node-koa root an empty string: throws Error/ },
	{ id: 'io-input', when: 'scan accepts an empty object as a detection', make: (x) => patchAdapter(x, 'typescript-nextjs', { scan: (root, d) => (d && typeof d === 'object' && Object.keys(d).length === 0 ? { modules: [], filesRead: [], scanNotes: ['x'] } : x.leaf['typescript-nextjs'].adapter.scan(root, d)) }), expect: /typescript-nextjs detection an empty object: scan does not throw TypeError/ },
	{ id: 'io-input', when: 'the claim lists other roots than the vocabulary', make: (x) => patchClaim(x, 'io-input', (s) => s.replace('an array or', 'a list or')), expect: /the claim does not list the roots as the vocabulary does/ },
	{ id: 'io-run-scan', when: 'files_read differs', make: (x) => patchReport(x, 'upstream-node-hono', { files_read: ['x'] }), expect: /files_read differs from filesRead/ },
	{ id: 'io-run-scan', when: 'the unknowns lose their last note', make: (x) => patchReport(x, 'next-reasons', { unknowns: x.reports['next-reasons'].unknowns.slice(0, -1) }), expect: /next-reasons: unknowns hold/ },
	{ id: 'io-run-scan', when: 'the report names another schema', make: (x) => patchReport(x, 'upstream-node-hono', { schema: 'sbf.scan-report/3' }), expect: /schema is sbf\.scan-report\/3/ },
	{ id: 'io-registry', when: 'a leaf id is listed', make: (x) => ({ ...x, registered: [...x.registered, { id: 'node-koa' }] }), expect: /node-koa is an id in the ADAPTERS list/ },
	{ id: 'io-registry', when: 'a registry file names the layer', make: (x) => ({ ...x, registryText: { ...x.registryText, 'scanners/registry.mjs': `${x.registryText['scanners/registry.mjs']}\nimport 'x/node-hono/y.mjs';` } }), expect: /scanners\/registry\.mjs names a path of this layer/ },
	{ id: 'io-registry', when: 'the list is empty', make: (x) => ({ ...x, registered: [] }), expect: /the ADAPTERS list is missing or empty/ },
	{ id: 'io-catalog', when: 'the list is not frozen', make: (x) => patchModule(x, 'catalog', { HTTP_WAVE_BC_TARGETS: [...x.mod.catalog.HTTP_WAVE_BC_TARGETS] }), expect: /is not a frozen array/ },
	{ id: 'io-catalog', when: 'the validator no longer throws for null', make: (x) => patchModule(x, 'catalog', { validateWaveBcCatalog: () => [] }), expect: /validateWaveBcCatalog\(\[null\]\) does not throw TypeError/ },
	{ id: 'io-catalog', when: 'the validator rejects the catalog', make: (x) => patchModule(x, 'catalog', { validateWaveBcCatalog: (list) => { if (list.length === 1 && list[0] === null) throw new TypeError('x'); return ['e']; } }), expect: /does not return an empty list/ },
	{ id: 'io-catalog', when: 'the fixture is missing', make: (x) => patchRecord(x, (r) => { r.fixtures = r.fixtures.filter((f) => f.id !== 'catalog-throws-on-a-null-entry'); }), expect: /has no fixture catalog-throws-on-a-null-entry/ },
	{ id: 'id-operation', when: 'an endpoint has an operationId', make: (x) => patchRuns(x, (r) => { firstEp(r['hono-dup']).operationId = 'x'; }), expect: /operationId of .* is not null/ },
	{ id: 'id-operation', when: 'a controller has operationIds', make: (x) => patchRuns(x, (r) => { first(r['koa-dup']).operationIds = ['y']; }), expect: /operationIds of .* is not an empty list/ },
	{ id: 'id-operation', when: 'method is not the handler name', make: (x) => patchRuns(x, (r) => { firstEp(r['hono-dup']).method = 'zzz'; }), expect: /hono-dup: method is not the handler name/ },
	{ id: 'id-operation', when: 'verb is not an HTTP method', make: (x) => patchRuns(x, (r) => { firstEp(r['koa-dup']).verb = 'FETCH'; }), expect: /verb FETCH is no HTTP method/ },
	{ id: 'id-class-name', when: 'className has no known form', make: (x) => patchRuns(x, (r) => { first(r['hono-dup']).className = 'Hono(x)'; }), expect: /className Hono\(x\) does not have the form of node-hono/ },
	{ id: 'id-class-name', when: 'className names another file', make: (x) => patchRuns(x, (r) => { first(r['hono-dup']).className = 'Hono(src/zzz.ts:app)'; }), expect: /names src\/zzz\.ts, the file gives src\/index\.ts/ },
	{ id: 'id-class-name', when: 'the Koa twins differ', make: (x) => patchRuns(x, (r) => { controllersOf(r['koa-twin'])[1].className = 'KoaRouter(other.js:router)'; }), expect: /koa-twin: two router files of one basename do not give two equal classNames/ },
	{ id: 'id-class-name', when: 'the Hono twins are equal', make: (x) => patchRuns(x, (r) => { const cs = controllersOf(r['hono-twin']); cs[1].className = cs[0].className; }), expect: /hono-twin: classNames are not pairwise different/ },
	{ id: 'id-duplicate', when: 'a duplicate registration is merged', make: (x) => patchRuns(x, (r) => { for (const c of controllersOf(r['hono-dup'])) c.endpoints = c.endpoints.filter((e, i) => i !== 1); }), expect: /hono-dup: 1 endpoints for GET \/a, expected 2/ },
	{ id: 'id-duplicate', when: 'same-line registrations differ in line', make: (x) => patchRuns(x, (r) => { endpointsOf(r['koa-same-line'])[1].line += 1; }), expect: /koa-same-line: the two endpoints differ in more than method/ },
	{ id: 'id-duplicate', when: 'same-line registrations share a method', make: (x) => patchRuns(x, (r) => { const [a, b] = endpointsOf(r['hono-same-line']); b.method = a.method; }), expect: /hono-same-line: method does not differ/ },
	{ id: 'id-duplicate', when: 'no note names the duplicate files', make: (x) => patchRuns(x, (r) => { const s = r['next-dup'].scan; s.scanNotes = s.scanNotes.filter((n) => !n.includes('duplicate')); }), expect: /next-dup: no scan note names both files/ },
	{ id: 'id-duplicate', when: 'a note names the files of disjoint methods', make: (x) => patchRuns(x, (r) => { r['next-disjoint'].scan.scanNotes.push('Next.js duplicate Route Handler identity GET /api is produced by: app/api/route.js, app/api/route.ts; this conflict is preserved instead of choosing a winner.'); }), expect: /next-disjoint: a scan note names one of the files/ },
	{ id: 'id-duplicate', when: 'the files of disjoint methods give one controller', make: (x) => patchRuns(x, (r) => { const m = r['next-disjoint'].scan.modules[0]; m.controllers = m.controllers.slice(0, 1); }), expect: /next-disjoint: 1 controllers for \/api, expected 2/ },
	{ id: 'id-line', when: 'a line is off by one', make: (x) => patchRuns(x, (r) => { firstEp(r['hono-dup']).line += 1; }), expect: /hono-dup: line of .* is \d+, the source has it at \d+/ },
	{ id: 'id-line', when: 'the shifted scan keeps its line', make: (x) => patchRuns(x, (r) => { firstEp(r['koa-dup-shift']).line = firstEp(r['koa-dup']).line; }), expect: /koa-dup and koa-dup-shift: line moved by 0, expected 1/ },
	{ id: 'id-line', when: 'className changes with the shift', make: (x) => patchRuns(x, (r) => { first(r['next-one-shift']).className = 'NextRoute(x)'; }), expect: /next-one and next-one-shift: className changed/ },
	{ id: 'id-location', when: 'file is relative', make: (x) => patchRuns(x, (r) => { first(r['hono-nested']).file = 'src/index.ts'; }), expect: /is not an existing absolute path/ },
	{ id: 'id-location', when: 'a filesRead entry is absolute', make: (x) => patchRuns(x, (r) => { const s = r['hono-nested'].scan; s.filesRead[0] = path.join(r['hono-nested'].root, s.filesRead[0]); }), expect: /filesRead entry .* is not an existing path below the scan root/ },
	{ id: 'id-location', when: 'className is relative to the scan root', make: (x) => patchRuns(x, (r) => { first(r['hono-nested']).className = 'Hono(apps/api/src/index.ts:app)'; }), expect: /is not relative to the project root/ },
	{ id: 'id-location', when: 'file is absolute for a relative scan root', make: (x) => patchAdapter(x, 'node-koa', { scan: (root, d) => { const s = x.leaf['node-koa'].adapter.scan(root, d); for (const m of s.modules) for (const c of m.controllers) c.file = path.resolve(c.file); return s; } }), expect: /koa-dup: with a relative scan root file is .*, expected a relative path/ },
	{ id: 'id-location', when: 'className changes with a relative scan root', make: (x) => patchAdapter(x, 'node-hono', { scan: (root, d) => { const s = x.leaf['node-hono'].adapter.scan(root, d); if (!path.isAbsolute(root)) for (const m of s.modules) for (const c of m.controllers) c.className = `Hono(${root}:app)`; return s; } }), expect: /hono-dup: className depends on the form of the scan root/ },
	{ id: 'id-location', when: 'filesRead changes with a relative scan root', make: (x) => patchAdapter(x, 'typescript-nextjs', { scan: (root, d) => { const s = x.leaf['typescript-nextjs'].adapter.scan(root, d); if (!path.isAbsolute(root)) s.filesRead = s.filesRead.map((f) => path.join(root, f)); return s; } }), expect: /next-one: filesRead depends on the form of the scan root/ },
	{ id: 'id-location', when: 'a relative scan root is not detected', make: (x) => patchAdapter(x, 'node-hono', { detect: (root) => (path.isAbsolute(root) ? x.leaf['node-hono'].adapter.detect(root) : null) }), expect: /hono-dup: a relative scan root gives 0 controllers, expected 1/ },
	{ id: 'id-no-digest', when: 'an endpoint gets a digest key', make: (x) => patchRuns(x, (r) => { firstEp(r['hono-dup']).routeDigest = 'abc'; }), expect: /the key routeDigest has hash, digest or sha as a word/ },
	{ id: 'id-no-digest', when: 'same-line values differ', make: (x) => patchRuns(x, (r) => { endpointsOf(r['koa-same-line'])[1].line += 1; }), expect: /koa-same-line: the two registrations on one line do not carry equal values/ },
	{ id: 'id-no-digest', when: 'the values do not move with an inserted line', make: (x) => patchRuns(x, (r) => { endpointsOf(r['hono-dup-shift']).forEach((e, i) => { e.line = endpointsOf(r['hono-dup'])[i].line; }); }), expect: /hono-dup and hono-dup-shift: the values do not change when a line is inserted/ },
	{ id: 'id-no-digest', when: 'a controller has no className', make: (x) => patchRuns(x, (r) => { delete first(r['koa-dup']).className; }), expect: /koa-dup: a controller has no className/ },
	{ id: 'un-empty-lists', when: 'a module has entities', make: (x) => patchRuns(x, (r) => { r['hono-dup'].scan.modules[0].entities = ['e']; }), expect: /hono-dup: entities is not an empty list/ },
	{ id: 'un-empty-lists', when: 'the source literal is reordered', make: (x) => patchSource(x, 'node-koa/adapter', (s) => s.replaceAll('entities: [], enums: [], dtos: []', 'enums: [], entities: [], dtos: []')), expect: /node-koa\/adapter: no literal entities: \[\], enums: \[\], dtos: \[\]/ },
	{ id: 'un-empty-lists', when: 'the sample holds no module', make: (x) => patchRuns(x, (r) => { for (const run of Object.values(r)) run.scan.modules = []; }), expect: /only 0 modules were sampled/ },
	{ id: 'un-not-detected', when: 'a rejected tree is detected', make: (x) => patchAdapter(x, 'node-hono', { detect: () => ({ projectRoot: '/x', packageFile: '/x/package.json' }), scan: () => ({ modules: [{ module: 'm', controllers: [] }], filesRead: ['a'], scanNotes: [], apiSurfaceSource: null }) }), expect: /node-hono: the rejected tree is detected/ },
	{ id: 'un-not-detected', when: 'the not-detected result holds two notes', make: (x) => patchAdapter(x, 'typescript-nextjs', { scan: (root, d) => (d === null ? { modules: [], filesRead: [], scanNotes: ['a', 'b'] } : x.leaf['typescript-nextjs'].scan(root, d)) }), expect: /typescript-nextjs: the rejected tree does not give the not-detected result/ },
	{ id: 'un-not-detected', when: 'a tree without routes has a module', make: (x) => patchRuns(x, (r) => { r['hono-empty'].scan.modules = [{ module: 'm', controllers: [] }]; }), expect: /hono-empty: a detected tree without routes does not give empty modules/ },
	{ id: 'un-not-detected', when: 'a tree without routes reads no file', make: (x) => patchRuns(x, (r) => { r['koa-empty'].scan.filesRead = []; }), expect: /koa-empty: a detected tree without routes/ },
	{ id: 'un-not-detected', when: 'a tree without routes is not detected', make: (x) => patchRuns(x, (r) => { r['next-no-method'].detection = null; }), expect: /next-no-method: not detected/ },
	{ id: 'un-reason-codes', when: 'a note with a reason is missing', make: (x) => patchRuns(x, (r) => { const s = r['next-reasons'].scan; s.scanNotes = s.scanNotes.filter((n) => !n.includes('private-folder')); }), expect: /next-reasons: 4 notes with a reason, expected 5/ },
	{ id: 'un-reason-codes', when: 'a reason code is renamed in the notes', make: (x) => patchRuns(x, (r) => { const s = r['next-reasons'].scan; s.scanNotes = s.scanNotes.map((n) => n.replace('private-folder', 'hidden-folder')); }), expect: /next-reasons: the reason codes of the notes differ from the vocabulary/ },
	{ id: 'un-reason-codes', when: 'a note names a file that is not in the tree', make: (x) => patchRuns(x, (r) => { const s = r['next-reasons'].scan; s.scanNotes = s.scanNotes.map((n) => n.replace('app/_private/route.ts', 'app/_gone/route.ts')); }), expect: /a note names app\/_gone\/route\.ts, which is no file of the tree/ },
	{ id: 'un-reason-codes', when: 'a Hono note names a reason code', make: (x) => patchRuns(x, (r) => { r['hono-dup'].scan.scanNotes.push('uses parallel-route-segment'); }), expect: /hono-dup: a note names a reason code/ },
	{ id: 'un-reason-codes', when: 'an endpoint carries a status', make: (x) => patchRuns(x, (r) => { firstEp(r['koa-dup']).status = 'withheld'; }), expect: /an endpoint has the key status/ },
	{ id: 'un-reason-codes', when: 'a second endpoint is emitted', make: (x) => patchRuns(x, (r) => { const c = first(r['next-reasons']); c.endpoints.push({ ...c.endpoints[0], path: '/extra' }); }), expect: /next-reasons: a file without a built path emitted an endpoint/ },
	{ id: 'un-reason-codes', when: 'a file without a supported method gets a reason note', make: (x) => patchRuns(x, (r) => { r['next-slot-no-method'].scan.scanNotes.push('Next.js Route Handler at app/@slot/route.ts uses parallel-route-segment; no endpoint path was emitted.'); }), expect: /next-slot-no-method: a note names a reason code for a file without a supported method/ },
	{ id: 'un-reason-codes', when: 'a file without a supported method emits an endpoint', make: (x) => patchRuns(x, (r) => { const c = first(r['next-slot-no-method']); c.endpoints.push({ ...c.endpoints[0], path: '/slot' }); }), expect: /next-slot-no-method: the sample does not give one endpoint, for \/ok/ },
	{ id: 'un-reason-codes', when: 'the base-path note gets a reason code', make: (x) => patchRuns(x, (r) => { const s = r['next-base-path'].scan; s.scanNotes = s.scanNotes.map((n) => (n.includes('app/api/route.ts') ? `${n} (parallel-route-segment)` : n)); }), expect: /next-base-path: a note names a reason code/ },
	{ id: 'un-reason-codes', when: 'the base-path note does not name the file', make: (x) => patchRuns(x, (r) => { const s = r['next-base-path'].scan; s.scanNotes = s.scanNotes.map((n) => n.replaceAll('app/api/route.ts', 'a file')); }), expect: /next-base-path: no note names the withheld file/ },
	{ id: 'un-reason-codes', when: 'the base-path tree gives a controller', make: (x) => patchRuns(x, (r) => { r['next-base-path'].scan.modules = [{ module: 'm', controllers: [{ className: 'x', endpoints: [] }] }]; }), expect: /next-base-path: the tree is not detected or gives a controller/ },
	{ id: 'un-show-routes', when: 'the parser drops the unknown lines', make: (x) => patchModule(x, PARSER, { parseHonoShowRoutes: (text) => ({ ...x.mod[PARSER].parseHonoShowRoutes(text), unknownLines: [] }) }), expect: /the sample listing does not give the snapshot of the oracle/ },
	{ id: 'un-show-routes', when: 'the parser names another schema', make: (x) => patchModule(x, PARSER, { parseHonoShowRoutes: (text) => ({ ...x.mod[PARSER].parseHonoShowRoutes(text), schema: 'bskel.hono-show-routes-snapshot/2' }) }), expect: /an empty string does not give empty lists/ },
	{ id: 'un-show-routes', when: 'null input gives a route', make: (x) => patchModule(x, PARSER, { parseHonoShowRoutes: (text) => (text === null ? { schema: x.vocab.schemas.show_routes_snapshot, routes: [{ method: 'GET', path: '/', line: 1, handlers: [] }], unknownLines: [] } : x.mod[PARSER].parseHonoShowRoutes(text)) }), expect: /null does not give empty lists/ },
	{ id: 'un-absent', when: 'no fixture has the silent-drop defect', make: (x) => patchRecord(x, (r) => { r.fixtures = r.fixtures.filter((f) => f.defect !== 'silent-drop'); }), expect: /holds no fixture with the defect silent-drop/ },
	{ id: 'un-absent', when: 'no fixture has the undetected-router defect', make: (x) => patchRecord(x, (r) => { r.fixtures = r.fixtures.filter((f) => f.defect !== 'undetected-router'); }), expect: /holds no fixture with the defect undetected-router/ },
	{ id: 'un-absent', when: 'the undetected-router limit is missing', make: (x) => patchRecord(x, (r) => { r.limits = r.limits.filter((l) => l.id !== 'undetected-router'); }), expect: /holds no limit undetected-router/ },
	{ id: 'pg-no-contracts-next', when: 'the evidence file names contracts/next', make: (x) => ({ ...x, peText: `${x.peText}\n"contracts/next"` }), expect: /profile-evidence\.json mentions contracts\/next/ },
	{ id: 'pg-no-contracts-next', when: 'the review request names schemas/next', make: (x) => ({ ...x, t19Text: `${x.t19Text}\n"schemas/next"` }), expect: /t19-review-request\.json mentions contracts\/next/ },
	{ id: 'pg-no-contracts-next', when: 'a gate names contracts/next', make: (x) => ({ ...x, vocab: { ...x.vocab, promotion: { ...x.vocab.promotion, gates: [...x.vocab.promotion.gates, { gate: 'contracts/next output', owner: 'T01', markers: {} }] } } }), expect: /the vocabulary lists a gate for contracts\/next: contracts\/next output/ },
	{ id: 'pg-no-contracts-next', when: 'the review request text is empty', make: (x) => ({ ...x, t19Text: '' }), expect: /t19-review-request\.json could not be read/ },
	{ id: 'ow-non-leaf-dirs', when: 'a leaf file sits in a non-leaf directory', make: (x) => ({ ...x, tree: [...x.tree, 'python-litestar/adapter.mjs'] }), expect: /python-litestar holds a file named adapter\.mjs/ },
	{ id: 'ow-non-leaf-dirs', when: 'a listed directory is missing', make: (x) => ({ ...x, vocab: { ...x.vocab, non_leaf_dirs: [...x.vocab.non_leaf_dirs, 'no-such-dir'] } }), expect: /no-such-dir is not a directory of the layer/ },
	{ id: 'ow-non-leaf-dirs', when: 'a scope record lies outside the directories', make: (x) => patchRecord(x, (r) => { r.targets.find((t) => t.scope_record).scope_record = `${BC}/node-hono/SCOPE.json`; }), expect: /scope_record .* is outside these directories/ },
	{ id: 'ow-non-leaf-dirs', when: 'a scope record file is gone', make: (x) => patchRecord(x, (r) => { const t = r.targets.find((q) => q.scope_record); t.scope_record = `${t.scope_record}.gone`; }), expect: /scope_record .* does not exist/ },
	{ id: 'ow-non-leaf-dirs', when: 'no target has a scope record', make: (x) => patchRecord(x, (r) => { for (const t of r.targets) t.scope_record = null; }), expect: /no target has a scope_record/ }
];

// ---- tests ---------------------------------------------------------------------------------------------------------------
test('the RFC, the vocabulary, the record and the modules of the layer load', () => {
	ready(LOADED);
	assert.equal(Object.keys(LOADED.leaf).length, 3);
	assert.ok(LOADED.text.length > 0);
});

test('INTERFACE_RFC.md agrees with the vocabulary and the code on title, headings, tables, key lists, spans and size', () => {
	assert.deepEqual(rfcProblems(ready(LOADED)), []);
});

for (const id of Object.keys(CHECKS)) {
	test(`claim ${id} holds for the sampled scans`, () => {
		assert.deepEqual(CHECKS[id](ready(LOADED)), []);
	});
}

test('every claim id has at least two negative cases and every negative case names a claim id', () => {
	const counts = new Map(Object.keys(CHECKS).map((id) => [id, 0]));
	for (const n of NEG) {
		assert.ok(counts.has(n.id), `${n.id} is no claim id`);
		counts.set(n.id, counts.get(n.id) + 1);
	}
	for (const [id, count] of counts) assert.ok(count >= 2, `${id} has ${count} negative cases`);
	assert.equal(new Set(NEG.map((n) => `${n.id} ${n.when}`)).size, NEG.length, 'a negative case is listed twice');
});

for (const n of NEG) {
	test(`check ${n.id} fails when ${n.when}`, () => {
		const x = ready(LOADED);
		assert.deepEqual(CHECKS[n.id](x), [], 'the unchanged context passes the check');
		const problems = CHECKS[n.id](n.make(x));
		assert.ok(problems.some((p) => n.expect.test(p)), `no problem matches ${n.expect}; got ${JSON.stringify(problems).slice(0, 500)}`);
	});
}

// ---- change and fail: which edits of INTERFACE_RFC.md (and of its vocabulary) does the document check catch ---------------------
// Every row changes one part of the text, or of one vocabulary claim. A replace and an append of the same part are separate rows.
// An edit that no check reads is listed as surviving; the outcomes are pinned, so a new check or a lost check shows up here.
const swapIn = (from, to) => (text) => {
	assert.ok(text.includes(from), `the text does not contain ${JSON.stringify(from)}`);
	return text.replace(from, () => to);
};
const append = (extra) => (text) => `${text.trimEnd()}\n${extra}\n`;
const onText = (fn) => (x) => ({ ...x, text: fn(x.text) });
const onClaim = (id, fn) => (x) => patchClaim(x, id, fn);
const PLAIN = 'A plain sentence that no check reads.';
const swapRows = (a, b) => (text) => {
	const rows = text.split('\n');
	const i = rows.findIndex((l) => l.startsWith(a));
	const j = rows.findIndex((l) => l.startsWith(b));
	assert.ok(i >= 0 && j >= 0, 'rows to swap not found');
	[rows[i], rows[j]] = [rows[j], rows[i]];
	return rows.join('\n');
};
const joint = (id, from, to) => (x) => {
	const edit = swapIn(from, to);
	return { ...x, text: edit(x.text), vocab: patchClaim(x, id, edit).vocab };
};
const toCap = (x) => {
	const have = x.text.trimEnd().split('\n').length;
	return { ...x, text: append(Array.from({ length: LINE_CAP + 1 - have }, () => PLAIN).join('\n'))(x.text) };
};

const CHANGES = [
	{ name: 'title', kind: 'replace', apply: onText(swapIn(TITLE, '# T13 interface RFC (draft)')), outcome: 'caught', expect: /title: the first line is/ },
	{ name: 'title', kind: 'append', apply: onText(swapIn(TITLE, `${TITLE} (draft)`)), outcome: 'caught', expect: /title: the first line is/ },
	{ name: 'heading', kind: 'replace', apply: onText(swapIn('## 3. Inputs and outputs', '## 3. Inputs and outputs of the layer')), outcome: 'caught', expect: /headings: found/ },
	{ name: 'heading', kind: 'append', apply: onText(append('## 8. Extra')), outcome: 'caught', expect: /headings: found/ },
	{ name: 'catalog table cell', kind: 'replace', apply: onText(swapIn('| 16 | 9 | 7 | 3 | 13 |', '| 16 | 9 | 7 | 4 | 12 |')), outcome: 'caught', expect: /\(catalog\) row 1 column 4/ },
	{ name: 'catalog table cell', kind: 'append', apply: onText(swapIn('| 16 | 9 | 7 | 3 | 13 |', '| 16 | 9 | 7 | 3 | 13 (approx) |')), outcome: 'caught', expect: /\(catalog\) row 1 column 5/ },
	{ name: 'catalog table row', kind: 'append', apply: onText(swapIn('| 16 | 9 | 7 | 3 | 13 |\n', '| 16 | 9 | 7 | 3 | 13 |\n| 17 | 9 | 7 | 3 | 14 |\n')), outcome: 'caught', expect: /\(catalog\): 2 rows, expected 1/ },
	{ name: 'adapter table rows', kind: 'replace', apply: onText(swapRows('| `node-hono` | 55', '| `node-koa` | 54')), outcome: 'caught', expect: /\(adapters\) row 1 column 1/ },
	{ name: 'specificity cell', kind: 'replace', apply: onText(swapIn('| `node-hono` | 55 |', '| `node-hono` | 65 |')), outcome: 'caught', expect: /\(adapters\) row 1 column 2/ },
	{ name: 'module input cell', kind: 'replace', apply: onText(swapIn('optional array of targets', 'optional list of targets')), outcome: 'caught', expect: /\(modules\) row 1 column 4/ },
	{ name: 'claim cell', kind: 'replace', apply: onText(swapIn('no sampled output and no module of section 3', 'a sampled output or a module of section 3')), outcome: 'caught', expect: /\(io claims\) row 1 column 2/ },
	{ name: 'claim cell', kind: 'append', apply: onText(swapIn('returns one info entry. |', 'returns one info entry. Added words. |')), outcome: 'caught', expect: /\(io claims\) row 2 column 2/ },
	{ name: 'claim id', kind: 'replace', apply: onText(swapIn('| `io-legacy` |', '| `io-legacies` |')), outcome: 'caught', expect: /\(io claims\) row 1 column 1/ },
	{ name: 'claim text in the vocabulary only', kind: 'replace', apply: onClaim('id-line', swapIn('moves `line` by one', 'moves `line` by two')), outcome: 'caught', expect: /\(identity claims\) row 4 column 2/ },
	{ name: 'claim text in the vocabulary only', kind: 'append', apply: onClaim('id-line', (s) => `${s} Added words.`), outcome: 'caught', expect: /\(identity claims\) row 4 column 2/ },
	{ name: 'gate owner', kind: 'replace', apply: onText(swapIn('| independent profile review | T19 |', '| independent profile review | T20 |')), outcome: 'caught', expect: /\(gates\) row 1 column 2/ },
	{ name: 'state value', kind: 'replace', apply: onText(swapIn('`REQUESTED_NOT_ACCEPTED`', '`ACCEPTED`')), outcome: 'caught', expect: /\(state\) row 3 column 3/ },
	{ name: 'consumer token', kind: 'replace', apply: onText(swapIn('| reserved | `test/http-wave-bc` |', '| reserved | `test/http-wave-a` |')), outcome: 'caught', expect: /\(consumers\) row 4 column 3/ },
	{ name: 'key list key', kind: 'replace', apply: onText(swapIn('{contract, id, title, specificity', '{contract, id, name, specificity')), outcome: 'caught', expect: /line "Keys in emitted order, as label \{keys\}:"/ },
	{ name: 'key list key', kind: 'append', apply: onText(swapIn('entities, enums, dtos}', 'entities, enums, dtos, extra}')), outcome: 'caught', expect: /line "Keys in emitted order, as label \{keys\}:"/ },
	{ name: 'key list order', kind: 'replace', apply: onText(swapIn('entities, enums, dtos}', 'enums, entities, dtos}')), outcome: 'caught', expect: /line "Keys in emitted order, as label \{keys\}:"/ },
	{ name: 'key list key', kind: 'remove', apply: onText(swapIn('scanNotes, apiSurfaceSource}', 'scanNotes}')), outcome: 'caught', expect: /line "Keys in emitted order, as label \{keys\}:"/ },
	{ name: 'schema name', kind: 'replace', apply: onText(swapIn('`sbf.scan-report/2` (report', '`sbf.scan-report/3` (report')), outcome: 'caught', expect: /line "Schemas in use:"/ },
	{ name: 'schemas line', kind: 'append', apply: onText(swapIn('(snapshot). Foreign', '(snapshot), new. Foreign')), outcome: 'caught', expect: /line "Schemas in use:"/ },
	{ name: 'reason code', kind: 'replace', apply: onText(swapIn('`private-folder`', '`hidden-folder`')), outcome: 'caught', expect: /line "Reason codes in Next notes:"/ },
	{ name: 'cited record file', kind: 'replace', apply: onText(swapIn('`BASELINE.json` (pins', '`BASELINES.json` (pins')), outcome: 'caught', expect: /span `BASELINES\.json`: no such path/ },
	{ name: 'cited test file', kind: 'replace', apply: onText(swapIn('`interface-rfc.test.mjs` compares', '`interface-rfc.tests.mjs` compares')), outcome: 'caught', expect: /span `interface-rfc\.tests\.mjs`: no such path/ },
	{ name: 'non-goal limit id (unknown id)', kind: 'replace', apply: onText(swapIn('`legacy-contract`', '`legacy-contracts`')), outcome: 'caught', expect: /line "Non-goals:": limit ids are/ },
	{ name: 'non-goal limit id (another listed id)', kind: 'replace', apply: onText(swapIn('`legacy-contract`', '`no-runtime`')), outcome: 'caught', expect: /line "Non-goals:": limit ids are/ },
	{ name: 'identifier span', kind: 'append', apply: onText(append('See `madeUpName`.')), outcome: 'caught', expect: /span `madeUpName`: not an identifier/ },
	{ name: 'universal word', kind: 'append', apply: onText(append('This holds for all adapters.')), outcome: 'caught', expect: /universal words outside code spans: all/ },
	{ name: 'universal word', kind: 'replace', apply: onText(swapIn('It changes no behaviour;', 'It changes nothing;')), outcome: 'caught', expect: /universal words outside code spans: nothing/ },
	{ name: 'number reference', kind: 'append', apply: onText(append(`See issue #${12}.`)), outcome: 'caught', expect: /number reference: "#\d"/ },
	{ name: 'line count over the cap', kind: 'append', apply: toCap, outcome: 'caught', expect: /line cap: 121 lines, the cap is 120/ },
	{ name: 'final newline', kind: 'append', apply: onText((t) => `${t}\n`), outcome: 'caught', expect: /ending: the file must end with one newline/ },
	{ name: 'header sentence', kind: 'replace', apply: onText(swapIn('Other sentences are not compared.', 'Other sentences are compared by hand.')), outcome: 'survives' },
	{ name: 'purpose sentence', kind: 'replace', apply: onText(swapIn('It changes no behaviour;', 'It may change behaviour;')), outcome: 'survives' },
	{ name: 'purpose sentence', kind: 'append', apply: onText(swapIn('is not covered by it.', 'is not covered by it. Added sentence.')), outcome: 'survives' },
	{ name: 'non-goals prose', kind: 'replace', apply: onText(swapIn('registration in the production registry', 'registration somewhere')), outcome: 'survives' },
	{ name: 'non-goals sentence about T13-03 to T13-06', kind: 'remove', apply: onText(swapIn(' The items T13-03 to T13-06 and the per-target items are not claimed here.', '')), outcome: 'survives' },
	{ name: 'section 7 lead sentence', kind: 'replace', apply: onText(swapIn('T13 edits the paths of its own row.', 'T13 edits the paths of its first row.')), outcome: 'survives' },
	{ name: 'consumers lead line', kind: 'replace', apply: onText(swapIn('Consumers (a sample, not a list):', 'Consumers (the list):')), outcome: 'survives' },
	{ name: 'plain line', kind: 'append', apply: onText(append(PLAIN)), outcome: 'survives' },
	{ name: 'claim row and vocabulary row together', kind: 'replace', apply: joint('id-no-digest', 'and not a stable identifier', 'and a stable identifier'), outcome: 'survives' }
];

for (const c of CHANGES) {
	test(`change and fail: ${c.name} ${c.kind} is ${c.outcome}`, () => {
		const x = ready(LOADED);
		const changed = c.apply(x);
		assert.ok(changed.text !== x.text || JSON.stringify(changed.vocab) !== JSON.stringify(x.vocab), 'the change changes nothing');
		const problems = rfcProblems(changed);
		if (c.outcome === 'caught') assert.ok(problems.some((p) => c.expect.test(p)), `no problem matches ${c.expect}; got ${JSON.stringify(problems).slice(0, 500)}`);
		else assert.deepEqual(problems, [], 'a surviving change is now caught: move the row to caught');
	});
}

test('the sampled scans are the three upstream-example directories and the trees that this test writes', () => {
	const x = ready(LOADED);
	const upstream = x.samples.runs.filter((r) => r.id.startsWith('upstream-'));
	assert.deepEqual(upstream.map((r) => r.leaf).sort(), Object.keys(UPSTREAM).sort());
	for (const r of upstream) assert.equal(r.root, path.join(x.root, 'test/http-wave-bc/fixtures', UPSTREAM[r.leaf]));
	const written = x.samples.runs.filter((r) => !r.id.startsWith('upstream-'));
	assert.equal(written.length, Object.keys(TREES).length + 1);
	for (const r of written) assert.ok(r.root.startsWith(x.samples.base), `${r.id} is not below the scratch folder`);
	assert.deepEqual(x.samples.runs.filter((r) => r.detection === null).map((r) => r.id), ['next-page-only'], 'only a Next tree with a page and no route handler is not detected');
});

test('the line cap admits 120 lines and refuses 121', () => {
	const x = ready(LOADED);
	const have = x.text.trimEnd().split('\n').length;
	assert.ok(have <= LINE_CAP, `INTERFACE_RFC.md has ${have} lines`);
	const padded = (n) => `${x.text.trimEnd()}${`\n${PLAIN}`.repeat(n - have)}\n`;
	assert.deepEqual(textProblems(padded(LINE_CAP)), []);
	assert.match(textProblems(padded(LINE_CAP + 1)).join('\n'), /line cap: 121 lines, the cap is 120/);
});

test('loading does not throw when the files are missing, when the vocabulary is not JSON or when the modules are gone', async () => {
	const empty = await load(tmpDir('bskel-t13-rfc-empty-'));
	assert.ok(empty.errors.length >= 1);
	assert.equal(empty.text, undefined);
	assert.throws(() => ready(empty), /could not be loaded/);
	const broken = tmpDir('bskel-t13-rfc-broken-');
	fs.mkdirSync(path.dirname(path.join(broken, VOCAB_FILE)), { recursive: true });
	fs.mkdirSync(path.dirname(path.join(broken, RFC_FILE)), { recursive: true });
	fs.writeFileSync(path.join(broken, RFC_FILE), 'x\n');
	fs.writeFileSync(path.join(broken, VOCAB_FILE), '{');
	const bad = await load(broken);
	assert.ok(bad.errors.some((e) => e.startsWith(VOCAB_FILE)), JSON.stringify(bad.errors));
	assert.equal(bad.vocab, undefined);
	const partial = tmpDir('bskel-t13-rfc-partial-');
	for (const file of [RFC_FILE, VOCAB_FILE]) {
		fs.mkdirSync(path.dirname(path.join(partial, file)), { recursive: true });
		fs.copyFileSync(path.join(REPO_ROOT, file), path.join(partial, file));
	}
	const gone = await load(partial);
	assert.ok(gone.errors.some((e) => e.includes('node-koa/adapter.mjs')), JSON.stringify(gone.errors));
	assert.throws(() => ready(gone), /could not be loaded/);
});

test('the stale statements are gone and no text of this change refers to a pull request or an issue by number', () => {
	const x = ready(LOADED);
	assert.ok(x.pe && x.t19, 'the promotion files could not be parsed');
	for (const key of ['pr', 'branch']) assert.ok(!(key in x.pe), `profile-evidence.json has the key ${key}`);
	assert.ok(!('source_pr' in x.t19), 't19-review-request.json has the key source_pr');
	const readme = fs.readFileSync(path.join(x.root, BC, 'README.md'), 'utf8');
	const texts = { 'profile-evidence.json': x.peText, 't19-review-request.json': x.t19Text, 'README.md': readme, 'INTERFACE_RFC.md': x.text, [VOCAB_FILE]: JSON.stringify(x.vocab) };
	for (const [name, body] of Object.entries(texts)) assert.ok(!BY_NUMBER.test(body), `${name} refers to a pull request or an issue by number`);
	for (const name of ['profile-evidence.json', 't19-review-request.json']) {
		assert.ok(!/aggregation shim|out-of-lease|re-home/i.test(texts[name]), `${name} holds the stale statement about the root aggregation shim`);
	}
	assert.ok(JSON.stringify(x.pe.blockers ?? x.pe).includes('package-shadow allowlist') || JSON.stringify(x.pe).includes('package allowlist'), 'the allowlist blocker is gone');
});

test('the change table: counts of caught and surviving edits', (t) => {
	const kinds = (outcome) => CHANGES.filter((c) => c.outcome === outcome);
	const label = (c) => `${c.name} (${c.kind})`;
	t.diagnostic(`caught: ${kinds('caught').length}; surviving: ${kinds('survives').length}`);
	t.diagnostic(`surviving edits: ${kinds('survives').map(label).join('; ')}`);
	assert.ok(kinds('caught').length >= 30);
	assert.ok(kinds('survives').length >= 8);
	for (const name of new Set(CHANGES.map((c) => c.name))) {
		const rows = CHANGES.filter((c) => c.name === name).map((c) => c.kind);
		assert.equal(new Set(rows).size, rows.length, `${name}: a kind is listed twice`);
	}
});
