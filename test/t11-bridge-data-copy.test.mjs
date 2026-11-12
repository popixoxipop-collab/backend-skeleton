import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeLegacyHttpWithObservation as bridge } from '../next/t11/observed-bridge-v1.mjs';
import { legacyHttpSemanticDigest } from '../adapters/http-legacy-next/parity.mjs';
import { LEGACY_HTTP_BASELINES } from '../adapters/http-legacy-next/baselines.mjs';
const input = () => ({ adapter: { id: 'java-spring', ...LEGACY_HTTP_BASELINES['java-spring'].descriptor,
  capabilities: { ...LEGACY_HTTP_BASELINES['java-spring'].descriptor.capabilities } },
  report: { schema: 'sbf.scan-report/2', adapter: 'java-spring', verdict: 'greenfield', confidence: 'high',
    api_surface_source: 'source', files_read: [], path_prefix_signals: [],
    related_modules: [{ module: 'app', controllers: [], entities: [], enums: [], dtos: [] }] } });

for (const where of ['modules-map', 'nested-map', 'iterator']) {
  test(`T11D01 caller array methods do not execute or corrupt the semantic digest: ${where}`, () => {
    const arg = input(); let calls = 0;
    if (where === 'modules-map') arg.report.related_modules.map = () => { calls++; return []; };
    if (where === 'nested-map') arg.report.related_modules[0].controllers.map = () => { calls++; return [{ className: 'fake' }]; };
    if (where === 'iterator') arg.report.related_modules[Symbol.iterator] = function* () { calls++; };
    const result = bridge(arg);
    assert.equal(calls, 0);
    assert.equal(result.legacy_bridge.legacy_report.related_modules.length, 1);
    assert.equal(result.legacy_semantic_sha256, legacyHttpSemanticDigest(result.legacy_bridge.legacy_report));
  });
}

for (const where of ['report-toJSON', 'nested-getter', 'adapter-getter', 'envelope-getter', 'proxy']) {
  test(`T11D02 executable object hooks are rejected without invocation: ${where}`, () => {
    let arg = input(); let calls = 0;
    if (where === 'report-toJSON') arg.report.toJSON = () => { calls++; return { schema: 'changed' }; };
    if (where === 'nested-getter') Object.defineProperty(arg.report.related_modules[0], 'extra', {
      enumerable: true, get() { calls++; return 'hidden'; } });
    if (where === 'adapter-getter') Object.defineProperty(arg.adapter.capabilities, 'evil', {
      enumerable: true, get() { calls++; return true; } });
    if (where === 'envelope-getter') { const saved = arg.report;
      Object.defineProperty(arg, 'report', { get() { calls++; return saved; } }); }
    if (where === 'proxy') arg = new Proxy(arg, { getOwnPropertyDescriptor() { calls++; throw new Error('trap'); },
      get() { calls++; throw new Error('trap'); } });
    assert.throws(() => bridge(arg)); assert.equal(calls, 0);
  });
}

test('T11D03 normal input and explicit undefined remain unmodified and observable', () => {
  const arg = input(); arg.report.files_read = undefined;
  const before = structuredClone(arg); const result = bridge(arg);
  assert.deepEqual(arg, before);
  assert.equal(result.report_observation.fields.files_read.state, 'explicit_undefined');
  assert.equal(Object.hasOwn(result.legacy_bridge.legacy_report, 'files_read'), false);
  assert.equal(result.legacy_semantic_sha256, legacyHttpSemanticDigest(result.legacy_bridge.legacy_report));
});
