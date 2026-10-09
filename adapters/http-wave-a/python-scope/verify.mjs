// Verifier for the Python HTTP scope records (HTTP-python-*-01). It RECOMPUTES every hash, count, pin and
// scanner-vs-framework comparison a record states; nothing is format-checked only.
//   verifyStoredRecord: the record against its own stored results (record corruption)
//   verifyLiveTree:     the record against the checked-out tree (fixtures, scanners, oracle.py, registrations)
// CLI: node verify.mjs [item-id ...]   (exit code 1 on any problem; python3 must be on PATH, there is no skip)
// Stored results are untrusted input: one that is missing, unreadable, unparseable or wrongly shaped is reported as a
// "result-set" problem (a missing fixture tree as "fixture-set"), never thrown, so the CLI always prints its report.
//
// record_digest seals the WHOLE record except its own field (sha256 over the canonical JSON: sorted keys, no
// whitespace), so an edit that is not re-sealed fails with code "seal". What the seal does not do: prose is
// sealed, not recomputed. claims.statement, runtime_tested.reason, conformance.reason, limits, plan, the
// oracle_range text, layer roles, must_catch construct/blind_property and covering_flags[].covers are not derived
// from any evidence, so an edit that IS re-sealed is not detected here; it shows up in the review diff.
// Statuses are bound by recomputation, not by membership: outcomes and the scope partition come from the stored
// oracle and static results, the rule of a must-catch id and the role of a fixture id are fixed below, and the
// test file freezes the partition each item is expected to publish.
// Nothing is checked by visiting only what is present: every stored list, key set and declared count is compared in
// both directions (a missing, empty, extra or mislabeled member is a problem, never a silent skip), and an entry that
// could hold without the scanner handling the construct it names (no ordinary route in the oracle result, or a
// catch-generated entry with no framework-generated route) is rejected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { runStatic, serializeStatic, STATIC_LAYERS, STATIC_LAYER_SOURCES, STATIC_RUNNER_SCHEMA, walk } from './static-runner.mjs';
import { HTTP_WAVE_BC_TARGETS } from '../../http-wave-bc/catalog.mjs';
import { FLASK_PROFILE } from '../flask.mjs';
import { DJANGO_DRF_PROFILE } from '../django-drf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const SCOPE_TARGETS = {
  'HTTP-python-fastapi-01': { framework: 'fastapi', track: 'T11', dir: 'adapters/http-legacy-next/python-fastapi', entry: 'app.py' },
  'HTTP-python-flask-01': { framework: 'flask', track: 'T12', dir: 'adapters/http-wave-a/python-flask', entry: 'app.py' },
  'HTTP-python-django-01': { framework: 'django', track: 'T12', dir: 'adapters/http-wave-a/python-django', entry: 'urls.py' },
  'HTTP-python-starlette-01': { framework: 'starlette', track: 'T13', dir: 'adapters/http-wave-bc/python-starlette', entry: 'app.py' },
  'HTTP-python-litestar-01': { framework: 'litestar', track: 'T13', dir: 'adapters/http-wave-bc/python-litestar', entry: 'app.py' },
};
const validateShape = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(fs.readFileSync(path.join(HERE, 'scope.schema.json'), 'utf8')));

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
// Both checks start here, so a record of the wrong shape is a structured problem from either of them and nothing below
// reads into a record that failed the schema.
const schemaProblems = (record) => (validateShape(record) ? [] : validateShape.errors.map((e) => ({ code: 'schema', where: e.instancePath || '/', message: e.message })));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// Stored evidence is untrusted input: a file that is missing, is a directory or cannot be read comes back as null
// (or as an empty walk) so that the caller reports a problem, and the CLI never ends in an uncaught exception.
const readBytes = (file) => { try { return fs.readFileSync(file); } catch { return null; } };
const readText = (file) => readBytes(file)?.toString('utf8') ?? null;
const walkIfDir = (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? walk(dir) : []);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isList = (value, test) => Array.isArray(value) && value.every(test);
const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const sameSet = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
const ORACLE_PATH = 'adapters/http-wave-a/python-scope/oracle.py';
const RUNNER_PATH = 'adapters/http-wave-a/python-scope/static-runner.mjs';
const pathOf = (pairText) => pairText.slice(pairText.indexOf(' ') + 1);
const DROPPED = new Set(['HEAD', 'OPTIONS']);
const pair = (method, route) => `${method ?? '-'} ${route}`;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sealOf = ({ record_digest: _seal, ...rest }) => sha256(canonicalJson(rest));
export const sealRecord = (record) => ({ ...record, record_digest: sealOf(record) });

