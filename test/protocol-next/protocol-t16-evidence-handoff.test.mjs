import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildProtocolOracleRequest, protocolOracleRequestDigest } from '../../adapters/protocol-next/contracts/protocol-oracle-request.mjs';
import { bindProtocolItemRef } from '../../adapters/protocol-next/contracts/protocol-item-ref.mjs';
import { loadProtocolArtifact } from '../../adapters/protocol-next/scanners/protocol-loaders.mjs';
import { artifactRefForBytes, protocolContext } from './_helpers.mjs';

const handoff = JSON.parse(
  fs.readFileSync(new URL('./fixtures/t16-grpc-unary-evidence-handoff.json', import.meta.url), 'utf8'),
);

function exactHandoff() {
  const scan = loadProtocolArtifact({
    family: handoff.source_fixture.family,
    file: handoff.source_fixture.file,
    text: handoff.source_fixture.text,
  });
  const context = protocolContext(scan, {
    featureId: 'grpc-unary-profile',
    featureUid: '11111111-1111-4111-8111-111111111111',
  });
  const method = context.contract.planes.grpc.methods.find((item) =>
    item.service === handoff.profile.static_selector.service
    && item.name === handoff.profile.static_selector.method
  );
  assert.ok(method, 'static T18 fixture must resolve one Orders.Get method before handoff');

  const actionRef = bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family: 'grpc',
    plane: 'methods',
    itemId: method.id,
  });

  const originalBytes = Buffer.from('original-grpc-unary-fixture-v1\n');
  const candidateBytes = Buffer.from('candidate-grpc-unary-fixture-v1\n');
  const profileBytes = Buffer.from(JSON.stringify({
    runtime_profile: handoff.profile.id,
    runtime_execution: handoff.profile.runtime_execution,
  }) + '\n');

  const originalRef = artifactRefForBytes(originalBytes, {
    family: 'runtime-original',
    mediaType: 'application/octet-stream',
  });
  const candidateRef = artifactRefForBytes(candidateBytes, {
    family: 'runtime-candidate',
    mediaType: 'application/octet-stream',
  });
  const runtimeProfileRef = artifactRefForBytes(profileBytes, {
    family: 'runtime-profile',
  });

  const request = buildProtocolOracleRequest({
    featureId: 'grpc-unary-profile',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scenarioId: 'orders-get',
    protocolContractRefs: [context.contract_ref],
    protocolContexts: [{
      contract_ref: context.contract_ref,
      contract: context.contract,
      contract_bytes: context.contract_bytes,
    }],
    originalRef,
    candidateRef,
    runtimeProfileRef,
    seed: '7',
    assertions: [{
      id: 'grpc-orders-get-status',
      kind: 'grpc-status',
      action_ref: actionRef,
      expect: { status: 'OK' },
    }],
  });

  return { scan, context, method, actionRef, request };
}

test('T18->T16 profile stays bounded and explicitly runtime-unverified', () => {
  assert.equal(handoff.handoff, 't18.t16-protocol-evidence-handoff/1');
  assert.equal(handoff.profile.id, 't18-grpc-unary-binding/1');
  assert.equal(handoff.profile.family, 'grpc');
  assert.equal(handoff.profile.plane, 'methods');
  assert.equal(handoff.profile.runtime_execution, 'not-performed');
  assert.equal(handoff.profile.runtime_tested, false);
  assert.equal(handoff.semantics.unexecuted_protocol_remains_runtime_unverified, true);
});

test('normal T18 handoff carries the exact source-derived ProtocolItemRef and contract ArtifactRef', () => {
  const { context, method, actionRef, request } = exactHandoff();

  assert.equal(actionRef.protocol_item_ref, 'sbf.protocol-item-ref/draft-1');
  assert.equal(actionRef.family, 'grpc');
  assert.equal(actionRef.plane, 'methods');
  assert.equal(actionRef.item_id, method.id);
  assert.deepEqual(actionRef.contract, context.contract_ref);
  assert.deepEqual(request.assertions[0].action_ref, actionRef);
  assert.equal(request.assertions[0].action_ref.contract.byte_sha256, context.contract_ref.byte_sha256);
  assert.equal(request.semantics.executor_must_rehash_referenced_bytes, true);
  assert.equal(request.semantics.executor_must_verify_protocol_item_existence, true);
});

test('stale protocol-contract bytes cannot be reused under the old ArtifactRef', () => {
  const { context, method } = exactHandoff();
  const staleBytes = Buffer.concat([context.contract_bytes, Buffer.from(' ')]);

  assert.throws(
    () => bindProtocolItemRef({
      contractRef: context.contract_ref,
      contract: context.contract,
      contractBytes: staleBytes,
      family: 'grpc',
      plane: 'methods',
      itemId: method.id,
    }),
    /contract bytes do not match ArtifactRef/,
  );
});

test('wrong item id is rejected against the exact original protocol-contract bytes', () => {
  const { context } = exactHandoff();

  assert.throws(
    () => bindProtocolItemRef({
      contractRef: context.contract_ref,
      contract: context.contract,
      contractBytes: context.contract_bytes,
      family: 'grpc',
      plane: 'methods',
      itemId: 'grpc-method:missing',
    }),
    /item_id does not exist/,
  );
});

