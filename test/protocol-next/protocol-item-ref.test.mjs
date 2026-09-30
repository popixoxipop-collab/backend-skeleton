import assert from 'node:assert/strict';
import test from 'node:test';
import { importProtoSource, importGraphqlSDL } from '../../adapters/protocol-next/scanners/protocol.mjs';
import {
  PROTOCOL_ITEM_REF_VERSION,
  assertProtocolItemRefAgainstContexts,
  assertProtocolItemRefBound,
  assertProtocolItemRefShape,
  assertT01ArtifactRefShape,
  bindProtocolItemRef,
  indexProtocolContractContexts,
} from '../../adapters/protocol-next/contracts/protocol-item-ref.mjs';
import { artifactRefForBytes, protocolContext, protocolItem } from './_helpers.mjs';

test('protocol item ref binds an exact T01-shaped artifact ref and existing item id', () => {
  const context = protocolContext(importProtoSource('syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }'));
  const reference = protocolItem(context, { family: 'grpc', plane: 'methods' });
  assert.equal(reference.protocol_item_ref, PROTOCOL_ITEM_REF_VERSION);
  assert.equal(reference.contract.artifact_ref, 'sbf.artifact-ref/1');
  assert.equal(reference.family, 'grpc');
  assert.equal(assertProtocolItemRefBound({ reference, contract: context.contract, contractBytes: context.contract_bytes }).name, 'Ping');
});

test('format-only contract byte change invalidates the protocol item ref', () => {
  const context = protocolContext(importGraphqlSDL('type Query { ping: String! }'));
  const reference = protocolItem(context, { family: 'graphql', plane: 'operations' });
  const reformatted = Buffer.from(JSON.stringify(context.contract), 'utf8');
  assert.notEqual(reformatted.toString('utf8'), context.contract_bytes.toString('utf8'));
  assert.throws(
    () => assertProtocolItemRefBound({ reference, contract: context.contract, contractBytes: reformatted }),
    /bytes do not match ArtifactRef/,
  );
});

test('missing item, family mismatch and invalid plane fail closed', () => {
  const context = protocolContext(importProtoSource('syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }'));
  const valid = protocolItem(context, { family: 'grpc', plane: 'methods' });
  assert.throws(
    () => assertProtocolItemRefBound({ reference: { ...valid, item_id: 'grpc-method:missing' }, contract: context.contract, contractBytes: context.contract_bytes }),
    /item_id does not exist/,
  );
  assert.throws(
    () => assertProtocolItemRefShape({ ...valid, family: 'graphql' }),
    /plane is invalid|family/,
  );
  assert.throws(
    () => assertProtocolItemRefShape({ ...valid, plane: 'http-methods' }),
    /plane is invalid/,
  );
});

test('T01 artifact-ref draft shape is consumed exactly, not approximated', () => {
  const ref = artifactRefForBytes(Buffer.from('{}'));
  assert.equal(assertT01ArtifactRefShape(ref), ref);
  assert.throws(() => assertT01ArtifactRefShape({ ...ref, sha256: ref.byte_sha256 }), /exactly/);
  assert.throws(() => assertT01ArtifactRefShape({ ...ref, byte_sha256: ref.byte_sha256.toUpperCase() }), /byte_sha256/);
});

test('flow/runtime consumers must provide the exact referenced contract context', () => {
  const grpcContext = protocolContext(importProtoSource('syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }'));
  const gqlContext = protocolContext(importGraphqlSDL('type Query { ping: String! }'));
  const grpcRef = protocolItem(grpcContext, { family: 'grpc', plane: 'methods' });
  const index = indexProtocolContractContexts([grpcContext, gqlContext]);
  assert.equal(assertProtocolItemRefAgainstContexts(grpcRef, index).name, 'Ping');
  assert.throws(() => assertProtocolItemRefAgainstContexts(grpcRef, [gqlContext]), /context is not available/);
  assert.throws(() => indexProtocolContractContexts([grpcContext, grpcContext]), /duplicate protocol contract context/);
});

test('bindProtocolItemRef cannot create a reference to a non-existent item', () => {
  const context = protocolContext(importGraphqlSDL('type Query { ping: String! }'));
  assert.throws(() => bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family: 'graphql',
    plane: 'operations',
    itemId: 'graphql-operation:not-present',
  }), /item_id does not exist/);
});


test('contract object view cannot disagree with the exact referenced contract bytes', () => {
  const context = protocolContext(importProtoSource('syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }'));
  const reference = protocolItem(context, { family: 'grpc', plane: 'methods' });
  const spoofed = structuredClone(context.contract);
  spoofed.planes.grpc.methods[0].name = 'SpoofedPing';
  assert.throws(
    () => assertProtocolItemRefBound({
      reference,
      contract: spoofed,
      contractBytes: context.contract_bytes,
    }),
    /context object does not match exact contract bytes/,
  );
});

test('protocol contract item refs require application/json media type', () => {
  const context = protocolContext(importGraphqlSDL('type Query { ping: String! }'));
  const reference = protocolItem(context, { family: 'graphql', plane: 'operations' });
  assert.throws(
    () => assertProtocolItemRefShape({
      ...reference,
      contract: { ...reference.contract, media_type: 'text/plain' },
    }),
    /media_type must be application\/json/,
  );
});

