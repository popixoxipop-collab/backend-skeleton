// Validates the five Python HTTP scope records (fastapi, flask, django, starlette, litestar -01) against
// their stored results and the live tree, then proves the validation FAILS when a record, a fixture, the
// oracle binding or the scanner output is tampered with. Nothing here skips: a missing interpreter fails.
// Runs through the nested runner only (node scripts/run-next-nested-tests.mjs T12), not through npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { STATIC_LAYERS, runStatic, serializeStatic } from '../../adapters/http-wave-a/python-scope/static-runner.mjs';
import {
  REPO_ROOT, SCOPE_TARGETS, derivePartition, loadRecord, oraclePairs, recordDir, sealRecord, verifyItems, verifyLiveTree, verifyScopeRecord, verifyStoredRecord,
} from '../../adapters/http-wave-a/python-scope/verify.mjs';

const ITEMS = ['HTTP-python-fastapi-01', 'HTTP-python-flask-01', 'HTTP-python-django-01', 'HTTP-python-starlette-01', 'HTTP-python-litestar-01'];
const SCOPE_ONLY = ['HTTP-python-starlette-01', 'HTTP-python-litestar-01'];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const lines = (problems) => problems.map((p) => `[${p.code}] ${p.where}: ${p.message}`);
const must = (record, id) => record.must_catch.find((mc) => mc.id === id);
const expectLine = (pattern) => (problems) => assert.ok(lines(problems).some((line) => pattern.test(line)), `expected a problem matching ${pattern}, got: ${JSON.stringify(lines(problems))}`);
const onlyCode = (code) => (problems) => assert.deepEqual([...new Set(problems.map((p) => p.code))], [code], `only a ${code} problem may object`);
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

// The statuses each item publishes, frozen here on purpose: moving an entry between supported, unknown_flagged and
// unsupported_gap needs an edit of this file as well as of the record, so a re-sealed record edit cannot do it alone.
const NO_SCANNER = { supported: '', unknown_flagged: '', unsupported_gap: '', unassessed: 'deployment-prefix dynamic-route-factory generated-routes middleware-auth normal-literal-routes router-prefix', oracle_blind: 'deployment-prefix middleware-auth' };
const LEDGER = {
  'HTTP-python-fastapi-01': {
    supported: 'normal-literal-routes@legacy-adapter normal-literal-routes@t06-fastapi-shadow',
    unknown_flagged: 'app-level-decorator@t06-fastapi-shadow mount-subapp@t06-fastapi-shadow router-prefix@legacy-adapter router-prefix@t06-fastapi-shadow',
    unsupported_gap: 'app-level-decorator@legacy-adapter dynamic-route-factory@legacy-adapter dynamic-route-factory@t06-fastapi-shadow generated-routes@legacy-adapter generated-routes@t06-fastapi-shadow mount-subapp@legacy-adapter root-route-trailing-slash@legacy-adapter root-route-trailing-slash@t06-fastapi-shadow',
    unassessed: '', oracle_blind: 'deployment-prefix middleware-auth' },
  'HTTP-python-flask-01': {
    supported: 'normal-literal-routes@t06-flask-shadow normal-literal-routes@t12-flask-leaf',
    unknown_flagged: 'default-methods@t06-flask-shadow default-methods@t12-flask-leaf router-prefix@t06-flask-shadow',
    unsupported_gap: 'dynamic-route-factory@t06-flask-shadow dynamic-route-factory@t12-flask-leaf generated-routes@t06-flask-shadow generated-routes@t12-flask-leaf imperative-registration@t06-flask-shadow imperative-registration@t12-flask-leaf router-prefix@t12-flask-leaf',
    unassessed: '', oracle_blind: 'deployment-prefix middleware-auth' },
  'HTTP-python-django-01': {
    supported: 'normal-literal-routes@t06-django-shadow',
    unknown_flagged: 'deployment-prefix@t12-django-drf-leaf dynamic-route-factory@t06-django-shadow dynamic-route-factory@t12-django-drf-leaf generated-admin@t12-django-drf-leaf generated-drf-router@t06-django-shadow generated-drf-router@t12-django-drf-leaf middleware-auth@t06-django-shadow middleware-auth@t12-django-drf-leaf normal-literal-routes@t12-django-drf-leaf router-prefix@t06-django-shadow router-prefix@t12-django-drf-leaf',
    unsupported_gap: 'generated-admin@t06-django-shadow',
    unassessed: '', oracle_blind: 'deployment-prefix middleware-auth' },
  'HTTP-python-starlette-01': NO_SCANNER,
  'HTTP-python-litestar-01': NO_SCANNER,
};
// The framework-provided pieces each catch-generated entry rests on, frozen here for the same reason as the ledger: the
// stored oracle result must report them as generated and leave the fixture's own routes ordinary, so a re-sealed record
// cannot make the entry hold by relabelling a mount, a docs route or an admin URL as an ordinary route.
const FRAMEWORK_PIECES = {
  'HTTP-python-fastapi-01': { id: 'generated-routes', ordinary: ['GET /ping'], generated: ['GET /api-docs', 'GET /api-openapi.json', 'GET /docs/oauth2-redirect'] },
  'HTTP-python-flask-01': { id: 'generated-routes', ordinary: ['GET /admin/'], generated: ['GET /admin/admin_static/<path:filename>', 'GET /assets/<path:filename>'] },
  'HTTP-python-django-01': { id: 'generated-admin', ordinary: ['- /ping/'], generated: ['- /admin/', '- /admin/auth/user/', '- /admin/login/', '- /admin/logout/'] },
  'HTTP-python-starlette-01': { id: 'generated-routes', ordinary: ['GET /ping'], generated: ['- /static'] },
  'HTTP-python-litestar-01': { id: 'generated-routes', ordinary: ['GET /ping'], generated: ['GET /docs', 'GET /docs/openapi.json', 'GET /docs/swagger'] },
};
const ledgerProblems = (item, record) => Object.entries(LEDGER[item])
  .filter(([bucket, text]) => !isDeepStrictEqual(record.scope[bucket], text.split(' ').filter(Boolean).sort()))
  .map(([bucket]) => ({ code: 'ledger', where: `scope.${bucket}`, message: `${bucket} differs from the statuses frozen in this test file` }));

