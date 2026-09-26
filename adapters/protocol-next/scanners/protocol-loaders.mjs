import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  importAsyncApiDocument,
  importGraphqlSDL,
  importProtoSource,
  importWebSocketManifest,
} from './protocol.mjs';
import {
  importGraphqlIntrospection,
  importProtobufDescriptorSet,
} from './protocol-descriptors.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 50000;
const DEFAULT_MAX_ALIASES = 50;

function countObjectBudget(value, { maxDepth, maxNodes }) {
  let nodes = 0;
  function visit(node, depth) {
    nodes += 1;
    if (nodes > maxNodes) throw new Error('structured protocol document exceeds maxNodes=' + maxNodes);
    if (depth > maxDepth) throw new Error('structured protocol document exceeds maxDepth=' + maxDepth);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) visit(item, depth + 1);
    }
  }
  visit(value, 0);
}

function rejectRemoteRefs(value) {
  function visit(node, pointer) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, pointer + '/' + index));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      const childPointer = pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
      if (key === '$ref' && typeof item === 'string' && /^https?:\/\//i.test(item)) {
        throw new Error('remote $ref is disabled by default at ' + childPointer);
      }
      visit(item, childPointer);
    }
  }
  visit(value, '#');
}

export function parseStructuredProtocolText(text, {
  file = 'protocol.yaml',
  maxBytes = DEFAULT_MAX_BYTES,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxNodes = DEFAULT_MAX_NODES,
  maxAliases = DEFAULT_MAX_ALIASES,
  allowRemoteRefs = false,
} = {}) {
  const source = String(text);
  const size = Buffer.byteLength(source);
  if (size > maxBytes) throw new Error('protocol document exceeds maxBytes=' + maxBytes + ': ' + file);

  let value;
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error('invalid JSON protocol document ' + file + ': ' + error.message);
    }
  } else {
    const document = parseDocument(source, {
      maxAliasCount: maxAliases,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length) {
      throw new Error('invalid YAML protocol document ' + file + ': ' + document.errors[0].message);
    }
    value = document.toJS({ maxAliasCount: maxAliases });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('structured protocol document must decode to an object: ' + file);
  }
  countObjectBudget(value, { maxDepth, maxNodes });
  if (!allowRemoteRefs) rejectRemoteRefs(value);
  return value;
}

function inferMode(family, file, format) {
  if (format && format !== 'auto') return format;
  const ext = path.extname(file).toLowerCase();
  if (family === 'grpc') return ext === '.proto' ? 'proto' : 'descriptor';
  if (family === 'graphql') return ['.graphql', '.gql', '.graphqls'].includes(ext) ? 'sdl' : 'introspection';
  if (family === 'asyncapi') return 'asyncapi';
  if (family === 'websocket') return 'websocket-manifest';
  throw new Error('unsupported protocol family: ' + JSON.stringify(family));
}

export function loadProtocolArtifact({
  family,
  text,
  file = 'protocol.txt',
  format = 'auto',
  limits = {},
} = {}) {
  const mode = inferMode(family, file, format);
  if (family === 'grpc' && mode === 'proto') return importProtoSource(text, { file });
  if (family === 'graphql' && mode === 'sdl') return importGraphqlSDL(text, { file });

  const document = parseStructuredProtocolText(text, { file, ...limits });
  if (family === 'grpc' && mode === 'descriptor') return importProtobufDescriptorSet(document, { file });
  if (family === 'graphql' && mode === 'introspection') return importGraphqlIntrospection(document, { file });
  if (family === 'asyncapi' && mode === 'asyncapi') return importAsyncApiDocument(document, { file });
  if (family === 'websocket' && mode === 'websocket-manifest') return importWebSocketManifest(document, { file });
  throw new Error('unsupported protocol format ' + JSON.stringify(mode) + ' for family ' + JSON.stringify(family));
}
