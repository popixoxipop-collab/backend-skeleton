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
import { STATIC_LAYERS, canonical, runStatic, serializeStatic } from '../../adapters/http-wave-a/python-scope/static-runner.mjs';
import {
  REPO_ROOT, SCOPE_TARGETS, derivePartition, loadRecord, oraclePairs, printedRecord, pythonJson, recordDir, sealRecord, verifyItems, verifyLiveTree, verifyScopeRecord, verifyStoredRecord,
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
      } else if (cmd.stdout_unstored !== undefined) {
        // the PyPI response is volatile and not stored, so nothing could recompute a hash or a size: the command asserts neither
        assert.ok(cmd.id.startsWith('registry-') && !('stdout_sha256' in cmd) && !('stdout_bytes' in cmd), `${item} ${cmd.id}`);
      } else {
        const text = cmd.stdout_empty ? '' : cmd.stdout_inline;
        assert.equal(typeof text, 'string', `${item} ${cmd.id}: an output that is not stored must be empty or inline`);
        assert.equal(sha256(text), cmd.stdout_sha256, `${item} ${cmd.id}`);
        assert.equal(Buffer.byteLength(text), cmd.stdout_bytes, `${item} ${cmd.id}`);
      }
    }
    assert.equal(sha256(fs.readFileSync(path.join(dir, 'results/registry.json'))), record.pin.registry.extract_sha256, `${item}: the registry extract is bound by its hash`);
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
      ...r.executed_commands.map((c) => c.stdout_unstored ?? ''),
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
    fs.writeFileSync(path.join(tmp, 'SCOPE.json'), printedRecord(ctx.record));
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
// The text each stored document has when its own tool printed it. The verifier holds a stored document to exactly that text, so an
// edit that changes the content keeps this spelling and only the content check can object (a re-spelling is tested separately).
const PRINTED = {
  'results/oracle.json': (doc) => `${pythonJson(doc)}\n`,
  'results/registry.json': (doc) => `${JSON.stringify(doc, null, 1)}\n`,
  'results/static.json': (doc) => serializeStatic(canonical(doc)),
};
const editStoredJson = (ctx, rel, edit) => {
  const doc = JSON.parse(fs.readFileSync(path.join(ctx.dir, rel), 'utf8'));
  edit(doc);
  rewriteStored(ctx, rel, PRINTED[rel](doc));
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

// A command is accepted only as the one text the pin and the target imply (verify.mjs, expectedCommands). The flag-order rule:
// `python -m pip <verb>` first, then the flags in the order of the template (a flag that takes a value is followed by it), then the
// pins name==version last in pin.packages order; single spaces, no leading or trailing whitespace. Nothing is filtered, sorted or
// case-folded before the comparison, so the cases below only have to change the text.
const commandOf = (record, id) => record.executed_commands.find((c) => c.id === id);
const textMismatch = (id) => (problems) => {
  assert.ok(lines(problems).some((line) => line.startsWith(`[executed-command] executed_commands.${id}: command text does not follow from the pin and the target: `)), `expected a text problem for ${id}, got: ${JSON.stringify(lines(problems))}`);
  onlyCode('executed-command')(problems);
};
const exactCommand = (name, item, id, change) => ({
  name, item, mode: 'stored', expect: 'executed-command', check: textMismatch(id),
  mutate: ({ record }) => { const cmd = commandOf(record, id); cmd.command = change(cmd.command); },
});
// The first pinned wheel under another file name, in the registry extract, the digest file and the digest command alike, so that
// only the comparison of the name with the pin can object.
const renameWheel = (ctx, rename) => {
  const pkg = ctx.record.pin.packages[0];
  const wheel = rename(pkg);
  assert.notEqual(wheel, pkg.wheel);
  editStoredJson(ctx, 'results/registry.json', (doc) => { doc.projects[pkg.pypi].pinned.filename = wheel; });
  rewriteStored(ctx, 'results/wheel-digest.txt', fs.readFileSync(path.join(ctx.dir, 'results/wheel-digest.txt'), 'utf8').replace(pkg.wheel, wheel));
  const digest = commandOf(ctx.record, 'wheel-digest');
  digest.command = digest.command.replace(pkg.wheel, wheel);
  pkg.wheel = wheel;
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
    mutate: ({ record }) => { record.pin.existing_profile_pin = { source: 'adapters/http-wave-bc/catalog.mjs', value: { repo: 'litestar-org/litestar', ref: '0'.repeat(40) }, check_command: 'profile-ref-check' }; },
    check: expectLine(/\[registration\] pin\.existing_profile_pin: the recorded profile pin differs from the live profile versionPin/) },
  // A command whose output is not stored (the PyPI response) carries no hash and no size, so no record states what the verifier cannot
  // recompute (the registry extract itself is bound by pin.registry.extract_sha256); the output form of every command is exact, so a
  // command cannot be moved into a form whose recompute is skipped.
  { name: 'a registry command carries a stdout_sha256 although its output is not stored', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { commandOf(record, 'registry-flask').stdout_sha256 = sha256('any text'); },
    check: (problems) => { expectLine(/\[schema\] \/executed_commands\/0\/stdout_sha256: must not be present: no output of this command is stored, so there is nothing to recompute it from/)(problems); onlyCode('schema')(problems); } },
  { name: 'a registry command carries a stdout_bytes although its output is not stored', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { commandOf(record, 'registry-fastapi').stdout_bytes = 12; },
    check: (problems) => { expectLine(/\[schema\] \/executed_commands\/0\/stdout_bytes: must not be present: no output of this command is stored/)(problems); onlyCode('schema')(problems); } },
  { name: 'the second registry command of a two-package pin carries both a hash and a size', item: 'HTTP-python-django-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { Object.assign(commandOf(record, 'registry-djangorestframework'), { stdout_sha256: sha256(''), stdout_bytes: 0 }); },
    check: (problems) => { expectLine(/\[schema\] \/executed_commands\/1\/stdout_sha256: must not be present/)(problems); expectLine(/\[schema\] \/executed_commands\/1\/stdout_bytes: must not be present/)(problems); onlyCode('schema')(problems); } },
  { name: 'a registry command is re-labelled as an empty output, with the hash and the size of nothing', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = commandOf(record, 'registry-flask'); delete cmd.stdout_unstored; Object.assign(cmd, { stdout_empty: true, stdout_sha256: sha256(''), stdout_bytes: 0 }); },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.registry-flask: output form \[stdout_empty\] is not exactly \[stdout_unstored\]/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'a registry command is re-labelled as a stored output of the registry extract', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ dir, record }) => {
      const cmd = commandOf(record, 'registry-fastapi');
      const extract = fs.readFileSync(path.join(dir, 'results/registry.json'));
      delete cmd.stdout_unstored;
      Object.assign(cmd, { stored_as: 'results/registry.json', stdout_sha256: sha256(extract), stdout_bytes: extract.length });
    },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.registry-fastapi: output form \[stored_as\] is not exactly \[stdout_unstored\]/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'an install command is re-labelled as unstored, which would skip its recompute', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = commandOf(record, 'install'); delete cmd.stdout_empty; delete cmd.stdout_sha256; delete cmd.stdout_bytes; cmd.stdout_unstored = 'not kept'; },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.install: output form \[stdout_unstored\] is not exactly \[stdout_empty\]/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'an oracle command is re-labelled as unstored, which would skip its recompute', item: 'HTTP-python-django-01', mode: 'stored', expect: 'executed-command',
    mutate: ({ record }) => { const cmd = commandOf(record, 'oracle-2'); delete cmd.stored_as; delete cmd.stdout_sha256; delete cmd.stdout_bytes; cmd.stdout_unstored = 'not kept'; },
    check: (problems) => { expectLine(/\[executed-command\] executed_commands\.oracle-2: output form \[stdout_unstored\] is not exactly \[stored_as\]/)(problems); onlyCode('executed-command')(problems); } },
  { name: 'the inline output of the profile ref check is another text, with its hash and size kept consistent', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: ({ record }) => { const text = `${'0'.repeat(40)}\n`; Object.assign(commandOf(record, 'profile-ref-check'), { stdout_inline: text, stdout_sha256: sha256(text), stdout_bytes: text.length }); },
    check: (problems) => { expectLine(/\[pin\] pin\.existing_profile_pin: the pinned ref is not a 40-hex SHA confirmed by the recorded gh api output/)(problems); onlyCode('pin')(problems); } },
  // Finding B: the text of a command is the one text the flag-order rule gives (see exactCommand); the matrix test below changes every
  // token of every command, these are the named members.
  exactCommand('the reported example: the pin before python -m pip install --only-binary=:all:', 'HTTP-python-flask-01', 'install', () => 'flask==3.1.3 python -m pip install --only-binary=:all:'),
  exactCommand('the pin moves in front of the whole template', 'HTTP-python-flask-01', 'install', (t) => `flask==3.1.3 ${t.replace(' flask==3.1.3', '')}`),
  exactCommand('the pin moves before the flags', 'HTTP-python-flask-01', 'install', (t) => t.replace(' flask==3.1.3', '').replace('install', 'install flask==3.1.3')),
  exactCommand('the pin moves between the flags', 'HTTP-python-flask-01', 'install', (t) => t.replace(' flask==3.1.3', '').replace('--only-binary=:all:', 'flask==3.1.3 --only-binary=:all:')),
  exactCommand('two flags change places', 'HTTP-python-flask-01', 'install', (t) => t.replace('--disable-pip-version-check --only-binary=:all:', '--only-binary=:all: --disable-pip-version-check')),
  exactCommand('flask gains --no-cache-dir, which its commands never carried', 'HTTP-python-flask-01', 'install', (t) => t.replace('--only-binary', '--no-cache-dir --only-binary')),
  exactCommand('fastapi loses --no-cache-dir, which its commands carry', 'HTTP-python-fastapi-01', 'install', (t) => t.replace(' --no-cache-dir', '')),
  exactCommand('the wheel download of fastapi loses --no-cache-dir', 'HTTP-python-fastapi-01', 'wheel', (t) => t.replace(' --no-cache-dir', '')),
  exactCommand('the pins of a two-package install change places', 'HTTP-python-django-01', 'install', (t) => t.replace('django==6.1.1 djangorestframework==3.18.1', 'djangorestframework==3.18.1 django==6.1.1')),
  // Stored results are exactly the text their tool prints. Each case keeps every recorded hash and size consistent with the edited
  // file and re-seals, so only the line grammar or the document text can object (a blank line or a re-indented file used to parse).
  { name: 'results/environment.txt has an empty line, hashes kept consistent', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/environment.txt', fs.readFileSync(path.join(ctx.dir, 'results/environment.txt'), 'utf8').replace('\n', '\n\n')),
    check: expectLine(/\[result-set\] results\/environment\.txt: is not newline-terminated lines without an empty line or a carriage return/) },
  { name: 'results/environment.txt has no final newline, hashes kept consistent', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/environment.txt', fs.readFileSync(path.join(ctx.dir, 'results/environment.txt'), 'utf8').slice(0, -1)),
    check: expectLine(/\[result-set\] results\/environment\.txt: is not newline-terminated lines/) },
  { name: 'results/wheel-digest.txt has an empty line, hashes kept consistent', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/wheel-digest.txt', fs.readFileSync(path.join(ctx.dir, 'results/wheel-digest.txt'), 'utf8').replace('\n', '\n\n')),
    check: expectLine(/\[result-set\] results\/wheel-digest\.txt: is not newline-terminated lines/) },
  { name: 'results/wheel-digest.txt ends its lines with a carriage return, hashes kept consistent', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/wheel-digest.txt', fs.readFileSync(path.join(ctx.dir, 'results/wheel-digest.txt'), 'utf8').replace(/\n/g, '\r\n')),
    check: expectLine(/\[result-set\] results\/wheel-digest\.txt: is not newline-terminated lines/) },
  { name: 'pip freeze lists a pinned package twice, pin.installed kept equal to the stored lines', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: (ctx) => {
      const text = fs.readFileSync(path.join(ctx.dir, 'results/environment.txt'), 'utf8');
      const line = text.split('\n').find((l) => /^flask==/i.test(l));
      assert.ok(line, 'the freeze output lists the pinned package');
      rewriteStored(ctx, 'results/environment.txt', `${text}${line}\n`);
      ctx.record.pin.installed.push(line);
    },
    check: (problems) => { expectLine(/\[pin\] pin\.installed: pip freeze lists flask 2 times/)(problems); expectLine(/\[pin\] pin\.packages\.flask: pip freeze does not list this exact version exactly once/)(problems); onlyCode('pin')(problems); } },
  { name: 'results/oracle.json is re-indented, its content unchanged, hashes kept consistent', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/oracle.json', `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'results/oracle.json'), 'utf8')), null, 2)}\n`),
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json: is not the text its tool prints for the document it holds/)(problems); onlyCode('result-set')(problems); } },
  { name: 'results/registry.json is re-indented, its content unchanged, hashes kept consistent', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/registry.json', `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'results/registry.json'), 'utf8')), null, 2)}\n`),
    check: (problems) => { expectLine(/\[result-set\] results\/registry\.json: is not the text its tool prints for the document it holds/)(problems); onlyCode('result-set')(problems); } },
  { name: 'results/static.json is re-indented, its content unchanged, hashes kept consistent', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => rewriteStored(ctx, 'results/static.json', `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'results/static.json'), 'utf8')), null, 2)}\n`),
    check: (problems) => { expectLine(/\[result-set\] results\/static\.json: is not the text its tool prints for the document it holds/)(problems); onlyCode('result-set')(problems); } },
  { name: 'results/oracle.json holds one member twice, which parsing hides, hashes kept consistent', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => {
      const line = ' "oracle": "framework-route-table",\n';
      rewriteStored(ctx, 'results/oracle.json', fs.readFileSync(path.join(ctx.dir, 'results/oracle.json'), 'utf8').replace(line, line + line));
    },
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json: is not the text its tool prints for the document it holds/)(problems); onlyCode('result-set')(problems); } },
  { name: 'results/oracle.json is not valid UTF-8, hashes kept consistent', item: 'HTTP-python-litestar-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => {
      const bytes = Buffer.concat([fs.readFileSync(path.join(ctx.dir, 'results/oracle.json')), Buffer.from([0xff])]);
      fs.writeFileSync(path.join(ctx.dir, 'results/oracle.json'), bytes);
      for (const cmd of ctx.record.executed_commands.filter((x) => x.stored_as === 'results/oracle.json')) { cmd.stdout_sha256 = sha256(bytes); cmd.stdout_bytes = bytes.length; }
    },
    check: (problems) => { expectLine(/\[result-set\] results: stored results cannot be read: /)(problems); onlyCode('result-set')(problems); } },
  // Order and multiplicity of what oracle.py prints: a set comparison alone cannot see a moved, repeated or reordered member
  { name: 'two rows of the oracle result change places, every expected pair unchanged', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const rows = doc.fixtures.normal.routes; assert.ok(rows.length >= 2); [rows[0], rows[1]] = [rows[1], rows[0]]; }),
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json:normal: routes are not in the order oracle\.py prints \(sorted by path, then methods, then name\)/)(problems); onlyCode('result-set')(problems); } },
  { name: 'an oracle row is listed twice, next to its original', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const rows = doc.fixtures.normal.routes; rows.splice(1, 0, structuredClone(rows[0])); }),
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json:normal: routes list a route twice \(two rows are equal in every member\)/)(problems); onlyCode('result-set')(problems); } },
  { name: 'the methods of an oracle row are not in ascending order', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const row = doc.fixtures.normal.routes.find((r) => r.methods?.length >= 2); assert.ok(row); row.methods.reverse(); }),
    check: (problems) => { expectLine(/\[result-set\] results\/oracle\.json:normal: fixture \{error, routes\[\{path, methods, generated\}\]/)(problems); onlyCode('result-set')(problems); } },
  { name: 'an oracle row lists one method twice', item: 'HTTP-python-starlette-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const row = doc.fixtures.normal.routes.find((r) => r.methods?.length >= 1); assert.ok(row); row.methods.splice(1, 0, row.methods[0]); }),
    check: expectLine(/\[result-set\] results\/oracle\.json:normal: fixture \{error, routes\[\{path, methods, generated\}\]/) },
  { name: 'a generated group lists a path twice, its count kept equal to the list', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const group = doc.fixtures['counterexamples/generated-admin'].generated_groups[0]; group.paths_sorted.splice(1, 0, group.paths_sorted[0]); group.count += 1; }),
    check: expectLine(/\[result-set\] results\/oracle\.json:counterexamples\/generated-admin: fixture \{error, routes\[.*generated_groups\[\{group, count, paths_sorted\}\]/) },
  { name: 'a generated group is listed twice', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { const groups = doc.fixtures['counterexamples/generated-admin'].generated_groups; groups.splice(1, 0, structuredClone(groups[0])); }),
    check: expectLine(/\[result-set\] results\/oracle\.json:counterexamples\/generated-admin: generated_groups are not in the order oracle\.py prints \(sorted by group, no group twice\)/) },
  { name: 'the oracle of a framework without generated groups reports one', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/oracle.json', (doc) => { doc.fixtures.normal.generated_groups.push({ group: 'django.contrib.admin', count: 1, paths_sorted: ['/admin/'] }); }),
    check: expectLine(/\[result-set\] results\/oracle\.json:normal: generated_groups must be empty: only the django oracle reports groups/) },
  { name: 'the recorded fixture list is reversed', item: 'HTTP-python-django-01', mode: 'stored', expect: 'fixture-set',
    mutate: ({ record }) => { record.fixtures.reverse(); },
    check: expectLine(/\[fixture-set\] fixtures: fixtures \[.*\] are not the normal fixture first, then the counterexamples in ascending id order/) },
  { name: 'a fixture id is listed twice in the record', item: 'HTTP-python-fastapi-01', mode: 'stored', expect: 'fixture-set',
    mutate: ({ record }) => { record.fixtures.push(structuredClone(record.fixtures.at(-1))); },
    check: expectLine(/\[fixture-set\] fixtures: a fixture id is listed twice/) },
  // covering flags and the pin: a flag listed twice, a flag whose code alone does not name the construct, a release or a package listed
  // twice, a window that ends before it starts, a wheel that is not a wheel of the pinned version
  { name: 'a covering flag is listed twice', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'schema',
    mutate: ({ record }) => { const flags = must(record, 'router-prefix').layers['t06-flask-shadow'].covering_flags; flags.push(structuredClone(flags[0])); },
    check: expectLine(/\[schema\] \/must_catch\/\d+\/layers\/t06-flask-shadow\/covering_flags: must NOT have duplicate items/) },
  { name: 'the text_includes of a covering flag that names its construct only through a printed text is removed', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'must-catch',
    mutate: ({ record }) => { const flag = must(record, 'router-prefix').layers['t06-flask-shadow'].covering_flags.find((f) => f.text_includes !== undefined); assert.ok(flag); delete flag.text_includes; },
    check: expectLine(/\[must-catch\] must_catch\.router-prefix@t06-flask-shadow: covering flag registration-limitation names no text_includes, but the layer prints a text under that code/) },
  { name: 'the registry extract lists a release after the pin twice, the hash kept consistent', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: (ctx) => editStoredJson(ctx, 'results/registry.json', (doc) => { const list = doc.projects.django.released_after_pin; list.push(structuredClone(list[0])); }),
    check: expectLine(/\[result-set\] results\/registry\.json:django: released_after_pin lists a version twice/) },
  { name: 'the fetch window ends before it starts, the registry extract carrying the same text', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: (ctx) => {
      const [from, to] = ctx.record.pin.registry.fetched_utc.split('..');
      assert.notEqual(from, to);
      ctx.record.pin.registry.fetched_utc = `${to}..${from}`;
      editStoredJson(ctx, 'results/registry.json', (doc) => { doc.fetched_utc = `${to}..${from}`; });
    },
    check: (problems) => { expectLine(/\[pin\] pin\.registry: the fetch window ends before it starts/)(problems); onlyCode('pin')(problems); } },
  { name: 'a package is pinned twice, which the registry extract cannot list twice', item: 'HTTP-python-django-01', mode: 'stored', expect: 'result-set',
    mutate: ({ record }) => { record.pin.packages.push(structuredClone(record.pin.packages[1])); },
    check: expectLine(/\[result-set\] results\/registry\.json: projects \[django,djangorestframework\] are not exactly the pinned packages \[django,djangorestframework,djangorestframework\], in the pin order/) },
  { name: 'two pinned packages name the same wheel', item: 'HTTP-python-django-01', mode: 'stored', expect: 'pin',
    mutate: ({ record }) => { record.pin.packages[1].wheel = record.pin.packages[0].wheel; },
    check: expectLine(/\[pin\] pin\.packages: a package or a wheel is pinned twice/) },
  { name: 'the pinned wheel is a wheel of another version, every file that names it edited to match', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: (ctx) => renameWheel(ctx, (pkg) => pkg.wheel.replace(pkg.version, '3.1.4')),
    check: (problems) => { expectLine(/\[pin\] pin\.packages\.flask: wheel flask-3\.1\.4-py3-none-any\.whl is not a wheel of flask 3\.1\.3/)(problems); onlyCode('pin')(problems); } },
  // the distribution name of the wheel is compared character for character (it used to be case-folded first)
  { name: 'the pinned wheel is spelled with a capital letter, every file that names it edited to match', item: 'HTTP-python-flask-01', mode: 'stored', expect: 'pin',
    mutate: (ctx) => renameWheel(ctx, (pkg) => pkg.wheel.replace('flask', 'Flask')),
    check: (problems) => { expectLine(/\[pin\] pin\.packages\.flask: wheel Flask-3\.1\.3-py3-none-any\.whl is not a wheel of flask 3\.1\.3/)(problems); onlyCode('pin')(problems); } },
  // the live tree: every file below a fixture is listed (nothing is skipped by name), in the order the walk lists them, and a listed
  // entry that is not a regular file is a problem of its own instead of a skipped hash check
  { name: 'a __pycache__ directory appears inside a recorded fixture', item: 'HTTP-python-flask-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ dir }) => { fs.mkdirSync(path.join(dir, 'fixtures/normal/__pycache__')); fs.writeFileSync(path.join(dir, 'fixtures/normal/__pycache__/app.cpython-312.pyc'), 'x'); },
    check: expectLine(/\[fixture-set\] fixtures\.normal: live files \[.*__pycache__\/app\.cpython-312\.pyc.*\] differ from the recorded files/) },
  { name: 'a recorded fixture file is replaced by a symbolic link to a file with the same content', item: 'HTTP-python-fastapi-01', mode: 'live', expect: 'fixture-hash',
    mutate: ({ dir }) => {
      const link = path.join(dir, 'fixtures/normal/app.py');
      const target = path.join(dir, 'app-copy.txt');
      fs.copyFileSync(link, target);
      fs.rmSync(link);
      fs.symlinkSync(target, link);
    },
    check: expectLine(/\[fixture-hash\] fixtures\.normal\/app\.py: is not a regular file that can be read, so its content cannot be hashed/) },
  { name: 'the fixtures directory is a symbolic link to a copy of the tree', item: 'HTTP-python-litestar-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ dir }) => { fs.renameSync(path.join(dir, 'fixtures'), path.join(dir, 'fixtures-copy')); fs.symlinkSync(path.join(dir, 'fixtures-copy'), path.join(dir, 'fixtures')); },
    check: expectLine(/\[fixture-set\] fixtures: live fixtures \[\] differ from the recorded ones/) },
  { name: 'the files of a recorded fixture are listed in another order than the walk lists them', item: 'HTTP-python-django-01', mode: 'live', expect: 'fixture-set',
    mutate: ({ record }) => { const fixture = record.fixtures.find((f) => f.id === 'normal'); assert.ok(Object.keys(fixture.files).length >= 2); fixture.files = Object.fromEntries(Object.entries(fixture.files).reverse()); },
    check: expectLine(/\[fixture-set\] fixtures\.normal: live files \[.*\] differ from the recorded files \[.*\] \(a file more, fewer, moved or listed twice\)/) },
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
  // the record's own directory used to be left out of that search, so an adapter placed next to the record was never seen
  CASES.push({
    name: `an adapter file appears next to the scope-only record of ${framework}, under a name that does not mention the framework`, item: `HTTP-python-${framework}-01`, mode: 'live', expect: 'adapter-appeared',
    mutate: ({ dir }) => fs.writeFileSync(path.join(dir, 'index.mjs'), '// an adapter now sits next to the record\n'),
    check: expectLine(new RegExp(`\\[adapter-appeared\\] layers: a scanner or adapter file for ${framework} now exists \\(adapters/http-wave-bc/python-${framework}/index[.]mjs\\)`)),
  });
}