test('python is available, because the live static re-run cannot be skipped', () => {
  assert.ok(findPythonRuntime(), 'python3 (3.8+) must be on PATH: the scope records re-run the in-repo scanners');
});

test('records exist for exactly the five python HTTP -01 items', () => {
  assert.deepEqual(Object.keys(SCOPE_TARGETS).sort(), [...ITEMS].sort());
  for (const item of ITEMS) {
    assert.ok(fs.existsSync(path.join(recordDir(item), 'SCOPE.json')), `${item}: SCOPE.json is missing`);
    const record = loadRecord(item);
    assert.equal(record.item, item);
    assert.equal(record.framework, SCOPE_TARGETS[item].framework);
    assert.equal(record.track, SCOPE_TARGETS[item].track);
  }
});

for (const item of ITEMS) {
  test(`${item}: every hash, pin, count and comparison recomputes against stored results and the live tree`, () => {
    const record = loadRecord(item);
    assert.deepEqual(lines(verifyScopeRecord(record, { dir: recordDir(item) })), []);
    assert.deepEqual(lines(ledgerProblems(item, record)), [], 'the published statuses must equal the ones frozen in this file');
  });
}

test('no record claims support or runtime testing; a registration alone is not support', () => {
  for (const item of ITEMS) {
    const record = loadRecord(item);
    assert.equal(record.claims.supported, false, item);
    assert.equal(record.claims.runtime_tested, false, item);
    assert.equal(record.runtime_tested.status, 'BLOCKED', item);
    assert.ok(record.runtime_tested.reason.length > 40, item);
    assert.ok(record.limits.length >= 3 && record.plan.length >= 1, item);
    if (item !== 'HTTP-python-fastapi-01') assert.notEqual(record.registration, null, `${item} is registered; that must still not read as supported`);
  }
  for (const item of SCOPE_ONLY) {
    const record = loadRecord(item);
    assert.equal(record.claims.extraction, 'none', item);
    assert.equal(record.conformance.status, 'BLOCKED', item);
    assert.ok(record.conformance.reason.length > 40, item);
    assert.deepEqual(record.layers, [], item);
    assert.deepEqual(record.scope.supported, [], item);
    assert.deepEqual(record.scope.unsupported_gap, [], item);
    assert.ok(record.must_catch.length >= 6 && record.must_catch.every((mc) => Object.keys(mc.layers).length === 0), `${item}: no scanner exists, so nothing may be assessed`);
  }
});

test('framework-provided routes are classified generated in the stored oracle results, and the entries that rest on them name them', () => {
  for (const item of ITEMS) {
    const record = loadRecord(item);
    const want = FRAMEWORK_PIECES[item];
    const entry = must(record, want.id);
    assert.equal(entry.rule, 'catch-generated', `${item}: ${want.id}`);
    assert.deepEqual(entry.expected.routes, want.ordinary, `${item}: the fixture's own routes`);
    for (const piece of want.generated) {
      assert.ok(entry.expected.generated.includes(piece), `${item}: ${piece} must be reported as framework-generated`);
      assert.ok(!entry.expected.routes.includes(piece), `${item}: ${piece} must not be an ordinary route`);
    }
    const oracle = JSON.parse(fs.readFileSync(path.join(recordDir(item), 'results/oracle.json'), 'utf8'));
    assert.deepEqual(oraclePairs(oracle.fixtures[entry.fixture]), entry.expected, `${item}: the entry equals the stored oracle result`);
  }
});

// The classification itself, run on stand-ins that carry only the names oracle.py reads, so that it is exercised in CI
// without installing any framework. A Mount or Host with no child routes serves an ASGI app and has no endpoint: it is
// classified by the class of the app it serves, and a module only counts as framework-provided when it IS the framework
// package or lies inside it.
const CLASSIFICATION = [
  ['a Mount serving a class the framework ships (StaticFiles)', 'route_generated("starlette", Mount(shipped), None)', true],
  ['a Mount serving an app the fixture defines', 'route_generated("starlette", Mount(own), None)', false],
  ['a Mount of a fixture app that the framework wrapped in its own middleware', 'route_generated("starlette", Mount(own, wrapper), None)', false],
  ['a Mount of a shipped app that the framework wrapped in its own middleware', 'route_generated("starlette", Mount(shipped, wrapper), None)', true],
  ['a Host serving a class the framework ships', 'route_generated("starlette", Host(shipped), None)', true],
  ['a Host serving an app the fixture defines', 'route_generated("starlette", Host(own), None)', false],
  ['a Route whose endpoint the framework defines', 'route_generated("fastapi", Route(), endpoint_of("fastapi.openapi.docs"))', true],
  ['a Route whose endpoint the fixture defines', 'route_generated("fastapi", Route(), endpoint_of("app"))', false],
  ['a module that only starts with the name of the framework package', 'route_generated("fastapi", Route(), endpoint_of("fastapi_utils.views"))', false],
  ['the Django static() view', 'generated_group("django", endpoint_of("django.views.static"))', 'django.views.static'],
  ['a Django REST framework view', 'generated_group("django", endpoint_of("rest_framework.views"))', 'rest_framework'],
  ['a Django module that only starts with the name of a generated package', 'generated_group("django", endpoint_of("rest_framework_extras.views"))', null],
];

test('oracle.py classifies a childless Mount or Host by the app it serves and an endpoint by the module that defines it', () => {
  const python = findPythonRuntime();
  assert.ok(python, 'python3 (3.8+) must be on PATH');
  const snippet = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("oracle", sys.argv[1])',
    'oracle = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(oracle)',
    'route_generated, generated_group = oracle.route_generated, oracle.generated_group',
    'def app_of(module): return type("App", (), {"__module__": module})()',
    'def endpoint_of(module):',
    '    def endpoint(): pass',
    '    endpoint.__module__ = module',
    '    return endpoint',
    'class Mount:',
    '    def __init__(self, base, outer=None):',
    '        self._base_app = base',
    '        self.app = outer or base',
    'class Host:',
    '    def __init__(self, app): self.app = app',
    'class Route: pass',
    'shipped, own, wrapper = app_of("starlette.staticfiles"), app_of("app"), app_of("starlette.middleware.errors")',
    'print(json.dumps([eval(expression) for expression in json.loads(sys.argv[2])]))',
  ].join('\n');
  const stdout = execFileSync(python.executable, ['-I', '-B', '-c', snippet, path.join(REPO_ROOT, 'adapters/http-wave-a/python-scope/oracle.py'), JSON.stringify(CLASSIFICATION.map(([, expression]) => expression))], { encoding: 'utf8' });
  const got = JSON.parse(stdout);
  assert.deepEqual(Object.fromEntries(CLASSIFICATION.map(([label], i) => [label, got[i]])), Object.fromEntries(CLASSIFICATION.map(([label, , expected]) => [label, expected])));
  assert.equal(got.length, CLASSIFICATION.length);
});

