// T11-02: preserve report key presence without changing the frozen legacy scan.
// A standalone positive/negative test outside the historical pinned T11 tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeLegacyScanReport as observe, T11_REPORT_OBSERVATION_V1 } from '../next/t11/report-observation-v1.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { legacyHttpBaseline, LEGACY_HTTP_ADAPTER_IDS } from '../adapters/http-legacy-next/baselines.mjs';


const missing = () => ({ schema: 'sbf.scan-report/2' });
const full = () => ({
  schema: 'sbf.scan-report/2',
  adapter: 'python-fastapi', verdict: 'green', confidence: 'high',
  api_surface_source: 'source', related_modules: [], path_prefix_signals: [],
  files_read: [],
});

test('T11O01 fully reported empty arrays carry explicit observed-empty markers', () => {
  const result = observe(full());
  assert.equal(result.schema, T11_REPORT_OBSERVATION_V1);
  assert.equal(result.quality, 'reported_fields_only');
  assert.equal(result.fields.related_modules.state, 'reported_empty');
  assert.equal(result.fields.related_modules.itemCount, 0);
  assert.equal(result.fields.path_prefix_signals.state, 'reported_empty');
  assert.equal(result.fields.files_read.state, 'reported_empty');
  assert.deepEqual(result.modules, []);
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
});

test('T11O02 omitted field never collapses to an explicitly reported empty array', () => {
  const absent = observe(missing());
  const empty = observe({ ...missing(), related_modules: [] });
  assert.equal(absent.fields.related_modules.state, 'not_reported');
  assert.equal(empty.fields.related_modules.state, 'reported_empty');
  assert.equal(empty.fields.related_modules.itemCount, 0);
  assert.notEqual(absent.observationSha256, empty.observationSha256);
});

test('T11O03 explicit null and own undefined differ from absent and from []', () => {
  const sources = [
    [missing(), 'not_reported'],
    [{ ...missing(), related_modules: null }, 'explicit_null'],
    [{ ...missing(), related_modules: undefined }, 'explicit_undefined'],
    [{ ...missing(), related_modules: [] }, 'reported_empty'],
  ];
  const digests = new Set();
  for (const [value, expected] of sources) {
    const result = observe(value);
    assert.equal(result.fields.related_modules.state, expected);
    digests.add(result.observationSha256);
  }
  assert.equal(digests.size, sources.length);
});

test('T11O04 false/0 are reported scalar values, empty string remains distinguishable', () => {
  const base = missing();
  for (const [value, expected] of [[false, 'reported_value'], [0, 'reported_value'],
    ['', 'reported_empty'], [null, 'explicit_null'], [undefined, 'explicit_undefined']]) {
    const result = observe({ ...base, verdict: value });
    assert.equal(result.fields.verdict.state, expected);
  }
});

test('T11O05 prototype-inherited fields never count as observed source', () => {
  const source = Object.create({ related_modules: [], files_read: [] });
  source.schema = 'sbf.scan-report/2';
  const result = observe(source);
  assert.equal(result.fields.related_modules.state, 'not_reported');
  assert.equal(result.fields.files_read.state, 'not_reported');
});

test('T11O06 getter accessors are not invoked and are explicitly unsupported', () => {
  let calls = 0;
  const source = missing();
  Object.defineProperty(source, 'files_read', {
    enumerable: true, get() { calls++; throw new Error('getter must not run'); },
  });
  const result = observe(source);
  assert.equal(result.fields.files_read.state, 'accessor_unsupported');
  assert.equal(result.quality, 'incomplete_report_fields');
  assert.equal(calls, 0);
});

test('T11O07 nested module lists preserve missing vs observed empty', () => {
  const absent = full();
  absent.related_modules = [{ module: 'app' }];
  const seen = full();
  seen.related_modules = [{ module: 'app', controllers: [], entities: [], enums: [], dtos: [] }];
  const a = observe(absent);
  const b = observe(seen);
  assert.equal(a.modules[0].fields.controllers.state, 'not_reported');
  assert.equal(b.modules[0].fields.controllers.state, 'reported_empty');
  assert.notEqual(a.observationSha256, b.observationSha256);
});

test('T11O08 invalid non-array section is not silently read as an empty array', () => {
  const bad = full();
  bad.related_modules = {};
  const result = observe(bad);
  assert.equal(result.fields.related_modules.state, 'invalid_type');
  assert.equal(result.fields.related_modules.itemCount, null);
  assert.equal(result.quality, 'incomplete_report_fields');
});

