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
