import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolContract, protocolContractDigest, verifyProtocolContractSnapshot } from '../../adapters/protocol-next/contracts/protocol.mjs';
import { importProtoSource, importGraphqlSDL, importAsyncApiDocument, importWebSocketManifest } from '../../adapters/protocol-next/scanners/protocol.mjs';

const feature = { featureId: 'protocol-orders', featureUid: 'uid-protocol-orders' };

test('protobuf importer preserves RPC streaming direction without converting it to HTTP', () => {
  const scan = importProtoSource('syntax = "proto3";\npackage shop.v1;\nmessage GetOrderRequest { string id = 1; }\nmessage Order { string id = 1; }\nservice Orders {\n  rpc GetOrder (GetOrderRequest) returns (Order);\n  rpc WatchOrders (GetOrderRequest) returns (stream Order);\n}');
  assert.equal(scan.family, 'grpc');
  assert.equal(scan.grpc.services[0].name, 'Orders');
  assert.deepEqual(scan.grpc.methods.map((m) => [m.name, m.client_streaming, m.server_streaming]), [
    ['GetOrder', false, false],
    ['WatchOrders', false, true],
  ]);
  assert.equal('method' in scan.grpc.methods[0], false);
  assert.equal('path' in scan.grpc.methods[0], false);
});

test('GraphQL importer keeps operation roots separate from HTTP methods', () => {
  const scan = importGraphqlSDL('type Query { order(id: ID!): Order }\ntype Mutation { cancelOrder(id: ID!): Order }\ntype Order { id: ID! status: String! }');
  assert.equal(scan.family, 'graphql');
  assert.deepEqual(scan.graphql.operations.map((x) => [x.root_type, x.name]), [
    ['Query', 'order'],
    ['Mutation', 'cancelOrder'],
  ]);
  assert.deepEqual(scan.graphql.fields.filter((x) => x.parent === 'Order').map((x) => x.name), ['id', 'status']);
  assert.ok(scan.graphql.operations.every((x) => !('http_method' in x)));
});

test('GraphQL explicit schema roots are preserved', () => {
  const scan = importGraphqlSDL('schema { query: RootQuery mutation: RootMutation }\ntype RootQuery { ping: String! }\ntype RootMutation { pong: String! }');
  assert.deepEqual(scan.graphql.operations.map((x) => [x.root_kind, x.root_type, x.name]), [
    ['query', 'RootQuery', 'ping'],
    ['mutation', 'RootMutation', 'pong'],
  ]);
});

test('AsyncAPI importer keeps publish/subscribe action and message refs', () => {
  const scan = importAsyncApiDocument({
    asyncapi: '2.6.0',
    channels: {
      'orders/created': {
        publish: { operationId: 'publishOrderCreated', message: { $ref: '#/components/messages/OrderCreated' } },
      },
    },
    components: { messages: { OrderCreated: { contentType: 'application/json', payload: { $ref: '#/components/schemas/OrderCreated' } } } },
  });
  assert.equal(scan.asyncapi.operations[0].direction, 'publish');
  assert.deepEqual(scan.asyncapi.operations[0].message_refs, ['OrderCreated']);
  assert.equal(scan.asyncapi.messages[0].payload_schema_ref, '#/components/schemas/OrderCreated');
});

test('WebSocket importer requires explicit message direction and skips unsupported values', () => {
  const scan = importWebSocketManifest({
    connections: [{ id: 'orders', endpoint: 'wss://example.test/orders', subprotocols: ['json'] }],
    messages: [
      { connection_id: 'orders', name: 'subscribe', direction: 'client-to-server', schema_ref: '#/$defs/Subscribe' },
      { connection_id: 'orders', name: 'event', direction: 'sideways' },
    ],
  });
  assert.equal(scan.websocket.messages.length, 1);
  assert.equal(scan.websocket.messages[0].direction, 'client-to-server');
  assert.equal(scan.warnings[0].code, 'WEBSOCKET_DIRECTION_UNSUPPORTED');
});

