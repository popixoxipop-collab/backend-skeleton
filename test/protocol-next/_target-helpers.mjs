import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtocolArtifact } from '../../adapters/protocol-next/scanners/protocol-loaders.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TARGET_FAMILIES = Object.freeze(['graphql', 'asyncapi', 'websocket']);

export function repoPath(relative) {
  return path.join(REPO_ROOT, relative);
}

export function readText(relative) {
  return fs.readFileSync(repoPath(relative), 'utf8');
}

export function readJson(relative) {
  return JSON.parse(readText(relative));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function sha256Utf8(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function canonicalSha256(value) {
  return sha256Utf8(JSON.stringify(canonicalJson(value)));
}

// Tool and fixture text hashes are taken over LF-normalized text so a CRLF checkout cannot change them.
export function lfSha256(text) {
  return sha256Utf8(text.replace(/\r\n/g, '\n'));
}

export function targetFiles(family) {
  return {
    scope: 'adapters/protocol-next/targets/' + family + '/SCOPE.json',
    readme: 'adapters/protocol-next/targets/' + family + '/README.md',
    fixtures: 'test/protocol-next/fixtures/targets/' + family + '.fixtures.json',
    oracle: 'test/protocol-next/fixtures/targets/' + family + '.oracle.json',
  };
}

export function loadTarget(family) {
  const files = targetFiles(family);
  return {
    files,
    scope: readJson(files.scope),
    fixtures: readJson(files.fixtures),
    readmeText: readText(files.readme),
    oracle: fs.existsSync(repoPath(files.oracle)) ? readJson(files.oracle) : null,
  };
}

export function runCase(family, fixture) {
  try {
    const scan = loadProtocolArtifact({
      family,
      file: fixture.input.file,
      text: fixture.input.text,
      ...(fixture.input.format ? { format: fixture.input.format } : {}),
    });
    return { ok: true, scan };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function sortedStrings(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function argsSuffix(args, { defaults = true } = {}) {
  if (!Array.isArray(args) || args.length === 0) return '';
  return '(' + args.map((arg) => arg.name + ': ' + arg.type + (defaults && arg.default_value != null ? ' = ' + arg.default_value : '')).join(', ') + ')';
}

const GRAPHQL_ROOT_ORDER = ['query', 'mutation', 'subscription'];

// Structured, adapter-neutral view of a GraphQL scan. `args` is null when the importer carries no argument data.
export function structureGraphqlScan(scan) {
  const graphql = scan.graphql;
  return {
    schemas: graphql.schemas.map((schema) => Object.fromEntries(
      GRAPHQL_ROOT_ORDER.filter((key) => schema.roots?.[key] != null).map((key) => [key, schema.roots[key]]),
    )),
    types: graphql.types.map((type) => ({ kind: type.kind, name: type.name })),
    fields: graphql.fields.map((field) => ({
      parent: field.parent,
      name: field.name,
      type: field.type,
      args: Array.isArray(field.arguments) ? field.arguments.map((arg) => ({ name: arg.name, type: arg.type, default_value: arg.default_value ?? null })) : null,
    })),
    operations: graphql.operations.map((operation) => ({
      root_kind: operation.root_kind,
      root_type: operation.root_type,
      name: operation.name,
      result_type: operation.result_type,
      args: Array.isArray(operation.arguments) ? operation.arguments.map((arg) => ({ name: arg.name, type: arg.type, default_value: arg.default_value ?? null })) : null,
    })),
  };
}

const GRAPHQL_KIND_ALIASES = { object: 'type', input_object: 'input' };

// `normalize` maps the introspection vocabulary onto SDL keywords and strips whitespace inside type references;
// `args` controls whether argument lists take part in the comparison, `defaults` whether their default values do.
export function formatGraphqlStructure(structure, { normalize = false, args = true, defaults = true } = {}) {
  const typeText = (text) => (normalize ? String(text).replace(/\s+/g, '') : String(text));
  const kindText = (kind) => (normalize ? (GRAPHQL_KIND_ALIASES[kind] ?? kind) : kind);
  const withArgs = (list) => (args ? argsSuffix(list?.map((arg) => ({ ...arg, type: typeText(arg.type) })), { defaults }) : '');
  return {
    schemas: sortedStrings(structure.schemas.map((roots) => GRAPHQL_ROOT_ORDER.filter((key) => roots[key] != null).map((key) => key + '=' + roots[key]).join(' '))),
    types: sortedStrings(structure.types.map((type) => kindText(type.kind) + ' ' + type.name)),
    fields: sortedStrings(structure.fields.map((field) => field.parent + '.' + field.name + withArgs(field.args) + ': ' + typeText(field.type))),
    operations: sortedStrings(structure.operations.map((operation) => operation.root_kind + ' ' + operation.root_type + '.' + operation.name + withArgs(operation.args) + ': ' + typeText(operation.result_type))),
  };
}

const GRAPHQL_BUILTIN_SCALARS = new Set(['Boolean', 'Float', 'ID', 'Int', 'String']);

// Adapter view used against a reference implementation: introspection vocabulary mapped to SDL keywords, whitespace
// removed from type references, built-in scalars and double-underscore meta types excluded, default values excluded
// (graphql-js 16 and 17 expose them differently).
export function comparableGraphqlView(scan) {
  const structure = structureGraphqlScan(scan);
  const isMeta = (name) => String(name).startsWith('__');
  return formatGraphqlStructure({
    schemas: structure.schemas,
    types: structure.types.filter((type) => !isMeta(type.name) && !(type.kind === 'scalar' && GRAPHQL_BUILTIN_SCALARS.has(type.name))),
    fields: structure.fields.filter((field) => !isMeta(field.parent)),
    operations: structure.operations.filter((operation) => !isMeta(operation.root_type)),
  }, { normalize: true, defaults: false });
}

export function projectScan(family, scan) {
  const warnings = scan.warnings.map((warning) => ({ code: warning.code, message: warning.message }));
  const head = { status: scan.completeness.status, dialect: scan.dialect, adapter: scan.adapter, warnings };
  if (family === 'graphql') {
    return { ...head, ...formatGraphqlStructure(structureGraphqlScan(scan)) };
  }
  if (family === 'asyncapi') {
    return {
      ...head,
      channels: sortedStrings(scan.asyncapi.channels.map((channel) => channel.name + ' @ ' + channel.address)),
      operations: sortedStrings(scan.asyncapi.operations.map((operation) =>
        operation.direction + ' ' + operation.channel + ' ' + (operation.operation_id ?? '-') + ' [' + operation.message_refs.join(',') + ']')),
      messages: sortedStrings(scan.asyncapi.messages.map((message) =>
        message.name + ' ' + (message.content_type ?? '-') + ' ' + (message.payload_schema_ref ?? '-'))),
    };
  }
  if (family === 'websocket') {
    return {
      ...head,
      connections: sortedStrings(scan.websocket.connections.map((connection) =>
        connection.id + ' ' + (connection.endpoint ?? '-') + ' [' + connection.subprotocols.join(',') + ']')),
      messages: sortedStrings(scan.websocket.messages.map((message) =>
        (message.connection_id ?? '-') + ' ' + message.name + ' ' + message.direction + ' ' + (message.schema_ref ?? '-') + ' ' + (message.correlation_field ?? '-'))),
    };
  }
  throw new Error('unsupported target family ' + family);
}

// The comparable category lists of a projection (everything except the status/dialect/warning head).
export function projectionCategories(family) {
  if (family === 'graphql') return ['schemas', 'types', 'fields', 'operations'];
  if (family === 'asyncapi') return ['channels', 'operations', 'messages'];
  if (family === 'websocket') return ['connections', 'messages'];
  throw new Error('unsupported target family ' + family);
}

export function multisetDiff(left, right) {
  const remaining = new Map();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const onlyLeft = [];
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) remaining.set(item, count - 1);
    else onlyLeft.push(item);
  }
  const onlyRight = [];
  for (const [item, count] of remaining) for (let i = 0; i < count; i += 1) onlyRight.push(item);
  return { only_adapter: sortedStrings(onlyLeft), only_oracle: sortedStrings(onlyRight) };
}

// Returns the categories whose multisets differ between the adapter view and the oracle view.
export function divergentCategories(adapterView, oracleView, categories) {
  return categories.filter((category) => {
    const diff = multisetDiff(adapterView[category] ?? [], oracleView[category] ?? []);
    return diff.only_adapter.length > 0 || diff.only_oracle.length > 0;
  });
}

export function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

export function packageLockVersion(name) {
  const lock = readJson('package-lock.json');
  return lock.packages?.['node_modules/' + name]?.version ?? null;
}
