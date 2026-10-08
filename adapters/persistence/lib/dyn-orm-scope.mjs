// Checks adapters/persistence/<orm>/SCOPE.json (contract bskel.internal.persistence-orm-scope-dyn/0) against the files
// it points at and against a fresh run of the repository's own persistence providers. Used by
// test/persistence-next/dyn-orm-scope.test.mjs. Not a test file: the nested runner collects only *.test.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { adapter as fastapi } from '../../../scanners/adapters/python-fastapi.mjs';
import { fromLegacyAdapterScan } from '../../../scanners/persistence-next/legacy.mjs';
import { parseDjangoModels } from '../../../scanners/persistence-next/providers/django-orm.mjs';
import { parseActiveRecordModels } from '../../../scanners/persistence-next/providers/active-record.mjs';
import { extractEloquentModelFacts } from '../../../scanners/language/ruby-php/model-facts.mjs';
import { fromRubyPhpModelFacts } from '../../../scanners/persistence-next/model-facts-bridge.mjs';
import { comparePersistenceIr } from '../../../scanners/persistence-next/drift.mjs';
import { createPersistenceIr } from '../../../scanners/persistence-next/ir.mjs';
import { isPersistenceTargetAdmitted, persistenceTargetById } from '../../../scanners/persistence-next/catalog.mjs';

export const CONTRACT = 'bskel.internal.persistence-orm-scope-dyn/0';
export const PERSISTENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORMS = { 'sqlalchemy-sqlmodel': 'sqlalchemy-sqlmodel', 'django-orm': 'django-orm', activerecord: 'active-record', eloquent: 'eloquent' };
export const FACETS = ['tables', 'columns', 'primary_keys', 'foreign_keys'];
const MODES = {
	'sqlalchemy-sqlmodel': ['legacy-adapter-bridge', 'python-fastapi adapter scan + fromLegacyAdapterScan (temp repo: pyproject.toml, FastAPI main.py stub, fixture model file)'],
	'django-orm': ['t10-provider', 'parseDjangoModels(<fixture model files>)'],
	activerecord: ['t10-provider', 'parseActiveRecordModels(<fixture model files>)'],
	eloquent: ['t07-model-facts', 'extractEloquentModelFacts per fixture model file + fromRubyPhpModelFacts on the merged report'],
};
const NEEDED = ['baseline', 'composite-key', 'naming-strategy', 'relation', 'tenant-scope', 'migration-drift'];

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const ripgrepAvailable = () => spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
const uniq = (xs) => [...new Set(xs)].sort();
const same = (a, b) => isDeepStrictEqual(a, b);
const readOrNull = (file) => { try { return fs.readFileSync(file); } catch { return null; } };

const S = { type: 'string', minLength: 1 };
const SA = { type: 'array', items: S };
const HEX = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const obj = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const facetMap = (keys) => Object.fromEntries(keys.map((key) => [key, SA]));
const REGISTRY = obj(['command', 'exit_code', 'output', 'output_sha256'], { command: S, exit_code: { type: 'integer' }, output: S, output_sha256: HEX });
const STEP = obj(['id', 'role', 'argv', 'expect_exit', 'capture', 'result_file', 'exit_code', 'output_sha256', 'output_bytes', 'runs', 'deterministic'], {
	id: S, case: S, role: { enum: ['setup', 'expected-schema'] }, argv: SA, expect_exit: { type: 'integer' }, capture: { type: 'array' }, result_file: S, exit_code: { type: 'integer' },
	output_sha256: HEX, output_bytes: { type: 'integer', minimum: 0 }, runs: { type: 'integer', minimum: 1 }, deterministic: { type: ['boolean', 'null'] } });
