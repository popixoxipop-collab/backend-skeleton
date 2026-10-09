// Checks adapters/persistence/<orm>/SCOPE.json (contract bskel.internal.persistence-orm-scope-dyn/0) against the files
// it points at and against a fresh run of the repository's own persistence providers. Used by
// test/persistence-next/dyn-orm-scope.test.mjs. Not a test file: the nested runner collects only *.test.mjs.
//
// How an oracle result is trusted. A result file under oracle/results/ is frozen output of a real ORM run, so it carries three bindings:
//   1. The oracle script prints the sha256 of every file it consumed (the script itself and the fixture it was pointed at) in its own
//      "inputs" block. verifyScope recomputes those digests from the repository, from the committed argv, and rejects the step when the
//      frozen output was produced from other bytes (an edited fixture or script whose result was not regenerated), when the record's
//      per-step "inputs" differ, or when the files the steps consumed are not exactly the fixture files the case lists.
//   2. deriveCase reads every file the case lists, whatever its role, and reports the digest of the bytes it read.
//   3. Where the pinned toolchain exists, reexecute() runs the recorded argv again and compares stdout with the frozen file byte for byte
//      (status "reproduced" or "differs"). Where it does not, the step is "unverified" with the reason, and reproducedAgreement() never
//      lists a case whose steps are not all reproduced. A digest binding alone cannot tell a regenerated result from a hand-edited one.
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
// The only commands a record may ask to have re-run: the committed oracle script pointed at one fixture. A record cannot name any other
// program or script, so re-execution never runs anything but the oracle. "bin" is the directory below the toolchain root put first on PATH.
const ORACLE = {
	'sqlalchemy-sqlmodel': { script: 'oracle/introspect.py', bin: 'bin', argv: (target) => ['python', 'oracle/introspect.py', target] },
	'django-orm': { script: 'oracle/introspect.py', bin: 'bin', argv: (target) => ['python', 'oracle/introspect.py', target] },
	activerecord: { script: 'oracle/introspect.rb', bin: 'bin', argv: (target) => ['env', 'GEM_HOME=$ORACLE_VENV', 'GEM_PATH=$ORACLE_VENV', 'ruby', 'oracle/introspect.rb', target] },
	eloquent: { script: 'oracle/introspect.php', bin: '', argv: (target) => ['php', 'oracle/introspect.php', target, '$ORACLE_VENV/project/vendor/autoload.php'] },
};

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
	output_sha256: HEX, output_bytes: { type: 'integer', minimum: 0 }, runs: { type: 'integer', minimum: 1 }, deterministic: { type: ['boolean', 'null'] },
	inputs: { type: 'array', minItems: 2, items: obj(['path', 'sha256'], { path: S, sha256: HEX }) }, tool_versions: { type: 'object', minProperties: 1, additionalProperties: S } });
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

