// Verifier for the Python HTTP scope records (HTTP-python-*-01).
//   verifyStoredRecord: the record against its own stored results (record corruption)
//   verifyLiveTree:     the record against the checked-out tree (fixtures, scanners, oracle.py, registrations)
// CLI: node verify.mjs [item-id ...]   (exit code 1 on any problem; python3 must be on PATH, there is no skip)
// Stored results are untrusted input: one that is missing, unreadable, unparseable or wrongly shaped is reported as a
// "result-set" problem (a missing fixture tree as "fixture-set"), never thrown, so the CLI always prints its report.
//
// Every key of a record is held in one of four ways, and what none of them reaches is a stated limit (the last limit of each record):
//   recomputed  derived again from a second source and compared exactly: the sha256 and byte count of every command output that is
//               stored, inline or empty; each fixture file hash; the wheel digests; the registry extract hash; the oracle.py hash; the
//               pin against the registry extract, pip freeze, the wheel digests and the oracle's own version report; every expected
//               pair list, outcome, flag set and the scope partition (from the stored oracle and static results); the static
//               results (the in-repo scanners are re-run and compared byte for byte); the registration and the profile pin
//               (against the live profile).
//   exact       compared character for character with the one value the pin and the target imply, with nothing split, filtered,
//               sorted or case-folded first: the commands (their set, their order, each text, its output form and stored file, exit
//               code 0), the members of every stored document in the order their tool prints them, the text of each stored
//               document (SCOPE.json, oracle.json, registry.json, static.json), the line grammar of the .txt results, the fixture
//               list, and the file list of each fixture.
//   absent      the schema allows no such member: a hash or a size beside stdout_unstored (the PyPI response is volatile and is not
//               stored, so nothing here could recompute them), and any member the schema does not name.
//   prose       sealed, not recomputed: statement, reasons, limits, plan, oracle_range text, layer roles, construct, blind_property,
//               covers and the stdout_unstored text. An edit that IS re-sealed is not detected here; it shows up in the review diff.
// Held to shape, order and the hash of the file only: the oracle row members no comparison reads (kind, name, view, regex,
// viewset_actions), a generated group's name, the registry extract values no comparison reads, the packages pip freeze printed
// besides the pinned ones, a HEAD or OPTIONS method, and the path of a generated route that has no other method.
// record_digest seals the whole record except its own field (sha256 over the canonical JSON: sorted keys, no whitespace), so an edit
// that is not re-sealed fails with code "seal". The seal sorts keys, not lists.
// The command rule (expectedCommands): `python -m pip <verb>` first, then the flags in the order of the template (a flag that takes a
// value is followed by it), then the pins name==version last in the order of pin.packages; single spaces, no leading or trailing
// whitespace. Statuses are bound by recomputation, not by membership: outcomes and the scope partition come from the stored oracle
// and static results, the rule of a must-catch id and the role of a fixture id are fixed below, and the test file freezes the
// partition each item is expected to publish.
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
import { canonical, runStatic, serializeStatic, STATIC_LAYERS, STATIC_LAYER_SOURCES, STATIC_RUNNER_SCHEMA, walk } from './static-runner.mjs';
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
// A hash or a size beside stdout_unstored is the one place the schema answers "false schema": a command whose output is not stored
// states neither, because nothing here could recompute them.
const NOT_RECOMPUTABLE = 'must not be present: no output of this command is stored, so there is nothing to recompute it from';
const schemaProblems = (record) => (validateShape(record) ? [] : validateShape.errors.map((e) => ({ code: 'schema', where: e.instancePath || '/', message: e.keyword === 'false schema' ? NOT_RECOMPUTABLE : e.message })));
// Stored evidence is untrusted input and is read exactly: invalid UTF-8 is an error (it is never replaced by U+FFFD), a byte-order
// mark stays in the text, and only a regular file counts (a symbolic link or a directory is not the stored file). A file that is
// missing or cannot be read comes back as null (or as an empty walk) so that the caller reports a problem, and the CLI never
// ends in an uncaught exception.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const readExact = (file) => {
  if (!fs.lstatSync(file).isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  return fs.readFileSync(file);
};
const readBytes = (file) => { try { return readExact(file); } catch { return null; } };
const readJson = (file) => JSON.parse(UTF8.decode(readExact(file)));
const walkIfDir = (dir) => { try { return fs.lstatSync(dir).isDirectory() ? walk(dir) : []; } catch { return []; } };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isList = (value, test) => Array.isArray(value) && value.every(test);
const sameKeys = (value, keys) => isObject(value) && isDeepStrictEqual(Object.keys(value), keys);
// PEP 503 form of a name as pip freeze prints it (the distribution's own spelling: Flask, Jinja2). It is used for those lines only:
// the version of a line is compared exactly and a pinned package must be listed exactly once. Every pypi name a record states is
// already canonical (the schema pattern), and a wheel file name is compared without any folding (see the wheel check below).
const canonicalName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const sameSet = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
// Text lines of a stored .txt result: newline-terminated, no empty line, no carriage return; null when the text is not that.
const linesOf = (text) => {
  if (!text.endsWith('\n')) return null;
  const parts = text.slice(0, -1).split('\n');
  return parts.every((line) => line.length > 0 && !line.includes('\r')) ? parts : null;
};
// Python orders and prints strings by code point; UTF-8 byte order is the same order (JS compares UTF-16 units).
const byCodePoint = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const ascending = (list, strict) => list.every((item, i) => i === 0 || byCodePoint(list[i - 1], item) < (strict ? 0 : 1));
const BACKSLASH = String.fromCharCode(92);
// json.dumps(ensure_ascii=True) of a string: everything outside space..tilde (DEL included) becomes a lowercase four-digit escape.
const pyString = (text) => JSON.stringify(text).replace(/[^\x20-\x7e]/g, (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
// json.dumps(value, sort_keys=True, indent=1), the text oracle.py prints (without its final newline).
export function pythonJson(value, depth = 0) {
  const pad = ' '.repeat(depth + 1);
  const end = ' '.repeat(depth);
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => pad + pythonJson(v, depth + 1)).join(',\n')}\n${end}]` : '[]';
  if (isObject(value)) {
    const keys = Object.keys(value).sort(byCodePoint);
    return keys.length ? `{\n${keys.map((k) => `${pad}${pyString(k)}: ${pythonJson(value[k], depth + 1)}`).join(',\n')}\n${end}}` : '{}';
  }
  return isText(value) ? pyString(value) : JSON.stringify(value);
}
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
const recordFile = (item, root = REPO_ROOT) => path.join(recordDir(item, root), 'SCOPE.json');
export const loadRecord = (item, root = REPO_ROOT) => readJson(recordFile(item, root));
// The text SCOPE.json has: what JSON.stringify prints for the record it holds, two-space indent, one final newline.
export const printedRecord = (record) => `${JSON.stringify(record, null, 2)}\n`;

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

// The members of every stored document, in the order the tool that wrote it prints them, and the types they hold. A document with a
// member more, fewer, moved or of another type is reported as a "result-set" problem before anything reads into it: a member
// nobody reads is still part of the hashed file, so it is held to the table instead of being read around.
const ORACLE_KEYS = ['fixtures', 'framework', 'oracle', 'python'];
const ORACLE_PYTHON_KEYS = ['implementation', 'machine', 'system', 'version'];
const ORACLE_FIXTURE_KEYS = ['error', 'generated_groups', 'routes'];
const ORACLE_GROUP_KEYS = ['count', 'group', 'paths_sorted'];
const ORACLE_ROW_KEYS = {
  fastapi: ['generated', 'kind', 'methods', 'name', 'path'],
  flask: ['generated', 'methods', 'name', 'path'],
  django: ['generated', 'methods', 'name', 'path', 'regex', 'view', 'viewset_actions'],
  starlette: ['generated', 'kind', 'methods', 'name', 'path'],
  litestar: ['generated', 'kind', 'methods', 'name', 'path'],
};
const REGISTRY_SOURCE = 'PyPI JSON API https://pypi.org/pypi/<project>/json';
const REGISTRY_KEYS = ['source', 'fetched_utc', 'projects'];
const REGISTRY_PROJECT_KEYS = ['info_version', 'requires_python', 'pinned', 'released_after_pin'];
const REGISTRY_PINNED_KEYS = ['version', 'filename', 'sha256', 'size', 'upload_time_iso_8601', 'yanked'];
const REGISTRY_RELEASE_KEYS = ['version', 'upload_time_iso_8601'];
const UPLOAD_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
const STATIC_KEYS = ['fixtures', 'layers', 'schema', 'target'];
// per static layer id: the members a layer has, and the member sets a flag of that layer may have (every flag member is a string)
const STATIC_LAYER_MEMBERS = {
  'legacy-adapter': { layer: ['detected', 'flags', 'routes'], flags: [['code', 'prefix', 'where']] },
  't06-fastapi-shadow': { layer: ['flags', 'routes'], flags: [['code', 'where']] },
  't06-flask-shadow': { layer: ['flags', 'routes'], flags: [['code', 'where'], ['code', 'text', 'where']] },
  't12-flask-leaf': { layer: ['flags', 'routes'], flags: [['code', 'where']] },
  't06-django-shadow': { layer: ['flags', 'routes'], flags: [['code', 'where']] },
  't12-django-drf-leaf': { layer: ['flags', 'observations', 'routes', 'status'], flags: [['code', 'where']] },
};
const matches = (pattern, value) => isText(value) && pattern.test(value);

// The shapes verifyStoredRecord dereferences. A stored results file that parses but has another shape is reported as a
// "result-set" problem before any check reads into it, instead of surfacing as a TypeError. The comparisons further down only
// visit what is present, so the shape is pinned here, member by member: the document members above; each stored fixture carries
// exactly the declared static layers; every oracle route has the row members of its framework, a boolean generated flag and a
// method list that is null or non-empty and strictly ascending, and the rows come in the order oracle.py sorts them, none twice; a
// generated group lists each path once, in ascending order; an ordinary route keeps a method besides HEAD and OPTIONS (every
// comparison drops those two, so it would vanish from every pair); the registry extract holds exactly the pinned projects in the
// pin order.
function malformedResults({ oracle, registry, staticReport, framework, layerIds, pypiNames }) {
  const bad = [];
  const need = (ok, where, what, how = 'is missing or has the wrong type') => { if (!ok) bad.push({ where, message: `${what} ${how}` }); return ok; };
  const members = (value, keys, where, what = 'the document') => need(sameKeys(value, keys), where, `${what} members [${Object.keys(value)}]`, `are not exactly [${keys}], in that order`);
  const rowKeys = ORACLE_ROW_KEYS[framework];
  const methodList = (list) => isList(list, isText) && list.length > 0 && ascending(list, true);
  const oracleRoute = (r) => sameKeys(r, rowKeys) && isText(r.path) && typeof r.generated === 'boolean' && (r.name === null || isText(r.name))
    && (!rowKeys.includes('kind') || isText(r.kind)) && (r.methods === null || methodList(r.methods))
    && (framework !== 'django' || (r.methods === null && typeof r.regex === 'boolean' && isText(r.view) && (r.viewset_actions === null || methodList(r.viewset_actions))));
  const oracleGroup = (g) => sameKeys(g, ORACLE_GROUP_KEYS) && isText(g.group) && isList(g.paths_sorted, isText) && g.paths_sorted.length > 0
    && ascending(g.paths_sorted, true) && g.count === g.paths_sorted.length;
  // oracle.py sorts rows by (path, json.dumps(methods), name or ""); ties keep their order, so equal keys are fine
  const rowKey = (r) => [r.path, r.methods === null ? 'null' : `[${r.methods.map(pyString).join(', ')}]`, r.name ?? ''];
  const rowsInOrder = (rows) => rows.every((row, i) => {
    if (i === 0) return true;
    const [before, after] = [rowKey(rows[i - 1]), rowKey(row)];
    for (let k = 0; k < before.length; k++) { const c = byCodePoint(before[k], after[k]); if (c !== 0) return c < 0; }
    return true;
  });
  if (need(isObject(oracle), 'results/oracle.json', 'the document')) {
    members(oracle, ORACLE_KEYS, 'results/oracle.json');
    need(oracle.oracle === 'framework-route-table', 'results/oracle.json', 'oracle', 'is not "framework-route-table"');
    need(sameKeys(oracle.framework, ['name', 'version']) && isText(oracle.framework.name) && isText(oracle.framework.version), 'results/oracle.json', 'framework {name, version}');
    need(sameKeys(oracle.python, ORACLE_PYTHON_KEYS) && Object.values(oracle.python).every(isText), 'results/oracle.json', 'python {implementation, machine, system, version}');
    if (need(isObject(oracle.fixtures), 'results/oracle.json', 'fixtures')) {
      for (const [id, fx] of Object.entries(oracle.fixtures)) {
        const where = `results/oracle.json:${id}`;
        if (!need(sameKeys(fx, ORACLE_FIXTURE_KEYS) && (fx.error === null || isText(fx.error)) && isList(fx.routes, oracleRoute) && isList(fx.generated_groups, oracleGroup),
          where, 'fixture {error, routes[{path, methods, generated}], generated_groups[{group, count, paths_sorted}]}', 'is missing, has members other than oracle.py prints, or holds a malformed row')) continue;
        need(rowsInOrder(fx.routes), where, 'routes', 'are not in the order oracle.py prints (sorted by path, then methods, then name)');
        // the comparisons collapse a pair into a set, so a row repeated in every member could not be told from a framework that
        // registers a route twice; no stored oracle result repeats a row or a group path, and a record that needs one has to say so
        need(new Set(fx.routes.map((r) => JSON.stringify(r))).size === fx.routes.length, where, 'routes', 'list a route twice (two rows are equal in every member)');
        need(framework === 'django' ? ascending(fx.generated_groups.map((g) => g.group), true) : fx.generated_groups.length === 0, where, 'generated_groups',
          framework === 'django' ? 'are not in the order oracle.py prints (sorted by group, no group twice)' : 'must be empty: only the django oracle reports groups');
        // a generated route may be the framework's implicit OPTIONS handler (Litestar adds one per path), which is dropped on purpose
        for (const route of fx.routes) need(route.generated || route.methods === null || route.methods.some((m) => !DROPPED.has(m)), where, `route ${route.path} [${route.methods}]`,
          'has no method besides HEAD and OPTIONS, which every comparison drops, so it would vanish from the expected pairs');
      }
    }
  }
  if (need(isObject(registry), 'results/registry.json', 'the document') && need(isObject(registry.projects), 'results/registry.json', 'projects')) {
    members(registry, REGISTRY_KEYS, 'results/registry.json');
    need(registry.source === REGISTRY_SOURCE, 'results/registry.json', 'source', `is not ${REGISTRY_SOURCE}`);
    need(isText(registry.fetched_utc), 'results/registry.json', 'fetched_utc');
    need(isDeepStrictEqual(Object.keys(registry.projects), pypiNames), 'results/registry.json', `projects [${Object.keys(registry.projects)}]`, `are not exactly the pinned packages [${pypiNames}], in the pin order`);
    for (const [name, project] of Object.entries(registry.projects)) {
      const where = `results/registry.json:${name}`;
      if (!need(sameKeys(project, REGISTRY_PROJECT_KEYS), where, 'project', `members are not exactly [${REGISTRY_PROJECT_KEYS}], in that order`)) continue;
      const { pinned, released_after_pin: releases } = project;
      need(isText(project.info_version) && isText(project.requires_python), where, 'info_version and requires_python');
      need(sameKeys(pinned, REGISTRY_PINNED_KEYS) && isText(pinned.version) && isText(pinned.filename) && matches(/^[0-9a-f]{64}$/, pinned.sha256)
        && Number.isInteger(pinned.size) && pinned.size >= 0 && matches(UPLOAD_TIME, pinned.upload_time_iso_8601) && typeof pinned.yanked === 'boolean',
      where, 'pinned {version, filename, sha256, size, upload_time_iso_8601, yanked}');
      if (need(isList(releases, (r) => sameKeys(r, REGISTRY_RELEASE_KEYS) && isText(r.version) && matches(UPLOAD_TIME, r.upload_time_iso_8601)), where, 'released_after_pin[{version, upload_time_iso_8601}]')) {
        need(new Set(releases.map((r) => r.version)).size === releases.length, where, 'released_after_pin', 'lists a version twice');
      }
    }
  }
  if (layerIds.length) {
    const layerOk = (id, layer) => {
      const table = STATIC_LAYER_MEMBERS[id];
      if (!sameKeys(layer, table.layer)) return false;
      const flagOk = (f) => isObject(f) && table.flags.some((keys) => isDeepStrictEqual(Object.keys(f), keys)) && Object.values(f).every(isText)
        && (id !== 't06-flask-shadow' || ('text' in f) === (f.code === 'registration-limitation'));
      const routeOk = (r) => sameKeys(r, ['method', 'path']) && isText(r.path) && (r.method === null || isText(r.method));
      return isList(layer.routes, routeOk) && isList(layer.flags, flagOk)
        && (id !== 'legacy-adapter' || typeof layer.detected === 'boolean')
        && (id !== 't12-django-drf-leaf' || (Number.isInteger(layer.observations) && layer.observations >= 0 && isText(layer.status)));
    };
    if (need(isObject(staticReport), 'results/static.json', 'the document') && need(isObject(staticReport.fixtures), 'results/static.json', 'fixtures')) {
      members(staticReport, STATIC_KEYS, 'results/static.json');
      need(staticReport.schema === STATIC_RUNNER_SCHEMA, 'results/static.json', 'schema', `is not ${STATIC_RUNNER_SCHEMA}`);
      need(staticReport.target === framework, 'results/static.json', 'target', `is not ${framework}`);
      for (const [id, fx] of Object.entries(staticReport.fixtures)) {
        const where = `results/static.json:${id}`;
        if (!need(isObject(fx) && isObject(fx.layers) && sameKeys(fx, ['layers']), where, 'fixture {layers}')) continue;
        if (!need(sameSet(Object.keys(fx.layers), layerIds), where, `layers [${Object.keys(fx.layers)}]`, `are not exactly the declared layers [${layerIds}]`)) continue;
        for (const layerId of layerIds) need(layerOk(layerId, fx.layers[layerId]), where, `layer ${layerId} {${STATIC_LAYER_MEMBERS[layerId].layer}}`, 'is missing, has other members than the scanner prints, or holds a malformed route or flag');
      }
    }
  }
  return bad;
}

// The commands a record states are fixed by its pin and its target, in this order: one registry lookup per pinned package (pin order),
// the venv, install, freeze, wheel download and wheel digest of that pin, two oracle runs, three static runs when a scanner layer
// exists, and the profile ref check when a profile pin is recorded. Each has one output form and ONE command text built from the
// same inputs, and the record's text must equal it character for character: nothing is split, filtered, sorted or case-folded
// before the comparison, so a command cannot be dropped, moved, repeated, left without a recomputable output, or pointed at another
// package set, oracle or fixture tree while the hashes of what is stored still verify.
// The flag-order rule: `python -m pip <verb>` first, then the flags in exactly the order of the template (a flag that takes a value
// is followed by it, -d wheels), then the pins name==version last in the order of pin.packages; single spaces, no leading or
// trailing whitespace. A pin before the flags, a moved, repeated, dropped or added flag, or another index URL is a different text.
const OUTPUT_FORMS = ['stored_as', 'stdout_inline', 'stdout_empty', 'stdout_unstored'];
// Flask's two pip commands ran without --no-cache-dir; the commands of every other record carry it, at the position below.
const PIP_NO_CACHE_DIR = { fastapi: true, flask: false, django: true, starlette: true, litestar: true };
export function expectedCommands(record) {
  const spec = SCOPE_TARGETS[record.item];
  const [major, minor] = record.pin.python.split('.');
  const interpreter = `python${major}.${minor}`;
  const pins = record.pin.packages.map((p) => `${p.pypi}==${p.version}`).join(' ');
  const cache = PIP_NO_CACHE_DIR[record.framework] ? ' --no-cache-dir' : '';
  const target = `${spec.framework} ${spec.dir}/fixtures`;
  const list = [];
  const add = (id, form, command, file) => list.push({ id, form, command, file });
  for (const p of record.pin.packages) add(`registry-${p.pypi}`, 'stdout_unstored', `curl -fsS https://pypi.org/pypi/${p.pypi}/json`);
  add('venv', 'stdout_empty', `${interpreter} -m venv $VENV`);
  add('install', 'stdout_empty', `python -m pip install --disable-pip-version-check${cache} --only-binary=:all: -q ${pins}`);
  add('freeze', 'stored_as', 'python -m pip freeze --all', 'results/environment.txt');
  add('wheel', 'stdout_empty', `python -m pip download --no-deps${cache} --only-binary=:all: --disable-pip-version-check -d wheels -q ${pins}`);
  add('wheel-digest', 'stored_as', `shasum -a 256 ${record.pin.packages.map((p) => p.wheel).join(' ')}`, 'results/wheel-digest.txt');
  for (const id of ['oracle-1', 'oracle-2']) add(id, 'stored_as', `$VENV/bin/python ${ORACLE_PATH} ${target}`, 'results/oracle.json');
  if (Object.hasOwn(STATIC_LAYERS, record.framework)) {
    for (const id of ['static-1', 'static-2']) add(id, 'stored_as', `node ${RUNNER_PATH} ${target}`, 'results/static.json');
    add(`static-py${major}${minor}`, 'stored_as', `BSKEL_PYTHON=${interpreter} node ${RUNNER_PATH} ${target}`, 'results/static.json');
  }
  const profile = record.pin.existing_profile_pin;
  if (profile) add(profile.check_command, 'stdout_inline', `gh api repos/${profile.value.repo}/commits/${profile.value.ref} --jq .sha`);
  return list;
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

  // executed commands: the command set, its order, each command text and the output form are held to what the pin and the target
  // imply (expectedCommands); the exit code is compared exactly; the hash and byte count of every output that is stored, inline or
  // empty are recomputed. A command whose output is not stored (the PyPI response) carries neither: the schema allows no hash and
  // no size beside stdout_unstored and requires both beside every other form, so no command states what it cannot recompute and no
  // hash check is skipped for want of an output (outputOf answers undefined only for stdout_unstored, or when no form is
  // present, and the form comparison below reports that).
  const wanted = expectedCommands(record);
  const wantedById = new Map(wanted.map((w) => [w.id, w]));
  const stored = new Set();
  const seen = new Set();
  const outputOf = (cmd) => {
    if (cmd.stdout_unstored !== undefined) return undefined;
    if (cmd.stored_as !== undefined) return readBytes(path.join(dir, cmd.stored_as));
    if (cmd.stdout_inline !== undefined) return Buffer.from(cmd.stdout_inline);
    return cmd.stdout_empty === true ? Buffer.alloc(0) : undefined;
  };
  for (const cmd of record.executed_commands) {
    const where = `executed_commands.${cmd.id}`;
    if (seen.has(cmd.id)) add('executed-command', where, 'duplicate command id');
    seen.add(cmd.id);
    const want = wantedById.get(cmd.id);
    if (!want) add('executed-command', where, 'this record has no place for such a command (the commands follow from the pin and the target)');
    else {
      const forms = OUTPUT_FORMS.filter((form) => cmd[form] !== undefined);
      if (!isDeepStrictEqual(forms, [want.form])) add('executed-command', where, `output form [${forms}] is not exactly [${want.form}]`);
      else if (want.file !== undefined && cmd.stored_as !== want.file) add('executed-command', where, `stored as ${cmd.stored_as}, expected ${want.file}`);
      if (cmd.command !== want.command) add('executed-command', where, `command text does not follow from the pin and the target: ${cmd.command}`);
    }
    if (cmd.exit_code !== 0) add('executed-command', where, `recorded exit code ${cmd.exit_code} is not 0`);
    if (cmd.stored_as !== undefined) stored.add(cmd.stored_as);
    const output = outputOf(cmd);
    if (output === null) add('result-hash', where, `${cmd.stored_as} is missing or cannot be read`);
    else if (output !== undefined && (sha256(output) !== cmd.stdout_sha256 || output.length !== cmd.stdout_bytes)) add('result-hash', where, `recomputed ${sha256(output)} (${output.length} bytes) differs from the recorded output`);
  }
  for (const w of wanted) if (!seen.has(w.id)) add('executed-command', `executed_commands.${w.id}`, 'a command this record must state is missing');
  const commandIds = record.executed_commands.map((c) => c.id);
  const wantedIds = wanted.map((w) => w.id);
  if (sameSet(commandIds, wantedIds) && !isDeepStrictEqual(commandIds, wantedIds)) add('executed-command', 'executed_commands', `the commands [${commandIds}] are not in the order [${wantedIds}] that the pin and the target imply`);
  const wantedFiles = [...new Set([...stored].map((s) => s.slice('results/'.length)).concat('registry.json'))].sort();
  const resultsDir = path.join(dir, 'results');
  let listedFiles = [];
  try { listedFiles = fs.readdirSync(resultsDir).sort(); } catch { /* a missing or non-directory results/ lists nothing, which the next line reports */ }
  if (!isDeepStrictEqual(listedFiles, wantedFiles)) add('result-set', 'results', `stored files [${listedFiles}] differ from the recorded set [${wantedFiles}]`);

  // every stored result is read here, strictly (UTF-8 or an error, regular files only), so a missing, unreadable or unparseable
  // file (static.json included) is a structured problem; nothing below is reached with a result that was not read
  const texts = {};
  let oracle; let registry; let environment; let digests; let staticReport = null;
  try {
    const load = (name) => { texts[name] = UTF8.decode(readExact(path.join(resultsDir, name))); return texts[name]; };
    oracle = JSON.parse(load('oracle.json'));
    const extract = readExact(path.join(resultsDir, 'registry.json'));
    if (sha256(extract) !== record.pin.registry.extract_sha256) add('result-hash', 'pin.registry', 'registry extract hash differs from the recorded one');
    texts['registry.json'] = UTF8.decode(extract);
    registry = JSON.parse(texts['registry.json']);
    environment = linesOf(load('environment.txt'));
    digests = linesOf(load('wheel-digest.txt'));
    if (isStatic) staticReport = JSON.parse(load('static.json'));
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
  // each JSON document is exactly the text its tool prints for the document it holds (member order, spacing, escaping, final
  // newline), so a duplicate key, a re-indented or re-escaped file or a changed line end cannot hide behind a parse
  const printed = [['oracle.json', `${pythonJson(oracle)}\n`], ['registry.json', `${JSON.stringify(registry, null, 1)}\n`]];
  if (isStatic) printed.push(['static.json', serializeStatic(canonical(staticReport))]);
  for (const [name, text] of printed) if (texts[name] !== text) add('result-set', `results/${name}`, 'is not the text its tool prints for the document it holds (member order, spacing, escaping, a duplicate member or the final newline differ)');
  for (const [name, lines] of [['environment.txt', environment], ['wheel-digest.txt', digests]]) if (lines === null) add('result-set', `results/${name}`, 'is not newline-terminated lines without an empty line or a carriage return');
  const installed = environment ?? [];

  // pins: registry extract, pip download digest, pip freeze and the oracle's own version report must agree
  const fixtureIds = record.fixtures.map((f) => f.id);
  const fixtureOrder = ['normal', ...fixtureIds.filter((id) => id !== 'normal').sort(byCodePoint)];
  if (new Set(fixtureIds).size !== fixtureIds.length) add('fixture-set', 'fixtures', 'a fixture id is listed twice');
  if (!isDeepStrictEqual(fixtureIds, fixtureOrder)) add('fixture-set', 'fixtures', `fixtures [${fixtureIds}] are not the normal fixture first, then the counterexamples in ascending id order [${fixtureOrder}]`);
  // the key order inside oracle.json and static.json is pinned by their printed text (above), so a set comparison loses nothing here
  if (!sameSet(Object.keys(oracle.fixtures), fixtureIds)) add('result-set', 'results/oracle.json', 'oracle fixtures differ from the recorded fixtures');
  for (const [id, fx] of Object.entries(oracle.fixtures)) if (fx.error !== null) add('result-set', `results/oracle.json:${id}`, `fixture failed to import: ${fx.error}`);
  if (!isDeepStrictEqual(record.pin.installed, installed)) add('pin', 'pin.installed', 'recorded installed set differs from the stored pip freeze output');
  if (registry.fetched_utc !== record.pin.registry.fetched_utc) add('pin', 'pin.registry', 'fetch time differs from the registry extract');
  const [fetchedFrom, fetchedTo] = record.pin.registry.fetched_utc.split('..');
  if (fetchedFrom > fetchedTo) add('pin', 'pin.registry', 'the fetch window ends before it starts');
  const wantDigests = record.pin.packages.map((p) => `${p.wheel_sha256}  ${p.wheel}`);
  if (!isDeepStrictEqual(digests ?? [], wantDigests)) add('pin', 'pin.packages', `the stored wheel digest lines [${digests ?? []}] are not exactly the pinned wheels [${wantDigests}]`);
  // pip freeze: every line is name==version, no distribution is listed twice, and every pinned package is listed exactly once
  const freeze = new Map();
  for (const line of installed) {
    const parsed = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][0-9A-Za-z.+!_-]*)$/.exec(line);
    if (!parsed) add('pin', 'pin.installed', `pip freeze line ${JSON.stringify(line)} is not name==version`);
    else freeze.set(canonicalName(parsed[1]), [...(freeze.get(canonicalName(parsed[1])) ?? []), parsed[2]]);
  }
  for (const [name, versions] of freeze) if (versions.length > 1) add('pin', 'pin.installed', `pip freeze lists ${name} ${versions.length} times`);
  const pinNames = record.pin.packages.map((p) => p.pypi);
  if (new Set(pinNames).size !== pinNames.length || new Set(record.pin.packages.map((p) => p.wheel)).size !== pinNames.length) add('pin', 'pin.packages', 'a package or a wheel is pinned twice');
  for (const pkg of record.pin.packages) {
    const where = `pin.packages.${pkg.pypi}`;
    const project = registry.projects?.[pkg.pypi];
    if (project?.pinned?.version !== pkg.version || project?.pinned?.filename !== pkg.wheel || project?.pinned?.sha256 !== pkg.registry_sha256) add('pin', where, 'registry extract disagrees with the pinned version, wheel or hash');
    if (pkg.wheel_sha256 !== pkg.registry_sha256) add('pin', where, 'the pip-downloaded wheel hash differs from the registry hash');
    // the wheel file name starts with the distribution name (hyphens written as underscores) and the version, character for character
    if (!pkg.wheel.startsWith(`${pkg.pypi.replaceAll('-', '_')}-${pkg.version}-`)) add('pin', where, `wheel ${pkg.wheel} is not a wheel of ${pkg.pypi} ${pkg.version}`);
    if (!isDeepStrictEqual(freeze.get(pkg.pypi), [pkg.version])) add('pin', where, 'pip freeze does not list this exact version exactly once');
    if (!isDeepStrictEqual(pkg.released_after_pin_not_covered, (project?.released_after_pin ?? []).map((r) => r.version))) add('pin', where, 'releases after the pin differ from the registry extract');
  }
  const frameworkPackages = record.pin.packages.filter((p) => p.role === 'framework');
  const main = frameworkPackages[0];
  if (frameworkPackages.length !== 1 || main.pypi !== record.framework) add('pin', 'pin.packages', 'the pin must list exactly one package with role framework, and it must be the package of the framework this record names');
  if (!main || oracle.framework.name !== record.framework || oracle.framework.version !== main.version) add('pin', 'pin.packages', 'the oracle reports a different framework or version than the pin');
  if (oracle.python.version !== record.pin.python || !isDeepStrictEqual(oracle.python, record.oracle_range.platform)) add('pin', 'oracle_range.platform', 'the oracle ran on a different interpreter or platform than recorded');
  const existing = record.pin.existing_profile_pin;
  if (existing) {
    const check = record.executed_commands.find((c) => c.id === existing.check_command);
    if (check?.stdout_inline !== `${existing.value.ref}\n`) add('pin', 'pin.existing_profile_pin', 'the pinned ref is not a 40-hex SHA confirmed by the recorded gh api output');
  }

  // fixtures and must-catch: each outcome is recomputed from the stored oracle and static results
  if (isStatic && !sameSet(Object.keys(staticReport.fixtures), fixtureIds)) add('result-set', 'results/static.json', 'static fixtures differ from the recorded fixtures');
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
    if (!sameSet(Object.keys(mc.layers), layerIds)) add('must-catch', where, 'layers differ from the scanner layers under test');
    for (const layerId of layerIds) {
      const declared = mc.layers[layerId];
      const output = Object.hasOwn(staticReport.fixtures, mc.fixture) ? staticReport.fixtures[mc.fixture].layers[layerId] : undefined;
      if (!declared) continue; // the layer-key comparison above reports a layer the entry does not declare
      if (!output) { add('must-catch', `${where}@${layerId}`, `no stored static output for fixture ${mc.fixture}, layer ${layerId}: the declared outcome cannot be recomputed`); continue; }
      for (const covering of declared.covering_flags) {
        if (!output.flags.some((f) => flagMatches(f, covering))) add('must-catch', `${where}@${layerId}`, `declared covering flag ${covering.code} is not emitted by the layer`);
        // a code under which the layer prints a text says which construct it names only through that text, so a covering flag for it
        // that names no text_includes would be the weaker claim "some flag with this code is present"
        else if (covering.text_includes === undefined && output.flags.some((f) => f.code === covering.code && f.text !== undefined)) add('must-catch', `${where}@${layerId}`, `covering flag ${covering.code} names no text_includes, but the layer prints a text under that code, so the code alone does not say which construct it covers`);
      }
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

  // the recorded fixture list is held to its order by verifyStoredRecord (normal first, then ascending), so the live ids are compared as a set
  const liveIds = walkIfDir(fixturesRoot).filter((f) => path.posix.basename(f) === spec.entry).map((f) => path.posix.dirname(f));
  if (!sameSet(liveIds, record.fixtures.map((f) => f.id))) add('fixture-set', 'fixtures', `live fixtures [${[...liveIds].sort()}] differ from the recorded ones`);
  const assigned = new Set();
  const frameworkPin = record.pin.packages.find((p) => p.role === 'framework');
  for (const fixture of record.fixtures) {
    const live = walkIfDir(path.join(fixturesRoot, fixture.id));
    for (const rel of live) assigned.add(`${fixture.id}/${rel}`);
    // exactly the files walk() lists, in its order (the record states them in that order): nothing is sorted before the comparison
    if (!isDeepStrictEqual(live, Object.keys(fixture.files))) add('fixture-set', `fixtures.${fixture.id}`, `live files [${live}] differ from the recorded files [${Object.keys(fixture.files)}] (a file more, fewer, moved or listed twice)`);
    for (const [rel, expected] of Object.entries(fixture.files)) {
      // a file that is not there is already a fixture-set problem (the live file list differs from the recorded one); a listed entry
      // that is there but is not a regular readable file (a symbolic link, say) is a problem of its own, never a skipped hash check
      const bytes = readBytes(path.join(fixturesRoot, fixture.id, rel));
      if (bytes === null) { if (live.includes(rel)) add('fixture-hash', `fixtures.${fixture.id}/${rel}`, 'is not a regular file that can be read, so its content cannot be hashed'); continue; }
      if (sha256(bytes) !== expected) add('fixture-hash', `fixtures.${fixture.id}/${rel}`, 'file content differs from the recorded sha256');
      if (rel === 'requirements.txt' && !bytes.equals(Buffer.from(`${record.framework}==${frameworkPin?.version}\n`))) add('fixture-hash', `fixtures.${fixture.id}/${rel}`, 'requirements.txt does not pin the recorded framework version');
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
    // byte for byte: the live text is compared with the stored bytes, not with a decoded copy of them
    const storedStatic = readBytes(path.join(dir, 'results/static.json'));
    if (live !== null && (storedStatic === null || !storedStatic.equals(Buffer.from(live)))) add('static-drift', 'results/static.json', 'a live run of the in-repo scanners differs from the stored static result (or the stored result cannot be read)');
  } else {
    // scope-only record: a scanner or adapter path named after the framework (outside this record's own directory), or any file in
    // the record's own directory besides SCOPE.json, results/ and fixtures/ (an adapter placed next to the record has no framework
    // name to find in a path that already contains it), means the record is out of date. File names only, no content is read.
    const own = walkIfDir(dir).filter((f) => !['SCOPE.json', 'results', 'fixtures'].includes(f.split('/')[0])).map((f) => `${spec.dir}/${f}`);
    const named = ['scanners', 'adapters'].flatMap((top) => walkIfDir(path.join(root, top)).map((f) => `${top}/${f}`))
      .filter((f) => !f.startsWith(`${spec.dir}/`) && f.toLowerCase().includes(record.framework));
    const hits = [...own, ...named];
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
      try {
        const text = UTF8.decode(readExact(recordFile(item, root)));
        const record = JSON.parse(text);
        loaded = { record, spelled: text === printedRecord(record) };
      } catch (error) { loaded = { problems: [{ code: 'schema', where: 'SCOPE.json', message: `the record cannot be read: ${error.message}` }] }; }
    }
    const named = loaded.record?.item;
    const problems = loaded.problems ?? [
      ...(named === item ? [] : [{ code: 'schema', where: 'SCOPE.json', message: `the record names ${JSON.stringify(named)} but is stored as the record of ${item}` }]),
      // JSON.parse keeps the last of two equal member names and ignores spacing, so the file is held to the text printed for what it holds
      ...(loaded.spelled ? [] : [{ code: 'schema', where: 'SCOPE.json', message: 'is not the text that JSON.stringify(record, null, 2) prints for the record it holds (a duplicate member, other spacing or escaping, or the final newline differ)' }]),
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
