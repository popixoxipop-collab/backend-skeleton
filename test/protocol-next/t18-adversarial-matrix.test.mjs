import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolArtifact } from '../../adapters/protocol-next/scanners/protocol-loaders.mjs';
import { bindProtocolItemRef, assertProtocolItemRefBound } from '../../adapters/protocol-next/contracts/protocol-item-ref.mjs';
import { artifactRefForBytes, protocolContext, protocolItem } from './_helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (family, file, text) => loadProtocolArtifact({ family, file, text });
const grpc = 'syntax = "proto3"; service Orders { rpc Get (Req) returns (Res); }';
const gql = 'type Query { order(id: ID!): String }';
const async2 = 'asyncapi: 2.6.0\nchannels:\n  orders:\n    publish:\n      operationId: sendOrder\n';
const async3 = 'asyncapi: 3.0.0\nchannels:\n  orders:\n    address: orders\noperations:\n  sendOrder:\n    action: send\n    channel:\n      $ref: "#/channels/orders"\n';
const ws = JSON.stringify({ version: '1', connections: [{ id: 'orders', endpoint: 'wss://example.test/orders' }],
  messages: [{ connection_id: 'orders', name: 'changed', direction: 'server-to-client' }] });

test('four-family source mutation matrix changes exact identity without fabricating runtime proof', () => {
  const cases = [
    { family: 'grpc', file: 'orders.proto', base: grpc, changed: grpc.replace('Get', 'Watch'),
      plane: 'grpc', key: 'methods', name: 'Watch' },
    { family: 'graphql', file: 'schema.graphql', base: gql, changed: gql.replace('order', 'orders'),
      plane: 'graphql', key: 'operations', name: 'orders' },
    { family: 'asyncapi', file: 'asyncapi.yaml', base: async3, changed: async3.replace('sendOrder', 'sendOrders'),
      plane: 'asyncapi', key: 'operations', name: 'sendOrders' },
    { family: 'websocket', file: 'websocket.json', base: ws, changed: ws.replace('changed', 'updated'),
      plane: 'websocket', key: 'messages', name: 'updated' },
  ];
  for (const item of cases) {
    const before = load(item.family, item.file, item.base);
    const after = load(item.family, item.file, item.changed);
    assert.notEqual(before.source_hash, after.source_hash, item.family);
    assert.equal(before.completeness.status, 'partial', item.family);
    assert.equal(after.completeness.status, 'partial', item.family);
    const records = after[item.plane][item.key];
    assert.ok(records.length > 0, item.family);
    assert.ok(records.some((record) => Object.values(record).includes(item.name)), item.family);
    assert.equal(Object.hasOwn(after, 'runtime_verified'), false, item.family);
    assert.equal(Object.hasOwn(after, 'certified'), false, item.family);
  }
});

test('comment decoys cannot create gRPC or GraphQL declarations', () => {
  const proto = load('grpc', 'orders.proto', `${grpc}\n// service Ghost { rpc Bad (X) returns (Y); }\n`);
  const graph = load('graphql', 'schema.graphql', `${gql}\n# type Ghost { bad: String }\n`);
  assert.deepEqual(proto.grpc.services.map((record) => record.name), ['Orders']);
  assert.deepEqual(proto.grpc.methods.map((record) => record.name), ['Get']);
  assert.deepEqual(graph.graphql.operations.map((record) => record.name), ['order']);
  assert.equal(graph.graphql.types.some((record) => record.name === 'Ghost'), false);
});

test('AsyncAPI 2.6 and 3.0 structural dialects remain separate and version labels do not certify broker behavior', () => {
  const old = load('asyncapi', 'asyncapi.yaml', async2);
  const current = load('asyncapi', 'asyncapi.yaml', async3);
  assert.equal(old.dialect, 'asyncapi-2.6.0');
  assert.equal(current.dialect, 'asyncapi-3.0.0');
  assert.equal(old.asyncapi.operations[0].direction, 'publish');
  assert.equal(current.asyncapi.operations[0].direction, 'send');
  assert.notEqual(old.source_hash, current.source_hash);
  for (const scan of [old, current]) {
    assert.equal(Object.hasOwn(scan, 'broker_delivery_verified'), false);
    assert.equal(Object.hasOwn(scan, 'runtime_verified'), false);
  }
  const changedLabel = load('asyncapi', 'asyncapi.yaml', async3.replace('3.0.0', '3.0.1'));
  assert.equal(changedLabel.asyncapi.operations[0].direction, 'send');
  assert.notEqual(changedLabel.source_hash, current.source_hash);
});