test('hashes and pins are recomputed here from the files, independently of verify.mjs', () => {
  for (const item of ITEMS) {
    const dir = recordDir(item);
    const record = loadRecord(item);
    assert.ok(record.fixtures.length >= 2 && record.executed_commands.length >= 8, `${item}: an empty list would make the loops below pass without checking anything`);
    for (const fixture of record.fixtures) {
      for (const [rel, want] of Object.entries(fixture.files)) assert.equal(sha256(fs.readFileSync(path.join(dir, 'fixtures', fixture.id, rel))), want, `${item} ${fixture.id}/${rel}`);
    }
    for (const cmd of record.executed_commands) {
      assert.equal(cmd.exit_code, 0, `${item} ${cmd.id}`);
      if (cmd.stored_as) {
        const data = fs.readFileSync(path.join(dir, cmd.stored_as));
        assert.equal(sha256(data), cmd.stdout_sha256, `${item} ${cmd.id}`);
        assert.equal(data.length, cmd.stdout_bytes, `${item} ${cmd.id}`);
      }
    }
    assert.equal(sha256(fs.readFileSync(path.join(REPO_ROOT, record.oracle_tool.path))), record.oracle_tool.sha256, item);
    const oracle = JSON.parse(fs.readFileSync(path.join(dir, 'results/oracle.json'), 'utf8'));
    const framework = record.pin.packages.find((p) => p.role === 'framework');
    assert.equal(oracle.framework.name, record.framework, item);
    assert.equal(oracle.framework.version, framework.version, item);
    assert.equal(oracle.python.version, record.pin.python, item);
    assert.deepEqual(Object.keys(oracle.fixtures).sort(), record.fixtures.map((f) => f.id).sort(), item);
    for (const pkg of record.pin.packages) {
      assert.match(pkg.wheel_sha256, /^[0-9a-f]{64}$/, `${item} ${pkg.pypi}`);
      assert.equal(pkg.wheel_sha256, pkg.registry_sha256, `${item} ${pkg.pypi}: pip download hash must equal the registry hash`);
    }
    if (record.pin.existing_profile_pin) assert.match(record.pin.existing_profile_pin.value.ref, /^[0-9a-f]{40}$/, item);
    const { record_digest: seal, ...rest } = record;
    assert.equal(sha256(canon(rest)), seal, `${item}: record_digest must be the sha256 of the whole record without the seal`);
  }
});

test('determinism: repeated oracle and static runs recorded one output hash, and two live static runs are byte-identical', () => {
  for (const item of ITEMS) {
    const record = loadRecord(item);
    const isStatic = Object.hasOwn(STATIC_LAYERS, record.framework);
    for (const [file, runs] of [['results/oracle.json', 2], ['results/static.json', isStatic ? 3 : 0]]) {
      const hashes = record.executed_commands.filter((c) => c.stored_as === file).map((c) => c.stdout_sha256);
      assert.ok(hashes.length >= runs, `${item} ${file}: needs at least ${runs} recorded runs`);
      assert.ok(new Set(hashes).size <= 1, `${item} ${file}: repeated runs recorded different output hashes`);
    }
    if (isStatic) {
      const root = path.join(recordDir(item), 'fixtures');
      assert.equal(serializeStatic(runStatic(record.framework, root)), serializeStatic(runStatic(record.framework, root)), `${item}: two live static runs differ`);
    }
  }
});

test('sealed prose states no count: every number in a record is recomputed by the verifier, not typed into text', () => {
  for (const item of ITEMS) {
    const r = loadRecord(item);
    const prose = [r.claims.statement, r.runtime_tested.reason, r.conformance.reason ?? '', ...r.limits, ...r.plan, r.oracle_range.kind, ...r.oracle_range.can_verify, ...r.oracle_range.cannot_verify,
      ...r.layers.map((l) => l.role), ...r.must_catch.flatMap((mc) => [mc.construct, mc.blind_property ?? '', ...Object.values(mc.layers).flatMap((l) => l.covering_flags.map((f) => f.covers))])];
    for (const text of prose) assert.doesNotMatch(text.replace(/[A-Za-z][\w.-]*\d[\w.-]*/g, ''), /\d/, `${item}: a count in prose is not recomputed: ${text}`);
  }
});

test('a record of the wrong shape is reported as schema problems by every check, never thrown', () => {
  const item = 'HTTP-python-flask-01';
  const record = loadRecord(item);
  const dir = recordDir(item);
  const broken = [null, 'x', [], {}, { ...record, fixtures: [null] }, { ...record, layers: true }, { ...record, fixtures: [{ id: 1, role: 'normal', files: {} }] }];
  assert.ok(broken.length >= 7, 'an empty list would make the loops below pass without checking anything');
  for (const wrong of broken) {
    for (const check of [verifyStoredRecord, verifyLiveTree, verifyScopeRecord]) {
      const problems = check(wrong, { dir });
      assert.ok(problems.length > 0 && problems.every((p) => p.code === 'schema'), `${check.name}(${JSON.stringify(wrong)?.slice(0, 50)}): ${JSON.stringify(lines(problems))}`);
    }
  }
});

