import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachEvidenceBinding,
  bindingBoundPromotableOperationKeys,
  buildEvidenceBinding,
} from '../../contracts/reconciliation-next/evidence-binding.mjs';
import {
  openapiInput,
  runtimeInput,
  sourceInput,
} from './approved-evidence-fixture.mjs';

function graph(sourceRef, openapiRef) {
  const both = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    openApiContext: {
      attached: true,
      version: 'bskel.openapi-context-audit/0-draft',
      openapiRef,
    },
    endpoints: [{
      endpointKey: '0:0',
      resolutionKind: 'matched',
      fields: [
        { field: 'operation.identity', state: 'resolved', authority: 'scan+openapi', evidence: both, value: 'findWidget' },
        { field: 'http.method', state: 'resolved', authority: 'scan+openapi', evidence: both, value: 'GET' },
        { field: 'http.path', state: 'resolved', authority: 'reconciled', evidence: both, value: '/widgets/{id}' },
      ],
    }],
    counts: { resolved: 3, conflict: 0, unknown: 0, absent: 0, skipped: 0 },
  };
}

test('exact T01 ArtifactRefs and bytes bind source to OpenAPI at the same repository/revision', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const binding = buildEvidenceBinding({ source, openapi });
  assert.equal(binding.sourceSpec.state, 'bound');
  assert.equal(binding.source.ref, source.artifactRef.byte_sha256);
  assert.equal(binding.openapi.ref, openapi.artifactRef.byte_sha256);
  assert.deepEqual(binding.source.artifactRef, source.artifactRef);
  assert.deepEqual(binding.openapi.artifactRef, openapi.artifactRef);
});

test('arbitrary string refs without T01 ArtifactRefs cannot bind source/spec evidence', () => {
  const binding = buildEvidenceBinding({
    source: { ref: 'proof', repository: 'repo/example', revision: 'abc123' },
    openapi: { ref: 'also-proof', repository: 'repo/example', revision: 'abc123' },
  });
  assert.equal(binding.sourceSpec.state, 'unknown');
  assert.match(binding.sourceSpec.reason, /artifact-bytes-missing|artifact-invalid/);
});

test('ArtifactRef with stale bytes fails closed', () => {
  const source = sourceInput();
  source.bytes = source.bytes + 'tamper';
  const binding = buildEvidenceBinding({ source, openapi: openapiInput() });
  assert.equal(binding.sourceSpec.state, 'unknown');
  assert.match(binding.sourceSpec.reason, /artifact-invalid/);
});

test('caller-provided ref cannot disagree with ArtifactRef digest', () => {
  const binding = buildEvidenceBinding({
    source: sourceInput({ ref: 'not-the-digest' }),
    openapi: openapiInput(),
  });
  assert.equal(binding.sourceSpec.state, 'unknown');
  assert.equal(binding.sourceSpec.reason, 'source-ref-does-not-match-artifact-digest');
});

test('source/OpenAPI repository mismatch is conflict', () => {
  const binding = buildEvidenceBinding({
    source: sourceInput(),
    openapi: openapiInput({ repository: 'repo/other' }),
  });
  assert.equal(binding.sourceSpec.state, 'conflict');
  assert.equal(binding.sourceSpec.reason, 'source-openapi-repository-mismatch');
});

test('source/OpenAPI revision mismatch is conflict', () => {
  const binding = buildEvidenceBinding({
    source: sourceInput(),
    openapi: openapiInput({ revision: 'different' }),
  });
  assert.equal(binding.sourceSpec.state, 'conflict');
  assert.equal(binding.sourceSpec.reason, 'source-openapi-revision-mismatch');
});

test('missing OpenAPI revision remains unknown', () => {
  const openapi = openapiInput();
  delete openapi.revision;
  const binding = buildEvidenceBinding({ source: sourceInput(), openapi });
  assert.equal(binding.sourceSpec.state, 'unknown');
  assert.equal(binding.sourceSpec.reason, 'openapi-revision-missing');
});

