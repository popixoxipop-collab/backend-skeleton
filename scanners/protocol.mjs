// T18 protocol-plane static importers. This module is intentionally independent of the HTTP adapter registry.
import { createHash } from 'node:crypto';
import { PROTOCOL_SCAN_SCHEMA, PROTOCOL_FAMILIES } from '../contracts/protocol.mjs';

export const PROTOCOL_IMPORTER_REVISION = 1;

export function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

export function sourceHash(file, bytes) {
  return createHash('sha256').update(String(file)).update('\0').update(bytes).digest('hex');
}

export function uniqueSorted(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) =>
    String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
    Number(a.line ?? 0) - Number(b.line ?? 0) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

export function baseProtocolScan({ family, dialect, adapter, file, bytes, payload, warnings = [] }) {
  if (!PROTOCOL_FAMILIES.includes(family)) throw new Error('unsupported protocol family: ' + family);
  const scan = {
    schema: PROTOCOL_SCAN_SCHEMA,
    family,
    dialect,
    adapter,
    adapter_revision: PROTOCOL_IMPORTER_REVISION,
    source_hash: sourceHash(file, bytes),
    files_read: [file],
    grpc: { packages: [], services: [], methods: [], messages: [] },
    graphql: { schemas: [], types: [], fields: [], operations: [] },
    asyncapi: { channels: [], operations: [], messages: [] },
    websocket: { connections: [], messages: [] },
    warnings,
    completeness: { status: 'partial' },
  };
  scan[family] = payload;
  return scan;
}

export function stripCStyleComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