// Tamper cases run on temp copies of one record directory. Each copy must verify cleanly first, so a failure
// can only come from the mutation, then the named problem code must appear.
function tamper(c) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-scope-'));
  const cleanup = [tmp];
  try {
    fs.cpSync(recordDir(c.item), tmp, { recursive: true });
    const ctx = { dir: tmp, root: REPO_ROOT, record: JSON.parse(fs.readFileSync(path.join(tmp, 'SCOPE.json'), 'utf8')), cleanup };
    c.prepare?.(ctx);
    const check = () => {
      if (c.mode === 'ledger') return [...verifyStoredRecord(ctx.record, { dir: ctx.dir }), ...ledgerProblems(c.item, ctx.record)];
      if (c.mode === 'stored') return verifyStoredRecord(ctx.record, { dir: ctx.dir });
      if (c.mode === 'live') return verifyLiveTree(ctx.record, { dir: ctx.dir, root: ctx.root });
      return verifyScopeRecord(ctx.record, { dir: ctx.dir, root: ctx.root });
    };
    assert.deepEqual(lines(check()), [], `${c.name}: the untouched copy must verify cleanly before it is tampered with`);
    c.mutate(ctx);
    // every case is re-sealed, so the targeted check has to catch the edit; `unsealed` cases prove the seal itself does
    if (!c.unsealed) ctx.record = sealRecord(ctx.record);
    fs.writeFileSync(path.join(tmp, 'SCOPE.json'), `${JSON.stringify(ctx.record, null, 2)}\n`);
    return c.during ? c.during(check) : check();
  } finally {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const editFile = (file, edit) => {
  const before = fs.readFileSync(file, 'utf8');
  const after = edit(before);
  assert.notEqual(after, before, `${file}: the edit changed nothing, so the case would prove nothing`);
  fs.writeFileSync(file, after);
  return after;
};

// Replaces a stored result and keeps every recorded hash and byte count consistent with the new content, so that
// only the readability or the shape of that content can make the verifier object.
const rewriteStored = ({ dir, record }, rel, text) => {
  fs.writeFileSync(path.join(dir, rel), text);
  for (const cmd of record.executed_commands.filter((x) => x.stored_as === rel)) { cmd.stdout_sha256 = sha256(text); cmd.stdout_bytes = Buffer.byteLength(text); }
  if (rel === 'results/registry.json') record.pin.registry.extract_sha256 = sha256(text);
};
const editStoredJson = (ctx, rel, edit) => {
  const doc = JSON.parse(fs.readFileSync(path.join(ctx.dir, rel), 'utf8'));
  edit(doc);
  rewriteStored(ctx, rel, `${JSON.stringify(doc, null, 2)}\n`);
};

const syntheticRoot = (ctx, extraFile) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-scope-root-'));
  ctx.cleanup.push(root);
  const oracle = 'adapters/http-wave-a/python-scope/oracle.py';
  fs.mkdirSync(path.dirname(path.join(root, oracle)), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, oracle), path.join(root, oracle));
  fs.mkdirSync(path.join(root, 'scanners'), { recursive: true });
  ctx.root = root;
  return () => fs.writeFileSync(path.join(root, extraFile), '// a scanner for this framework now exists\n');
};