test('protocol contract activates only its own family plane', () => {
  const scan = importProtoSource('service Echo { rpc Ping (PingRequest) returns (PingReply); } message PingRequest {} message PingReply {}');
  const contract = buildProtocolContract({ ...feature, scan });
  assert.equal(contract.sbf_protocol_contract, '1');
  assert.equal(contract.protocol.family, 'grpc');
  assert.equal(contract.planes.grpc.methods.length, 1);
  assert.deepEqual(contract.planes.graphql, { schemas: [], types: [], fields: [], operations: [] });
  assert.deepEqual(contract.planes.asyncapi, { channels: [], operations: [], messages: [] });
  assert.deepEqual(contract.planes.websocket, { connections: [], messages: [] });
});

test('contract builder is deterministic for the same scan', () => {
  const scan = importProtoSource('message B {} message A {}');
  const a = buildProtocolContract({ ...feature, scan });
  const rebuilt = buildProtocolContract({ ...feature, scan });
  assert.equal(protocolContractDigest(a), protocolContractDigest(rebuilt));
});

test('snapshot verification detects protocol payload drift', () => {
  const scan = importGraphqlSDL('type Query { ping: String! }');
  const contract = buildProtocolContract({ ...feature, scan });
  assert.equal(verifyProtocolContractSnapshot({ contract, scan, ...feature }).current, true);
  contract.planes.graphql.operations[0].name = 'pong';
  const result = verifyProtocolContractSnapshot({ contract, scan, ...feature });
  assert.equal(result.current, false);
  assert.ok(result.changes.some((x) => x.field === 'contract_digest'));
});

test('blocked scans cannot emit a trusted protocol contract', () => {
  const scan = importProtoSource('// no protocol declarations');
  assert.equal(scan.completeness.status, 'blocked');
  assert.throws(() => buildProtocolContract({ ...feature, scan }), /blocked protocol scan/);
});

test('comments cannot create fake protobuf declarations', () => {
  const scan = importProtoSource('// service Fake { rpc Nope (A) returns (B); }\n/* message Nope {} */');
  assert.equal(scan.grpc.services.length, 0);
  assert.equal(scan.grpc.messages.length, 0);
  assert.equal(scan.completeness.status, 'blocked');
});

test('source changes alter source hash', () => {
  const a = importGraphqlSDL('type Query { ping: String }');
  const b = importGraphqlSDL('type Query { ping: String! }');
  assert.notEqual(a.source_hash, b.source_hash);
});


test('protobuf client and bidi streaming flags remain protocol-native', () => {
  const scan = importProtoSource('service S { rpc Upload (stream Chunk) returns (Ack); rpc Chat (stream Msg) returns (stream Msg); }');
  const byName = Object.fromEntries(scan.grpc.methods.map((x) => [x.name, x]));
  assert.deepEqual([byName.Upload.client_streaming, byName.Upload.server_streaming], [true, false]);
  assert.deepEqual([byName.Chat.client_streaming, byName.Chat.server_streaming], [true, true]);
});

test('GraphQL arguments and directive arguments are not emitted as fields', () => {
  const scan = importGraphqlSDL('type Query { user(id: ID!, limit: Int): User @deprecated(reason: "x") } type User { id: ID! }');
  assert.deepEqual(scan.graphql.fields.filter((x) => x.parent === 'Query').map((x) => x.name), ['user']);
  assert.equal(scan.graphql.fields.some((x) => x.name === 'id' && x.parent === 'Query'), false);
  assert.equal(scan.graphql.fields.some((x) => x.name === 'reason'), false);
});

test('AsyncAPI 3 operations preserve action instead of an HTTP verb', () => {
  const scan = importAsyncApiDocument({
    asyncapi: '3.0.0',
    channels: { orders: { address: 'orders' } },
    operations: {
      sendOrder: {
        action: 'send',
        channel: { $ref: '#/channels/orders' },
        messages: [{ $ref: '#/components/messages/Order' }],
      },
    },
    components: { messages: { Order: {} } },
  });
  assert.deepEqual(scan.asyncapi.operations.map((x) => [x.operation_id, x.direction, x.channel]), [
    ['sendOrder', 'send', 'orders'],
  ]);
});