const AGREEMENT = obj(['result', 'matched', 'oracle_only', 'provider_only'], { result: { enum: ['empty', 'match', 'provider-omits', 'provider-extra', 'mismatch'] }, matched: { type: 'integer', minimum: 0 }, oracle_only: SA, provider_only: SA });
const SCHEMA = obj(['contract', 'target_id', 'orm', 'catalog', 'status', 'profile', 'pins', 'constructs', 'cases', 'probes', 'oracle', 'evidence_plan', 'limits'], {
	contract: { const: CONTRACT }, target_id: S, orm: S, catalog: { type: 'object' }, evidence_plan: { type: 'object' }, limits: { type: 'array', minItems: 1, items: S },
	status: obj(['support_completed', 'runtime_tested', 'evidence_level', 'statement'], { support_completed: { const: false }, runtime_tested: { const: false }, evidence_level: { enum: ['fixture-only', 'oracle-compared'] }, statement: S }),
	profile: obj(['id', 'versions', 'platform', 'capabilities'], { id: S, versions: SA, platform: S, capabilities: { type: 'array', items: S } }),
	pins: obj(['checked_at', 'packages', 'not_covered'], {
		checked_at: S,
		packages: { type: 'array', minItems: 1, items: obj(['name', 'version', 'role', 'oracle_install', 'registry_check'], { name: S, version: S, role: S, oracle_install: { type: 'boolean' }, registry_check: REGISTRY }) },
		not_covered: { type: 'array', items: obj(['name', 'version', 'dist_tag', 'reason', 'registry_check'], { name: S, version: S, dist_tag: S, reason: S, registry_check: REGISTRY }) } }),
	constructs: { type: 'array', minItems: 1, items: obj(['id', 'category', 'construct', 'orm_behavior', 'support', 'implementation', 'gap_behavior', 'facets', 'cases', 'planned_in'], {
		id: S, category: S, construct: S, orm_behavior: S, support: { enum: ['supported', 'partial', 'unsupported', 'unknown'] }, implementation: { enum: ['implemented', 'planned', 'none', 'blocked'] },
		gap_behavior: { enum: ['none', 'silent-omission', 'wrong-value', 'diagnostic', 'ir-unknown', 'not-modeled', 'not-detected'] }, facets: { type: 'array', items: { enum: [...FACETS, 'changes'] } }, cases: SA, planned_in: { type: ['string', 'null'] } }) },
	cases: { type: 'array', minItems: 1, items: obj(['id', 'category', 'kind', 'purpose', 'fixture', 'oracle_steps', 'expected', 'expected_changes', 'provider', 'agreement', 'outcome'], {
		id: S, category: S, kind: { enum: ['normal', 'counterexample'] }, purpose: S, oracle_steps: SA, outcome: { enum: ['agrees', 'omits', 'diverges', 'not-detected', 'blocked'] },
		fixture: obj(['files'], { files: { type: 'array', minItems: 1, items: obj(['path', 'sha256', 'role', 'group'], { path: S, sha256: HEX, role: { enum: ['model', 'support'] }, group: { type: ['string', 'null'] } }) } }),
		expected: { type: ['object', 'null'], additionalProperties: obj([...FACETS, 'unmodeled'], facetMap([...FACETS, 'unmodeled'])) },
		expected_changes: { anyOf: [{ type: 'null' }, SA] }, agreement: { type: ['object', 'null'], additionalProperties: AGREEMENT },
		provider: obj(['mode', 'invocation', 'admitted', 'blocker', 'facts', 'unknowns', 'inferred_tables', 'diagnostics', 'detected', 'changes'], {
			mode: S, invocation: S, admitted: { type: 'boolean' }, blocker: { type: ['string', 'null'] }, facts: { anyOf: [{ type: 'null' }, obj(FACETS, facetMap(FACETS))] },
			unknowns: SA, inferred_tables: SA, diagnostics: SA, detected: { type: 'boolean' }, changes: { type: ['object', 'null'] } }) }) },
	probes: obj(['migration_plane', 'live_database'], {
		migration_plane: obj(['status', 'reason'], { status: { enum: ['not-run'] }, reason: S }),
		live_database: obj(['status', 'reason', 'requires', 'affected'], { status: { enum: ['blocked'] }, reason: S, requires: S, affected: SA }) }),
	oracle: obj(['scope', 'environment', 'setup', 'steps', 'blocked'], {
		scope: S, environment: { type: 'object' }, setup: { type: 'array', items: STEP }, steps: { type: 'array', items: STEP },
		blocked: { type: 'array', items: obj(['id', 'reason', 'affects'], { id: S, reason: S, affects: SA }) } }),
});

