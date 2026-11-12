import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LEGACY_HTTP_BASELINES, LEGACY_HTTP_ADAPTER_IDS } from '../../adapters/http-legacy-next/baselines.mjs';
import { T11_REPORT_CONSUMER_V1, consumeObservedLegacyReport } from './observed-report-cli-v1.mjs';

const CLI = fileURLToPath(new URL('./observed-report-cli-v1.mjs',import.meta.url));
function descriptor(id) { return { id, ...LEGACY_HTTP_BASELINES[id].descriptor }; }
function report(id, options = {}) {
  return {
    schema: 'sbf.scan-report/2',
    adapter: id,
    confidence: 'high',
    api_surface_source: 'fixture-conservative',
    verdict: 'detect-only',
    ...options,
  };
}
function exec(payload) {
  const p = spawnSync(process.execPath, [CLI], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, parsed: p.status === 0 ? JSON.parse(p.stdout) : null };
}

for (const id of LEGACY_HTTP_ADAPTER_IDS) {
  test(`T11C ${id}: product CLI consumes real legacy descriptor vocabulary`, () => {
    const baseline = LEGACY_HTTP_BASELINES[id];
    const related_modules = baseline.inventory.modules.map(name => ({
      module: name, controllers: [], entities: [], enums: [], dtos: [],
    }));
    const data = report(id, { related_modules, files_read: [], path_prefix_signals: [] });
    const result = exec({adapter: descriptor(id), report: data});
    assert.equal(result.status, 0, result.stderr);
    const output = result.parsed;
    assert.equal(output.schema, T11_REPORT_CONSUMER_V1);
    assert.equal(output.adapter_id, id);
    assert.equal(output.legacy_bridge_schema, 'sbf.http-legacy-bridge/1');
    assert.equal(output.legacy_summary.moduleCount, baseline.inventory.moduleCount);
    assert.equal(output.sections.related_modules.state, 'reported_value');
    assert.equal(output.sections.related_modules.itemCount, baseline.inventory.moduleCount);
    assert.match(output.legacy_semantic_sha256,/^[0-9a-f]{64}$/);
    assert.match(output.observation_sha256,/^[0-9a-f]{64}$/);
    assert.equal(output.runtime_certified, false);
    assert.equal(output.source_authorized, false);
    assert.equal(output.promotion_allowed, false);
  });
}

test('T11C missed related_modules !== observed [] while legacy digest stays identical', () => {
  const id = LEGACY_HTTP_ADAPTER_IDS[0];
  const absent = exec({adapter:descriptor(id),report:report(id)});
  const empty = exec({adapter:descriptor(id),report:report(id,{related_modules:[]})});
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(absent.parsed.legacy_semantic_sha256,empty.parsed.legacy_semantic_sha256);
  assert.notEqual(absent.parsed.observation_sha256,empty.parsed.observation_sha256);
  assert.equal(absent.parsed.sections.related_modules.state,'not_reported');
  assert.equal(empty.parsed.sections.related_modules.state,'reported_empty');
  assert.equal(absent.parsed.legacy_summary.moduleCount,0);
  assert.equal(empty.parsed.legacy_summary.moduleCount,0);
});

test('T11C missing files_read is not reported_empty', () => {
  const id='javascript-express';
  const absent=exec({adapter:descriptor(id),report:report(id,{related_modules:[]})});
  const empty=exec({adapter:descriptor(id),report:report(id,{related_modules:[],files_read:[]})});
  assert.equal(absent.status,0);
  assert.equal(empty.status,0);
  assert.equal(absent.parsed.sections.files_read.state,'not_reported');
  assert.equal(empty.parsed.sections.files_read.state,'reported_empty');
});

test('T11C reports are deterministic across independent CLI invocations', () => {
  const input={adapter:descriptor('ruby-rails'),report:report('ruby-rails',{related_modules:[],files_read:[]})};
  const a=exec(input),b=exec(input);
  assert.equal(a.status,0);assert.equal(b.status,0);
  assert.equal(a.stdout,b.stdout);
});

test('T11C wrong adapter identity exits 2 and prints no success JSON', () => {
  const out=exec({adapter:descriptor('java-spring'),report:report('ruby-rails')});
  assert.equal(out.status,2);assert.equal(out.stdout,'');
  assert.match(out.stderr,/T11_CONSUMER_REJECTED/);
});

test('T11C malformed JSON exits 2 without partial output', () => {
  const out=exec('{BROKEN');
  assert.equal(out.status,2);assert.equal(out.stdout,'');
});

test('T11C null report exits 2 without partial output', () => {
  const out=exec({adapter:descriptor('java-spring'),report:null});
  assert.equal(out.status,2);assert.equal(out.stdout,'');
});

test('T11C programmatic consumer and child process agree on output', () => {
  const input={adapter:descriptor('typescript-express'),report:report('typescript-express',{related_modules:[]})};
  const child=exec(input);assert.equal(child.status,0);
  assert.deepEqual(child.parsed,consumeObservedLegacyReport(input));
});

for (const [field, value] of [
  ['verdict', false],
  ['confidence', 0],
  ['api_surface_source', true],
  ['verdict', { unexpected: true }],
  ['confidence', ['high']],
  ['api_surface_source', { source: 'fixture' }],
]) {
  test(`T11C ${field} non-string value fails closed as invalid_type`, () => {
    const id = 'java-spring';
    const out = exec({ adapter: descriptor(id), report: report(id, { [field]: value }) });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.parsed.sections[field].state, 'invalid_type');
    assert.equal(out.parsed.observation_quality, 'incomplete_report_fields');
    assert.equal(out.parsed.runtime_certified, false);
    assert.equal(out.parsed.source_authorized, false);
    assert.equal(out.parsed.promotion_allowed, false);
  });
}