for (const c of CASES) {
  test(`tamper: ${c.name} -> ${c.expect}`, () => {
    const problems = tamper(c);
    assert.ok(problems.some((p) => p.code === c.expect), `expected a ${c.expect} problem, got: ${JSON.stringify(lines(problems))}`);
    c.check?.(problems);
  });
}

// The commands of each record, frozen here for the same reason as the ledger: a re-sealed edit of the pin, of a flag or of the order
// cannot pass unless this file changes with it. The ids are in the order the record states them; the three long texts are the ones
// whose flags and pins the flag-order rule is about. The install and the download of flask carry no --no-cache-dir; every other record's do.
const FROZEN_COMMANDS = {
  'HTTP-python-fastapi-01': {
    ids: 'registry-fastapi venv install freeze wheel wheel-digest oracle-1 oracle-2 static-1 static-2 static-py312',
    install: 'python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -q fastapi==0.143.0',
    wheel: 'python -m pip download --no-deps --no-cache-dir --only-binary=:all: --disable-pip-version-check -d wheels -q fastapi==0.143.0',
    digest: 'shasum -a 256 fastapi-0.143.0-py3-none-any.whl',
  },
  'HTTP-python-flask-01': {
    ids: 'registry-flask venv install freeze wheel wheel-digest oracle-1 oracle-2 static-1 static-2 static-py312 profile-ref-check',
    install: 'python -m pip install --disable-pip-version-check --only-binary=:all: -q flask==3.1.3',
    wheel: 'python -m pip download --no-deps --only-binary=:all: --disable-pip-version-check -d wheels -q flask==3.1.3',
    digest: 'shasum -a 256 flask-3.1.3-py3-none-any.whl',
  },
  'HTTP-python-django-01': {
    ids: 'registry-django registry-djangorestframework venv install freeze wheel wheel-digest oracle-1 oracle-2 static-1 static-2 static-py312 profile-ref-check',
    install: 'python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -q django==6.1.1 djangorestframework==3.18.1',
    wheel: 'python -m pip download --no-deps --no-cache-dir --only-binary=:all: --disable-pip-version-check -d wheels -q django==6.1.1 djangorestframework==3.18.1',
    digest: 'shasum -a 256 django-6.1.1-py3-none-any.whl djangorestframework-3.18.1-py3-none-any.whl',
  },
  'HTTP-python-starlette-01': {
    ids: 'registry-starlette venv install freeze wheel wheel-digest oracle-1 oracle-2',
    install: 'python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -q starlette==1.7.0',
    wheel: 'python -m pip download --no-deps --no-cache-dir --only-binary=:all: --disable-pip-version-check -d wheels -q starlette==1.7.0',
    digest: 'shasum -a 256 starlette-1.7.0-py3-none-any.whl',
  },
  'HTTP-python-litestar-01': {
    ids: 'registry-litestar venv install freeze wheel wheel-digest oracle-1 oracle-2',
    install: 'python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -q litestar==2.24.0',
    wheel: 'python -m pip download --no-deps --no-cache-dir --only-binary=:all: --disable-pip-version-check -d wheels -q litestar==2.24.0',
    digest: 'shasum -a 256 litestar-2.24.0-py3-none-any.whl',
  },
};

