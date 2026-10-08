import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { loadTarget, projectScan, readJson, runCase } from './_target-helpers.mjs';
import { mustScan, registerReplayTests } from './_target-test-kit.mjs';

const { scope, fixtures, oracle } = loadTarget('websocket');
const byId = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));
const validateManifest = new Ajv2020({ allErrors: true, strict: false }).compile(readJson('adapters/protocol-next/schemas/websocket-manifest.schema.json'));

registerReplayTests('websocket');

test('websocket has no oracle evidence and the oracle is explicitly blocked', () => {
  assert.equal(oracle, null);
  assert.equal(scope.runtime_oracle.oracle.status, 'BLOCKED');
  assert.match(scope.runtime_oracle.oracle.reason, /T16/);
  assert.match(scope.runtime_oracle.oracle.reason, /RFC 6455/);
  assert.equal(scope.runtime_oracle.runtime_tested, false);
});

test('websocket reads declared manifests only and discovers nothing else', () => {
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-WS-MANIFEST-ONLY'));
  assert.equal(scope.profile.versions.manifest_dialect.startsWith('bskel-websocket-manifest/'), true);
  const dialects = new Set();
  for (const fixture of fixtures.cases) {
    const outcome = runCase('websocket', fixture);
    if (outcome.ok) dialects.add(outcome.scan.dialect.split('/')[0]);
  }
  assert.deepEqual([...dialects], ['bskel-websocket-manifest']);
  const source = byId.get('ws-c08-source-code-not-discovered');
  assert.ok(source.input.text.includes('new WebSocket('), 'the fixture is real client code');
  const outcome = runCase('websocket', source);
  assert.equal(outcome.ok, false, 'client source code is rejected, not scanned for connections');
  assert.ok(outcome.error.startsWith('structured protocol document must decode to an object'));
  const empty = projectScan('websocket', mustScan('websocket', byId.get('ws-x01-empty-object')));
  assert.deepEqual([empty.status, empty.connections, empty.messages], ['blocked', [], []]);
});

test('websocket state machine, retry and idempotency are caller declarations that no manifest field backs', () => {
  const flows = fixtures.flow_cases;
  assert.ok(flows.length >= 5);
  assert.ok(flows.some((flow) => flow.expect.steps.some((step) => step.retry !== null)), 'a flow carries a retry declaration');
  assert.ok(flows.some((flow) => flow.expect.steps.some((step) => step.idempotency !== null)), 'a flow carries an idempotency declaration');
  const lifecycle = projectScan('websocket', mustScan('websocket', byId.get('ws-c01-lifecycle-keys-ignored')));
  const absent = projectScan('websocket', mustScan('websocket', byId.get('ws-c01b-lifecycle-keys-absent')));
  assert.deepEqual(lifecycle, absent, 'state, retry and idempotency keys in the manifest change nothing');
  for (const id of ['U-WS-STATE-MACHINE', 'U-WS-RETRY-IDEMPOTENCY']) assert.ok(scope.unsupported.some((claim) => claim.id === id), id);
});

test('websocket manifest schema disagrees with the importer on recorded fixtures', () => {
  const checked = fixtures.cases.filter((fixture) => typeof fixture.manifest_schema_valid === 'boolean');
  assert.ok(checked.length >= 10);
  let accepted = 0;
  for (const fixture of checked) {
    assert.equal(validateManifest(parse(fixture.input.text)), fixture.manifest_schema_valid, fixture.id);
    if (!fixture.manifest_schema_valid && runCase('websocket', fixture).ok) accepted += 1;
  }
  assert.ok(accepted >= 1, 'the importer accepts a manifest that the schema rejects');
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-WS-MANIFEST-SCHEMA-NOT-ENFORCED'));
});

test('websocket RFC 6455 and library pins are references and candidates only', () => {
  const rfc = scope.pins.documents.find((document) => document.kind === 'rfc');
  assert.equal(rfc.number, 6455);
  assert.equal(rfc.status, 'PROPOSED STANDARD');
  assert.deepEqual(rfc.updated_by, ['RFC7936', 'RFC8307', 'RFC8441']);
  assert.ok(rfc.phrases.some((phrase) => phrase.text.includes('MUST be 13')));
  const ws = scope.pins.libraries.find((library) => library.name === 'ws');
  assert.equal(ws.version, '8.22.0');
  assert.equal(ws.selected, false);
  assert.ok(scope.pins.tags.every((tag) => tag.selected === false), 'no conformance suite is selected');
  for (const id of ['ws-c03a-version-999', 'ws-c03b-version-zero', 'ws-c03c-version-absent']) {
    const scan = mustScan('websocket', byId.get(id));
    assert.equal(scan.completeness.status, 'partial');
  }
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-WS-RFC6455-WIRE'));
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-WS-VERSION-NOT-VALIDATED'));
});