test('approved T16 binding/evidence plus exact T01 artifact digests creates runtime bound relation', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'bound');
  assert.equal(binding.runtimeBinding.reason, 't01-artifacts-and-t16-binding-evidence-bound');
  assert.equal(binding.runtime.bindingHash, runtime.bindingHash);
  assert.equal(binding.runtime.profileApprovalHash, runtime.profileApprovalHash);
  assert.equal(binding.runtime.attemptNonce, runtime.attemptNonce);
});

test('old local repo/revision/build/env metadata alone can no longer bind runtime', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const binding = buildEvidenceBinding({
    source,
    openapi,
    runtime: {
      ref: 'runtime-local',
      repository: source.repository,
      revision: source.revision,
      buildFingerprint: 'build',
      environmentFingerprint: 'env',
    },
  });
  assert.notEqual(binding.runtimeBinding.state, 'bound');
  assert.equal(binding.runtimeBinding.state, 'unknown');
});

test('runtime repository mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi, repository: 'repo/other' });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'source-runtime-repository-mismatch');
});

test('runtime revision mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi, revision: 'different' });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'source-runtime-revision-mismatch');
});

test('runtime binding hash mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  runtime.bindingHash = 'f'.repeat(64);
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-binding-hash-mismatch');
});

test('runtime contract hash mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  runtime.contractHash = '9'.repeat(64);
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-contract-hash-mismatch');
});

test('runtime case revision hash mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  runtime.caseRevisionHash = '9'.repeat(64);
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-case-revision-hash-mismatch');
});

test('runtime profile approval mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  runtime.profileApprovalHash = '9'.repeat(64);
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-profile-approval-hash-mismatch');
});

test('runtime attempt mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  runtime.attemptNonce = '223e4567-e89b-42d3-a456-426614174000';
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-attempt-nonce-mismatch');
});

test('runtime source artifact digest mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({
    source,
    openapi,
    mutateBinding(binding) {
      binding.artifacts['source-input'] = '9'.repeat(64);
      return binding;
    },
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-source-artifact-mismatch');
});

test('runtime OpenAPI artifact digest mismatch is conflict', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({
    source,
    openapi,
    mutateBinding(binding) {
      binding.artifacts['openapi-input'] = '9'.repeat(64);
      return binding;
    },
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.equal(binding.runtimeBinding.reason, 'runtime-openapi-artifact-mismatch');
});

test('tampered T16 evidence pair cannot bind runtime', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({
    source,
    openapi,
    mutatePair(pair) {
      pair.candidate_evidence_hash = '9'.repeat(64);
      return pair;
    },
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.notEqual(binding.runtimeBinding.state, 'bound');
  assert.equal(binding.runtimeBinding.state, 'conflict');
  assert.match(binding.runtimeBinding.reason, /candidate evidence hash mismatch/);
});

test('route promotion works with exact T01 source/spec evidence when runtime is not required', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const binding = buildEvidenceBinding({ source, openapi });
  assert.deepEqual(
    bindingBoundPromotableOperationKeys(graph(source.artifactRef.byte_sha256, openapi.artifactRef.byte_sha256), binding),
    ['0:0'],
  );
});

test('runtime-required route promotes only after exact T16 binding/evidence validation', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const { runtime } = runtimeInput({ source, openapi });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  assert.deepEqual(
    bindingBoundPromotableOperationKeys(
      graph(source.artifactRef.byte_sha256, openapi.artifactRef.byte_sha256),
      binding,
      { requireRuntime: true },
    ),
    ['0:0'],
  );
});

test('attaching evidence rejects graph provenance that differs from exact ArtifactRef digests', () => {
  const source = sourceInput();
  const openapi = openapiInput();
  const binding = buildEvidenceBinding({ source, openapi });
  assert.throws(
    () => attachEvidenceBinding(graph('f'.repeat(64), openapi.artifactRef.byte_sha256), binding),
    /source binding ref does not match/,
  );
});