test('the commands of each record are frozen here, and an unstored output states no hash and no size', () => {
  let unstored = 0;
  for (const item of ITEMS) {
    const record = loadRecord(item);
    const want = FROZEN_COMMANDS[item];
    assert.equal(record.executed_commands.map((c) => c.id).join(' '), want.ids, `${item}: the command ids, in order`);
    assert.equal(commandOf(record, 'install').command, want.install, item);
    assert.equal(commandOf(record, 'wheel').command, want.wheel, item);
    assert.equal(commandOf(record, 'wheel-digest').command, want.digest, item);
    const registry = record.executed_commands.filter((c) => c.stdout_unstored !== undefined);
    assert.deepEqual(registry.map((c) => c.id), record.pin.packages.map((p) => `registry-${p.pypi}`), `${item}: the unstored outputs are the registry responses, one per pinned package, stated first`);
    for (const c of registry) assert.deepEqual(Object.keys(c).sort(), ['command', 'exit_code', 'id', 'stdout_unstored'], `${item} ${c.id}: nothing could recompute a hash or a size of the response, so none is stated`);
    unstored += registry.length;
  }
  assert.equal(unstored, 6, 'five records, six pinned packages');
});

// How each key of a command record is held. A changed value must end in the code named here, a deleted member in some problem; the one
// key that is held by neither is the prose of an unstored output, which is sealed, not recomputed (a stated limit of every record).
const COMMAND_KEYS = {
  id: 'executed-command', command: 'executed-command', exit_code: 'executed-command', stored_as: 'executed-command',
  stdout_sha256: 'result-hash', stdout_bytes: 'result-hash', stdout_inline: 'result-hash', stdout_empty: 'schema', stdout_unstored: null,
};
// another value of the same type; a hash keeps its shape, so only a recompute (not the schema) can object to it
const changed = (value) => (typeof value === 'string' ? (/^[0-9a-f]{40,64}$/.test(value) ? `${value[0] === 'a' ? 'b' : 'a'}${value.slice(1)}` : `${value}x`) : typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'x');

