import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolFlowContract, protocolFlowDigest } from '../../adapters/protocol-next/contracts/protocol-flow.mjs';
import {
  importAsyncApiDocument,
  importGraphqlSDL,
  importProtoSource,
  importWebSocketManifest,
} from '../../adapters/protocol-next/scanners/protocol.mjs';
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