const CASES = [
  { name: 'a fixture byte is changed', item: 'HTTP-python-flask-01', mode: 'live', expect: 'fixture-hash',
    mutate: ({ dir }) => fs.appendFileSync(path.join(dir, 'fixtures/normal/app.py'), '\n# tampered\n') },
  { name: 'an unrecorded file appears in a fixture', item: 'HTTP-python-starlette-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ dir }) => fs.writeFileSync(path.join(dir, 'fixtures/normal/extra.py'), 'x = 1\n') },
  { name: 'an unrecorded fixture appears', item: 'HTTP-python-litestar-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ dir }) => { fs.mkdirSync(path.join(dir, 'fixtures/counterexamples/new-case'), { recursive: true }); fs.writeFileSync(path.join(dir, 'fixtures/counterexamples/new-case/app.py'), 'x = 1\n'); } },
  { name: 'the fixture requirements pin is moved while its recorded hash is kept consistent', item: 'HTTP-python-fastapi-01', mode: 'live', expect: 'fixture-hash',
    mutate: ({ dir, record }) => {
      const text = editFile(path.join(dir, 'fixtures/normal/requirements.txt'), (t) => t.replace('fastapi==', 'fastapi==0.'));
      record.fixtures.find((f) => f.id === 'normal').files['requirements.txt'] = sha256(text);
    },
    check: (problems) => assert.ok(problems.some((p) => p.code === 'fixture-hash' && /requirements\.txt does not pin/.test(p.message))) },
  { name: 'the stored oracle output is edited', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-hash',
    mutate: ({ dir }) => editFile(path.join(dir, 'results/oracle.json'), (t) => t.replace('"GET"', '"PUT"')) },
  { name: 'a stored evidence file is deleted', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-hash',
    mutate: ({ dir }) => fs.rmSync(path.join(dir, 'results/environment.txt')) },
  // stored results that are missing, unparseable or wrongly shaped must end in a structured problem, never in an
  // exception (an exception would end the CLI without a report); hashes are kept consistent so only the content objects
  { name: 'results/static.json is deleted', item: 'HTTP-python-flask-01', mode: 'full', expect: 'result-set',
    mutate: ({ dir }) => fs.rmSync(path.join(dir, 'results/static.json')),
    check: (problems) => assert.ok(problems.some((p) => p.code === 'result-set' && /stored results cannot be read/.test(p.message))) },
  { name: 'results/static.json is not JSON, hashes kept consistent', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/static.json', '{not json\n'),
    check: (problems) => assert.deepEqual([...new Set(problems.map((p) => p.code))], ['result-set'], 'only the unreadable document may object') },
  { name: 'results/static.json parses to null, hashes kept consistent', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/static.json', 'null\n'),
    check: (problems) => assert.deepEqual([...new Set(problems.map((p) => p.code))], ['result-set'], 'only the wrongly shaped document may object') },
  { name: 'a layer of results/static.json has no routes list, hashes kept consistent', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { delete Object.values(Object.values(doc.fixtures)[0].layers)[0].routes; }) },
  { name: 'results/oracle.json parses to an object without fixtures, hashes kept consistent', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/oracle.json', '{}\n') },
  { name: 'an oracle fixture entry has routes that are not a list, hashes kept consistent', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { Object.values(doc.fixtures)[0].routes = {}; }) },
  { name: 'results/registry.json lists the later releases as text, hash kept consistent', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/registry.json', (doc) => { Object.values(doc.projects)[0].released_after_pin = 'none'; }) },
  { name: 'a stored result is replaced by a directory', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: ({ dir }) => { fs.rmSync(path.join(dir, 'results/environment.txt')); fs.mkdirSync(path.join(dir, 'results/environment.txt')); } },
  { name: 'the fixtures directory is removed', item: 'HTTP-python-flask-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ dir }) => fs.rmSync(path.join(dir, 'fixtures'), { recursive: true }) },
  { name: 'a recorded exit code is changed', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { record.executed_commands.find((c) => c.id === 'oracle-1').exit_code = 1; } },
  { name: 'a declared outcome is upgraded to caught', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { must(record, 'dynamic-route-factory').layers['t06-flask-shadow'].outcome = 'caught'; } },
  { name: 'a declared covering flag is not emitted by the layer', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { must(record, 'router-prefix').layers['t06-flask-shadow'].covering_flags[0].code = 'no-such-flag'; } },
  { name: 'the scope partition is edited by hand', item: 'HTTP-python-django-01', mode: 'stored', expect: 'partition',
    mutate: ({ record }) => { record.scope.supported.push('generated-admin@t12-django-drf-leaf'); } },
  { name: 'the pinned framework version is moved', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: ({ record }) => { record.pin.packages[0].version = '3.1.4'; } },
  { name: 'the pip freeze set no longer matches the record', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'pin',
    mutate: ({ record }) => { record.pin.installed.push('extra==1.0'); } },
  { name: 'supported is claimed', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'claims',
    mutate: ({ record }) => { record.claims.supported = true; } },
  { name: 'runtime testing is claimed', item: 'HTTP-python-django-01', mode: 'stored', expect: 'claims',
    mutate: ({ record }) => { record.claims.runtime_tested = true; } },
  { name: 'extraction is claimed for a target with no scanner', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'claims',
    mutate: ({ record }) => { record.claims.extraction = 'partial-static'; } },
  { name: 'the BLOCKED conformance of a scope-only target is flipped', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'conformance',
    mutate: ({ record }) => { record.conformance.status = 'COMPARED'; } },
  { name: 'a required block is removed', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { delete record.runtime_tested; } },
  { name: 'oracle.py no longer matches the recorded binding', item: 'HTTP-python-starlette-01', mode: 'live', expect: 'oracle-binding',
    mutate: ({ record }) => { record.oracle_tool.sha256 = '0'.repeat(64); } },
  { name: 'the live profile registration differs from the recorded one', item: 'HTTP-python-flask-01', mode: 'live', expect: 'registration',
    mutate: ({ record }) => { record.registration.entry.state = 'supported'; } },
  { name: 'the stored static output drifts from the in-repo scanners with every hash kept consistent', item: 'HTTP-python-flask-01', mode: 'full', expect: 'static-drift',
    mutate: ({ dir, record }) => {
      const file = path.join(dir, 'results/static.json');
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      const flag = Object.values(report.fixtures).flatMap((f) => Object.values(f.layers)).flatMap((l) => l.flags)[0];
      assert.ok(flag, 'a stored flag to alter must exist');
      flag.where += '#drift';
      const text = serializeStatic(report);
      fs.writeFileSync(file, text);
      for (const cmd of record.executed_commands.filter((x) => x.stored_as === 'results/static.json')) { cmd.stdout_sha256 = sha256(text); cmd.stdout_bytes = Buffer.byteLength(text); }
    },
    check: (problems) => assert.ok(!problems.some((p) => ['result-hash', 'must-catch', 'partition'].includes(p.code)), 'only the live comparison may object') },
  // seal: an edit that is not re-sealed fails, whichever part of the record it touches (prose included)
  { name: 'a limit statement is edited without re-sealing', item: 'HTTP-python-django-01', mode: 'stored', expect: 'seal', unsealed: true,
    mutate: ({ record }) => { record.limits[0] += ' (edited)'; },
    check: (problems) => assert.deepEqual(problems.map((p) => p.code), ['seal'], 'prose is only bound by the seal') },
  { name: 'a plan statement of a scope-only record is edited without re-sealing', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'seal', unsealed: true,
    mutate: ({ record }) => { record.plan[0] = 'Starlette extraction is supported.'; } },
  { name: 'a covers text deep inside a must-catch layer is edited without re-sealing', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'seal', unsealed: true,
    mutate: ({ record }) => { must(record, 'router-prefix').layers['t06-flask-shadow'].covering_flags[0].covers = 'the shadow understands every prefix'; } },
  { name: 'the recorded seal is replaced by a well-formed wrong digest', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'seal', unsealed: true,
    mutate: ({ record }) => { record.record_digest = '0'.repeat(64); } },
  // statuses: a re-sealed edit must still fail where the verifier recomputes or the frozen ledger records the status
  { name: 'runtime_tested is re-labelled from BLOCKED (re-sealed)', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { record.runtime_tested.status = 'PASSED'; } },
  { name: 'an unsupported entry is relabelled flagged with an unrelated emitted flag, re-derived and re-sealed (consistent forgery)', item: 'HTTP-python-flask-01', mode: 'ledger', expect: 'ledger',
    mutate: ({ record }) => {
      const layer = must(record, 'generated-routes').layers['t06-flask-shadow'];
      layer.covering_flags = [{ code: 'registration-limitation', covers: 'forged claim that this flag names the generated static routes' }];
      layer.outcome = 'flagged';
      record.scope = derivePartition(record);
    } },
  { name: 'a middleware/auth entry is re-ruled as catchable (re-sealed)', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { must(record, 'middleware-auth').rule = 'catch-or-flag'; } },
  { name: 'a required must-catch class is dropped (re-sealed)', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { record.must_catch = record.must_catch.filter((mc) => mc.id !== 'dynamic-route-factory'); },
    check: (problems) => assert.ok(problems.some((p) => /required class dynamic-route-factory is missing/.test(p.message))) },
  { name: 'a counterexample fixture is relabelled as the normal one (re-sealed)', item: 'HTTP-python-django-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { record.fixtures.find((f) => f.id === 'counterexamples/router-prefix').role = 'normal'; } },
  { name: 'python disappears: the static re-run fails instead of being skipped', item: 'HTTP-python-django-01', mode: 'live', expect: 'static-run-failed',
    mutate: () => {}, // the tree is untouched; only the environment changes while the check runs
    during: (check) => {
      const saved = { PATH: process.env.PATH, BSKEL_PYTHON: process.env.BSKEL_PYTHON };
      const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-no-python-'));
      try {
        process.env.PATH = emptyBin;
        delete process.env.BSKEL_PYTHON;
        return check();
      } finally {
        fs.rmSync(emptyBin, { recursive: true, force: true });
        process.env.PATH = saved.PATH;
        if (saved.BSKEL_PYTHON === undefined) delete process.env.BSKEL_PYTHON; else process.env.BSKEL_PYTHON = saved.BSKEL_PYTHON;
      }
    } },

  // A check that only visits what is present lets a missing, empty, extra or mislabeled member pass. Each case below keeps
  // every recorded hash consistent and re-seals, so only the check it names can object; each asserts that check's message.
  { name: 'a stored static fixture omits one of the declared layers', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { delete doc.fixtures['counterexamples/router-prefix'].layers['t12-django-drf-leaf']; }),
    check: (problems) => { expectLine(/\[result-set\] results\/static\.json:counterexamples\/router-prefix: layers \[t06-django-shadow\] are not exactly the declared layers/)(problems); onlyCode('result-set')(problems); } },
  { name: 'a stored static fixture carries a layer that is not declared', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { doc.fixtures.normal.layers['t99-extra'] = { routes: [], flags: [] }; }),
    check: expectLine(/\[result-set\] results\/static\.json:normal: layers \[.*t99-extra\] are not exactly the declared layers/) },
  { name: 'a stored static fixture carries a key besides layers', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { doc.fixtures.normal.detected = true; }),
    check: expectLine(/\[result-set\] results\/static\.json:normal: fixture \{layers\} is missing or has the wrong type/) },
  { name: 'a fixture is deleted from results/static.json, so its declared outcomes have no stored output', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'must-catch',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { delete doc.fixtures['counterexamples/router-prefix']; }),
    check: expectLine(/\[must-catch\] must_catch\.router-prefix@t06-flask-shadow: no stored static output for fixture counterexamples\/router-prefix/) },
  { name: 'results/static.json names another target', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { doc.target = 'flask'; }),
    check: expectLine(/\[result-set\] results\/static\.json: target is not fastapi/) },
  { name: 'results/static.json carries another schema tag', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { doc.schema = 'bskel.internal.other/0'; }),
    check: expectLine(/\[result-set\] results\/static\.json: schema is not bskel\.internal\.python-scope-static-run\/0/) },
  // the generated pieces: an entry must rest on a route the framework registered itself
  { name: 'the Starlette StaticFiles mount is recorded as an ordinary route again, expected pairs kept consistent', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'must-catch',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => {
      const fixture = doc.fixtures['counterexamples/generated-routes'];
      const mount = fixture.routes.find((r) => r.path === '/static');
      assert.equal(mount.generated, true, 'the mount is stored as generated before this case flips it');
      mount.generated = false;
      must(ctx.record, 'generated-routes').expected = oraclePairs(fixture);
    }),
    check: expectLine(/\[must-catch\] must_catch\.generated-routes: the oracle registers no framework-generated route for fixture counterexamples\/generated-routes/) },
  { name: 'the only catch-generated entry is dropped while generated-drf-router stays (an id prefix is not a rule)', item: 'HTTP-python-django-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { record.must_catch = record.must_catch.filter((mc) => mc.id !== 'generated-admin'); },
    check: expectLine(/\[must-catch\] must_catch: no catch-generated entry/) },
  { name: 'every route of the normal fixture is relabelled generated in the oracle result, expected pairs kept consistent', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'must-catch',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => {
      for (const route of doc.fixtures.normal.routes) route.generated = true;
      must(ctx.record, 'normal-literal-routes').expected = oraclePairs(doc.fixtures.normal);
    }),
    check: expectLine(/\[must-catch\] must_catch\.normal-literal-routes: the oracle registers no ordinary route for fixture normal/) },
  { name: 'an entry is re-pointed at the normal fixture with its pairs recomputed', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'must-catch',
    mutate: (ctx) => {
      const entry = must(ctx.record, 'router-prefix');
      entry.fixture = 'normal';
      entry.minimal_counterexample = 'app.py';
      entry.expected = oraclePairs(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'results/oracle.json'), 'utf8')).fixtures.normal);
    },
    check: expectLine(/\[must-catch\] must_catch\.router-prefix: fixture normal is not counterexamples\/router-prefix, the fixture this entry id names/) },
  // the shape of the oracle result: every member the comparison reads is pinned, not only the ones that happen to be there
  { name: 'an oracle route has a generated flag that is not a boolean', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { Object.values(doc.fixtures)[0].routes[0].generated = 'no'; }),
    check: expectLine(/\[result-set\] results\/oracle\.json:[^ ]+: fixture \{error, routes\[\{path, methods, generated\}\]/) },
  { name: 'an oracle route has an empty method list, so it would vanish from every pair', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { Object.values(doc.fixtures)[0].routes[0].methods = []; }),
    check: expectLine(/\[result-set\] results\/oracle\.json:[^ ]+: fixture \{error, routes/) },
  { name: 'an ordinary oracle route registers nothing but HEAD and OPTIONS, expected pairs kept consistent', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => {
      const fixture = doc.fixtures.normal;
      fixture.routes.find((r) => r.path === '/health' && !r.generated).methods = ['OPTIONS'];
      must(ctx.record, 'normal-literal-routes').expected = oraclePairs(fixture);
    }),
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json:normal: route \/health \[OPTIONS\] has no method besides HEAD and OPTIONS/)(problems); onlyCode('result-set')(problems); } },
  { name: 'a generated group states a count that is not its path list', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { doc.fixtures['counterexamples/generated-admin'].generated_groups[0].count += 1; }),
    check: expectLine(/\[result-set\] results\/oracle\.json:counterexamples\/generated-admin: fixture \{error, routes\[.*generated_groups\[\{group, count, paths_sorted\}\]/) },
  { name: 'the oracle result is not tagged as a framework route table', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { doc.oracle = 'request-level'; }),
    check: expectLine(/\[result-set\] results\/oracle\.json: oracle is not "framework-route-table"/) },
  { name: 'the registry extract lists a project that is not pinned', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/registry.json', (doc) => { doc.projects.werkzeug = { released_after_pin: [] }; }),
    check: expectLine(/\[result-set\] results\/registry\.json: projects \[flask,werkzeug\] are not exactly the pinned packages \[flask\]/) },
  // the oracle range states what the oracle can and cannot see; an empty list on either side says nothing, and the schema refuses it
  { name: 'the oracle range lists nothing the oracle can verify (re-sealed)', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { record.oracle_range.can_verify = []; },
    check: expectLine(/\[schema\] \/oracle_range\/can_verify: must NOT have fewer than 1 items/) },
  { name: 'the oracle range lists nothing the oracle cannot verify (re-sealed)', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { record.oracle_range.cannot_verify = []; },
    check: expectLine(/\[schema\] \/oracle_range\/cannot_verify: must NOT have fewer than 1 items/) },
  // pins: both directions
  { name: 'the stored wheel digest output lists a wheel that is not pinned', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: (ctx) => rewriteStored(ctx, 'results/wheel-digest.txt', `${fs.readFileSync(path.join(ctx.dir, 'results/wheel-digest.txt'), 'utf8')}${'0'.repeat(64)}  extra-1.0-py3-none-any.whl\n`),
    check: expectLine(/\[pin\] pin\.packages: the stored wheel digest lines .* are not exactly the pinned wheels/) },
  { name: 'a second package is labelled framework', item: 'HTTP-python-django-01', mode: 'stored', expect: 'pin',
    mutate: ({ record }) => { record.pin.packages.find((p) => p.pypi === 'djangorestframework').role = 'framework'; },
    check: expectLine(/\[pin\] pin\.packages: the pin must list exactly one package with role framework/) },
  { name: 'oracle_tool is re-pointed at another file whose hash is recorded', item: 'HTTP-python-starlette-01', mode: 'full', expect: 'oracle-binding',
    mutate: ({ record }) => {
      const other = 'adapters/http-wave-a/python-scope/static-runner.mjs';
      record.oracle_tool = { path: other, sha256: sha256(fs.readFileSync(path.join(REPO_ROOT, other))) };
    },
    check: expectLine(/\[oracle-binding\] oracle_tool\.path: adapters\/http-wave-a\/python-scope\/static-runner\.mjs is not the oracle/) },
  // executed commands: the set, the output form and the text follow from the pin and the target
  { name: 'the install command names another version than the pin', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'install'); cmd.command = cmd.command.replace('fastapi==0.143.0', 'fastapi==0.142.0'); },
    check: expectLine(/\[executed-command\] executed_commands\.install: command text does not follow from the pin and the target/) },
  { name: 'the wheel command leaves out a pinned package', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'wheel'); cmd.command = cmd.command.replace(' djangorestframework==3.18.1', ''); },
    check: expectLine(/\[executed-command\] executed_commands\.wheel: command text does not follow from the pin and the target/) },
  { name: 'the install command adds an index URL, so the packages may come from elsewhere than the pinned registry', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'install'); cmd.command = cmd.command.replace('--only-binary=:all:', '--only-binary=:all: --index-url https://example.invalid/simple'); },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.install: command text does not follow from the pin and the target/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'the wheel command adds a requirement that carries no pinned version', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'wheel'); cmd.command = `${cmd.command} requests`; },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.wheel: command text does not follow from the pin and the target/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'the wheel command downloads into a directory other than wheels', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'wheel'); cmd.command = cmd.command.replace('-d wheels', '-d /tmp/elsewhere'); },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.wheel: command text does not follow from the pin and the target/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'the wheel command separates -d from the directory it takes', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'wheel'); cmd.command = cmd.command.replace('-d wheels -q', '-d -q wheels'); },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.wheel: command text does not follow from the pin and the target/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'an oracle command runs another framework', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'oracle-2'); cmd.command = cmd.command.replace('oracle.py litestar', 'oracle.py flask'); },
    check: expectLine(/\[executed-command\] executed_commands\.oracle-2: command text does not follow from the pin and the target/) },
  { name: 'a static command runs another fixture tree', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'static-py312'); cmd.command = cmd.command.replace('python-flask/fixtures', 'python-django/fixtures'); },
    check: expectLine(/\[executed-command\] executed_commands\.static-py312: command text does not follow from the pin and the target/) },
  { name: 'the profile ref check asks for another ref than the pinned one', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'profile-ref-check'); cmd.command = cmd.command.replace(record.pin.existing_profile_pin.value.ref, '0'.repeat(40)); },
    check: expectLine(/\[executed-command\] executed_commands\.profile-ref-check: command text does not follow from the pin and the target/) },
  { name: 'the profile ref check asks the API for something other than the commit SHA', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = record.executed_commands.find((c) => c.id === 'profile-ref-check'); cmd.command = cmd.command.replace('--jq .sha', '--jq .commit.url'); },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.profile-ref-check: command text does not follow from the pin and the target/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'a command the record must state is dropped', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { record.executed_commands = record.executed_commands.filter((c) => c.id !== 'wheel'); },
    check: expectLine(/\[executed-command\] executed_commands\.wheel: a command this record must state is missing/) },
  { name: 'a command is added that the pin and the target do not imply', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { record.executed_commands.push({ id: 'extra-check', command: 'true extra-check', exit_code: 0, stdout_sha256: sha256(''), stdout_bytes: 0, stdout_empty: true }); },
    check: expectLine(/\[executed-command\] executed_commands\.extra-check: this record has no place for such a command/) },
  { name: 'a command states no output form, so nothing about its output is recomputed', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { delete record.executed_commands.find((c) => c.id === 'venv').stdout_empty; },
    check: expectLine(/\[executed-command\] executed_commands\.venv: output form \[\] is not exactly \[stdout_empty\]/) },
  // the live tree: layer sources and the profile pin, both directions
  { name: 'a layer names another in-repo file than the one the static runner exercises', item: 'HTTP-python-flask-01', mode: 'live', expect: 'layer-source',
    mutate: ({ record }) => { record.layers.find((l) => l.id === 't06-flask-shadow').source = 'scanners/language/python/django-shadow.mjs'; },
    check: expectLine(/\[layer-source\] layers\.t06-flask-shadow: source scanners\/language\/python\/django-shadow\.mjs is not the file the static runner exercises/) },
  { name: 'the recorded profile pin is dropped although the live profile has one', item: 'HTTP-python-flask-01', mode: 'live', expect: 'registration',
    mutate: ({ record }) => { record.pin.existing_profile_pin = null; },
    check: expectLine(/\[registration\] pin\.existing_profile_pin: the recorded profile pin differs from the live profile versionPin/) },
  { name: 'the recorded profile pin names another file than the one the live profile pin is read from', item: 'HTTP-python-flask-01', mode: 'live', expect: 'registration',
    mutate: ({ record }) => { record.pin.existing_profile_pin.source = 'adapters/http-wave-a/django-drf.mjs DJANGO_DRF_PROFILE.versionPin'; },
    check: expectLine(/\[registration\] pin\.existing_profile_pin: source adapters\/http-wave-a\/django-drf\.mjs DJANGO_DRF_PROFILE\.versionPin is not where the live profile pin is read from/) },
  { name: 'a profile pin is recorded for a target whose live registration has none', item: 'HTTP-python-litestar-01', mode: 'live', expect: 'registration',
    mutate: ({ record }) => { record.pin.existing_profile_pin = { source: 'adapters/http-wave-bc/catalog.mjs', value: { ref: '0'.repeat(40) }, check_command: 'profile-ref-check' }; },
    check: expectLine(/\[registration\] pin\.existing_profile_pin: the recorded profile pin differs from the live profile versionPin/) },
];

