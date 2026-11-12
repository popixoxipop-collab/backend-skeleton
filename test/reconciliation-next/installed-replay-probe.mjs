#!/usr/bin/env node
// Product imports are exclusively from the disposable installed package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, fixtureRoot, expected] = process.argv.slice(2);
assert.ok(path.isAbsolute(consumer) && path.isAbsolute(fixtureRoot));
assert.ok(expected === 'absent' || expected === 'present');
const product = path.join(consumer, 'node_modules', 'backend-skeleton');
const load = relative => import(pathToFileURL(path.join(product, relative)).href);
const t09Path = path.join(product, 'contracts/reconciliation-next/promotion-readiness.mjs');
assert.equal(fs.existsSync(t09Path), expected === 'present');

// Both historical packages must still execute their installed stable scanner.
const { runScan } = await load('scanners/index.mjs');
const scan = runScan({ repoRoot: path.join(fixtureRoot, 'test/fixtures/java-spring'), terms: [] });
assert.equal(scan.schema, 'sbf.scan-report/2');
assert.equal(scan.adapter, 'java-spring');
assert.equal(scan.verdict, 'inventory');

let t09 = null;
if (expected === 'present') {
  const { createT01ArtifactRef } = await load('contracts/reconciliation-next/artifact-ref.mjs');
  const { buildEvidenceBinding } = await load('contracts/reconciliation-next/evidence-binding.mjs');
  const { buildPromotionReadinessReport } = await load('contracts/reconciliation-next/promotion-readiness.mjs');
  const sourceBytes = 'replay-source-controller\n';
  const openapiBytes = '{"openapi":"3.1.0","paths":{}}\n';
  const sourceRef = createT01ArtifactRef(sourceBytes,
    { family: 'source.snapshot', version: '1', media_type: 'text/plain' });
  const openapiRef = createT01ArtifactRef(openapiBytes,
    { family: 'openapi', version: '3.1.0', media_type: 'application/json' });
  const source = { repository: 'replay/example', revision: 'pinned-revision',
    artifactRef: sourceRef, bytes: sourceBytes };
  const openapi = { repository: 'replay/example', revision: 'pinned-revision',
    artifactRef: openapiRef, bytes: openapiBytes };
  const graph = {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    openApiContext: { attached: true, version: 'bskel.openapi-context-audit/0-draft',
      openapiRef: openapiRef.byte_sha256 },
    endpoints: [{ endpointKey: '0:0', fields: [
      { field: 'operation.identity', state: 'resolved', value: 'findWidget' },
      { field: 'http.method', state: 'resolved', value: 'GET' },
      { field: 'http.path', state: 'resolved', value: '/widgets/{id}' },
    ].map(field => ({ ...field, evidence: [
      { role: 'scan', ref: sourceRef.byte_sha256 },
      { role: 'openapi', ref: openapiRef.byte_sha256 },
    ] })) }],
  };
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'bound');
  const report = buildPromotionReadinessReport({ graph, binding });
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.stableCapabilityWire, false);
  assert.equal(report.endpoints[0].sourceSpecReady, true);
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-binding-not-bound');
  const mismatch = buildEvidenceBinding({ source, openapi: { ...openapi, revision: 'other-revision' } });
  assert.equal(mismatch.sourceSpec.state, 'conflict');
  const rejected = buildPromotionReadinessReport({ graph, binding: mismatch });
  assert.equal(rejected.endpoints[0].sourceSpecReady, false);
  assert.equal(rejected.endpoints[0].runtimeRouteReady, false);
  t09 = { schema: report.version, source_spec_ready: true, runtime_route_ready: false,
    mismatch_blocked: true, advisory_only: report.advisoryOnly,
    stable_capability_wire: report.stableCapabilityWire };
}

if (expected === 'present' && process.env.T09_TEST_INTERRUPT_PROBE === '1')
  process.kill(process.pid, 'SIGTERM');
console.log(JSON.stringify({ schema: 'bskel.t09-installed-replay-probe/1',
  expected, scan_adapter: scan.adapter, t09, release_authorized: false }));
