import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { loadTarget, projectScan, runCase } from './_target-helpers.mjs';
import { mustScan, registerOracleTests, registerReplayTests } from './_target-test-kit.mjs';

const { scope, fixtures, oracle } = loadTarget('asyncapi');
const byId = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));
const VERSION_PATTERN = /^(?:2|3)\.\d+\.\d+$/;

registerReplayTests('asyncapi');
registerOracleTests('asyncapi');

test('asyncapi dialect and VERSION_UNTESTED / VERSION_MISSING warnings follow the version pattern', () => {
  assert.equal(scope.profile.versions.version_pattern, VERSION_PATTERN.source);
  const versionCases = fixtures.cases.filter((fixture) => fixture.kind === 'version');
  const seen = { matching: 0, untested: 0, missing: 0 };
  for (const fixture of versionCases) {
    const scan = mustScan('asyncapi', fixture);
    const declared = parse(fixture.input.text)?.asyncapi;
    const codes = scan.warnings.map((warning) => warning.code).filter((code) => code.startsWith('ASYNCAPI_VERSION_'));
    if (typeof declared === 'string' && VERSION_PATTERN.test(declared)) {
      seen.matching += 1;
      assert.deepEqual(codes, [], fixture.id);
      assert.equal(scan.dialect, 'asyncapi-' + declared);
    } else if (typeof declared === 'string' && declared !== '') {
      seen.untested += 1;
      assert.deepEqual(codes, ['ASYNCAPI_VERSION_UNTESTED'], fixture.id);
      assert.equal(scan.dialect, 'asyncapi-' + declared);
    } else {
      seen.missing += 1;
      assert.deepEqual(codes, ['ASYNCAPI_VERSION_MISSING'], fixture.id);
      assert.equal(scan.dialect, 'asyncapi-unknown');
    }
  }
  assert.ok(seen.matching >= 9 && seen.untested >= 5 && seen.missing >= 4, JSON.stringify(seen));
  assert.equal(scope.profile.versions.untested_warning, 'ASYNCAPI_VERSION_UNTESTED');
  assert.equal(scope.profile.versions.missing_warning, 'ASYNCAPI_VERSION_MISSING');
});

test('asyncapi accepts versions the official parser rejects without any warning', () => {
  for (const id of ['aapi-v-silent-2.6.1', 'aapi-v-silent-3.0.1', 'aapi-v-silent-3.9.9']) {
    const scan = mustScan('asyncapi', byId.get(id));
    assert.deepEqual(scan.warnings.filter((warning) => warning.code.startsWith('ASYNCAPI_VERSION_')), [], id);
    assert.ok(oracle.summary.adapter_accepts_oracle_rejects.includes(id), id + ' is rejected by the reference parser');
  }
  const supported = scope.profile.versions.reference_parser_supported_versions;
  for (const version of ['2.6.1', '3.0.1', '3.9.9']) assert.equal(supported.includes(version), false, version);
  assert.deepEqual(supported.filter((version) => !VERSION_PATTERN.test(version)), []);
});

test('asyncapi retry, idempotency and delivery guarantees are not read from the document', () => {
  const declared = byId.get('aapi-c10-retry-idempotency-delivery-declared');
  const control = byId.get('aapi-c00-control-minimal-send');
  assert.ok(/retry|idempot|delivery|qos/i.test(declared.input.text), 'the counterexample document really declares them');
  const left = projectScan('asyncapi', mustScan('asyncapi', declared));
  const right = projectScan('asyncapi', mustScan('asyncapi', control));
  for (const plane of ['channels', 'operations', 'messages']) assert.deepEqual(left[plane], right[plane], plane);
  const flow = fixtures.flow_cases.find((item) => item.scan_case === declared.id);
  assert.ok(flow, 'a flow case pairs the declaration with a control');
  assert.equal(flow.expect.steps[0].retry.max_attempts, 5, 'flow steps carry the caller declaration, not the document');
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-AAPI-RETRY-IDEMPOTENCY-DELIVERY'));
});

test('asyncapi broker and client library versions are unknown and servers are dropped', () => {
  assert.match(scope.profile.versions.broker_and_client_libraries, /^UNKNOWN/);
  const servers = byId.get('aapi-c04-servers-broker-identity');
  assert.ok(servers.input.text.includes('broker.example.test') && servers.input.text.includes('3.7.0'));
  const text = JSON.stringify(mustScan('asyncapi', servers));
  assert.equal(text.includes('broker.example.test'), false);
  assert.equal(text.includes('3.7.0'), false);
  assert.equal(scope.pins.libraries.some((library) => /kafka|mqtt|amqp|rabbit|nats/i.test(library.name)), false);
  assert.equal(runCase('asyncapi', servers).ok, true);
});

test('asyncapi reference parser supports exactly the versions with a tagged specification', () => {
  const tags = scope.pins.tags.filter((tag) => tag.selected).map((tag) => tag.tag).sort();
  assert.deepEqual(tags, scope.profile.versions.reference_spec_tags);
  assert.deepEqual(scope.pins.absent_tags[0].tags, ['v2.6.1', '2.6.1', 'v3.9.9', '3.9.9']);
  assert.equal(scope.pins.tags.find((tag) => tag.tag === 'v3.0.1').selected, false);
});
