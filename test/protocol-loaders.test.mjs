import assert from 'node:assert/strict';
import test from 'node:test';
import { importGraphqlIntrospection, importProtobufDescriptorSet } from '../scanners/protocol-descriptors.mjs';
import { loadProtocolArtifact, parseStructuredProtocolText } from '../scanners/protocol-loaders.mjs';
import { buildProtocolOracleRequest, protocolOracleRequestDigest } from '../contracts/protocol-oracle-request.mjs';

test('protobuf FileDescriptorSet JSON preserves nested messages and streaming flags', () => {
  const scan = importProtobufDescriptorSet({
    file: [{
      name: 'orders.proto',
      package: 'shop.v1',
      syntax: 'proto3',
      messageType: [{
        name: 'Envelope',
        field: [{ name: 'id', number: 1, type: 'TYPE_STRING' }],
        nestedType: [{ name: 'Meta', field: [{ name: 'trace_id', number: 1, type: 'TYPE_STRING' }] }],
      }],
      service: [{
        name: 'Orders',
        method: [{
          name: 'Watch',
          inputType: '.shop.v1.Envelope',
          outputType: '.shop.v1.Envelope.Meta',
          clientStreaming: false,
          serverStreaming: true,
        }],
      }],
    }],
  });
  assert.equal(scan.family, 'grpc');
  assert.equal(scan.source_hash_basis, 'canonical-parsed-object');
  assert.deepEqual(scan.grpc.messages.map((x) => x.name).sort(), ['shop.v1.Envelope', 'shop.v1.Envelope.Meta'].sort());
  assert.deepEqual(scan.grpc.methods.map((x) => [x.service, x.name, x.request_type, x.response_type, x.server_streaming]), [
    ['shop.v1.Orders', 'Watch', 'shop.v1.Envelope', 'shop.v1.Envelope.Meta', true],
  ]);
});

test('protobuf descriptor object hashing is canonical across object key order', () => {
  const a = importProtobufDescriptorSet({ file: [{ name: 'a.proto', package: 'p', messageType: [{ name: 'A' }] }] });
  const b = importProtobufDescriptorSet({ file: [{ package: 'p', messageType: [{ name: 'A' }], name: 'a.proto' }] });
  assert.equal(a.source_hash, b.source_hash);
});

test('GraphQL introspection imports root operations, args and wrapped return types', () => {
  const scan = importGraphqlIntrospection({
    data: {
      __schema: {
        queryType: { name: 'RootQuery' },
        mutationType: null,
        subscriptionType: null,
        types: [{
          kind: 'OBJECT',
          name: 'RootQuery',
          fields: [{
            name: 'orders',
            args: [{
              name: 'limit',
              defaultValue: '10',
              type: { kind: 'SCALAR', name: 'Int', ofType: null },
            }],
            type: {
              kind: 'NON_NULL',
              name: null,
              ofType: {
                kind: 'LIST',
                name: null,
                ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'Order', ofType: null } },
              },
            },
            isDeprecated: false,
            deprecationReason: null,
          }],
        }],
      },
    },
  });
  assert.equal(scan.source_hash_basis, 'canonical-parsed-object');
  assert.deepEqual(scan.graphql.operations.map((x) => [x.root_kind, x.root_type, x.name, x.result_type]), [
    ['query', 'RootQuery', 'orders', '[Order!]!'],
  ]);
  assert.deepEqual(scan.graphql.operations[0].arguments, [{ name: 'limit', type: 'Int', default_value: '10' }]);
});

test('raw AsyncAPI YAML loader is bounded and keeps event semantics', () => {
  const scan = loadProtocolArtifact({
    family: 'asyncapi',
    file: 'asyncapi.yaml',
    text: 'asyncapi: 3.0.0\nchannels:\n  orders:\n    address: orders\noperations:\n  sendOrder:\n    action: send\n    channel:\n      $ref: "#/channels/orders"\n',
  });
  assert.equal(scan.family, 'asyncapi');
  assert.deepEqual(scan.asyncapi.operations.map((x) => [x.operation_id, x.direction, x.channel]), [
    ['sendOrder', 'send', 'orders'],
  ]);
});