test('T11O09 invalid nested module never becomes a fabricated empty module', () => {
  const report = full();
  report.related_modules = [null];
  const result = observe(report);
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].index, 0);
  assert.equal(result.modules[0].fields.controllers.state, 'invalid_container');
  assert.equal(result.quality, 'incomplete_report_fields');
});

test('T11O10 excessive module lists fail closed instead of truncating silently', () => {
  const report = full();
  report.related_modules = Array.from({ length: 2049 }, () => ({}));
  assert.throws(() => observe(report), /T11_OBSERVATION_MODULE_LIMIT/);
});

test('T11O11 wrong/absent schema and non-object reports are rejected', () => {
  for (const bad of [null, [], {}, { schema: 'sbf.scan-report/1' },
    { schema: undefined }, Object.create({ schema: 'sbf.scan-report/2' })]) {
    assert.throws(() => observe(bad), /own sbf.scan-report\/2 schema/);
  }
});

test('T11O12 observation does not mutate or replace legacy report data', () => {
  const source = full();
  source.related_modules = [{ module: 'a', controllers: [], entities: [], enums: [], dtos: [] }];
  const before = structuredClone(source);
  const result = observe(source);
  assert.deepEqual(source, before);
  assert.equal(source.schema, 'sbf.scan-report/2');
  assert.equal(result.modules[0].fields.controllers.state, 'reported_empty');
});

test('T11O13 identical inputs yield the same digest; a changed presence does not', () => {
  const r = full();
  const a = observe(r);
  const b = observe(structuredClone(r));
  assert.deepEqual(a, b);
  const changed = structuredClone(r);
  delete changed.files_read;
  assert.notEqual(observe(changed).observationSha256, a.observationSha256);
});

test('T11O14 observation cannot be changed into a positive runtime support claim', () => {
  const report = observe(full());
  assert.equal(report.supportCertified, false);
  assert.equal(report.promotionAllowed, false);
  assert.throws(() => { report.promotionAllowed = true; }, TypeError);
  assert.throws(() => { report.fields.related_modules.state = 'reported_value'; }, TypeError);
});

test('T11O15 nested array item counts preserve observed cardinality and input order', () => {
  const source = full();
  source.related_modules = [
    { module: 'z', controllers: [], entities: [{}], enums: [], dtos: [] },
    { module: 'a', controllers: [{}], entities: [], enums: [], dtos: [] },
  ];
  const r = observe(source);
  assert.equal(r.modules[0].index, 0);
  assert.equal(r.modules[0].fields.entities.itemCount, 1);
  assert.equal(r.modules[1].index, 1);
  assert.equal(r.modules[1].fields.controllers.itemCount, 1);
  assert.equal(r.modules[1].fields.entities.itemCount, 0);
});

test('T11O16 malformed nested field types are not normalized to empty lists', () => {
  const source = full();
  source.related_modules = [{
    module: 'app', controllers: false, entities: [], enums: null, dtos: undefined,
  }];
  const r = observe(source);
  assert.equal(r.modules[0].fields.controllers.state, 'invalid_type');
  assert.equal(r.modules[0].fields.enums.state, 'explicit_null');
  assert.equal(r.modules[0].fields.dtos.state, 'explicit_undefined');
  assert.equal(r.quality, 'incomplete_report_fields');
});

test('T11O17 existing real five-legacy-adapter scan fixtures remain unchanged', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(LEGACY_HTTP_ADAPTER_IDS.length, 5);
  for (const id of LEGACY_HTTP_ADAPTER_IDS) {
    const baseline = legacyHttpBaseline(id);
    assert.ok(baseline && baseline.fixture, id);
    const report = runScan({ repoRoot: path.join(root, baseline.fixture), terms: [] });
    assert.equal(report.schema, 'sbf.scan-report/2');
    const before = structuredClone(report);
    const evidence = observe(report);
    assert.equal(evidence.sourceReportSchema, 'sbf.scan-report/2');
    assert.equal(evidence.fields.related_modules.state,
      report.related_modules.length ? 'reported_value' : 'reported_empty', id);
    assert.equal(evidence.fields.related_modules.itemCount, report.related_modules.length);
    assert.equal(evidence.supportCertified, false);
    assert.equal(evidence.promotionAllowed, false);
    assert.deepEqual(report, before, id);
  }
});
