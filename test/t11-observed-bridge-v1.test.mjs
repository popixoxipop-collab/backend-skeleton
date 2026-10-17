// T11-02 product consumer wiring: opt-in observation coupled to the
// existing legacy bridge, preserving report bytes, semantics and registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { ADAPTERS } from '../scanners/registry.mjs';
import {
  legacyHttpBaseline, LEGACY_HTTP_ADAPTER_IDS,
} from '../adapters/http-legacy-next/baselines.mjs';
import { bridgeLegacyHttpScan } from '../adapters/http-legacy-next/bridge.mjs';
import { legacyHttpSemanticDigest } from '../adapters/http-legacy-next/parity.mjs';
import {
  bridgeLegacyHttpWithObservation, T11_OBSERVED_BRIDGE_V1,
} from '../next/t11/observed-bridge-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = ADAPTERS.find(a => a.id === 'python-fastapi');
const source = () => ({
  schema: 'sbf.scan-report/2',
  adapter: 'python-fastapi',
  confidence: 'high',
  verdict: 'green',
  api_surface_source: 'source',
});

test('T11B01 unchanged legacy semantic digest cannot distinguish omitted vs empty', () => {
  const a = bridgeLegacyHttpWithObservation({ adapter: ADAPTER, report: source() });
  const b = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: [] },
  });
  assert.equal(a.schema, T11_OBSERVED_BRIDGE_V1);
  assert.equal(a.legacy_semantic_sha256, b.legacy_semantic_sha256);
  assert.notEqual(a.report_observation_sha256, b.report_observation_sha256);
  assert.equal(a.report_observation.fields.related_modules.state, 'not_reported');
  assert.equal(b.report_observation.fields.related_modules.state, 'reported_empty');
  assert.equal(a.report_observation.fields.related_modules.itemCount, null);
  assert.equal(b.report_observation.fields.related_modules.itemCount, 0);
});

test('T11B02 an explicit undefined is preserved even though legacy JSON cloning drops it', () => {
  const report = { ...source(), path_prefix_signals: undefined };
  const a = bridgeLegacyHttpWithObservation({ adapter: ADAPTER, report });
  assert.equal(a.report_observation.fields.path_prefix_signals.state, 'explicit_undefined');
  assert.equal(Object.hasOwn(a.legacy_bridge.legacy_report, 'path_prefix_signals'), false);
  assert.equal(Object.hasOwn(report, 'path_prefix_signals'), true);
});

test('T11B03 five actual legacy fixture reports remain byte-for-byte semantically stable', () => {
  for (const id of LEGACY_HTTP_ADAPTER_IDS) {
    const adapter = ADAPTERS.find(a => a.id === id);
    const fixture = legacyHttpBaseline(id);
    const report = runScan({ repoRoot: path.join(ROOT, fixture.fixture), terms: [] });
    const original = structuredClone(report);
    const wrapped = bridgeLegacyHttpWithObservation({ adapter, report });
    const vanilla = bridgeLegacyHttpScan({ adapter, report });
    assert.deepEqual(report, original, id);
    assert.deepEqual(wrapped.legacy_bridge, vanilla, id);
    assert.equal(wrapped.source_adapter_id, id);
    assert.equal(wrapped.legacy_semantic_sha256, legacyHttpSemanticDigest(report));
    assert.equal(wrapped.report_observation.sourceReportSchema, report.schema);
    assert.equal(wrapped.report_observation.fields.related_modules.itemCount,
      report.related_modules.length);
    assert.equal(wrapped.runtime_certified, false);
    assert.equal(wrapped.promotion_allowed, false);
    assert.equal(wrapped.source_authorized, false);
  }
});

test('T11B04 different observed nested modules remain distinct without reordering', () => {
  const full = {
    ...source(), related_modules: [
      { module: 'z', controllers: [], entities: [], enums: [], dtos: [] },
      { module: 'a', controllers: [], entities: [{}], enums: [], dtos: [] },
    ],
  };
  const r = bridgeLegacyHttpWithObservation({ adapter: ADAPTER, report: full });
  assert.equal(r.report_observation.modules.length, 2);
  assert.equal(r.report_observation.modules[0].index, 0);
  assert.equal(r.report_observation.modules[1].index, 1);
  assert.equal(r.report_observation.modules[1].fields.entities.itemCount, 1);
  assert.equal(r.report_observation.quality, 'incomplete_report_fields');
});

