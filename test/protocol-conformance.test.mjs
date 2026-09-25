import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadProtocolArtifact } from '../scanners/protocol-loaders.mjs';

const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/protocol/conformance.json', import.meta.url), 'utf8'));

function counts(scan) {
  if (scan.family === 'grpc') {
    return {
      status: scan.completeness.status,
      services: scan.grpc.services.length,
      methods: scan.grpc.methods.length,
      messages: scan.grpc.messages.length,
    };
  }
  if (scan.family === 'graphql') {
    return {
      status: scan.completeness.status,
      types: scan.graphql.types.length,
      operations: scan.graphql.operations.length,
    };
  }
  if (scan.family === 'asyncapi') {
    return {
      status: scan.completeness.status,
      channels: scan.asyncapi.channels.length,
      operations: scan.asyncapi.operations.length,
    };
  }
  if (scan.family === 'websocket') {
    return {
      status: scan.completeness.status,
      connections: scan.websocket.connections.length,
      messages: scan.websocket.messages.length,
    };
  }
  throw new Error('unexpected family ' + scan.family);
}

test('protocol conformance corpus metadata is explicit and non-runtime', () => {
  assert.equal(corpus.schema, 'sbf.protocol-conformance-corpus/1');
  assert.match(corpus.note, /not runtime certification/i);
  assert.ok(corpus.cases.length >= 8);
});

for (const entry of corpus.cases) {
  test('protocol conformance: ' + entry.id, () => {
    if (entry.expect_error) {
      assert.throws(
        () => loadProtocolArtifact({ family: entry.family, file: entry.file, text: entry.text }),
        (error) => String(error?.message ?? error).includes(entry.expect_error),
      );
      return;
    }
    const scan = loadProtocolArtifact({ family: entry.family, file: entry.file, text: entry.text });
    assert.deepEqual(counts(scan), entry.expect);
  });
}