test('T16 evidence handoff requires exact action_ref binding instead of display-name matching', () => {
  const { actionRef, request } = exactHandoff();
  const boundary = handoff.consumer_boundary;

  assert.equal(boundary.consume_exact_protocol_item_ref, true);
  assert.equal(boundary.consume_exact_contract_artifact_ref, true);
  assert.equal(boundary.result_must_bind_exact_frozen_action_ref, true);
  assert.equal(boundary.evidence_digest_must_commit_to_action_ref, true);
  assert.equal(boundary.display_name_matching_forbidden, true);
  assert.equal(boundary.new_runtime_binding_forbidden, true);
  assert.equal(boundary.new_executor_forbidden, true);
  assert.deepEqual(request.assertions[0].action_ref, actionRef);

  const crossItem = handoff.expected_t16_negatives.find((entry) => entry.id === 'cross-item-evidence-swap');
  assert.equal(crossItem.expected_error, 'PROTOCOL_RUNTIME_ASSERTION_ITEM_MISMATCH');
});

test('ordering and correlation stay declaration semantics and never become runtime causality', () => {
  const { request } = exactHandoff();

  assert.equal(handoff.semantics.ordering_does_not_imply_causation, true);
  assert.equal(handoff.semantics.correlation_does_not_imply_causation, true);
  assert.equal(request.semantics.ordering_does_not_imply_causation, true);
  assert.equal(request.semantics.correlation_does_not_imply_causation, true);
});

// T00-E3: the same scenario id and the same protocol item id re-used against a DIFFERENT contract
// content (extra unrelated service => different bytes/ArtifactRef, identical `Orders.Get` item id)
// must not be accepted by an oracle request that pins the original contract.
test('same scenario id and item id with different contract content is rejected, never aliased', () => {
  const contextFor = (extraText) => {
    const scan = loadProtocolArtifact({
      family: handoff.source_fixture.family,
      file: handoff.source_fixture.file,
      text: handoff.source_fixture.text + extraText,
    });
    return protocolContext(scan, {
      featureId: 'grpc-unary-profile',
      featureUid: '11111111-1111-4111-8111-111111111111',
    });
  };
  const a = contextFor('');
  const b = contextFor('service Audit { rpc Log (Req) returns (Res); }\n');
  const methodA = a.contract.planes.grpc.methods.find((item) => item.name === handoff.profile.static_selector.method);
  const methodB = b.contract.planes.grpc.methods.find((item) => item.name === handoff.profile.static_selector.method);
  assert.equal(methodA.id, methodB.id, 'precondition: identical item id');
  assert.notEqual(a.contract_ref.byte_sha256, b.contract_ref.byte_sha256, 'precondition: different contract content');

  const bind = (context) => bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family: 'grpc',
    plane: 'methods',
    itemId: methodA.id,
  });
  const originalRef = artifactRefForBytes(Buffer.from('o\n'), { family: 'runtime-original', mediaType: 'application/octet-stream' });
  const candidateRef = artifactRefForBytes(Buffer.from('c\n'), { family: 'runtime-candidate', mediaType: 'application/octet-stream' });
  const runtimeProfileRef = artifactRefForBytes(Buffer.from('p\n'), { family: 'runtime-profile' });
  const ctxOf = (context) => ({ contract_ref: context.contract_ref, contract: context.contract, contract_bytes: context.contract_bytes });
  const request = (refContext, contexts, actionContext) => buildProtocolOracleRequest({
    featureId: 'grpc-unary-profile',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scenarioId: 'orders-get',
    protocolContractRefs: [refContext.contract_ref],
    protocolContexts: contexts,
    originalRef,
    candidateRef,
    runtimeProfileRef,
    seed: '7',
    assertions: [{ id: 'grpc-orders-get-status', kind: 'grpc-status', action_ref: bind(actionContext), expect: { status: 'OK' } }],
  });

  // Each content is individually valid, but the two requests never share a digest.
  const requestA = request(a, [ctxOf(a)], a);
  const requestB = request(b, [ctxOf(b)], b);
  assert.notEqual(protocolOracleRequestDigest(requestA), protocolOracleRequestDigest(requestB));
  assert.equal(requestA.scenario_id, requestB.scenario_id);

  const typeError = (pattern) => (error) => error instanceof TypeError && pattern.test(error.message);
  const plainError = (pattern) => (error) => error instanceof Error && pattern.test(error.message);
  // Pinning contract A but supplying B's (same-ID) context: exact context for A is missing.
  assert.throws(() => request(a, [ctxOf(b)], a), plainError(/missing exact contract context for bound protocol contract ref/));
  // Claiming ref A with B's bytes and view: bytes do not match the pinned ArtifactRef.
  assert.throws(
    () => request(a, [{ contract_ref: a.contract_ref, contract: b.contract, contract_bytes: b.contract_bytes }], a),
    typeError(/contract bytes do not match ArtifactRef/),
  );
  // Assertion action_ref bound to B's content while the request pins only contract A.
  assert.throws(() => request(a, [ctxOf(a)], b), plainError(/references a protocol contract not bound by this oracle request/));
});
