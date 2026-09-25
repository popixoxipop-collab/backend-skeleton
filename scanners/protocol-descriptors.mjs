import { baseProtocolScan, uniqueSorted } from './protocol.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function descriptorFiles(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('protobuf descriptor importer requires an object');
  }
  return asArray(document.file ?? document.files);
}

function fieldTypeName(field) {
  if (typeof field?.typeName === 'string' && field.typeName) return field.typeName.replace(/^\./, '');
  if (typeof field?.type_name === 'string' && field.type_name) return field.type_name.replace(/^\./, '');
  const type = field?.type;
  return type == null ? null : String(type);
}

function walkDescriptorMessages({ packageName, parent = [], messages, fileName, out }) {
  for (const message of asArray(messages)) {
    if (!message || typeof message.name !== 'string') continue;
    const path = [...parent, message.name];
    const fullName = [packageName, ...path].filter(Boolean).join('.');
    const fields = asArray(message.field).map((field) => ({
      name: field?.name ?? null,
      number: Number(field?.number),
      type: fieldTypeName(field),
      label: field?.label == null ? null : String(field.label),
      json_name: field?.jsonName ?? field?.json_name ?? null,
      oneof_index: Number.isInteger(field?.oneofIndex) ? field.oneofIndex
        : (Number.isInteger(field?.oneof_index) ? field.oneof_index : null),
      proto3_optional: Boolean(field?.proto3Optional ?? field?.proto3_optional),
      file: fileName,
      line: 1,
    })).filter((field) => typeof field.name === 'string' && Number.isFinite(field.number));
    out.push({ name: fullName, fields, file: fileName, line: 1 });
    walkDescriptorMessages({
      packageName,
      parent: path,
      messages: message.nestedType ?? message.nested_type,
      fileName,
      out,
    });
  }
}

export function importProtobufDescriptorSet(document, { file = 'descriptor-set.json' } = {}) {
  const packages = [];
  const services = [];
  const methods = [];
  const messages = [];
  const warnings = [];
  const files = descriptorFiles(document);

  for (const descriptor of files) {
    const fileName = descriptor?.name ?? file;
    const packageName = typeof descriptor?.package === 'string' ? descriptor.package : '';
    const syntax = descriptor?.syntax ?? null;
    if (packageName) packages.push({ name: packageName, file: fileName, line: 1 });
    if (syntax && syntax !== 'proto2' && syntax !== 'proto3' && syntax !== 'editions') {
      warnings.push({ code: 'PROTO_DESCRIPTOR_SYNTAX_UNTESTED', message: 'descriptor syntax ' + JSON.stringify(syntax) + ' is outside the tested proto2/proto3/editions profiles', file: fileName, line: 1 });
    }

    walkDescriptorMessages({
      packageName,
      messages: descriptor?.messageType ?? descriptor?.message_type,
      fileName,
      out: messages,
    });

    for (const service of asArray(descriptor?.service)) {
      if (!service || typeof service.name !== 'string') continue;
      const serviceName = [packageName, service.name].filter(Boolean).join('.');
      services.push({ name: serviceName, file: fileName, line: 1 });
      for (const method of asArray(service.method)) {
        if (!method || typeof method.name !== 'string') continue;
        methods.push({
          service: serviceName,
          name: method.name,
          request_type: String(method.inputType ?? method.input_type ?? '').replace(/^\./, '') || null,
          response_type: String(method.outputType ?? method.output_type ?? '').replace(/^\./, '') || null,
          client_streaming: Boolean(method.clientStreaming ?? method.client_streaming),
          server_streaming: Boolean(method.serverStreaming ?? method.server_streaming),
          file: fileName,
          line: 1,
        });
      }
    }
  }

  const scan = baseProtocolScan({
    family: 'grpc',
    dialect: 'protobuf-file-descriptor-set-json',
    adapter: 'protobuf-descriptor-object',
    file,
    bytes: Buffer.from(JSON.stringify(document)),
    sourceHashBasis: 'canonical-parsed-object',
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
    descriptor_file_count: files.length,
    service_count: services.length,
    method_count: methods.length,
    message_count: messages.length,
    note: 'FileDescriptorSet JSON shape only; custom options, source-code info and generated runtime behavior are not interpreted',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'PROTO_DESCRIPTOR_DECLARATIONS_NOT_FOUND', message: 'descriptor set contains no service or message declarations' });
  }
  return scan;
}