test('structured loader rejects remote refs, oversized documents and duplicate YAML keys', () => {
  assert.throws(() => parseStructuredProtocolText('asyncapi: 3.0.0\nchannels:\n  a:\n    $ref: https://example.test/a.yaml\n'), /remote \$ref is disabled/);
  assert.throws(() => parseStructuredProtocolText('a: 1\n', { maxBytes: 2 }), /maxBytes/);
  assert.throws(() => parseStructuredProtocolText('a: 1\na: 2\n'), /invalid YAML/);
});

test('loader routes proto source and GraphQL SDL without structured parsing', () => {
  const grpc = loadProtocolArtifact({ family: 'grpc', file: 'x.proto', text: 'syntax = "proto3"; service X { rpc Ping (A) returns (B); }' });
  const graphql = loadProtocolArtifact({ family: 'graphql', file: 'schema.graphql', text: 'type Query { ping: String! }' });
  assert.equal(grpc.grpc.methods[0].name, 'Ping');
  assert.equal(graphql.graphql.operations[0].name, 'ping');
});

test('loader routes descriptor and introspection JSON by family', () => {
  const descriptor = loadProtocolArtifact({
    family: 'grpc',
    file: 'descriptor.json',
    text: JSON.stringify({ file: [{ name: 'x.proto', messageType: [{ name: 'X' }] }] }),
  });
  const introspection = loadProtocolArtifact({
    family: 'graphql',
    file: 'introspection.json',
    text: JSON.stringify({ __schema: { queryType: { name: 'Query' }, types: [{ kind: 'OBJECT', name: 'Query', fields: [{ name: 'ping', args: [], type: { kind: 'SCALAR', name: 'String' } }] }] } }),
  });
  assert.equal(descriptor.grpc.messages[0].name, 'X');
  assert.equal(introspection.graphql.operations[0].name, 'ping');
});

function artifactRef(seed, family = 'test/artifact', version = '1') {
  return { family, version, sha256: seed.repeat(64), size_bytes: 123 };
}

test('oracle request binds immutable artifact refs and sorts assertions deterministically', () => {
  const base = {
    featureId: 'orders',
    featureUid: 'uid-orders',
    scenarioId: 'create-order',
    protocolContractRef: artifactRef('a', 'sbf.protocol-contract', '1'),
    flowContractRef: artifactRef('b', 'sbf.protocol-flow', '1'),
    originalRef: artifactRef('c', 'repo.snapshot', '1'),
    candidateRef: artifactRef('d', 'repo.snapshot', '1'),
    runtimeProfileRef: artifactRef('e', 'beval.runtime-profile', '1'),
    seed: 42,
  };
  const a = buildProtocolOracleRequest({
    ...base,
    assertions: [
      { id: 'b', kind: 'message-observed', action_ref: 'asyncapi:orders.created', expect: { count: 1 } },
      { id: 'a', kind: 'grpc-status', action_ref: 'grpc:Orders/Create', expect: { code: 'OK' } },
    ],
  });
  const b = buildProtocolOracleRequest({
    ...base,
    assertions: [...a.assertions].reverse(),
  });
  assert.deepEqual(a.assertions.map((x) => x.id), ['a', 'b']);
  assert.equal(protocolOracleRequestDigest(a), protocolOracleRequestDigest(b));
  assert.equal(a.semantics.request_is_not_runtime_evidence, true);
  assert.equal(a.semantics.executor_must_rehash_referenced_bytes, true);
});

test('oracle request rejects malformed refs, duplicate assertions and unsupported assertion kinds', () => {
  const valid = {
    featureId: 'orders',
    featureUid: 'uid-orders',
    scenarioId: 's',
    protocolContractRef: artifactRef('a'),
    originalRef: artifactRef('b'),
    candidateRef: artifactRef('c'),
    runtimeProfileRef: artifactRef('d'),
  };
  assert.throws(() => buildProtocolOracleRequest({ ...valid, protocolContractRef: { ...artifactRef('a'), sha256: 'ABC' }, assertions: [{ id: 'x', kind: 'state', expect: true }] }), /sha256/);
  assert.throws(() => buildProtocolOracleRequest({ ...valid, assertions: [{ id: 'x', kind: 'state', expect: true }, { id: 'x', kind: 'state', expect: false }] }), /duplicate assertion ids/);
  assert.throws(() => buildProtocolOracleRequest({ ...valid, assertions: [{ id: 'x', kind: 'http-status', expect: 200 }] }), /unsupported protocol assertion kind/);
});