// The must-catch classes the work package names (dynamic route factory, router prefix, middleware/auth, generated
// routes, deployment prefix). A record may add entries but may not drop one, and the rule an entry is judged by and
// the fixture it is judged on both follow from its id, so reclassifying an entry or re-pointing it at the normal
// fixture cannot turn an unsupported construct into a supported one. At least one entry must be catch-generated.
const REQUIRED_CLASSES = ['dynamic-route-factory', 'router-prefix', 'middleware-auth', 'deployment-prefix'];
const RULES = { 'middleware-auth': 'oracle-blind', 'deployment-prefix': 'oracle-blind', 'generated-routes': 'catch-generated', 'generated-admin': 'catch-generated' };
const ruleOf = (id) => RULES[id] ?? 'catch-or-flag';
const fixtureOf = (id) => (id === 'normal-literal-routes' ? 'normal' : `counterexamples/${id}`);

export const recordDir = (item, root = REPO_ROOT) => path.join(root, SCOPE_TARGETS[item].dir);
export const loadRecord = (item, root = REPO_ROOT) => readJson(path.join(recordDir(item, root), 'SCOPE.json'));

// What the framework itself registered for one fixture: non-generated pairs and framework-generated pairs.
export function oraclePairs(fixture) {
  const routes = new Set();
  const generated = new Set();
  for (const route of fixture.routes) {
    for (const method of route.methods ?? [null]) {
      if (!DROPPED.has(method)) (route.generated ? generated : routes).add(pair(method, route.path));
    }
  }
  for (const group of fixture.generated_groups) for (const p of group.paths_sorted) generated.add(pair(null, p));
  return { routes: [...routes].sort(), generated: [...generated].sort() };
}

// One scanner layer against the oracle. A static pair with method "-" (method left null by the scanner) that
// matches an oracle path is "unresolved" (path caught, method honestly unknown), never an exact match.
export function compareLayer(oracle, layerRoutes) {
  const have = [...new Set(layerRoutes.filter((r) => !DROPPED.has(r.method)).map((r) => pair(r.method, r.path)))].sort();
  const known = new Set([...oracle.routes, ...oracle.generated]);
  const oraclePaths = new Set(oracle.routes.map(pathOf));
  const unresolved = have.filter((p) => p.startsWith('- ') && !known.has(p) && oraclePaths.has(pathOf(p)));
  const resolvedPaths = new Set(unresolved.map(pathOf));
  const missed = oracle.routes.filter((o) => !have.includes(o) && !resolvedPaths.has(pathOf(o)));
  const extra = have.filter((p) => !known.has(p) && !unresolved.includes(p));
  const klass = extra.length ? 'wrong' : missed.length ? 'incomplete' : unresolved.length ? 'method-unresolved' : 'exact';
  return { class: klass, missed, extra, unresolved, generated_unseen: oracle.generated.filter((g) => !have.includes(g)).length };
}

export function outcomeOf(rule, compared, covered) {
  const generatedGap = rule === 'catch-generated' && compared.generated_unseen > 0;
  if (compared.class === 'exact' && !generatedGap) return 'caught';
  if (compared.class === 'method-unresolved' && !generatedGap) return 'left-unknown';
  if (covered) return 'flagged';
  return compared.class === 'wrong' ? 'wrong-unflagged' : 'omitted-unflagged';
}

const flagMatches = (flag, covering) => flag.code === covering.code
  && (covering.text_includes === undefined || (flag.text ?? '').includes(covering.text_includes));

