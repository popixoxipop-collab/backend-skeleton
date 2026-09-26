import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import { buildProtocolFlowContract } from '../../adapters/protocol-next/contracts/protocol-flow.mjs';
import { buildProtocolOracleRequest } from '../../adapters/protocol-next/contracts/protocol-oracle-request.mjs';
import { importAsyncApiDocument, importProtoSource } from '../../adapters/protocol-next/scanners/protocol.mjs';
import { artifactRefForBytes, protocolContext, protocolItem } from './_helpers.mjs';

function readSchema(name) {
  return JSON.parse(fs.readFileSync(
    new URL('../../adapters/protocol-next/schemas/' + name, import.meta.url),
    'utf8',
  ));
}

const schemas = {
  contract: readSchema('protocol-contract.schema.json'),
  itemRef: readSchema('protocol-item-ref.schema.json'),
  flow: readSchema('protocol-flow.schema.json'),
  oracle: readSchema('protocol-oracle-request.schema.json'),
  websocket: readSchema('websocket-manifest.schema.json'),
};

function validator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schemas.itemRef);
  if (schema.$id !== schemas.itemRef.$id) ajv.addSchema(schema);
  return ajv.getSchema(schema.$id);
}

function assertValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

test('all T18 draft schemas compile independently of stable schema registry', () => {
  for (const schema of Object.values(schemas)) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(schemas.itemRef);
    if (schema.$id !== schemas.itemRef.$id) ajv.addSchema(schema);
    assert.equal(typeof ajv.getSchema(schema.$id), 'function');
  }
});

test('generated protocol contract validates and wrong source hash basis is rejected', () => {
  const context = protocolContext(importProtoSource(
    'syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }',
  ));
  const validate = validator(schemas.contract);
  assertValid(validate, context.contract);

  const bad = structuredClone(context.contract);
  bad.source.source_hash_basis = 'semantic-equivalence';
  assert.equal(validate(bad), false);
});

test('typed protocol item ref validates and family/plane mismatch is rejected by schema', () => {
  const context = protocolContext(importProtoSource(
    'syntax = "proto3"; service Echo { rpc Ping (A) returns (B); }',
  ));
  const reference = protocolItem(context, { family: 'grpc', plane: 'methods' });
  const validate = validator(schemas.itemRef);
  assertValid(validate, reference);

  const bad = { ...reference, family: 'websocket' };
  assert.equal(validate(bad), false);
});

test('generated protocol flow validates with typed exact action refs', () => {
  const grpc = protocolContext(importProtoSource(
    'syntax = "proto3"; service Orders { rpc Create (A) returns (B); }',
  ));
  const event = protocolContext(importAsyncApiDocument({
    asyncapi: '3.0.0',
    channels: { orders: { address: 'orders' } },
    operations: { sendOrder: { action: 'send', channel: { $ref: '#/channels/orders' } } },
  }));
  const grpcAction = protocolItem(grpc, { family: 'grpc', plane: 'methods' });
  const eventAction = protocolItem(event, { family: 'asyncapi', plane: 'operations' });
  const flow = buildProtocolFlowContract({
    featureId: 'orders',
    featureUid: 'uid-orders',
    protocolContexts: [grpc, event],
    scenario: {
      id: 'create-order',
      steps: [
        { id: 'request', family: 'grpc', action_ref: grpcAction },
        { id: 'event', family: 'asyncapi', action_ref: eventAction, after: ['request'] },
      ],
    },
  });
  const validate = validator(schemas.flow);
  assertValid(validate, flow);

  const bad = structuredClone(flow);
  bad.semantics.ordering_does_not_imply_causation = false;
  assert.equal(validate(bad), false);
});

test('generated oracle request validates and HTTP assertion kind is rejected', () => {
  const grpc = protocolContext(importProtoSource(
    'syntax = "proto3"; service Orders { rpc Create (A) returns (B); }',
  ));
  const grpcAction = protocolItem(grpc, { family: 'grpc', plane: 'methods' });
  const genericRef = (text, family) => artifactRefForBytes(Buffer.from(text), { family, version: '1' });
  const request = buildProtocolOracleRequest({
    featureId: 'orders',
    featureUid: 'uid-orders',
    scenarioId: 'create',
    protocolContractRefs: [grpc.contract_ref],
    protocolContexts: [grpc],
    originalRef: genericRef('original', 'repo-snapshot'),
    candidateRef: genericRef('candidate', 'repo-snapshot'),
    runtimeProfileRef: genericRef('profile', 'beval.runtime-profile'),
    assertions: [{ id: 'grpc-ok', kind: 'grpc-status', action_ref: grpcAction, expect: { code: 'OK' } }],
  });
  const validate = validator(schemas.oracle);
  assertValid(validate, request);

  const bad = structuredClone(request);
  bad.assertions[0].kind = 'http-status';
  assert.equal(validate(bad), false);
});

test('explicit WebSocket manifest schema rejects unsupported direction and undeclared fields', () => {
  const validate = validator(schemas.websocket);
  assertValid(validate, {
    version: '1',
    connections: [{ id: 'orders', endpoint: 'wss://example.test/orders', subprotocols: ['json'] }],
    messages: [{ connection_id: 'orders', name: 'event', direction: 'server-to-client', schema_ref: '#/$defs/Event' }],
  });

  assert.equal(validate({
    connections: [{ id: 'orders' }],
    messages: [{ name: 'event', direction: 'sideways' }],
  }), false);

  assert.equal(validate({ connections: [{ id: 'orders', arbitrary: true }] }), false);
});