test('every key of every command record is recomputed, compared exactly or absent from the schema: deleting or changing it is reported', () => {
  const seen = new Set();
  let mutations = 0;
  for (const item of ITEMS) {
    const base = loadRecord(item);
    const dir = recordDir(item);
    const run = (record) => verifyStoredRecord(sealRecord(record), { dir });
    base.executed_commands.forEach((cmd, index) => {
      for (const [key, value] of Object.entries(cmd)) {
        seen.add(key);
        const deleted = structuredClone(base);
        delete deleted.executed_commands[index][key];
        assert.ok(run(deleted).length > 0, `${item} ${cmd.id}: deleting ${key} must be reported`);
        const other = structuredClone(base);
        other.executed_commands[index][key] = changed(value);
        const code = COMMAND_KEYS[key];
        if (code !== null) assert.ok(run(other).some((p) => p.code === code), `${item} ${cmd.id}: changing ${key} must end in a ${code} problem`);
        mutations += 2;
      }
    });
  }
  assert.deepEqual([...seen].sort(), Object.keys(COMMAND_KEYS).sort(), 'a command key that is not classified above is held by nothing');
  assert.ok(mutations >= 600, `only ${mutations} mutations ran`);
});

// Token matrix. Each command text of each record is changed in every way the flag-order rule excludes: a token moved to every other
// position, two tokens swapped, a token repeated, dropped, written in capitals or in lower case, a gap of two spaces, a tab, a newline
// or a no-break space, a flag added, a token with a character more in front of it or behind it (a pin with another name or version),
// a pin with another operator, whitespace before or after the whole text. The record is
// re-sealed after each change and the verifier has to object to the text of that very command. (A variant equal to the original is
// skipped; oracle-2 and static-2 are run too, although they repeat the text of oracle-1 and static-1.)
const NBSP = String.fromCharCode(160);
function textVariants(text) {
  const tokens = text.split(' ');
  const out = new Map(); // variant text -> kind
  const add = (kind, parts) => { const variant = parts.join(' '); if (variant !== text && !out.has(variant)) out.set(variant, kind); };
  tokens.forEach((token, i) => {
    tokens.forEach((_, j) => {
      if (i === j) return;
      const rest = tokens.filter((__, k) => k !== i);
      rest.splice(j, 0, token);
      add('moved', rest);
      if (j > i) { const swapped = [...tokens]; [swapped[i], swapped[j]] = [swapped[j], swapped[i]]; add('swapped', swapped); }
    });
    add('repeated', [...tokens.slice(0, i + 1), token, ...tokens.slice(i + 1)]);
    add('dropped', tokens.filter((_, k) => k !== i));
    add('upper', tokens.map((t, k) => (k === i ? t.toUpperCase() : t)));
    add('lower', tokens.map((t, k) => (k === i ? t.toLowerCase() : t)));
    add('flag-before', [...tokens.slice(0, i), '--pre', ...tokens.slice(i)]);
    add('suffix', tokens.map((t, k) => (k === i ? `${t}1` : t)));
    add('prefix', tokens.map((t, k) => (k === i ? `x${t}` : t)));
    if (token.includes('==')) add('operator', tokens.map((t, k) => (k === i ? t.replace('==', '>=') : t)));
    if (i > 0) for (const gap of ['  ', '\t', '\n', NBSP]) add('gap', [tokens.slice(0, i).join(' ') + gap + tokens.slice(i).join(' ')]);
  });
  add('flag-after', [...tokens, '-v']);
  for (const space of [' ', '\t', '\n', '\r', NBSP]) { add('leading', [space + text]); add('trailing', [text + space]); }
  return out;
}