// T00-E3 (same-ID / different-content reuse): the contract identity (featureId/featureUid) AND the
// protocol item id (`grpc-method:...`) are IDENTICAL across the two contexts below; only the bytes
// differ (the response message type). An ID that survives a content change must never let the old
// ArtifactRef vouch for the new bytes, nor let the new bytes be found under the old ref.
// Item ids are derived from the method signature and source location, so appending an unrelated
// service after the method keeps `Echo.Ping`'s item id identical while the serialized contract
// bytes (and therefore the ArtifactRef digest) change.
const SAME_ID_SOURCE_A = 'syntax = "proto3"; service Echo { rpc Ping (A) returns (B); } message A {} message B {}';
const SAME_ID_SOURCE_B = SAME_ID_SOURCE_A + ' service Extra { rpc Other (A) returns (B); }';

function bindGrpcMethod(context, itemId) {
  return bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family: 'grpc',
    plane: 'methods',
    itemId,
  });
}

function sameIdContexts() {
  const a = protocolContext(importProtoSource(SAME_ID_SOURCE_A));
  const b = protocolContext(importProtoSource(SAME_ID_SOURCE_B));
  const itemA = a.contract.planes.grpc.methods.find((method) => method.name === 'Ping');
  const itemB = b.contract.planes.grpc.methods.find((method) => method.id === itemA.id);
  assert.ok(itemB, 'same item id must exist in the different-content contract');
  // Preconditions: this really is the same-ID/different-content case, not two unrelated contracts.
  assert.equal(a.contract.feature_id, b.contract.feature_id);
  assert.equal(a.contract.feature_uid, b.contract.feature_uid);
  assert.equal(itemA.id, itemB.id);
  assert.notEqual(a.contract_bytes.toString('utf8'), b.contract_bytes.toString('utf8'));
  assert.notEqual(a.contract_ref.byte_sha256, b.contract_ref.byte_sha256);
  return { a, b, itemId: itemA.id };
}

test('same feature id and same item id with different contract content: old ArtifactRef rejects the new bytes', () => {
  const { a, b, itemId } = sameIdContexts();
  const referenceA = bindGrpcMethod(a, itemId);
  // Positive control: the reference is valid against its own exact bytes.
  assert.equal(assertProtocolItemRefBound({ reference: referenceA, contract: a.contract, contractBytes: a.contract_bytes }).name, 'Ping');
  // Same item id exists in B, but B's bytes are not the bytes the ref pins.
  assert.throws(
    () => assertProtocolItemRefBound({ reference: referenceA, contract: b.contract, contractBytes: b.contract_bytes }),
    (error) => error instanceof TypeError && /ProtocolItemRef contract bytes do not match ArtifactRef/.test(error.message),
  );
  // bindProtocolItemRef with A's ref and B's (same-ID) content is rejected for the same reason.
  assert.throws(
    () => bindProtocolItemRef({
      contractRef: a.contract_ref,
      contract: b.contract,
      contractBytes: b.contract_bytes,
      family: 'grpc',
      plane: 'methods',
      itemId,
    }),
    (error) => error instanceof TypeError && /contract bytes do not match ArtifactRef/.test(error.message),
  );
});

test('same-ID/different-content context cannot be registered under the other contract ref', () => {
  const { a, b } = sameIdContexts();
  // Context claims ref A but carries B's bytes and B's parsed view.
  assert.throws(
    () => indexProtocolContractContexts([{ contract_ref: a.contract_ref, contract: b.contract, contract_bytes: b.contract_bytes }]),
    (error) => error instanceof TypeError && /contract bytes do not match ArtifactRef/.test(error.message),
  );
  // A's bytes with B's parsed view is likewise rejected (view must match the exact bytes).
  assert.throws(
    () => indexProtocolContractContexts([{ contract_ref: a.contract_ref, contract: b.contract, contract_bytes: a.contract_bytes }]),
    (error) => error instanceof TypeError && /context object does not match exact contract bytes/.test(error.message),
  );
});

test('a ref pinned to one same-ID contract is not satisfied by a context holding the other content', () => {
  const { a, b, itemId } = sameIdContexts();
  const referenceA = bindGrpcMethod(a, itemId);
  const referenceB = bindGrpcMethod(b, itemId);
  assert.equal(referenceA.item_id, referenceB.item_id);
  assert.notDeepEqual(referenceA.contract, referenceB.contract);
  // Both contexts are individually exact; each ref resolves only against its own contract.
  const both = indexProtocolContractContexts([a, b]);
  assert.equal(both.size, 2);
  assert.equal(assertProtocolItemRefAgainstContexts(referenceA, both).name, 'Ping');
  assert.equal(assertProtocolItemRefAgainstContexts(referenceB, both).name, 'Ping');
  // Supplying only the other content must not silently satisfy the reference.
  assert.throws(
    () => assertProtocolItemRefAgainstContexts(referenceA, [b]),
    (error) => error instanceof TypeError && /ProtocolItemRef contract context is not available/.test(error.message),
  );
  assert.throws(
    () => assertProtocolItemRefAgainstContexts(referenceB, [a]),
    (error) => error instanceof TypeError && /ProtocolItemRef contract context is not available/.test(error.message),
  );
});