function withTempRoot(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-scope-'));
	try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function runProvider(orm, ormDir, files) {
	const text = (file) => fs.readFileSync(path.join(ormDir, file.path), 'utf8');
	let ir = null;
	if (orm === 'sqlalchemy-sqlmodel') {
		ir = withTempRoot((root) => {
			fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "orm-scope-harness"\nversion = "0.0.0"\ndependencies = ["fastapi", "sqlmodel"]\n');
			fs.writeFileSync(path.join(root, 'main.py'), 'from fastapi import FastAPI\n\napp = FastAPI()\n');
			for (const file of files) fs.writeFileSync(path.join(root, path.basename(file.path)), text(file));
			const detected = fastapi.detect(root);
			return detected ? fromLegacyAdapterScan({ adapterId: fastapi.id, scan: fastapi.scan(root, detected), repoRoot: root }) : null;
		});
	} else if (orm === 'django-orm') {
		ir = parseDjangoModels(files.map((file) => ({ file: file.path, text: text(file) })));
	} else if (orm === 'activerecord') {
		ir = parseActiveRecordModels(files.map((file) => ({ file: file.path, text: text(file) })));
	} else {
		const reports = files.map((file) => extractEloquentModelFacts(text(file), { file: file.path }));
		ir = reports.length ? fromRubyPhpModelFacts({ ...reports[0], models: reports.flatMap((r) => r.models), unknowns: reports.flatMap((r) => r.unknowns) }) : null;
	}
	return ir ?? createPersistenceIr({ provider: 'orm-scope-harness', source_kind: 'source', entities: [] });
}

function irFacts(ir) {
	const facts = Object.fromEntries(FACETS.map((key) => [key, []]));
	const unknowns = [], inferred = [];
	for (const e of ir.entities) {
		const table = e.table.name && (e.table.schema ? `${e.table.schema}.${e.table.name}` : e.table.name);
		if (!table) { unknowns.push(`${e.name}: table unknown`); continue; }
		facts.tables.push(table);
		if (e.table.source === 'inferred') inferred.push(table);
		facts.columns.push(...e.fields.map((field) => `${table}.${field.name}`));
		if (e.primary_key.columns.length) facts.primary_keys.push(`${table}(${e.primary_key.columns.join(',')})`);
		else unknowns.push(`${table}: primary key unknown`);
		for (const r of e.relations) facts.foreign_keys.push(`${table}(${r.columns.join(',')})->${r.references_table}(${r.references_columns.join(',')})`);
	}
	for (const key of FACETS) facts[key] = uniq(facts[key]);
	return { facts, unknowns: uniq(unknowns), inferred_tables: uniq(inferred), diagnostics: uniq(ir.diagnostics.map((d) => d.code)) };
}

// Drift comparator, called in both directions: the comparator reports only what the expected side has and the observed side lacks.
function driftRecord(v1, v2) {
	const forward = comparePersistenceIr({ expected: v2, observed: v1 });
	const backward = comparePersistenceIr({ expected: v1, observed: v2 });
	const describe = (c) => ({ findings: c.findings.map((f) => `${f.code} ${f.table ?? ''}${f.column ? `.${f.column}` : ''}`.trim()).sort(), unknowns: c.unknowns.map((u) => u.code).sort() });
	const word = (f, verb) => (f.code === 'column-missing' ? `${verb}-column ${f.table}.${f.column}` : f.code === 'table-missing' ? `${verb === 'add' ? 'create' : 'drop'}-table ${f.table}` : `${f.code} ${f.table}`);
	const changes = [...forward.findings.map((f) => word(f, 'add')), ...backward.findings.map((f) => word(f, 'drop'))];
	return { call_expected_v2_observed_v1: describe(forward), call_expected_v1_observed_v2: describe(backward), changes: uniq(changes) };
}

// Schema change between two oracle snapshots as the strings a migration diff would list.
export function oracleChanges(v1, v2) {
	const columnsOf = (facts, table) => new Set(facts.columns.filter((c) => c.startsWith(`${table}.`)));
	const out = [];
	for (const t of v2.tables) if (!v1.tables.includes(t)) out.push(`create-table ${t}`);
	for (const t of v1.tables) if (!v2.tables.includes(t)) out.push(`drop-table ${t}`);
	for (const t of v1.tables.filter((x) => v2.tables.includes(x))) {
		for (const c of columnsOf(v2, t)) if (!columnsOf(v1, t).has(c)) out.push(`add-column ${c}`);
		for (const c of columnsOf(v1, t)) if (!columnsOf(v2, t).has(c)) out.push(`drop-column ${c}`);
	}
	return uniq(out);
}

export function agree(oracle, provider) {
	const o = new Set(oracle), p = new Set(provider);
	const oracle_only = [...o].filter((x) => !p.has(x)).sort(), provider_only = [...p].filter((x) => !o.has(x)).sort();
	const result = !o.size && !p.size ? 'empty' : !oracle_only.length && !provider_only.length ? 'match' : oracle_only.length && provider_only.length ? 'mismatch' : oracle_only.length ? 'provider-omits' : 'provider-extra';
	return { result, matched: [...o].filter((x) => p.has(x)).length, oracle_only, provider_only };
}

// Everything in a case that is computed rather than observed: provider block, expected changes, agreement, outcome.
export function deriveCase(orm, ormDir, c) {
	const modelFiles = (group) => c.fixture.files.filter((f) => f.role === 'model' && (group === undefined || f.group === group));
	const [mode, invocation] = MODES[orm];
	const base = { mode, invocation, admitted: isPersistenceTargetAdmitted(ORMS[orm]), blocker: null };
	const none = { unknowns: [], inferred_tables: [], diagnostics: [] };
	const drift = c.category === 'migration-drift';
	const first = c.expected?.[c.oracle_steps[0]] ?? null;
	let provider, agreement = null, expected_changes = null;
	if (drift) {
		const v1 = runProvider(orm, ormDir, modelFiles('v1')), v2 = runProvider(orm, ormDir, modelFiles('v2'));
		provider = { ...base, facts: null, ...none, detected: v1.entities.length > 0 && v2.entities.length > 0, changes: driftRecord(v1, v2) };
		if (first) {
			expected_changes = oracleChanges(first, c.expected[c.oracle_steps[1]]);
			agreement = { changes: agree(expected_changes, provider.changes.changes) };
		}
	} else {
		const ir = runProvider(orm, ormDir, modelFiles());
		provider = { ...base, ...irFacts(ir), detected: ir.entities.length > 0, changes: null };
		if (first) agreement = Object.fromEntries(FACETS.map((key) => [key, agree(first[key], provider.facts[key])]));
	}
	const results = Object.values(agreement ?? {}).map((a) => a.result);
	const outcome = !first ? 'blocked' : first.tables.length && !provider.detected ? 'not-detected'
		: results.every((r) => r === 'match' || r === 'empty') ? 'agrees' : results.some((r) => r === 'mismatch' || r === 'provider-extra') ? 'diverges' : 'omits';
	return { provider, agreement, expected_changes, outcome };
}

function filesUnder(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// Returns a list of problems; an empty list means every claim in the record was re-derived from files and repository code.
export function verifyScope(rec, ormDir) {
	const errors = [];
	const bad = (message) => errors.push(message);
	const orm = path.basename(ormDir);
	if (!ORMS[orm]) return [`unknown ORM directory ${orm}`];
	const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
	if (!ajv.validate(SCHEMA, rec)) return [`record does not match the schema: ${ajv.errorsText(ajv.errors.slice(0, 5))}`];
	if (rec.orm !== orm || rec.target_id !== `ORM-${orm}-01`) bad('orm or target_id does not match the directory');
	if (!same(rec.catalog, persistenceTargetById(ORMS[orm]))) bad('catalog block differs from scanners/persistence-next/catalog.mjs');
	const listed = new Set();
	for (const c of rec.cases) for (const f of c.fixture.files) {
		listed.add(f.path);
		const buf = readOrNull(path.join(ormDir, f.path));
		if (!buf) bad(`${c.id}: fixture ${f.path} is missing`);
		else if (sha256(buf) !== f.sha256) bad(`${c.id}: fixture ${f.path} sha256 differs`);
	}
	const onDisk = filesUnder(path.join(ormDir, 'fixtures')).map((p) => path.relative(ormDir, p).split(path.sep).join('/')).sort();
	if (!same(onDisk, [...listed].sort())) bad('files under fixtures/ differ from the files listed in cases');
	const outputs = new Map(), reported = {};
	for (const s of [...rec.oracle.setup, ...rec.oracle.steps]) {
		const buf = readOrNull(path.join(ormDir, s.result_file));
		if (!buf) { bad(`${s.id}: result file is missing`); continue; }
		if (sha256(buf) !== s.output_sha256 || buf.length !== s.output_bytes) bad(`${s.id}: result file sha256 or size differs`);
		if (s.exit_code !== s.expect_exit) bad(`${s.id}: exit code ${s.exit_code} is not the expected ${s.expect_exit}`);
		if (s.role === 'expected-schema') {
			if (s.runs < 2 || s.deterministic !== true) bad(`${s.id}: not recorded as identical over two runs`);
			try { const parsed = JSON.parse(buf); outputs.set(s.id, parsed.facts); for (const [k, v] of Object.entries(parsed.versions)) reported[k.toLowerCase()] = v; } catch { bad(`${s.id}: result file is not the oracle JSON`); }
		}
	}
	const runtime = rec.oracle.environment.runtime;
	if (rec.oracle.steps.length && reported[runtime?.name] !== runtime?.version) bad(`environment.runtime ${runtime?.name}@${runtime?.version} is not what the oracle reported (${reported[runtime?.name]})`);
	for (const p of [...rec.pins.packages, ...rec.pins.not_covered]) {
		const rc = p.registry_check;
		if (rc.exit_code !== 0 || rc.output !== p.version || sha256(rc.output) !== rc.output_sha256 || !rc.command.includes(p.name) || !(rc.command.includes(p.version) || 'dist_tag' in p)) bad(`pin ${p.name}@${p.version}: registry check does not support it`);
	}
	for (const p of rec.pins.packages) if (p.oracle_install && reported[p.name.toLowerCase()] !== p.version) bad(`pin ${p.name}@${p.version}: the oracle output reports ${reported[p.name.toLowerCase()]}`);
	if (rec.pins.not_covered.some((p) => rec.pins.packages.some((q) => q.name === p.name && q.version === p.version))) bad('a not_covered release equals a pin');
	if (!same(rec.profile.versions, rec.pins.packages.map((p) => `${p.name}@${p.version}`).sort())) bad('profile.versions differs from the pins');
	const byId = new Map(rec.cases.map((c) => [c.id, c]));
	for (const c of rec.cases) {
		for (const id of c.oracle_steps) if (!same(c.expected?.[id], outputs.get(id))) bad(`${c.id}: expected.${id} differs from the recorded oracle output`);
		if (!same(Object.keys(c.expected ?? {}), c.oracle_steps) && c.oracle_steps.length) bad(`${c.id}: expected holds results of steps it does not list`);
		const fresh = deriveCase(orm, ormDir, c);
		for (const key of Object.keys(fresh)) if (!same(fresh[key], c[key])) bad(`${c.id}: ${key} differs from a fresh run of the repository provider`);
		if (!c.oracle_steps.length && !rec.oracle.blocked.some((b) => b.affects.includes(c.id))) bad(`${c.id}: has no oracle step and no blocked record`);
	}
	for (const k of rec.constructs) {
		for (const id of k.cases) if (!byId.has(id)) bad(`construct ${k.id}: unknown case ${id}`);
		if (k.planned_in && !(k.planned_in in rec.evidence_plan)) bad(`construct ${k.id}: planned_in ${k.planned_in} is not in evidence_plan`);
		if (k.support === 'supported') {
			if (!k.cases.length || !k.facets.length || k.implementation !== 'implemented' || k.gap_behavior !== 'none') bad(`construct ${k.id}: supported needs implemented, gap_behavior none, cases and facets`);
			for (const id of k.cases) for (const facet of k.facets) if (byId.get(id)?.agreement?.[facet]?.result !== 'match') bad(`construct ${k.id}: supported but ${id}/${facet} is ${byId.get(id)?.agreement?.[facet]?.result}`);
		} else if (k.gap_behavior === 'none') bad(`construct ${k.id}: ${k.support} needs a gap_behavior`);
	}
	if (!same(rec.profile.capabilities, rec.constructs.filter((k) => k.support === 'supported').map((k) => k.id).sort())) bad('profile.capabilities differs from the supported constructs');
	for (const cat of NEEDED) if (!rec.cases.some((c) => c.category === cat)) bad(`no ${cat} case`);
	for (const cat of ['naming-strategy', 'tenant-scope']) if (!rec.cases.some((c) => c.category === cat && c.kind === 'counterexample')) bad(`no ${cat} counterexample`);
	if (!rec.cases.some((c) => c.kind === 'normal')) bad('no normal fixture');
	return errors;
}