test('token matrix: no text that the flag-order rule does not give is accepted for any command of any record', () => {
  const kinds = new Set();
  let variants = 0;
  for (const item of ITEMS) {
    const base = loadRecord(item);
    const dir = recordDir(item);
    base.executed_commands.forEach((cmd, index) => {
      const where = `executed_commands.${cmd.id}`;
      const original = cmd.command;
      try {
        for (const [variant, kind] of textVariants(original)) {
          cmd.command = variant;
          const problems = verifyStoredRecord(sealRecord(base), { dir });
          assert.ok(problems.some((p) => p.code === 'executed-command' && p.where === where && p.message.startsWith('command text does not follow from the pin and the target')), `${item} ${cmd.id}: the ${kind} variant ${JSON.stringify(variant)} was not rejected as a text`);
          kinds.add(kind);
          variants += 1;
        }
      } finally {
        base.executed_commands[index].command = original;
      }
    });
  }
  assert.deepEqual([...kinds].sort(), ['dropped', 'flag-after', 'flag-before', 'gap', 'leading', 'lower', 'moved', 'operator', 'prefix', 'repeated', 'suffix', 'swapped', 'trailing', 'upper']);
  assert.ok(variants >= 4000, `only ${variants} variants ran`);
});

test('order matrix: a command dropped, repeated, moved to another place or swapped with another is reported for every command of every record', () => {
  let variants = 0;
  for (const item of ITEMS) {
    const base = loadRecord(item);
    const dir = recordDir(item);
    const list = base.executed_commands;
    const run = (commands) => lines(verifyStoredRecord(sealRecord({ ...base, executed_commands: commands }), { dir }));
    const reported = (found, start, what) => assert.ok(found.some((line) => line.startsWith(start)), `${item}: ${what}: expected a line starting ${start}, got ${JSON.stringify(found)}`);
    list.forEach((cmd, i) => {
      reported(run(list.filter((_, k) => k !== i)), `[executed-command] executed_commands.${cmd.id}: a command this record must state is missing`, `${cmd.id} dropped`);
      reported(run([...list.slice(0, i + 1), structuredClone(cmd), ...list.slice(i + 1)]), `[executed-command] executed_commands.${cmd.id}: duplicate command id`, `${cmd.id} repeated`);
      variants += 2;
      list.forEach((_, j) => {
        if (i === j) return;
        const moved = list.filter((__, k) => k !== i);
        moved.splice(j, 0, cmd);
        reported(run(moved), '[executed-command] executed_commands: the commands [', `${cmd.id} moved to place ${j}`);
        variants += 1;
        if (j < i) return;
        const swapped = [...list];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        reported(run(swapped), '[executed-command] executed_commands: the commands [', `${cmd.id} swapped with ${list[j].id}`);
        variants += 1;
      });
    });
  }
  assert.ok(variants >= 850, `only ${variants} variants ran`);
});

