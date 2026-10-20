import test from 'node:test';
import assert from 'node:assert/strict';
import { observeLegacyScanReport as observe } from '../next/t11/report-observation-v1.mjs';
const moduleValue = () => ({ module: 'app', controllers: [], entities: [], enums: [], dtos: [] });
const input = (modules) => ({ schema: 'sbf.scan-report/2', adapter: 'java-spring', verdict: 'greenfield',
  confidence: 'high', api_surface_source: 'source', related_modules: modules, files_read: [], path_prefix_signals: [] });

test('T11I01 sparse slots are dense invalid module observations, never positive quality', () => {
  for (const modules of [new Array(1), [moduleValue(), , moduleValue()], [undefined], [null]]) {
    const result = observe(input(modules));
    assert.equal(result.quality, 'incomplete_report_fields');
    assert.equal(result.modules.length, modules.length);
    for (let index = 0; index < modules.length; index++) {
      assert.ok(Object.hasOwn(result.modules, index));
      assert.equal(result.modules[index].index, index);
      if (!Object.hasOwn(modules, index) || modules[index] == null) {
        assert.equal(result.modules[index].fields.module.state, 'invalid_container');
      }
    }
  }
});

test('T11I02 inherited array values do not fill an unreported own slot', () => {
  const modules = new Array(1); const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, '0', { value: moduleValue() }); Object.setPrototypeOf(modules, prototype);
  const result = observe(input(modules));
  assert.equal(result.modules[0].fields.module.state, 'invalid_container');
  assert.equal(result.quality, 'incomplete_report_fields');
});

test('T11I03 array index accessors are rejected without invoking a getter', () => {
  let calls = 0; const modules = [];
  Object.defineProperty(modules, '0', { enumerable: true, get() { calls++; return moduleValue(); } });
  assert.throws(() => observe(input(modules)), /MODULE_ACCESSOR/);
  assert.equal(calls, 0);
});

test('T11I04 input array map overrides cannot replace observations', () => {
  const modules = [null]; let calls = 0;
  modules.map = () => { calls++; return []; };
  const result = observe(input(modules));
  assert.equal(calls, 0); assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].fields.module.state, 'invalid_container');
  assert.equal(result.quality, 'incomplete_report_fields');
});