test('T11B05 wrong report schema or adapter ID is rejected', () => {
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), schema: 'sbf.scan-report/1' },
  }), /own sbf.scan-report\/2 schema/);
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), adapter: 'java-spring' },
  }), /does not match descriptor/);
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: { id: 'not-legacy', contract: 'sbf.adapter/2' },
    report: source(),
  }), /not one of T11/);
});

test('T11B06 absent and null observations remain different in returned bridge', () => {
  const omitted = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: source(),
  });
  const nulled = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER,
    report: { ...source(), related_modules: null },
  });
  assert.notEqual(omitted.report_observation_sha256, nulled.report_observation_sha256);
  assert.equal(nulled.report_observation.fields.related_modules.state, 'explicit_null');
  assert.equal(nulled.legacy_bridge.legacy_report.related_modules, null);
});

test('T11B07 invalid source root never gains a report result', () => {
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: source(), root: 'not-absolute',
  }), /absolute|root/);
});

test('T11B08 consumer envelope is immutable, reports only source observation', () => {
  const a = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: [] },
  });
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.legacy_bridge), true);
  assert.equal(Object.isFrozen(a.legacy_bridge.legacy_report), true);
  assert.equal(Object.isFrozen(a.report_observation), true);
  assert.equal(Object.isFrozen(a.report_observation.fields), true);
  assert.throws(() => { a.source_authorized = true; }, TypeError);
  assert.throws(() => { a.report_observation.fields.related_modules.state = 'reported_value'; }, TypeError);
});

test('T11B09 deterministic bytes and hashes for exactly equal consumer inputs', () => {
  const a = bridgeLegacyHttpWithObservation({ adapter: ADAPTER, report: source() });
  const b = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: structuredClone(source()),
  });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('T11B10 missing original input is not converted to fabricated success', () => {
  assert.throws(() => bridgeLegacyHttpWithObservation({ adapter: ADAPTER }), /own sbf.scan-report\/2/);
  assert.throws(() => bridgeLegacyHttpWithObservation(), /own sbf.scan-report\/2/);
});


test('T11B11 report own accessors fail closed before legacy JSON clone runs', () => {
  let invoked = 0;
  const report = source();
  Object.defineProperty(report, 'files_read', {
    enumerable: true, get() {
      invoked++;
      throw new Error('UNTRUSTED_GETTER_SHOULD_NOT_RUN');
    },
  });
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report,
  }), /T11_REPORT_ACCESSOR_UNSUPPORTED/);
  assert.equal(invoked, 0);
});

test('T11B12 nested section accessors fail closed before legacy parity reads', () => {
  let invoked = 0;
  const module = { module: 'safe' };
  Object.defineProperty(module, 'controllers', {
    enumerable: true, get() {
      invoked++;
      throw new Error('UNTRUSTED_NESTED_GETTER_SHOULD_NOT_RUN');
    },
  });
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: [module] },
  }), /T11_REPORT_ACCESSOR_UNSUPPORTED/);
  assert.equal(invoked, 0);
});

test('T11B13 invalid report lists remain a refusal, never fabricated zero endpoints', () => {
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: {} },
  }));
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: false },
  }));
});

test('T11B14 adapter mismatch still blocks missing-vs-empty evidence projection', () => {
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER,
    report: { ...source(), adapter: 'java-spring', related_modules: [] },
  }), /does not match descriptor/);
});

test('T11B15 unsupported nested fields never become a supported capability', () => {
  const result = bridgeLegacyHttpWithObservation({
    adapter: ADAPTER,
    report: {
      ...source(),
      related_modules: [{ module: 'mod1', controllers: [], entities: [] }],
    },
  });
  assert.equal(result.report_observation.modules[0].fields.controllers.state,
    'reported_empty');
  assert.equal(result.report_observation.modules[0].fields.enums.state,
    'not_reported');
  assert.equal(result.report_observation.quality, 'incomplete_report_fields');
  assert.equal(result.promotion_allowed, false);
  assert.equal(result.runtime_certified, false);
});

test('T11B16 inherited top-level report fields cannot influence legacy semantics', () => {
  const report = Object.assign(Object.create({ related_modules: [] }), source());
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report,
  }), /T11_REPORT_INHERITED_FIELD_UNSUPPORTED/);
});

test('T11B17 inherited nested fields cannot alter legacy semantic projection', () => {
  const module = Object.assign(Object.create({ controllers: [] }), { module: 'app' });
  assert.throws(() => bridgeLegacyHttpWithObservation({
    adapter: ADAPTER, report: { ...source(), related_modules: [module] },
  }), /T11_MODULE_INHERITED_FIELD_UNSUPPORTED/);
});