// a stored static fixture whose layers object is empty used to pass: the layer loop and the comparison both skipped it
for (const item of ['HTTP-python-fastapi-01', 'HTTP-python-flask-01', 'HTTP-python-django-01']) {
  CASES.push({
    name: `every stored static fixture of ${item} has an empty layers object`, item, mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/static.json', (doc) => { for (const fixture of Object.values(doc.fixtures)) fixture.layers = {}; }),
    check: (problems) => { expectLine(/\[result-set\] results\/static\.json:normal: layers \[\] are not exactly the declared layers/)(problems); onlyCode('result-set')(problems); },
  });
}

for (const framework of ['starlette', 'litestar']) {
  let appear;
  CASES.push({
    name: `a scanner file for ${framework} appears, so the scope-only record is out of date`, item: `HTTP-python-${framework}-01`, mode: 'live', expect: 'adapter-appeared',
    prepare: (ctx) => { appear = syntheticRoot(ctx, `scanners/${framework}-extract.mjs`); },
    mutate: () => appear(),
  });
}

for (const c of CASES) {
  test(`tamper: ${c.name} -> ${c.expect}`, () => {
    const problems = tamper(c);
    assert.ok(problems.some((p) => p.code === c.expect), `expected a ${c.expect} problem, got: ${JSON.stringify(lines(problems))}`);
    c.check?.(problems);
  });
}