export function derivePartition(record) {
  const out = { supported: [], unknown_flagged: [], unsupported_gap: [], unassessed: [], oracle_blind: [] };
  const bucket = { caught: 'supported', 'left-unknown': 'unknown_flagged', flagged: 'unknown_flagged', 'omitted-unflagged': 'unsupported_gap', 'wrong-unflagged': 'unsupported_gap' };
  for (const mc of record.must_catch) {
    if (mc.rule === 'oracle-blind') out.oracle_blind.push(mc.id);
    const layers = Object.entries(mc.layers);
    if (!layers.length) out.unassessed.push(mc.id);
    for (const [layerId, layer] of layers) {
      // an oracle-blind entry whose route set matched is not "supported": the named property was never observed
      if (mc.rule === 'oracle-blind' && layer.outcome === 'caught') continue;
      out[bucket[layer.outcome]].push(`${mc.id}@${layerId}`);
    }
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

export function liveRegistration(framework) {
  const pick = (p) => ({ id: p.id, state: p.state, registration: p.registration, productionDefault: p.productionDefault, runtimeTested: p.runtimeTested, t19Review: p.t19Review });
  if (framework === 'flask') return { source: 'adapters/http-wave-a/flask.mjs', entry: pick(FLASK_PROFILE) };
  if (framework === 'django') return { source: 'adapters/http-wave-a/django-drf.mjs', entry: pick(DJANGO_DRF_PROFILE) };
  if (framework === 'starlette' || framework === 'litestar') {
    return { source: 'adapters/http-wave-bc/catalog.mjs', entry: HTTP_WAVE_BC_TARGETS.find((t) => t.id === `python-${framework}`) ?? null };
  }
  return null;
}

// The shapes verifyStoredRecord dereferences. A stored results file that parses but has another shape is reported
// as a "result-set" problem before any check reads into it, instead of surfacing as a TypeError. The later checks
// only visit what is present, so the shape is pinned here: each stored fixture carries exactly the declared static
// layers, every oracle route has a boolean generated flag and a method list that is null or not empty, an ordinary
// route keeps a method besides HEAD and OPTIONS (every comparison drops those two, so it would vanish from every pair),
// and the registry extract holds exactly the pinned projects.
function malformedResults({ oracle, registry, staticReport, framework, layerIds, pypiNames }) {
  const bad = [];
  const need = (ok, where, what, how = 'is missing or has the wrong type') => { if (!ok) bad.push({ where, message: `${what} ${how}` }); return ok; };
  const oracleRoute = (r) => isObject(r) && isText(r.path) && typeof r.generated === 'boolean'
    && (r.methods === null || (isList(r.methods, isText) && r.methods.length > 0));
  const oracleGroup = (g) => isObject(g) && isText(g.group) && isList(g.paths_sorted, isText) && g.paths_sorted.length > 0 && g.count === g.paths_sorted.length;
  if (need(isObject(oracle), 'results/oracle.json', 'the document')) {
    need(oracle.oracle === 'framework-route-table', 'results/oracle.json', 'oracle', 'is not "framework-route-table"');
    need(isObject(oracle.framework) && isText(oracle.framework.name) && isText(oracle.framework.version), 'results/oracle.json', 'framework {name, version}');
    need(isObject(oracle.python) && isText(oracle.python.version), 'results/oracle.json', 'python {version, ...}');
    if (need(isObject(oracle.fixtures), 'results/oracle.json', 'fixtures')) {
      for (const [id, fx] of Object.entries(oracle.fixtures)) {
        const where = `results/oracle.json:${id}`;
        if (!need(isObject(fx) && (fx.error === null || isText(fx.error)) && isList(fx.routes, oracleRoute) && isList(fx.generated_groups, oracleGroup),
          where, 'fixture {error, routes[{path, methods, generated}], generated_groups[{group, count, paths_sorted}]}')) continue;
        // a generated route may be the framework's implicit OPTIONS handler (Litestar adds one per path), which is dropped on purpose
        for (const route of fx.routes) need(route.generated || route.methods === null || route.methods.some((m) => !DROPPED.has(m)), where, `route ${route.path} [${route.methods}]`,
          'has no method besides HEAD and OPTIONS, which every comparison drops, so it would vanish from the expected pairs');
      }
    }
  }
  if (need(isObject(registry), 'results/registry.json', 'the document') && need(isObject(registry.projects), 'results/registry.json', 'projects')) {
    need(sameSet(Object.keys(registry.projects), pypiNames), 'results/registry.json', `projects [${Object.keys(registry.projects)}]`, `are not exactly the pinned packages [${pypiNames}]`);
    for (const [name, project] of Object.entries(registry.projects)) {
      need(isObject(project) && isList(project.released_after_pin, (r) => isObject(r) && isText(r.version)), `results/registry.json:${name}`, 'project {released_after_pin[]}');
    }
  }
  if (layerIds.length) {
    const layerOk = (l) => isObject(l)
      && isList(l.routes, (r) => isObject(r) && isText(r.path) && (r.method === null || isText(r.method)))
      && isList(l.flags, (f) => isObject(f) && isText(f.code) && (f.text === undefined || isText(f.text)));
    if (need(isObject(staticReport), 'results/static.json', 'the document') && need(isObject(staticReport.fixtures), 'results/static.json', 'fixtures')) {
      need(staticReport.schema === STATIC_RUNNER_SCHEMA, 'results/static.json', 'schema', `is not ${STATIC_RUNNER_SCHEMA}`);
      need(staticReport.target === framework, 'results/static.json', 'target', `is not ${framework}`);
      for (const [id, fx] of Object.entries(staticReport.fixtures)) {
        const where = `results/static.json:${id}`;
        if (!need(isObject(fx) && isObject(fx.layers) && sameSet(Object.keys(fx), ['layers']), where, 'fixture {layers}')) continue;
        if (!need(sameSet(Object.keys(fx.layers), layerIds), where, `layers [${Object.keys(fx.layers)}]`, `are not exactly the declared layers [${layerIds}]`)) continue;
        need(Object.values(fx.layers).every(layerOk), where, 'every layer {routes[], flags[]}');
      }
    }
  }
  return bad;
}

// The commands a record states are fixed by its pin and its target: one registry lookup per pinned package, the venv,
// install, freeze, wheel download and wheel digest of that pin, two oracle runs, three static runs when a scanner layer
// exists, and the profile ref check when a profile pin is recorded. Each has one output form and a command text that
// follows from the same inputs, so a command cannot be dropped, left without a recomputable output, or pointed at another
// package set, oracle or fixture tree while the hashes of what is stored still verify.
const OUTPUT_FORMS = ['stored_as', 'stdout_inline', 'stdout_empty', 'stdout_unstored'];
// The flags a pip command of a record may carry: those every record needs and those it may add. Any other flag (an index URL,
// --no-binary, extra requirements) changes what was installed or from where, and is not a command this record can state.
// The order of the flags is the record's own, but a flag that takes a value keeps it: -d is followed by wheels.
const PIP_FLAGS = {
  install: [['--only-binary=:all:'], ['--disable-pip-version-check', '--no-cache-dir', '-q']],
  download: [['--only-binary=:all:', '--no-deps', '-d', 'wheels'], ['--disable-pip-version-check', '--no-cache-dir', '-q']],
};
function expectedCommands(record, spec, isStatic) {
  const [major, minor] = record.pin.python.split('.');
  const interpreter = `python${major}.${minor}`;
  const exact = (text) => (got) => got === text;
  const pinned = record.pin.packages.map((p) => `${normalizeName(p.pypi)}==${p.version}`).sort();
  const named = (text) => text.split(/\s+/).filter((token) => token.includes('==')).map((token) => { const [name, version] = token.split('=='); return `${normalizeName(name)}==${version}`; }).sort();
  const pip = (verb) => (text) => {
    const [required, optional] = PIP_FLAGS[verb];
    const tokens = text.split(/\s+/);
    const rest = tokens.filter((token) => !token.includes('=='));
    return isDeepStrictEqual(rest.slice(0, 4), ['python', '-m', 'pip', verb]) && isDeepStrictEqual(named(text), pinned)
      && new Set(rest).size === rest.length && required.every((token) => rest.includes(token)) && rest.slice(4).every((token) => required.includes(token) || optional.includes(token))
      && (verb !== 'download' || tokens[tokens.indexOf('-d') + 1] === 'wheels');
  };
  const want = new Map();
  const set = (id, form, command, file) => want.set(id, { form, command, file });
  for (const p of record.pin.packages) set(`registry-${p.pypi}`, 'stdout_unstored', exact(`curl -fsS https://pypi.org/pypi/${p.pypi}/json`));
  set('venv', 'stdout_empty', exact(`${interpreter} -m venv $VENV`));
  set('install', 'stdout_empty', pip('install'));
  set('freeze', 'stored_as', exact('python -m pip freeze --all'), 'results/environment.txt');
  set('wheel', 'stdout_empty', pip('download'));
  set('wheel-digest', 'stored_as', exact(`shasum -a 256 ${record.pin.packages.map((p) => p.wheel).join(' ')}`), 'results/wheel-digest.txt');
  const target = `${spec.framework} ${spec.dir}/fixtures`;
  for (const id of ['oracle-1', 'oracle-2']) set(id, 'stored_as', exact(`$VENV/bin/python ${ORACLE_PATH} ${target}`), 'results/oracle.json');
  if (isStatic) {
    for (const id of ['static-1', 'static-2']) set(id, 'stored_as', exact(`node ${RUNNER_PATH} ${target}`), 'results/static.json');
    set(`static-py${major}${minor}`, 'stored_as', exact(`BSKEL_PYTHON=${interpreter} node ${RUNNER_PATH} ${target}`), 'results/static.json');
  }
  const existing = record.pin.existing_profile_pin;
  if (existing && !want.has(existing.check_command)) set(existing.check_command, 'stdout_inline', exact(`gh api repos/${existing.value.repo}/commits/${existing.value.ref} --jq .sha`));
  return want;
}

export function verifyStoredRecord(record, { dir }) {
  const problems = [];
  const add = (code, where, message) => problems.push({ code, where, message });
  const shape = schemaProblems(record);
  if (shape.length) return shape;
  const spec = SCOPE_TARGETS[record.item];
  const isStatic = Object.hasOwn(STATIC_LAYERS, record.framework);
  const layerIds = isStatic ? STATIC_LAYERS[record.framework] : [];
  if (record.record_digest !== sealOf(record)) add('seal', 'record_digest', 'the seal does not match the record content (an edit that was not re-sealed)');
  if (record.framework !== spec.framework || record.track !== spec.track) add('schema', 'item', 'framework or track does not match the item');
  if (record.claims.supported !== false) add('claims', 'claims.supported', 'a scope record never claims "supported"');
  if (record.claims.runtime_tested !== false) add('claims', 'claims.runtime_tested', 'nothing here ran a request, so Runtime-tested must stay false');
  if (record.claims.extraction !== (isStatic ? 'partial-static' : 'none')) add('claims', 'claims.extraction', 'extraction claim does not match the scanner layers that exist');
  if (record.evidence_level !== (isStatic ? 'oracle-compared' : 'scope-and-oracle-baseline')) add('claims', 'evidence_level', 'evidence level does not match the evidence that was run');
  if (record.oracle_tool.path !== ORACLE_PATH) add('oracle-binding', 'oracle_tool.path', `${record.oracle_tool.path} is not the oracle (${ORACLE_PATH}) that the stored results were produced with`);

  // executed commands: exit code, output hash and byte count are recomputed from what is stored, and the command set,
  // the output form and the command text are held to what the pin and the target imply (expectedCommands)
  const wanted = expectedCommands(record, spec, isStatic);
  const stored = new Map();
  const seen = new Set();
  for (const cmd of record.executed_commands) {
    const where = `executed_commands.${cmd.id}`;
    if (seen.has(cmd.id)) add('executed-command', where, 'duplicate command id');
    seen.add(cmd.id);
    const want = wanted.get(cmd.id);
    if (!want) add('executed-command', where, 'this record has no place for such a command (the commands follow from the pin and the target)');
    else {
      const forms = OUTPUT_FORMS.filter((form) => cmd[form] !== undefined);
      if (!isDeepStrictEqual(forms, [want.form])) add('executed-command', where, `output form [${forms}] is not exactly [${want.form}]`);
      else if (want.file !== undefined && cmd.stored_as !== want.file) add('executed-command', where, `stored as ${cmd.stored_as}, expected ${want.file}`);
      if (!want.command(cmd.command)) add('executed-command', where, `command text does not follow from the pin and the target: ${cmd.command}`);
    }
    if (cmd.exit_code !== 0) add('executed-command', where, `recorded exit code ${cmd.exit_code} is not 0`);
    let actual = null;
    if (cmd.stored_as !== undefined) {
      stored.set(cmd.stored_as, (stored.get(cmd.stored_as) ?? 0) + 1);
      const data = readBytes(path.join(dir, cmd.stored_as));
      if (data) actual = { sha: sha256(data), bytes: data.length }; else add('result-hash', where, `${cmd.stored_as} is missing or cannot be read`);
    } else if (cmd.stdout_inline !== undefined) actual = { sha: sha256(cmd.stdout_inline), bytes: Buffer.byteLength(cmd.stdout_inline) };
    else if (cmd.stdout_empty === true) actual = { sha: sha256(''), bytes: 0 };
    if (actual && (actual.sha !== cmd.stdout_sha256 || actual.bytes !== cmd.stdout_bytes)) add('result-hash', where, `recomputed ${actual.sha} (${actual.bytes} bytes) differs from the recorded output`);
  }
  for (const id of wanted.keys()) if (!seen.has(id)) add('executed-command', `executed_commands.${id}`, 'a command this record must state is missing');
  const wantedFiles = [...new Set([...stored.keys()].map((s) => s.slice('results/'.length)).concat('registry.json'))].sort();
  const resultsDir = path.join(dir, 'results');
  let listedFiles = [];
  try { listedFiles = fs.readdirSync(resultsDir).sort(); } catch { /* a missing or non-directory results/ lists nothing, which the next line reports */ }
  if (!isDeepStrictEqual(listedFiles, wantedFiles)) add('result-set', 'results', `stored files [${listedFiles}] differ from the recorded set [${wantedFiles}]`);

  // every stored result is read here, so a missing, unreadable or unparseable file (static.json included) is a
  // structured problem; nothing below is reached with a result that was not read
  let oracle; let registry; let environment; let digests; let staticReport = null;
  try {
    oracle = readJson(path.join(resultsDir, 'oracle.json'));
    const extract = fs.readFileSync(path.join(resultsDir, 'registry.json'));
    if (sha256(extract) !== record.pin.registry.extract_sha256) add('result-hash', 'pin.registry', 'registry extract hash differs from the recorded one');
    registry = JSON.parse(extract.toString('utf8'));
    environment = fs.readFileSync(path.join(resultsDir, 'environment.txt'), 'utf8').split('\n').filter(Boolean);
    digests = fs.readFileSync(path.join(resultsDir, 'wheel-digest.txt'), 'utf8').split('\n').filter(Boolean);
    if (isStatic) staticReport = readJson(path.join(resultsDir, 'static.json'));
  } catch (error) {
    add('result-set', 'results', `stored results cannot be read: ${error.message}`);
    return problems;
  }
  // parseable but wrongly shaped results are reported, not dereferenced
  const malformed = malformedResults({ oracle, registry, staticReport, framework: record.framework, layerIds, pypiNames: record.pin.packages.map((p) => p.pypi) });
  if (malformed.length) {
    for (const m of malformed) add('result-set', m.where, m.message);
    return problems;
  }

  // pins: registry extract, pip download digest, pip freeze and the oracle's own version report must agree
  const fixtureIds = record.fixtures.map((f) => f.id);
  if (!isDeepStrictEqual(Object.keys(oracle.fixtures).sort(), [...fixtureIds].sort())) add('result-set', 'results/oracle.json', 'oracle fixtures differ from the recorded fixtures');
  for (const [id, fx] of Object.entries(oracle.fixtures)) if (fx.error !== null) add('result-set', `results/oracle.json:${id}`, `fixture failed to import: ${fx.error}`);
  if (!isDeepStrictEqual(record.pin.installed, environment)) add('pin', 'pin.installed', 'recorded installed set differs from the stored pip freeze output');
  if (registry.fetched_utc !== record.pin.registry.fetched_utc) add('pin', 'pin.registry', 'fetch time differs from the registry extract');
  const wantDigests = record.pin.packages.map((p) => `${p.wheel_sha256}  ${p.wheel}`);
  if (!isDeepStrictEqual(digests, wantDigests)) add('pin', 'pin.packages', `the stored wheel digest lines [${digests}] are not exactly the pinned wheels [${wantDigests}]`);
  for (const pkg of record.pin.packages) {
    const where = `pin.packages.${pkg.pypi}`;
    const project = registry.projects?.[pkg.pypi];
    if (project?.pinned?.version !== pkg.version || project?.pinned?.filename !== pkg.wheel || project?.pinned?.sha256 !== pkg.registry_sha256) add('pin', where, 'registry extract disagrees with the pinned version, wheel or hash');
    if (pkg.wheel_sha256 !== pkg.registry_sha256) add('pin', where, 'the pip-downloaded wheel hash differs from the registry hash');
    if (!environment.some((line) => normalizeName(line.split('==')[0]) === normalizeName(pkg.pypi) && line.split('==')[1] === pkg.version)) add('pin', where, 'pip freeze does not list this exact version');
    if (!isDeepStrictEqual(pkg.released_after_pin_not_covered, (project?.released_after_pin ?? []).map((r) => r.version))) add('pin', where, 'releases after the pin differ from the registry extract');
  }
  const frameworkPackages = record.pin.packages.filter((p) => p.role === 'framework');
  const main = frameworkPackages[0];
  if (frameworkPackages.length !== 1 || normalizeName(main.pypi) !== record.framework) add('pin', 'pin.packages', 'the pin must list exactly one package with role framework, and it must be the package of the framework this record names');
  if (!main || oracle.framework.name !== record.framework || oracle.framework.version !== main.version) add('pin', 'pin.packages', 'the oracle reports a different framework or version than the pin');
  if (oracle.python.version !== record.pin.python || !isDeepStrictEqual(oracle.python, record.oracle_range.platform)) add('pin', 'oracle_range.platform', 'the oracle ran on a different interpreter or platform than recorded');
  const existing = record.pin.existing_profile_pin;
  if (existing) {
    const check = record.executed_commands.find((c) => c.id === existing.check_command);
    if (!/^[0-9a-f]{40}$/.test(existing.value.ref) || check?.stdout_inline !== `${existing.value.ref}\n`) add('pin', 'pin.existing_profile_pin', 'the pinned ref is not a 40-hex SHA confirmed by the recorded gh api output');
  }

  // fixtures and must-catch: each outcome is recomputed from the stored oracle and static results
  if (isStatic && !isDeepStrictEqual(Object.keys(staticReport.fixtures).sort(), [...fixtureIds].sort())) add('result-set', 'results/static.json', 'static fixtures differ from the recorded fixtures');
  if (isStatic && !isDeepStrictEqual(staticReport.layers, STATIC_LAYERS[record.framework])) add('result-set', 'results/static.json', 'static layers differ from the scanner layers under test');
  for (const f of record.fixtures) if (f.role !== (f.id === 'normal' ? 'normal' : 'counterexample')) add('must-catch', `fixtures.${f.id}`, 'fixture role does not match its id (only "normal" is the normal fixture, every other id is a counterexample)');
  if (!fixtureIds.includes('normal')) add('must-catch', 'fixtures', 'the normal fixture is missing');
  const mustIds = record.must_catch.map((mc) => mc.id);
  if (new Set(mustIds).size !== mustIds.length) add('must-catch', 'must_catch', 'duplicate must-catch id');
  for (const id of REQUIRED_CLASSES) if (!mustIds.includes(id)) add('must-catch', 'must_catch', `required class ${id} is missing`);
  if (!mustIds.some((id) => ruleOf(id) === 'catch-generated')) add('must-catch', 'must_catch', 'no catch-generated entry (generated-routes or generated-admin) is present');
  const used = new Set();
  for (const mc of record.must_catch) {
    const where = `must_catch.${mc.id}`;
    if (mc.rule !== ruleOf(mc.id)) add('must-catch', where, `rule ${mc.rule} is not the rule fixed for ${mc.id} (${ruleOf(mc.id)})`);
    if (mc.fixture !== fixtureOf(mc.id)) add('must-catch', where, `fixture ${mc.fixture} is not ${fixtureOf(mc.id)}, the fixture this entry id names`);
    const fixture = record.fixtures.find((f) => f.id === mc.fixture);
    used.add(mc.fixture);
    if (!fixture || !Object.hasOwn(oracle.fixtures, mc.fixture)) { add('must-catch', where, `fixture ${mc.fixture} is not a recorded fixture`); continue; }
    if (!Object.hasOwn(fixture.files, mc.minimal_counterexample)) add('must-catch', where, `${mc.minimal_counterexample} is not a file of fixture ${mc.fixture}`);
    if (mc.rule === 'oracle-blind' && !mc.blind_property) add('must-catch', where, 'an oracle-blind entry must name the property the oracle cannot see');
    const expected = oraclePairs(oracle.fixtures[mc.fixture]);
    if (!isDeepStrictEqual(mc.expected, expected)) add('must-catch', where, 'expected pairs differ from the stored oracle result');
    // an entry that names no ordinary route (or, for catch-generated, no generated route) in the oracle result could hold
    // without the scanner handling the construct, so the stored oracle result has to give it something to catch
    if (!expected.routes.length) add('must-catch', where, `the oracle registers no ordinary route for fixture ${mc.fixture}, so the entry could hold without the scanner handling anything`);
    if (mc.rule === 'catch-generated' && !expected.generated.length) add('must-catch', where, `the oracle registers no framework-generated route for fixture ${mc.fixture}, so a catch-generated entry would hold with nothing generated to catch`);
    if (!isDeepStrictEqual(Object.keys(mc.layers).sort(), [...layerIds].sort())) add('must-catch', where, 'layers differ from the scanner layers under test');
    for (const layerId of layerIds) {
      const declared = mc.layers[layerId];
      const output = Object.hasOwn(staticReport.fixtures, mc.fixture) ? staticReport.fixtures[mc.fixture].layers[layerId] : undefined;
      if (!declared) continue; // the layer-key comparison above reports a layer the entry does not declare
      if (!output) { add('must-catch', `${where}@${layerId}`, `no stored static output for fixture ${mc.fixture}, layer ${layerId}: the declared outcome cannot be recomputed`); continue; }
      for (const covering of declared.covering_flags) if (!output.flags.some((f) => flagMatches(f, covering))) add('must-catch', `${where}@${layerId}`, `declared covering flag ${covering.code} is not emitted by the layer`);
      const compared = compareLayer(expected, output.routes);
      const derived = { ...compared, outcome: outcomeOf(mc.rule, compared, declared.covering_flags.length > 0), flags: [...new Set(output.flags.map((f) => f.code))].sort() };
      const { covering_flags: _covering, ...recorded } = declared;
      if (!isDeepStrictEqual(recorded, derived)) add('must-catch', `${where}@${layerId}`, `recorded ${JSON.stringify(recorded)} differs from recomputed ${JSON.stringify(derived)}`);
    }
  }
  for (const id of fixtureIds) if (!used.has(id)) add('must-catch', `fixtures.${id}`, 'fixture is not referenced by any must-catch entry');
  if (!isDeepStrictEqual(record.scope, derivePartition(record))) add('partition', 'scope', 'scope partition differs from the recomputed outcomes');
  const wantConformance = isStatic ? { status: 'COMPARED', layers: STATIC_LAYERS[record.framework], compared_fixtures: fixtureIds.length } : { status: 'BLOCKED' };
  const { reason, ...haveConformance } = record.conformance;
  if (!isDeepStrictEqual(haveConformance, wantConformance) || (!isStatic && !reason)) add('conformance', 'conformance', 'conformance status does not match the scanner layers that exist (BLOCKED needs a reason)');
  return problems;
}

export function verifyLiveTree(record, { dir, root = REPO_ROOT }) {
  const shape = schemaProblems(record);
  if (shape.length) return shape;
  const problems = [];
  const add = (code, where, message) => problems.push({ code, where, message });
  const spec = SCOPE_TARGETS[record.item];
  const isStatic = Object.hasOwn(STATIC_LAYERS, record.framework);
  const fixturesRoot = path.join(dir, 'fixtures');
  for (const layer of record.layers) {
    if (!fs.existsSync(path.join(root, layer.source))) add('layer-source', `layers.${layer.id}`, `${layer.source} does not exist`);
    const runs = Object.hasOwn(STATIC_LAYER_SOURCES, layer.id) ? STATIC_LAYER_SOURCES[layer.id] : null;
    if (layer.source !== runs) add('layer-source', `layers.${layer.id}`, `source ${layer.source} is not the file the static runner exercises for this layer (${runs})`);
  }
  if (!isDeepStrictEqual(record.layers.map((l) => l.id), isStatic ? STATIC_LAYERS[record.framework] : [])) add('layer-source', 'layers', 'recorded layers differ from the layers the static runner exercises');

  const liveIds = walkIfDir(fixturesRoot).filter((f) => path.posix.basename(f) === spec.entry).map((f) => path.posix.dirname(f)).sort();
  if (!isDeepStrictEqual(liveIds, record.fixtures.map((f) => f.id).sort())) add('fixture-set', 'fixtures', `live fixtures [${liveIds}] differ from the recorded ones`);
  const assigned = new Set();
  const frameworkPin = record.pin.packages.find((p) => p.role === 'framework');
  for (const fixture of record.fixtures) {
    const live = walkIfDir(path.join(fixturesRoot, fixture.id));
    for (const rel of live) assigned.add(`${fixture.id}/${rel}`);
    if (!isDeepStrictEqual([...live].sort(), Object.keys(fixture.files).sort())) add('fixture-set', `fixtures.${fixture.id}`, `live files [${live}] differ from the recorded files`);
    for (const [rel, expected] of Object.entries(fixture.files)) {
      // a missing or unreadable file is already a fixture-set problem (the live file list differs from the recorded one)
      const bytes = readBytes(path.join(fixturesRoot, fixture.id, rel));
      if (bytes && sha256(bytes) !== expected) add('fixture-hash', `fixtures.${fixture.id}/${rel}`, 'file content differs from the recorded sha256');
      if (rel === 'requirements.txt' && bytes && bytes.toString('utf8') !== `${record.framework}==${frameworkPin?.version}\n`) add('fixture-hash', `fixtures.${fixture.id}/${rel}`, 'requirements.txt does not pin the recorded framework version');
    }
  }
  for (const rel of walkIfDir(fixturesRoot)) if (!assigned.has(rel)) add('fixture-set', rel, 'file belongs to no recorded fixture');

  const oracleBytes = readBytes(path.join(root, record.oracle_tool.path));
  if (!oracleBytes || sha256(oracleBytes) !== record.oracle_tool.sha256) add('oracle-binding', 'oracle_tool', 'oracle.py differs from the version the stored oracle results were produced with');

  const registration = liveRegistration(record.framework);
  if (!isDeepStrictEqual(record.registration, registration)) add('registration', 'registration', 'recorded registration differs from the live profile or catalog entry');
  const existing = record.pin.existing_profile_pin;
  const profile = record.framework === 'flask' ? FLASK_PROFILE : record.framework === 'django' ? DJANGO_DRF_PROFILE : null;
  if (!isDeepStrictEqual(existing?.value ?? null, profile?.versionPin ?? null)) add('registration', 'pin.existing_profile_pin', 'the recorded profile pin differs from the live profile versionPin (a pin that was dropped, invented or changed)');
  const pinSource = profile ? `${registration.source} ${record.framework === 'flask' ? 'FLASK_PROFILE' : 'DJANGO_DRF_PROFILE'}.versionPin` : null;
  if (existing && pinSource && existing.source !== pinSource) add('registration', 'pin.existing_profile_pin', `source ${existing.source} is not where the live profile pin is read from (${pinSource})`);
  if (record.framework === 'django') {
    const [django, drf] = ['django', 'djangorestframework'].map((n) => record.pin.packages.find((p) => p.pypi === n)?.version);
    if (DJANGO_DRF_PROFILE.versionPin.framework !== `Django ${django} / djangorestframework ${drf}`) add('registration', 'pin.packages', 'record pins differ from the versions named by the live Django/DRF profile pin');
  }

  if (isStatic) {
    let live = null;
    try {
      live = serializeStatic(runStatic(record.framework, fixturesRoot));
    } catch (error) {
      add('static-run-failed', 'results/static.json', `the live static run did not complete (python3 on PATH is required): ${error.message}`);
    }
    if (live !== null && live !== readText(path.join(dir, 'results/static.json'))) add('static-drift', 'results/static.json', 'a live run of the in-repo scanners differs from the stored static result (or the stored result cannot be read)');
  } else {
    // scope-only record: a scanner or adapter path named after the framework (outside this record's own directory)
    // means the record is out of date
    const hits = ['scanners', 'adapters'].flatMap((top) => walkIfDir(path.join(root, top)).map((f) => `${top}/${f}`))
      .filter((f) => !f.startsWith(`${spec.dir}/`) && f.toLowerCase().includes(record.framework));
    if (hits.length) add('adapter-appeared', 'layers', `a scanner or adapter file for ${record.framework} now exists (${hits.join(', ')}); this scope-only record must be re-issued`);
  }
  return problems;
}

export function verifyScopeRecord(record, { dir, root = REPO_ROOT }) {
  const stored = verifyStoredRecord(record, { dir });
  return stored.some((p) => p.code === 'schema') ? stored : [...stored, ...verifyLiveTree(record, { dir, root })];
}

// The CLI body. Every failure is printed as a structured problem line, including an unknown item, an unreadable
// SCOPE.json and unreadable or wrongly shaped stored results; it returns the number of problems.
export function verifyItems(items, { root = REPO_ROOT, log = console.log } = {}) {
  let failed = 0;
  for (const item of items) {
    let loaded;
    if (!Object.hasOwn(SCOPE_TARGETS, item)) loaded = { problems: [{ code: 'schema', where: 'item', message: `${item} is not one of ${Object.keys(SCOPE_TARGETS).join(', ')}` }] };
    else {
      try { loaded = { record: loadRecord(item, root) }; } catch (error) { loaded = { problems: [{ code: 'schema', where: 'SCOPE.json', message: `the record cannot be read: ${error.message}` }] }; }
    }
    const named = loaded.record?.item;
    const problems = loaded.problems ?? [
      ...(named === item ? [] : [{ code: 'schema', where: 'SCOPE.json', message: `the record names ${JSON.stringify(named)} but is stored as the record of ${item}` }]),
      ...verifyScopeRecord(loaded.record, { dir: recordDir(item, root), root }),
    ];
    log(`${item}: ${problems.length ? 'FAIL' : 'ok'}`);
    for (const p of problems) log(`  [${p.code}] ${p.where}: ${p.message}`);
    failed += problems.length;
  }
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = verifyItems(process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCOPE_TARGETS)) ? 1 : 0;
}