// pythonJson stands in for json.dumps(value, sort_keys=True, indent=1): the stored oracle.json is compared with its text, so a different
// escape or a different key order (JavaScript sorts by UTF-16 unit, Python by code point) would accept or reject the wrong file.
// Here real Python prints the same document and the two texts must be equal.
test('pythonJson prints exactly what python json.dumps(sort_keys=True, indent=1) prints', () => {
  const python = findPythonRuntime();
  assert.ok(python, 'python3 (3.8+) must be on PATH');
  const doc = {
    [String.fromCodePoint(0x10000)]: 'a key above the basic plane sorts after U+FFFF, though its UTF-16 units sort before it',
    [String.fromCharCode(0xffff)]: 'the last code point of the basic plane',
    [String.fromCharCode(0xe9)]: 'e acute',
    '\x7f': 'DEL is escaped, since it is outside space..tilde',
    '\0': 'NUL',
    a: 'ascii',
    B: 'upper case sorts before lower case',
    empty_list: [],
    empty_object: {},
    nested: { list: [[], [1, [2, []]], {}, { b: 1, a: [true, false, null] }], text: '' },
    numbers: [0, -1, 1.5, 12345678901],
    text: ['"quoted"', String.fromCharCode(92), '\n\t\r\b\f', '\x01\x1f', String.fromCodePoint(0x1f600), String.fromCharCode(0x2028), String.fromCharCode(0xd800), String.fromCharCode(0xe9)],
  };
  const snippet = 'import json, sys\nprint(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, indent=1))';
  const printed = execFileSync(python.executable, ['-I', '-B', '-X', 'utf8', '-c', snippet], { input: JSON.stringify(doc), encoding: 'utf8' });
  assert.equal(`${pythonJson(doc)}\n`, printed);
  assert.ok(printed.includes(`"${String.fromCharCode(92)}u007f"`) && printed.includes(`${String.fromCharCode(92)}ud83d${String.fromCharCode(92)}ude00`), 'the document must contain the escapes that matter');
});