// verifyItems is the body of `node verify.mjs`. It runs here against throwaway repository roots (one record
// directory plus the files its live checks read), so a broken input can be applied without touching the tree.
function miniRoot(item) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-scope-cli-'));
  const record = loadRecord(item);
  const dir = path.join(root, SCOPE_TARGETS[item].dir);
  fs.cpSync(recordDir(item), dir, { recursive: true });
  for (const rel of [record.oracle_tool.path, ...record.layers.map((l) => l.source)]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  return { root, dir };
}

const CLI_CASES = [
  { name: 'results/static.json is missing', item: 'HTTP-python-flask-01', line: /^ {2}\[result-set\] results: stored results cannot be read: /,
    mutate: (dir) => fs.rmSync(path.join(dir, 'results/static.json')) },
  { name: 'results/static.json is not JSON', item: 'HTTP-python-fastapi-01', line: /^ {2}\[result-set\] results: stored results cannot be read: .*JSON/,
    mutate: (dir) => fs.writeFileSync(path.join(dir, 'results/static.json'), '{not json') },
  { name: 'results/static.json parses to null', item: 'HTTP-python-django-01', line: /^ {2}\[result-set\] results\/static\.json: the document is missing or has the wrong type/,
    mutate: (dir) => fs.writeFileSync(path.join(dir, 'results/static.json'), 'null') },
  { name: 'results/oracle.json parses to an empty object', item: 'HTTP-python-litestar-01', line: /^ {2}\[result-set\] results\/oracle\.json: fixtures is missing or has the wrong type/,
    mutate: (dir) => fs.writeFileSync(path.join(dir, 'results/oracle.json'), '{}') },
  { name: 'the fixtures directory is missing', item: 'HTTP-python-flask-01', line: /^ {2}\[fixture-set\] fixtures: /,
    mutate: (dir) => fs.rmSync(path.join(dir, 'fixtures'), { recursive: true }) },
  { name: 'SCOPE.json is missing', item: 'HTTP-python-starlette-01', line: /^ {2}\[schema\] SCOPE\.json: the record cannot be read: /,
    mutate: (dir) => fs.rmSync(path.join(dir, 'SCOPE.json')) },
  { name: 'SCOPE.json is the re-sealed record of another item', item: 'HTTP-python-flask-01', line: /^ {2}\[schema\] SCOPE\.json: the record names "HTTP-python-django-01" but is stored as the record of HTTP-python-flask-01$/,
    mutate: (dir) => { const file = path.join(dir, 'SCOPE.json'); const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.item = 'HTTP-python-django-01'; fs.writeFileSync(file, JSON.stringify(sealRecord(record), null, 2)); } },
];

test('the CLI body prints a structured failure for missing, unparseable and wrongly shaped inputs instead of throwing', () => {
  const run = (item, mutate) => {
    const { root, dir } = miniRoot(item);
    try {
      mutate?.(dir);
      const out = [];
      return { failed: verifyItems([item], { root, log: (line) => out.push(line) }), out };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  assert.deepEqual(run('HTTP-python-flask-01'), { failed: 0, out: ['HTTP-python-flask-01: ok'] }, 'the untouched throwaway root must verify cleanly before it is broken');
  for (const c of CLI_CASES) {
    const { failed, out } = run(c.item, c.mutate); // an exception here would fail the test with its stack
    assert.ok(failed > 0, c.name);
    assert.equal(out[0], `${c.item}: FAIL`, c.name);
    assert.ok(out.some((line) => c.line.test(line)), `${c.name}: expected a line matching ${c.line}, got ${JSON.stringify(out)}`);
  }
  const unknown = [];
  assert.equal(verifyItems(['HTTP-python-nope-01'], { log: (line) => unknown.push(line) }), 1);
  assert.match(unknown.join('\n'), /\[schema\] item: HTTP-python-nope-01 is not one of /);
});
