import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolFlowContract, protocolFlowDigest } from '../../adapters/protocol-next/contracts/protocol-flow.mjs';

const feature = { featureId: 'orders', featureUid: 'uid-orders' };

function scenario(steps) {
  return { id: 'order-flow', steps };
}

test('temporal ordering never becomes a causal edge implicitly', () => {
  const contract = buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'request', family: 'grpc', action_ref: 'grpc:Orders/Create' },
    { id: 'event', family: 'asyncapi', action_ref: 'asyncapi:orders.created', after: ['request'] },
  ]) });
  assert.deepEqual(contract.relations.ordering, [{ before: 'request', after: 'event', provenance: 'explicit-after' }]);
  assert.deepEqual(contract.relations.causation, []);
  assert.equal(contract.semantics.ordering_does_not_imply_causation, true);
});

test('causation is emitted only from caused_by', () => {
  const contract = buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'request', family: 'graphql', action_ref: 'graphql:Mutation.createOrder' },
    { id: 'event', family: 'asyncapi', action_ref: 'asyncapi:orders.created', caused_by: ['request'] },
  ]) });
  assert.deepEqual(contract.relations.causation, [{ cause: 'request', effect: 'event', provenance: 'explicit-caused-by' }]);
  assert.deepEqual(contract.relations.ordering, []);
});

test('correlation does not become causation', () => {
  const contract = buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'subscribe', family: 'websocket', action_ref: 'ws:orders.subscribe' },
    { id: 'event', family: 'asyncapi', action_ref: 'asyncapi:orders.created', correlations: [
      { key: 'order-id', with_step: 'subscribe', local_ref: 'payload.order_id', remote_ref: 'payload.order_id' },
    ] },
  ]) });
  assert.equal(contract.relations.correlation.length, 1);
  assert.deepEqual(contract.relations.causation, []);
  assert.equal(contract.semantics.correlation_does_not_imply_causation, true);
});

test('retry timeout and idempotency policy are retained as declared', () => {
  const contract = buildProtocolFlowContract({ ...feature, scenario: scenario([
    {
      id: 'create',
      family: 'grpc',
      action_ref: 'grpc:Orders/Create',
      timeout_ms: 1500,
      retry: { max_attempts: 3, backoff_ms: 100 },
      idempotency: { key_ref: 'request.idempotency_key' },
    },
  ]) });
  assert.deepEqual(contract.steps[0].retry, { max_attempts: 3, backoff_ms: 100 });
  assert.equal(contract.steps[0].timeout_ms, 1500);
  assert.deepEqual(contract.steps[0].idempotency, { key_ref: 'request.idempotency_key', required: true });
});

test('unknown and self references fail closed', () => {
  assert.throws(() => buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'a', family: 'grpc', action_ref: 'x', caused_by: ['missing'] },
  ]) }), /unknown step/);
  assert.throws(() => buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'a', family: 'grpc', action_ref: 'x', after: ['a'] },
  ]) }), /cannot reference itself/);
});

test('causal and ordering cycles fail closed', () => {
  assert.throws(() => buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'a', family: 'grpc', action_ref: 'a', after: ['b'] },
    { id: 'b', family: 'graphql', action_ref: 'b', caused_by: ['a'] },
  ]) }), /cycle/);
});

test('duplicate step ids fail closed', () => {
  assert.throws(() => buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'same', family: 'grpc', action_ref: 'a' },
    { id: 'same', family: 'graphql', action_ref: 'b' },
  ]) }), /duplicate step ids/);
});

test('same logical scenario has a deterministic digest independent of step input order', () => {
  const a = buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'a', family: 'grpc', action_ref: 'a' },
    { id: 'b', family: 'graphql', action_ref: 'b', after: ['a'] },
  ]) });
  const b = buildProtocolFlowContract({ ...feature, scenario: scenario([
    { id: 'b', family: 'graphql', action_ref: 'b', after: ['a'] },
    { id: 'a', family: 'grpc', action_ref: 'a' },
  ]) });
  assert.equal(protocolFlowDigest(a), protocolFlowDigest(b));
});