test('remote reference and budget mutations fail closed before an external resolution', () => {
  assert.throws(() => load('asyncapi', 'asyncapi.yaml', async3.replace('#/channels/orders',
    'https://example.test/orders.yaml')), /remote \$ref is disabled/);
  assert.throws(() => loadProtocolArtifact({ family: 'asyncapi', file: 'asyncapi.yaml',
    text: async3, limits: { maxBytes: 8 } }), /maxBytes/);
  assert.throws(() => loadProtocolArtifact({ family: 'asyncapi', file: 'asyncapi.yaml',
    text: 'asyncapi: 3.0.0\nchannels:\n  a: {}\n  a: {}\n' }), /invalid YAML/);
});

test('WebSocket connection mutation blocks an unbound message instead of inventing an endpoint', () => {
  const baseline = load('websocket', 'websocket.json', ws);
  const changed = load('websocket', 'websocket.json', ws.replace('"connection_id":"orders"',
    '"connection_id":"missing"'));
  assert.equal(baseline.websocket.messages.length, 1);
  assert.equal(changed.completeness.status, 'blocked');
  assert.equal(changed.websocket.messages.length, 0);
  assert.ok(changed.warnings.length > 0);
});

test('exact contract bytes, item identity, and family mutations do not reuse a bound item', () => {
  const context = protocolContext(load('grpc', 'orders.proto', grpc));
  const item = protocolItem(context, { family: 'grpc', plane: 'methods' });
  assert.ok(assertProtocolItemRefBound({ reference: item, contract: context.contract,
    contractBytes: context.contract_bytes }));
  const changedBytes = Buffer.from(context.contract_bytes.toString().replace('Orders', 'OrdersChanged'));
  assert.notEqual(artifactRefForBytes(changedBytes).byte_sha256, context.contract_ref.byte_sha256);
  assert.throws(() => assertProtocolItemRefBound({ reference: item, contract: context.contract,
    contractBytes: changedBytes }), /bytes do not match/);
  assert.throws(() => bindProtocolItemRef({ contractRef: context.contract_ref,
    contract: context.contract, contractBytes: context.contract_bytes,
    family: 'graphql', plane: 'operations', itemId: item.item_id }));
  const changed = protocolContext(load('grpc', 'orders.proto', grpc.replace('Get', 'Watch')));
  assert.notEqual(changed.contract_ref.byte_sha256, context.contract_ref.byte_sha256);
  assert.throws(() => assertProtocolItemRefBound({ reference: item, contract: changed.contract,
    contractBytes: changed.contract_bytes }), /bytes do not match/);
});

test('Node permission mode executes bounded protocol intake but denies unrelated read, write, and child process', () => {
  const dependencyRoot = fs.realpathSync(path.join(root, 'node_modules'));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { loadProtocolArtifact } from './adapters/protocol-next/scanners/protocol-loaders.mjs';
    const scan = loadProtocolArtifact({family:'grpc',file:'x.proto',text:'syntax = "proto3"; service X { rpc Ping (A) returns (B); }'});
    assert.equal(scan.grpc.methods.length, 1);
    assert.equal(process.permission.has('fs.write'), false);
    assert.equal(process.permission.has('fs.read','test/corpus-next/negative-vectors.json'), false);
    assert.throws(() => fs.readFileSync('test/corpus-next/negative-vectors.json'), e => e.code === 'ERR_ACCESS_DENIED');
    let fd;
    try { fd = fs.openSync('adapters/protocol-next/docs/protocol-contract.md','r+'); }
    catch (e) { assert.equal(e.code,'ERR_ACCESS_DENIED'); }
    if (fd !== undefined) { fs.closeSync(fd); throw new Error('write access unexpectedly granted'); }
    let denied = false;
    try { denied = spawnSync(process.execPath,['-e','0']).error?.code === 'ERR_ACCESS_DENIED'; }
    catch (e) { denied = e.code === 'ERR_ACCESS_DENIED'; }
    assert.equal(denied,true);
  `;
  const run = spawnSync(process.execPath, ['--permission', '--allow-fs-read=./adapters/protocol-next',
    '--allow-fs-read=./node_modules', `--allow-fs-read=${dependencyRoot}`,
    '--allow-fs-read=./package.json',
    '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
});

test('T18 local adversarial matrix does not alter T19 fixed 79-vector certification catalog', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'test/corpus-next/negative-vectors.json')));
  assert.equal(catalog.contract, 'sbf.qa-negative-vectors/1');
  assert.equal(catalog.vectors.length, 79);
  assert.equal(catalog.vectors.some(({ category }) => category === 'protocol'), false);
});
