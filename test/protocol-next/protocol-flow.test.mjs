import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolFlowContract, protocolFlowDigest } from '../../adapters/protocol-next/contracts/protocol-flow.mjs';
import {
  importAsyncApiDocument,
  importGraphqlSDL,
  importProtoSource,
  importWebSocketManifest,
} from '../../adapters/protocol-next/scanners/protocol.mjs';
import { bindProtocolItemRef } from '../../adapters/protocol-next/contracts/protocol-item-ref.mjs';
import { protocolContext, protocolItem } from './_helpers.mjs';

const feature = { featureId: 'orders', featureUid: 'uid-orders' };

const grpcContext = protocolContext(importProtoSource(
  'syntax = "proto3"; service Orders { rpc Create (CreateRequest) returns (Order); } message CreateRequest {} message Order {}',
));
const graphqlContext = protocolContext(importGraphqlSDL('type Mutation { createOrder: Order } type Order { id: ID! }'));
const asyncapiContext = protocolContext(importAsyncApiDocument({
  asyncapi: '3.0.0',
  channels: { orders: { address: 'orders' } },
  operations: { sendOrder: { action: 'send', channel: { $ref: '#/channels/orders' } } },
}));
const websocketContext = protocolContext(importWebSocketManifest({
  connections: [{ id: 'orders' }],
  messages: [{ connection_id: 'orders', name: 'subscribe', direction: 'client-to-server' }],
}));
const protocolContexts = [grpcContext, graphqlContext, asyncapiContext, websocketContext];

const grpcAction = protocolItem(grpcContext, { family: 'grpc', plane: 'methods' });
const graphqlAction = protocolItem(graphqlContext, { family: 'graphql', plane: 'operations' });
const asyncapiAction = protocolItem(asyncapiContext, { family: 'asyncapi', plane: 'operations' });
const websocketAction = protocolItem(websocketContext, { family: 'websocket', plane: 'messages' });

function scenario(steps) {
  return { id: 'order-flow', steps };
}

function build(steps, contexts = protocolContexts) {
  return buildProtocolFlowContract({ ...feature, scenario: scenario(steps), protocolContexts: contexts });
}

test('temporal ordering never becomes a causal edge implicitly', () => {
  const contract = build([
    { id: 'request', family: 'grpc', action_ref: grpcAction },
    { id: 'event', family: 'asyncapi', action_ref: asyncapiAction, after: ['request'] },
  ]);
  assert.deepEqual(contract.relations.ordering, [{ before: 'request', after: 'event', provenance: 'explicit-after' }]);
  assert.deepEqual(contract.relations.causation, []);
  assert.equal(contract.semantics.ordering_does_not_imply_causation, true);
});

test('causation is emitted only from caused_by', () => {
  const contract = build([
    { id: 'request', family: 'graphql', action_ref: graphqlAction },
    { id: 'event', family: 'asyncapi', action_ref: asyncapiAction, caused_by: ['request'] },
  ]);
  assert.deepEqual(contract.relations.causation, [{ cause: 'request', effect: 'event', provenance: 'explicit-caused-by' }]);
  assert.deepEqual(contract.relations.ordering, []);
});

test('correlation does not become causation', () => {
  const contract = build([
    { id: 'subscribe', family: 'websocket', action_ref: websocketAction },
    { id: 'event', family: 'asyncapi', action_ref: asyncapiAction, correlations: [
      { key: 'order-id', with_step: 'subscribe', local_ref: 'payload.order_id', remote_ref: 'payload.order_id' },
    ] },
  ]);
  assert.equal(contract.relations.correlation.length, 1);
  assert.deepEqual(contract.relations.causation, []);
  assert.equal(contract.semantics.correlation_does_not_imply_causation, true);
});

test('retry timeout and idempotency policy are retained as declared', () => {
  const contract = build([
    {
      id: 'create',
      family: 'grpc',
      action_ref: grpcAction,
      timeout_ms: 1500,
      retry: { max_attempts: 3, backoff_ms: 100 },
      idempotency: { key_ref: 'request.idempotency_key' },
    },
  ]);
  assert.deepEqual(contract.steps[0].retry, { max_attempts: 3, backoff_ms: 100 });
  assert.equal(contract.steps[0].timeout_ms, 1500);
  assert.deepEqual(contract.steps[0].idempotency, { key_ref: 'request.idempotency_key', required: true });
});

