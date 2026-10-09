// Validates the five Python HTTP scope records (fastapi, flask, django, starlette, litestar -01) against
// their stored results and the live tree, then proves the validation FAILS when a record, a fixture, the
// oracle binding or the scanner output is tampered with. Nothing here skips: a missing interpreter fails.
// Runs through the nested runner only (node scripts/run-next-nested-tests.mjs T12), not through npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { STATIC_LAYERS, runStatic, serializeStatic } from '../../adapters/http-wave-a/python-scope/static-runner.mjs';
import {
  REPO_ROOT, SCOPE_TARGETS, derivePartition, loadRecord, recordDir, sealRecord, verifyItems, verifyLiveTree, verifyScopeRecord, verifyStoredRecord,
} from '../../adapters/http-wave-a/python-scope/verify.mjs';

const ITEMS = ['HTTP-python-fastapi-01', 'HTTP-python-flask-01', 'HTTP-python-django-01', 'HTTP-python-starlette-01', 'HTTP-python-litestar-01'];
const SCOPE_ONLY = ['HTTP-python-starlette-01', 'HTTP-python-litestar-01'];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const lines = (problems) => problems.map((p) => `[${p.code}] ${p.where}: ${p.message}`);
const must = (record, id) => record.must_catch.find((mc) => mc.id === id);
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
    assert.ok(record.must_catch.every((mc) => Object.keys(mc.layers).length === 0), `${item}: no scanner exists, so nothing may be assessed`);
  }
});

test('hashes and pins are recomputed here from the files, independently of verify.mjs', () => {
  for (const item of ITEMS) {
    const dir = recordDir(item);
    const record = loadRecord(item);
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
];

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