test('empty WebSocket manifest is blocked', () => {
  const scan = importWebSocketManifest({});
  assert.equal(scan.completeness.status, 'blocked');
  assert.equal(scan.warnings.at(-1).code, 'WEBSOCKET_MANIFEST_EMPTY');
});


test('protobuf dialect follows explicit proto2/proto3 syntax and unknown stays explicit', () => {
  const proto2 = importProtoSource('syntax = "proto2"; message A { optional string id = 1; }');
  const unknown = importProtoSource('message A { string id = 1; }');
  assert.equal(proto2.dialect, 'proto2-text');
  assert.equal(unknown.dialect, 'protobuf-text-unknown');
  assert.ok(unknown.warnings.some((x) => x.code === 'PROTO_SYNTAX_UNRESOLVED'));
});

test('protobuf nested message fields do not leak into the parent simple-field list', () => {
  const scan = importProtoSource('syntax = "proto3"; message Outer { message Inner { string nested = 1; } string outer = 2; }');
  const outer = scan.grpc.messages.find((x) => x.name === 'Outer');
  assert.deepEqual(outer.fields.map((x) => x.name), ['outer']);
});

test('GraphQL explicit schema roots disable implicit Query root naming', () => {
  const scan = importGraphqlSDL('schema { query: RootQuery } type RootQuery { ping: String } type Query { notARoot: String }');
  assert.deepEqual(scan.graphql.operations.map((x) => [x.root_type, x.name]), [['RootQuery', 'ping']]);
});

test('GraphQL strings cannot create fake type declarations', () => {
  const scan = importGraphqlSDL('type Query { note: String @deprecated(reason: "type Fake { hacked: String }") }');
  assert.equal(scan.graphql.types.some((x) => x.name === 'Fake'), false);
});

test('parsed-object protocol hashes are canonical across key insertion order', () => {
  const a = importAsyncApiDocument({ asyncapi: '3.0.0', channels: { orders: { address: 'orders' } } });
  const b = importAsyncApiDocument({ channels: { orders: { address: 'orders' } }, asyncapi: '3.0.0' });
  assert.equal(a.source_hash_basis, 'canonical-parsed-object');
  assert.equal(a.source_hash, b.source_hash);

  const wsA = importWebSocketManifest({ connections: [{ id: 'c', endpoint: 'wss://x' }], version: '1' });
  const wsB = importWebSocketManifest({ version: '1', connections: [{ endpoint: 'wss://x', id: 'c' }] });
  assert.equal(wsA.source_hash_basis, 'canonical-parsed-object');
  assert.equal(wsA.source_hash, wsB.source_hash);
});

test('WebSocket unresolved or duplicate connection identity blocks the manifest', () => {
  const unresolved = importWebSocketManifest({
    connections: [{ id: 'known' }],
    messages: [{ connection_id: 'missing', name: 'event', direction: 'server-to-client' }],
  });
  assert.equal(unresolved.completeness.status, 'blocked');
  assert.ok(unresolved.warnings.some((x) => x.code === 'WEBSOCKET_CONNECTION_UNRESOLVED'));

  const duplicate = importWebSocketManifest({ connections: [{ id: 'same' }, { id: 'same', endpoint: 'wss://other' }] });
  assert.equal(duplicate.completeness.status, 'blocked');
  assert.ok(duplicate.warnings.some((x) => x.code === 'WEBSOCKET_DUPLICATE_CONNECTION_ID'));
});

test('contract snapshot verification binds source hash basis as well as hash bytes', () => {
  const scan = importAsyncApiDocument({ asyncapi: '3.0.0', channels: { a: { address: 'a' } } });
  const contract = buildProtocolContract({ ...feature, scan });
  assert.equal(contract.source.source_hash_basis, 'canonical-parsed-object');
  contract.source.source_hash_basis = 'raw-bytes';
  const result = verifyProtocolContractSnapshot({ contract, scan, ...feature });
  assert.equal(result.current, false);
  assert.ok(result.changes.some((x) => x.field === 'source.source_hash_basis'));
});