// files: [{ path, text }], the bytes deriveCase already read.
function runProvider(orm, files) {
	let ir = null;
	if (orm === 'sqlalchemy-sqlmodel') {
		ir = withTempRoot((root) => {
			fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "orm-scope-harness"\nversion = "0.0.0"\ndependencies = ["fastapi", "sqlmodel"]\n');
			fs.writeFileSync(path.join(root, 'main.py'), 'from fastapi import FastAPI\n\napp = FastAPI()\n');
			for (const file of files) fs.writeFileSync(path.join(root, path.basename(file.path)), file.text);
			const detected = fastapi.detect(root);
			return detected ? fromLegacyAdapterScan({ adapterId: fastapi.id, scan: fastapi.scan(root, detected), repoRoot: root }) : null;
		});
	} else if (orm === 'django-orm') {
		ir = parseDjangoModels(files.map((file) => ({ file: file.path, text: file.text })));
	} else if (orm === 'activerecord') {
		ir = parseActiveRecordModels(files.map((file) => ({ file: file.path, text: file.text })));
	} else {
		const reports = files.map((file) => extractEloquentModelFacts(file.text, { file: file.path }));
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

// Everything in a case that is computed rather than observed: provider block, expected changes, agreement, outcome, plus `inputs`: the
// path, role and sha256 of the bytes read from every file the case lists, support files included. The providers are handed only the
// model files (none of them parses a schema or scope file), but a changed support file still changes `inputs`, and verifyScope compares
// those digests with the recorded ones and with the digests the oracle printed for the files it consumed.
export function deriveCase(orm, ormDir, c) {
	const read = new Map(c.fixture.files.map((f) => [f.path, fs.readFileSync(path.join(ormDir, f.path))]));
	const inputs = c.fixture.files.map((f) => ({ path: f.path, role: f.role, sha256: sha256(read.get(f.path)) }));
	const modelFiles = (group) => c.fixture.files.filter((f) => f.role === 'model' && (group === undefined || f.group === group)).map((f) => ({ path: f.path, text: read.get(f.path).toString('utf8') }));
	const [mode, invocation] = MODES[orm];
	const base = { mode, invocation, admitted: isPersistenceTargetAdmitted(ORMS[orm]), blocker: null };
	const none = { unknowns: [], inferred_tables: [], diagnostics: [] };
	const drift = c.category === 'migration-drift';
	const first = c.expected?.[c.oracle_steps[0]] ?? null;
	let provider, agreement = null, expected_changes = null;
	if (drift) {
		const v1 = runProvider(orm, modelFiles('v1')), v2 = runProvider(orm, modelFiles('v2'));
		provider = { ...base, facts: null, ...none, detected: v1.entities.length > 0 && v2.entities.length > 0, changes: driftRecord(v1, v2) };
		if (first) {
			expected_changes = oracleChanges(first, c.expected[c.oracle_steps[1]]);
			agreement = { changes: agree(expected_changes, provider.changes.changes) };
		}
	} else {
		const ir = runProvider(orm, modelFiles());
		provider = { ...base, ...irFacts(ir), detected: ir.entities.length > 0, changes: null };
		if (first) agreement = Object.fromEntries(FACETS.map((key) => [key, agree(first[key], provider.facts[key])]));
	}
	const results = Object.values(agreement ?? {}).map((a) => a.result);
	const outcome = !first ? 'blocked' : first.tables.length && !provider.detected ? 'not-detected'
		: results.every((r) => r === 'match' || r === 'empty') ? 'agrees' : results.some((r) => r === 'mismatch' || r === 'provider-extra') ? 'diverges' : 'omits';
	return { provider, agreement, expected_changes, outcome, inputs };
}

function filesUnder(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// The recorded argv must be exactly the committed oracle command for this ORM pointed at one fixture; anything else is neither bound
// nor ever executed. Returns { script, target } or null.
function oracleCommand(orm, argv) {
	const target = argv.find((a) => a.startsWith('fixtures/') && !a.split('/').includes('..'));
	return target && same(argv, ORACLE[orm].argv(target)) ? { script: ORACLE[orm].script, target } : null;
}

// The files one oracle command consumes, hashed from disk now: the oracle script and the fixture (a file, or every file below a
// directory). Keys are the paths the oracle scripts print in their own "inputs" block. Throws when one of them is missing.
function inputsOf(ormDir, { script, target }) {
	const found = new Map();
	const add = (rel) => found.set(rel, sha256(fs.readFileSync(path.join(ormDir, rel))));
	add(script);
	const abs = path.join(ormDir, target);
	if (fs.statSync(abs).isDirectory()) for (const file of filesUnder(abs)) add(path.posix.join(target, path.relative(abs, file).split(path.sep).join('/')));
	else add(target);
	return found;
}

export const oracleEnvName = (orm) => `ORM_SCOPE_ORACLE_${orm.toUpperCase().replaceAll('-', '_')}`;

// The pinned toolchain a step can be re-run with: the directory the setup steps installed into ($ORACLE_VENV in the recorded argv).
export function toolchainFromEnv(orm) {
	const root = process.env[oracleEnvName(orm)];
	return root ? { root, bin: ORACLE[orm].bin } : { missing: `no pinned toolchain: set ${oracleEnvName(orm)} to the directory the setup steps installed into` };
}

// Runs one recorded step again, exactly as recorded, and compares its stdout with the frozen result file byte for byte.
//   reproduced: exit code and bytes equal.  differs: they are not.  unverified: it was not run (reason says why); an install transcript is
// always unverified because repeating it needs the network and rewrites the toolchain. The caller must already have checked that argv is
// the committed oracle command (reexecute does); this function runs whatever argv it is given.
export function reexecuteStep(step, ormDir, toolchain) {
	const out = (status, reason) => ({ id: step.id, case: step.case ?? null, role: step.role, status, reason });
	if (step.role !== 'expected-schema') return out('unverified', 'install transcript: repeating it needs the network and rewrites the toolchain, so it is never re-run');
	if (!toolchain || toolchain.missing) return out('unverified', toolchain?.missing ?? 'no toolchain given');
	if (!fs.existsSync(toolchain.root)) return out('unverified', 'the toolchain directory does not exist');
	const frozen = readOrNull(path.join(ormDir, step.result_file));
	if (!frozen) return out('unverified', 'the frozen result file is missing');
	const argv = step.argv.map((a) => a.replaceAll('$ORACLE_VENV', toolchain.root));
	const run = spawnSync(argv[0], argv.slice(1), { cwd: ormDir, env: { ...process.env, PATH: [path.join(toolchain.root, toolchain.bin), process.env.PATH].join(path.delimiter) }, maxBuffer: 1 << 26, timeout: 120000 });
	if (run.error) return out('unverified', `could not run ${step.argv[0]}: ${run.error.code ?? run.error.message}`);
	if (run.status !== step.expect_exit) return out('differs', `exit code ${run.status}, recorded ${step.expect_exit}`);
	if (!run.stdout.equals(frozen)) return out('differs', `stdout (${run.stdout.length} bytes) is not the frozen output (${frozen.length} bytes)`);
	return out('reproduced', `ran the recorded argv again: ${run.stdout.length} bytes identical to the frozen output`);
}

// One status per recorded step (setup steps first). Only steps whose argv is the committed oracle command are ever executed.
export function reexecute(rec, ormDir, toolchain = toolchainFromEnv(path.basename(ormDir))) {
	const orm = path.basename(ormDir);
	return [...rec.oracle.setup, ...rec.oracle.steps].map((s) => (s.role === 'expected-schema' && !oracleCommand(orm, s.argv)
		? { id: s.id, case: s.case ?? null, role: s.role, status: 'unverified', reason: 'argv is not the committed oracle command, so it is not run' }
		: reexecuteStep(s, ormDir, toolchain)));
}

// Cases whose recorded agreement rests on oracle steps that were all reproduced. A case with a step that is unverified, differs or is
// missing is never listed, so unverified evidence cannot count as agreement.
export function reproducedAgreement(rec, results) {
	const status = new Map(results.map((r) => [r.id, r.status]));
	return rec.cases.filter((c) => c.agreement && c.oracle_steps.length && c.oracle_steps.every((id) => status.get(id) === 'reproduced')).map((c) => c.id);
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const listOf = (digests) => [...digests].map(([p, h]) => ({ path: p, sha256: h })).sort(byPath);

// Returns a list of problems; an empty list means every claim in the record was re-derived from files and repository code, and every
// oracle result was shown to come from the inputs on disk. options.reexecute additionally runs the recorded oracle commands again with
// the toolchain named by ORM_SCOPE_ORACLE_<ORM> (or options.toolchain): output that differs is a problem, a step that cannot be run
// is not (reexecute() reports it as unverified and reproducedAgreement() does not count it).
export function verifyScope(rec, ormDir, options = {}) {
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
	// outputs/consumed only ever hold steps whose frozen output is bound to the files on disk; a case that depends on any other step is rejected below.
	const outputs = new Map(), consumed = new Map(), reported = {};
	let toolVersions = null;
	for (const s of [...rec.oracle.setup, ...rec.oracle.steps]) {
		const buf = readOrNull(path.join(ormDir, s.result_file));
		if (!buf) { bad(`${s.id}: result file is missing`); continue; }
		if (sha256(buf) !== s.output_sha256 || buf.length !== s.output_bytes) bad(`${s.id}: result file sha256 or size differs`);
		if (s.exit_code !== s.expect_exit) bad(`${s.id}: exit code ${s.exit_code} is not the expected ${s.expect_exit}`);
		if (s.role !== 'expected-schema') continue;
		if (s.runs < 2 || s.deterministic !== true) bad(`${s.id}: not recorded as identical over two runs`);
		let parsed = null;
		try { parsed = JSON.parse(buf); } catch { /* reported just below */ }
		if (!parsed?.facts || !parsed.inputs || !parsed.versions) { bad(`${s.id}: result file is not the oracle JSON`); continue; }
		for (const [k, v] of Object.entries(parsed.versions)) reported[k.toLowerCase()] = v;
		const command = oracleCommand(orm, s.argv);
		let disk = null;
		try { disk = command && inputsOf(ormDir, command); } catch { /* reported just below */ }
		if (!disk) { bad(`${s.id}: argv is not the committed oracle command, or a file it consumes is missing`); continue; }
		let bound = true;
		if (!same(s.inputs && [...s.inputs].sort(byPath), listOf(disk))) { bad(`${s.id}: recorded inputs differ from the files the command consumes on disk`); bound = false; }
		if (!same(parsed.inputs, Object.fromEntries(disk))) { bad(`${s.id}: the frozen oracle output was produced from different input files than the ones on disk (stale oracle output)`); bound = false; }
		if (!same(s.tool_versions, parsed.versions)) { bad(`${s.id}: recorded tool_versions differ from the versions the frozen output reports`); bound = false; }
		if (toolVersions && !same(toolVersions, parsed.versions)) { bad(`${s.id}: reports other tool versions than the first oracle step`); bound = false; }
		toolVersions ??= parsed.versions;
		if (bound) { outputs.set(s.id, parsed.facts); consumed.set(s.id, disk); }
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
	const stepOf = new Map(rec.oracle.steps.map((s) => [s.id, s]));
	for (const s of rec.oracle.steps) if (!rec.cases.some((c) => c.oracle_steps.includes(s.id))) bad(`${s.id}: no case uses this oracle step`);
	for (const c of rec.cases) {
		const unbound = c.oracle_steps.filter((id) => !outputs.has(id));
		for (const id of unbound) bad(`${c.id}: oracle step ${id} is missing or not bound to the current inputs, so its agreement is not counted`);
		for (const id of c.oracle_steps) {
			if (stepOf.get(id) && stepOf.get(id).case !== c.id) bad(`${c.id}: oracle step ${id} belongs to case ${stepOf.get(id).case}`);
			if (outputs.has(id) && !same(c.expected?.[id], outputs.get(id))) bad(`${c.id}: expected.${id} differs from the recorded oracle output`);
		}
		if (!same(Object.keys(c.expected ?? {}), c.oracle_steps) && c.oracle_steps.length) bad(`${c.id}: expected holds results of steps it does not list`);
		let fresh = null;
		try { fresh = deriveCase(orm, ormDir, c); } catch (e) { bad(`${c.id}: cannot be re-derived: ${e.code ?? e.message}`); }
		if (fresh) {
			for (const key of ['provider', 'agreement', 'expected_changes', 'outcome']) if (!same(fresh[key], c[key])) bad(`${c.id}: ${key} differs from a fresh run of the repository provider`);
			if (!same(fresh.inputs, c.fixture.files.map(({ path: p, role, sha256: h }) => ({ path: p, role, sha256: h })))) bad(`${c.id}: the provider side read other bytes than its fixture entries record`);
			if (c.oracle_steps.length && !unbound.length) {
				const used = new Set(c.oracle_steps.flatMap((id) => [...consumed.get(id).keys()]).filter((p) => !p.startsWith('oracle/')));
				if (!same([...used].sort(), c.fixture.files.map((f) => f.path).sort())) bad(`${c.id}: the files its oracle steps consumed are not the fixture files the case lists`);
			}
		}
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
	if (options.reexecute) for (const r of reexecute(rec, ormDir, options.toolchain)) if (r.status === 'differs') bad(`${r.id}: running the recorded command again does not reproduce the frozen output (${r.reason})`);
	return errors;
}
