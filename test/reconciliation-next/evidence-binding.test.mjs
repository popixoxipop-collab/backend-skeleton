import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachEvidenceBinding,
  bindingBoundPromotableOperationKeys,
  buildEvidenceBinding,
} from '../../contracts/reconciliation-next/evidence-binding.mjs';

const sourceRef = 'scan:sha256:source';
const openapiRef = 'openapi:sha256:document';

function meta({
  sourceRevision = 'abc123',
  openapiRevision = 'abc123',
  openapiBuild = null,
  runtimeRevision = 'abc123',
  runtimeBuild = null,
  runtimeEnvironment = null,
} = {}) {
  return {
    source: {
      ref: sourceRef,
      repository: 'repo/example',
      revision: sourceRevision,
    },
    openapi: {
      ref: openapiRef,
      repository: 'repo/example',
      revision: openapiRevision,
      ...(openapiBuild ? { buildFingerprint: openapiBuild } : {}),
    },
    runtime: runtimeRevision == null ? null : {
      ref: 'runtime:sha256:observation',
      repository: 'repo/example',
      revision: runtimeRevision,
      ...(runtimeBuild ? { buildFingerprint: runtimeBuild } : {}),
      ...(runtimeEnvironment ? { environmentFingerprint: runtimeEnvironment } : {}),
    },
  };
}

function graph() {
  const both = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    openApiContext: { attached: true, version: 'bskel.openapi-context-audit/0-draft', openapiRef },
    endpoints: [{
      endpointKey: '0:0',
      resolutionKind: 'matched',
      fields: [
        { field: 'operation.identity', state: 'resolved', authority: 'scan+openapi', evidence: both, value: 'findWidget' },
        { field: 'http.method', state: 'resolved', authority: 'scan+openapi', evidence: both, value: 'GET' },
        { field: 'http.path', state: 'resolved', authority: 'reconciled', evidence: both, value: '/widgets' },
      ],
    }],
    counts: { resolved: 3, conflict: 0, unknown: 0, absent: 0, skipped: 0 },
  };
}

test('same repository and revision binds source to OpenAPI without needing runtime', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'bound');
  assert.equal(binding.sourceSpec.reason, 'source-openapi-revision-bound');
  assert.equal(binding.runtimeBinding.state, 'absent');
});

test('source/OpenAPI repository mismatch is a conflict', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  openapi.repository = 'repo/other';
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'conflict');
  assert.equal(binding.sourceSpec.reason, 'source-openapi-repository-mismatch');
});

test('source/OpenAPI revision mismatch is a conflict', () => {
  const { source, openapi } = meta({ openapiRevision: 'def456', runtimeRevision: null });
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'conflict');
  assert.equal(binding.sourceSpec.reason, 'source-openapi-revision-mismatch');
});

test('missing OpenAPI revision remains unknown instead of assuming current source revision', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  delete openapi.revision;
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'unknown');
  assert.equal(binding.sourceSpec.reason, 'openapi-revision-missing');
});

test('runtime binding requires the exact source revision', () => {
  const { source, openapi, runtime } = meta({
    openapiBuild: 'build-1',
    runtimeRevision: 'different',
    runtimeBuild: 'build-1',
    runtimeEnvironment: 'env-1',
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'source-runtime-revision-mismatch');
});

test('runtime binding requires OpenAPI and runtime to name the same build', () => {
  const { source, openapi, runtime } = meta({
    openapiBuild: 'build-1',
    runtimeBuild: 'build-2',
    runtimeEnvironment: 'env-1',
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'openapi-runtime-build-mismatch');
});

test('runtime without an environment fingerprint remains unknown', () => {
  const { source, openapi, runtime } = meta({
    openapiBuild: 'build-1',
    runtimeBuild: 'build-1',
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'unknown');
  assert.equal(binding.runtimeBinding.reason, 'runtime-environment-fingerprint-missing');
});

test('exact repository/revision/build plus runtime environment creates a bound runtime relation', () => {
  const { source, openapi, runtime } = meta({
    openapiBuild: 'build-1',
    runtimeBuild: 'build-1',
    runtimeEnvironment: 'env-1',
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.sourceSpec.state, 'bound');
  assert.equal(binding.runtimeBinding.state, 'bound');
  assert.equal(binding.runtimeBinding.buildFingerprint, 'build-1');
  assert.equal(binding.runtimeBinding.environmentFingerprint, 'env-1');
});

test('route promotion works with a bound source/spec relation when runtime is not required', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  const binding = buildEvidenceBinding({ source, openapi });
  assert.deepEqual(bindingBoundPromotableOperationKeys(graph(), binding), ['0:0']);
});

test('the same route does not promote when runtime is explicitly required but absent', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  const binding = buildEvidenceBinding({ source, openapi });
  assert.deepEqual(bindingBoundPromotableOperationKeys(graph(), binding, { requireRuntime: true }), []);
});

test('runtime-required route promotes only after exact runtime binding', () => {
  const { source, openapi, runtime } = meta({
    openapiBuild: 'build-1',
    runtimeBuild: 'build-1',
    runtimeEnvironment: 'env-1',
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.deepEqual(bindingBoundPromotableOperationKeys(graph(), binding, { requireRuntime: true }), ['0:0']);
});

test('attaching a binding to a graph with different provenance is rejected', () => {
  const { source, openapi } = meta({ runtimeRevision: null });
  const binding = buildEvidenceBinding({ source, openapi });
  const wrong = graph();
  wrong.endpoints[0].fields = wrong.endpoints[0].fields.map((field) => ({
    ...field,
    evidence: field.evidence.map((entry) => (
      entry.role === 'scan' ? { ...entry, ref: 'scan:sha256:other' } : entry
    )),
  }));
  assert.throws(() => attachEvidenceBinding(wrong, binding), /source binding ref does not match/);
});