function unwrapTypeRef(ref) {
  if (!ref || typeof ref !== 'object') return { rendered: null, named: null };
  if (ref.kind === 'NON_NULL') {
    const inner = unwrapTypeRef(ref.ofType);
    return { rendered: inner.rendered == null ? null : inner.rendered + '!', named: inner.named };
  }
  if (ref.kind === 'LIST') {
    const inner = unwrapTypeRef(ref.ofType);
    return { rendered: inner.rendered == null ? null : '[' + inner.rendered + ']', named: inner.named };
  }
  return { rendered: ref.name ?? null, named: ref.name ?? null };
}

function schemaFromIntrospection(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('GraphQL introspection importer requires an object');
  }
  if (document.data?.__schema) return document.data.__schema;
  if (document.__schema) return document.__schema;
  throw new Error('GraphQL introspection object must contain __schema or data.__schema');
}

export function importGraphqlIntrospection(document, { file = 'graphql-introspection.json' } = {}) {
  const schema = schemaFromIntrospection(document);
  const schemas = [];
  const types = [];
  const fields = [];
  const operations = [];
  const warnings = [];
  const roots = new Map();

  for (const [kind, prop] of [['query', 'queryType'], ['mutation', 'mutationType'], ['subscription', 'subscriptionType']]) {
    const name = schema?.[prop]?.name;
    if (typeof name === 'string' && name) roots.set(name, kind);
  }
  schemas.push({
    roots: Object.fromEntries([...roots.entries()].map(([name, kind]) => [kind, name])),
    file,
    line: 1,
  });

  for (const type of asArray(schema?.types)) {
    if (!type || typeof type.name !== 'string') continue;
    const typeKind = String(type.kind ?? 'UNKNOWN').toLowerCase();
    types.push({ kind: typeKind, name: type.name, file, line: 1 });
    for (const field of asArray(type.fields)) {
      if (!field || typeof field.name !== 'string') continue;
      const result = unwrapTypeRef(field.type);
      const args = asArray(field.args).map((arg) => {
        const argType = unwrapTypeRef(arg?.type);
        return {
          name: arg?.name ?? null,
          type: argType.rendered,
          default_value: arg?.defaultValue ?? null,
        };
      }).filter((arg) => typeof arg.name === 'string');
      const item = {
        parent: type.name,
        name: field.name,
        type: result.rendered,
        arguments: args,
        deprecated: Boolean(field.isDeprecated),
        deprecation_reason: field.deprecationReason ?? null,
        file,
        line: 1,
      };
      fields.push(item);
      const rootKind = roots.get(type.name);
      if (rootKind) {
        operations.push({
          root_kind: rootKind,
          root_type: type.name,
          name: field.name,
          result_type: result.rendered,
          arguments: args,
          file,
          line: 1,
        });
      }
    }
  }

  const scan = baseProtocolScan({
    family: 'graphql',
    dialect: 'graphql-introspection-json',
    adapter: 'graphql-introspection-object',
    file,
    bytes: Buffer.from(JSON.stringify(document)),
    sourceHashBasis: 'canonical-parsed-object',
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
    note: 'introspection schema only; resolver bindings, authorization directives and runtime behavior are not inferred',
  };
  if (scan.completeness.status === 'blocked') {
    scan.warnings.push({ code: 'GRAPHQL_INTROSPECTION_TYPES_NOT_FOUND', message: 'introspection schema contains no types' });
  }
  return scan;
}