export function extractBalancedBlock(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

function parseMessageFields(body, file, baseIndex, source) {
  const fields = [];
  const fieldRe = /\b(?:repeated\s+|optional\s+)?([A-Za-z_][\w.<>]*)\s+([A-Za-z_][\w]*)\s*=\s*(\d+)\b/g;
  for (const m of body.matchAll(fieldRe)) {
    fields.push({ type: m[1], name: m[2], number: Number(m[3]), file, line: lineNumberAt(source, baseIndex + m.index) });
  }
  return fields;
}

export function importProtoSource(text, { file = 'schema.proto' } = {}) {
  const source = String(text);
  const clean = stripCStyleComments(source);
  const packages = [];
  const services = [];
  const methods = [];
  const messages = [];
  const warnings = [];

  const pkg = clean.match(/\bpackage\s+([A-Za-z_][\w.]*)\s*;/);
  if (pkg) packages.push({ name: pkg[1], file, line: lineNumberAt(source, pkg.index) });

  const declRe = /\b(service|message)\s+([A-Za-z_][\w]*)\s*\{/g;
  for (const m of clean.matchAll(declRe)) {
    const openIndex = m.index + m[0].lastIndexOf('{');
    const block = extractBalancedBlock(clean, openIndex);
    if (!block) {
      warnings.push({ code: 'PROTO_UNCLOSED_BLOCK', message: m[1] + ' ' + m[2] + ' has no closing brace', file, line: lineNumberAt(source, m.index) });
      continue;
    }
    if (m[1] === 'message') {
      messages.push({
        name: m[2],
        fields: parseMessageFields(block.body, file, openIndex + 1, source),
        file,
        line: lineNumberAt(source, m.index),
      });
      continue;
    }

    services.push({ name: m[2], file, line: lineNumberAt(source, m.index) });
    const rpcRe = /\brpc\s+([A-Za-z_][\w]*)\s*\(\s*(stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*;/g;
    for (const rpc of block.body.matchAll(rpcRe)) {
      methods.push({
        service: m[2],
        name: rpc[1],
        request_type: rpc[3],
        response_type: rpc[5],
        client_streaming: Boolean(rpc[2]),
        server_streaming: Boolean(rpc[4]),
        file,
        line: lineNumberAt(source, openIndex + 1 + rpc.index),
      });
    }
  }

  const scan = baseProtocolScan({
    family: 'grpc',
    dialect: 'proto3-text',
    adapter: 'protobuf-static',
    file,
    bytes: Buffer.from(source),
    warnings,
    payload: {
      packages: uniqueSorted(packages),
      services: uniqueSorted(services),
      methods: uniqueSorted(methods),
      messages: uniqueSorted(messages),
    },
  });
  scan.completeness = {
    status: services.length || messages.length ? 'partial' : 'blocked',
    service_count: services.length,
    method_count: methods.length,
    message_count: messages.length,
    note: 'static .proto source only; descriptor options, imports and generated runtime behavior are not inferred',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'PROTO_DECLARATIONS_NOT_FOUND', message: 'no service or message declarations were found' });
  }
  return scan;
}

function stripGraphqlComments(text) {
  return text.replace(/#[^\n]*/g, (m) => ' '.repeat(m.length));
}

export function importGraphqlSDL(text, { file = 'schema.graphql' } = {}) {
  const source = String(text);
  const clean = stripGraphqlComments(source);
  const schemas = [];
  const types = [];
  const fields = [];
  const operations = [];
  const warnings = [];
  const rootKinds = new Map([['Query', 'query'], ['Mutation', 'mutation'], ['Subscription', 'subscription']]);

  const schemaRe = /\bschema\s*\{/g;
  for (const m of clean.matchAll(schemaRe)) {
    const openIndex = m.index + m[0].lastIndexOf('{');
    const block = extractBalancedBlock(clean, openIndex);
    if (!block) continue;
    const roots = {};
    for (const root of block.body.matchAll(/\b(query|mutation|subscription)\s*:\s*([_A-Za-z][_0-9A-Za-z]*)/g)) {
      roots[root[1]] = root[2];
      rootKinds.set(root[2], root[1]);
    }
    schemas.push({ roots, file, line: lineNumberAt(source, m.index) });
  }

  const typeRe = /\b(type|input|interface|enum|scalar|union)\s+([_A-Za-z][_0-9A-Za-z]*)[^\{\n]*(\{)?/g;
  for (const m of clean.matchAll(typeRe)) {
    const kind = m[1];
    const name = m[2];
    types.push({ kind, name, file, line: lineNumberAt(source, m.index) });
    if (!m[3] || ['enum', 'scalar', 'union'].includes(kind)) continue;
    const openIndex = m.index + m[0].lastIndexOf('{');
    const block = extractBalancedBlock(clean, openIndex);
    if (!block) {
      warnings.push({ code: 'GRAPHQL_UNCLOSED_TYPE', message: kind + ' ' + name + ' has no closing brace', file, line: lineNumberAt(source, m.index) });
      continue;
    }
    const fieldRe = /([_A-Za-z][_0-9A-Za-z]*)\s*(?:\([^)]*\))?\s*:\s*(\[[^\]]+\]!?|[_A-Za-z][_0-9A-Za-z]*!?)/g;
    const depthAt = (offset) => {
      let depth = 0;
      for (let i = 0; i < offset; i += 1) {
        if (block.body[i] === '(') depth += 1;
        else if (block.body[i] === ')') depth = Math.max(0, depth - 1);
      }
      return depth;
    };
    for (const f of block.body.matchAll(fieldRe)) {
      if (depthAt(f.index) !== 0) continue;
      const resultType = f[2].trim();
      const item = { parent: name, name: f[1], type: resultType, file, line: lineNumberAt(source, openIndex + 1 + f.index) };
      fields.push(item);
      const rootKind = rootKinds.get(name);
      if (rootKind) {
        operations.push({ root_kind: rootKind, root_type: name, name: f[1], result_type: resultType, file, line: item.line });
      }
    }
  }

  const scan = baseProtocolScan({
    family: 'graphql',
    dialect: 'graphql-sdl',
    adapter: 'graphql-sdl-static',
    file,
    bytes: Buffer.from(source),
    warnings,
    payload: {
      schemas: uniqueSorted(schemas),
      types: uniqueSorted(types),
      fields: uniqueSorted(fields),
      operations: uniqueSorted(operations),
    },
  });
  scan.completeness = {
    status: types.length ? 'partial' : 'blocked',
    type_count: types.length,
    field_count: fields.length,
    operation_count: operations.length,
    note: 'SDL declarations only; resolver binding, federation execution and authorization are not inferred',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'GRAPHQL_TYPES_NOT_FOUND', message: 'no GraphQL type declarations were found' });
  }
  return scan;
}

function pointerName(ref) {
  return typeof ref === 'string' ? ref.split('/').pop() : null;
}

function messageRef(message) {
  if (!message) return null;
  if (message.$ref) return pointerName(message.$ref);
  return message.name ?? null;
}

export function importAsyncApiDocument(document, { file = 'asyncapi.json' } = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('AsyncAPI importer requires a parsed object');
  }
  const bytes = Buffer.from(JSON.stringify(document));
  const channels = [];
  const operations = [];
  const messages = [];
  const warnings = [];
  const version = typeof document.asyncapi === 'string' ? document.asyncapi : null;

  for (const [name, channel] of Object.entries(document.channels ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    channels.push({ name, address: channel?.address ?? name, file, line: 1 });
    for (const direction of ['publish', 'subscribe']) {
      const op = channel?.[direction];
      if (!op || typeof op !== 'object') continue;
      const refs = [];
      if (op.message) refs.push(messageRef(op.message));
      if (Array.isArray(op.messages)) refs.push(...op.messages.map(messageRef));
      operations.push({
        channel: name,
        direction,
        operation_id: op.operationId ?? null,
        message_refs: refs.filter(Boolean).sort(),
        file,
        line: 1,
      });
    }
  }

  for (const [operationId, op] of Object.entries(document.operations ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const channelRef = op?.channel?.$ref ? pointerName(op.channel.$ref) : (op?.channel?.address ?? null);
    const refs = Array.isArray(op?.messages) ? op.messages.map(messageRef).filter(Boolean).sort() : [];
    operations.push({
      channel: channelRef,
      direction: op?.action ?? null,
      operation_id: operationId,
      message_refs: refs,
      file,
      line: 1,
    });
  }

  for (const [name, message] of Object.entries(document.components?.messages ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    messages.push({
      name,
      content_type: message?.contentType ?? null,
      payload_schema_ref: message?.payload?.$ref ?? null,
      file,
      line: 1,
    });
  }

  if (!version) warnings.push({ code: 'ASYNCAPI_VERSION_MISSING', message: 'document.asyncapi is missing' });
  const scan = baseProtocolScan({
    family: 'asyncapi',
    dialect: version ? 'asyncapi-' + version : 'asyncapi-unknown',
    adapter: 'asyncapi-object',
    file,
    bytes,
    warnings,
    payload: {
      channels: uniqueSorted(channels),
      operations: uniqueSorted(operations),
      messages: uniqueSorted(messages),
    },
  });
  scan.completeness = {
    status: channels.length || operations.length ? 'partial' : 'blocked',
    channel_count: channels.length,
    operation_count: operations.length,
    message_count: messages.length,
    note: 'parsed AsyncAPI object only; delivery guarantees, broker state and consumer runtime behavior are not inferred',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'ASYNCAPI_CHANNELS_NOT_FOUND', message: 'no channels or operations were found' });
  }
  return scan;
}

const WEBSOCKET_DIRECTIONS = new Set(['client-to-server', 'server-to-client', 'bidirectional']);

export function importWebSocketManifest(manifest, { file = 'websocket.contract.json' } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('WebSocket importer requires an explicit manifest object');
  }
  const connections = [];
  const messages = [];
  const warnings = [];

  for (const item of manifest.connections ?? []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
    connections.push({
      id: item.id,
      endpoint: item.endpoint ?? null,
      subprotocols: [...(item.subprotocols ?? [])].map(String).sort(),
      file,
      line: 1,
    });
  }

  for (const item of manifest.messages ?? []) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue;
    const direction = item.direction ?? 'bidirectional';
    if (!WEBSOCKET_DIRECTIONS.has(direction)) {
      warnings.push({
        code: 'WEBSOCKET_DIRECTION_UNSUPPORTED',
        message: 'message ' + item.name + ' has unsupported direction ' + JSON.stringify(direction),
      });
      continue;
    }
    messages.push({
      connection_id: item.connection_id ?? null,
      name: item.name,
      direction,
      schema_ref: item.schema_ref ?? null,
      correlation_field: item.correlation_field ?? null,
      file,
      line: 1,
    });
  }

  const bytes = Buffer.from(JSON.stringify(manifest));
  const scan = baseProtocolScan({
    family: 'websocket',
    dialect: manifest.version ? 'bskel-websocket-manifest/' + manifest.version : 'bskel-websocket-manifest/1',
    adapter: 'websocket-manifest',
    file,
    bytes,
    warnings,
    payload: {
      connections: uniqueSorted(connections),
      messages: uniqueSorted(messages),
    },
  });
  scan.completeness = {
    status: connections.length || messages.length ? 'partial' : 'blocked',
    connection_count: connections.length,
    message_count: messages.length,
    note: 'explicit manifest only; source-code socket discovery is not message-contract certification',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'WEBSOCKET_MANIFEST_EMPTY', message: 'manifest contains no connections or messages' });
  }
  return scan;
}