test('unknown and self references fail closed after action identity is verified', () => {
  assert.throws(() => build([
    { id: 'a', family: 'grpc', action_ref: grpcAction, caused_by: ['missing'] },
  ]), /unknown step/);
  assert.throws(() => build([
    { id: 'a', family: 'grpc', action_ref: grpcAction, after: ['a'] },
  ]), /cannot reference itself/);
});

test('causal and ordering cycles fail closed', () => {
  assert.throws(() => build([
    { id: 'a', family: 'grpc', action_ref: grpcAction, after: ['b'] },
    { id: 'b', family: 'graphql', action_ref: graphqlAction, caused_by: ['a'] },
  ]), /cycle/);
});

test('duplicate step ids fail closed', () => {
  assert.throws(() => build([
    { id: 'same', family: 'grpc', action_ref: grpcAction },
    { id: 'same', family: 'graphql', action_ref: graphqlAction },
  ]), /duplicate step ids/);
});

test('action reference family mismatch and missing contract context fail closed', () => {
  assert.throws(() => build([
    { id: 'a', family: 'graphql', action_ref: grpcAction },
  ]), /family does not match/);
  assert.throws(() => build([
    { id: 'a', family: 'grpc', action_ref: grpcAction },
  ], [graphqlContext]), /context is not available/);
});

test('same logical scenario has a deterministic digest independent of step input order', () => {
  const a = build([
    { id: 'a', family: 'grpc', action_ref: grpcAction },
    { id: 'b', family: 'graphql', action_ref: graphqlAction, after: ['a'] },
  ]);
  const b = build([
    { id: 'b', family: 'graphql', action_ref: graphqlAction, after: ['a'] },
    { id: 'a', family: 'grpc', action_ref: grpcAction },
  ]);
  assert.equal(protocolFlowDigest(a), protocolFlowDigest(b));
});

// T00-E3: the SAME flow id ('order-flow') and step ids re-used with a DIFFERENT contract behind the
// same protocol item id must not resolve, and must never share a flow digest with the original.
test('same flow id and step ids with different-content contract behind the same item id fails closed', () => {
  const contextA = protocolContext(importProtoSource(
    'syntax = "proto3"; service Orders { rpc Create (CreateRequest) returns (Order); } message CreateRequest {} message Order {}',
  ));
  const contextB = protocolContext(importProtoSource(
    'syntax = "proto3"; service Orders { rpc Create (CreateRequest) returns (Order); } message CreateRequest {} message Order {} service Audit { rpc Log (Order) returns (Order); }',
  ));
  const idA = contextA.contract.planes.grpc.methods.find((method) => method.name === 'Create').id;
  assert.equal(idA, contextB.contract.planes.grpc.methods.find((method) => method.name === 'Create').id);
  assert.notEqual(contextA.contract_ref.byte_sha256, contextB.contract_ref.byte_sha256);
  const bindCreate = (context) => bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family: 'grpc',
    plane: 'methods',
    itemId: idA,
  });
  const refA = bindCreate(contextA);
  const refB = bindCreate(contextB);
  const steps = (ref) => [{ id: 'create', family: 'grpc', action_ref: ref }];

  const flowA = build(steps(refA), [contextA]);
  const flowB = build(steps(refB), [contextB]);
  // Same flow id, different bound content => different digest (no aliasing of the flow identity).
  assert.notEqual(protocolFlowDigest(flowA), protocolFlowDigest(flowB));

  // Flow A's action ref cannot be satisfied by contract B's content (same item id), and vice versa.
  assert.throws(() => build(steps(refA), [contextB]), (error) => error instanceof TypeError && /context is not available/.test(error.message));
  assert.throws(() => build(steps(refB), [contextA]), (error) => error instanceof TypeError && /context is not available/.test(error.message));
  // A context that claims ref A but carries B's bytes is rejected outright.
  assert.throws(
    () => build(steps(refA), [{ contract_ref: contextA.contract_ref, contract: contextB.contract, contract_bytes: contextB.contract_bytes }]),
    (error) => error instanceof TypeError && /bytes do not match ArtifactRef/.test(error.message),
  );
});