// Record sweep. Every path of every record is mutated one way at a time (a member deleted, a value changed, a list item repeated, two
// neighbours swapped, a list extended, an object given one more member), the record is re-sealed, and verifyStoredRecord runs on it:
// about 5,600 mutations, none sampled. What the stored check does not object to has to be one of
//   - prose (SWEEP_PROSE): sealed, not recomputed, the stated limit of every record; the table is exact, so an entry that no mutation
//     escapes any more is stale and fails;
//   - the author's order of the must-catch list (SWEEP_AUTHORIAL); or
//   - held by the checked-out tree: then verifyLiveTree has to object to one mutation of that kind (the first, in the cheapest record).
// record_digest is skipped, since re-sealing rewrites it; the seal has its own case above.
const SWEEP_PROSE = {
  'claims.statement': 'change',
  'runtime_tested.reason': 'change',
  'conformance.reason': 'change',
  'layers.*.role': 'change',
  'must_catch.*.construct': 'change',
  'must_catch.*.blind_property': 'change',
  'must_catch.*.layers.<k>.covering_flags.*.covers': 'change',
  'oracle_range.kind': 'change',
  'oracle_range.can_verify': 'extend',
  'oracle_range.can_verify.*': 'delete repeat swap change',
  'oracle_range.cannot_verify': 'extend',
  'oracle_range.cannot_verify.*': 'delete repeat swap change',
  'executed_commands.*.stdout_unstored': 'change',
  limits: 'extend',
  'limits.*': 'delete repeat swap change',
  plan: 'extend',
  'plan.*': 'delete repeat swap change',
};
const SWEEP_AUTHORIAL = 'must_catch.* :: swap';
const CHEAPEST_FIRST = ['HTTP-python-starlette-01', 'HTTP-python-litestar-01', 'HTTP-python-flask-01', 'HTTP-python-django-01', 'HTTP-python-fastapi-01'];
const isNested = (value) => value !== null && typeof value === 'object';
function* sweepPaths(value, p = []) {
  yield [p, value];
  if (isNested(value)) for (const key of Object.keys(value)) yield* sweepPaths(value[key], [...p, key]);
}
// list positions are '*'; the keys under files and layers (file names, layer ids) are '<k>'
const sweepClass = (p) => p.map((key, i) => (/^\d+$/.test(key) ? '*' : i > 0 && (p[i - 1] === 'files' || p[i - 1] === 'layers') ? '<k>' : key)).join('.');
function sweepMutations(root, p, value) {
  const key = p[p.length - 1];
  const parent = (record) => p.slice(0, -1).reduce((node, k) => node[k], record);
  const here = (record) => p.reduce((node, k) => node[k], record);
  const siblings = parent(root);
  const inList = Array.isArray(siblings);
  const out = [['delete', (record) => { if (inList) parent(record).splice(Number(key), 1); else delete parent(record)[key]; }]];
  if (inList) {
    out.push(['repeat', (record) => parent(record).splice(Number(key) + 1, 0, structuredClone(parent(record)[Number(key)]))]);
    if (Number(key) + 1 < siblings.length) out.push(['swap', (record) => { const list = parent(record); const i = Number(key); [list[i], list[i + 1]] = [list[i + 1], list[i]]; }]);
  }
  if (Array.isArray(value)) out.push(['extend', (record) => { const list = here(record); list.push(list.length ? structuredClone(list[0]) : 'x'); }]);
  else if (isNested(value)) out.push(['add', (record) => { here(record).zz_extra = 1; }]);
  else out.push(['change', (record) => { parent(record)[key] = changed(value); }]);
  return out;
}

test('record sweep: a mutation of any path of any record is reported by the stored check, by the live check, or is listed prose', () => {
  const escaped = new Map(); // 'class :: kind' -> [{ item, p, apply }]
  let mutations = 0;
  for (const item of ITEMS) {
    const base = loadRecord(item);
    const dir = recordDir(item);
    for (const [p, value] of sweepPaths(base)) {
      if (p.length === 0 || p[0] === 'record_digest') continue;
      for (const [kind, apply] of sweepMutations(base, p, value)) {
        const record = structuredClone(base);
        apply(record);
        if (isDeepStrictEqual(record, base)) continue; // two equal neighbours swapped
        mutations += 1;
        if (verifyStoredRecord(sealRecord(record), { dir }).length) continue;
        const key = `${sweepClass(p)} :: ${kind}`;
        if (!escaped.has(key)) escaped.set(key, []);
        escaped.get(key).push({ item, p, apply });
      }
    }
  }
  assert.ok(mutations >= 5000, `only ${mutations} mutations ran`);
  const prose = Object.entries(SWEEP_PROSE).flatMap(([cls, kinds]) => kinds.split(' ').map((kind) => `${cls} :: ${kind}`));
  assert.deepEqual(prose.filter((key) => !escaped.has(key)), [], 'listed as prose, but every mutation of that kind is reported now: remove it from SWEEP_PROSE');
  assert.ok(escaped.has(SWEEP_AUTHORIAL), 'the must-catch order is the only order the author keeps: stale entry');
  const held = [...escaped.keys()].filter((key) => !prose.includes(key) && key !== SWEEP_AUTHORIAL);
  assert.ok(held.length >= 30, `only ${held.length} kinds are held by the live tree`);
  for (const key of held) {
    const { item, apply } = [...escaped.get(key)].sort((a, b) => CHEAPEST_FIRST.indexOf(a.item) - CHEAPEST_FIRST.indexOf(b.item))[0];
    const record = structuredClone(loadRecord(item));
    apply(record);
    const problems = verifyLiveTree(sealRecord(record), { dir: recordDir(item), root: REPO_ROOT });
    assert.ok(problems.length > 0, `${key} (${item}) is reported by neither the stored check nor the live check, and it is not listed prose`);
  }
});

test('the limits that state what is sealed and what is held are present in every record', () => {
  for (const item of ITEMS) {
    const { limits } = loadRecord(item);
    assert.equal(limits.filter((text) => text.startsWith('record_digest seals the whole record, so an edit that is not re-sealed fails. Prose is sealed, not recomputed: ')).length, 1, item);
    assert.equal(limits.filter((text) => text.startsWith('Held to shape, order and the hash of the file, not recomputed from a second source: ')).length, 1, item);
    assert.ok(limits.some((text) => text.startsWith('Route-set evidence only: ')) && limits.some((text) => text.startsWith('Only the pinned version was run. ')), item);
  }
});

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

const SPELLING = /^ {2}\[schema\] SCOPE\.json: is not the text that JSON\.stringify\(record, null, 2\) prints for the record it holds \(/;
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
    mutate: (dir) => { const file = path.join(dir, 'SCOPE.json'); const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.item = 'HTTP-python-django-01'; fs.writeFileSync(file, printedRecord(sealRecord(record))); } },
  // JSON.parse ignores spacing and keeps the last of two equal member names, so each of these parses to the very record that verifies
  { name: 'SCOPE.json is indented by four spaces, the record it holds unchanged', item: 'HTTP-python-starlette-01', line: SPELLING,
    mutate: (dir) => { const file = path.join(dir, 'SCOPE.json'); fs.writeFileSync(file, `${JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 4)}\n`); } },
  { name: 'SCOPE.json lacks its final newline', item: 'HTTP-python-litestar-01', line: SPELLING,
    mutate: (dir) => { const file = path.join(dir, 'SCOPE.json'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd()); } },
  { name: 'SCOPE.json states a member twice', item: 'HTTP-python-flask-01', line: SPELLING,
    mutate: (dir) => { const file = path.join(dir, 'SCOPE.json'); const text = fs.readFileSync(file, 'utf8'); const twice = text.replace(/^ {2}"item": .*\n/m, (member) => member + member); assert.notEqual(twice, text); fs.writeFileSync(file, twice); } },
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
