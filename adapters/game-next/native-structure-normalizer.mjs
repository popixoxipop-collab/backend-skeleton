import { verifyNativeExportEnvelope } from './native-export-envelope.mjs';

export const NATIVE_STRUCTURE_SCHEMA = 'sbf.game-native-structure/draft-1';
export const NATIVE_STRUCTURE_REVISION = 1;

const PROFILE_SCHEMAS = Object.freeze({
  unreal: 'sbf.game-unreal-structure-export/draft-1',
  unity: 'sbf.game-unity-serialized-export/draft-1',
  godot: 'sbf.game-godot-scene-export/draft-1',
});

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('native structure bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function parseJson(raw) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('native structure bytes must be valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('native structure bytes must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native structure payload must be a top-level object');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function strings(value, label) {
  const out = array(value ?? [], label).map((item, index) => requireString(item, `${label}[${index}]`));
  if (out.length !== new Set(out).size) throw new TypeError(`${label} must not contain duplicates`);
  return [...out].sort();
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  return requireString(value, label);
}

function assertOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function sortedUnique(items, keyFn, label) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`);
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

function source(engine, path, localId) {
  return { engine, path, local_id: localId };
}

function unreal(payload) {
  assertOnlyKeys(payload, ['schema', 'types'], 'Unreal payload');
  const nodes = [];
  const relations = [];
  const declarations = { replication: [], rpc: [], signals: [] };
  for (const [typeIndex, type] of array(payload.types, 'types').entries()) {
    if (!type || typeof type !== 'object' || Array.isArray(type)) throw new TypeError(`types[${typeIndex}] must be an object`);
    assertOnlyKeys(type, ['id', 'kind', 'name', 'base', 'specifiers', 'properties', 'functions'], `types[${typeIndex}]`);
    const id = requireString(type.id, `types[${typeIndex}].id`);
    const kind = requireString(type.kind, `types[${typeIndex}].kind`);
    if (!['class', 'struct', 'interface', 'enum'].includes(kind)) throw new TypeError(`unsupported Unreal type kind: ${kind}`);
    const name = requireString(type.name, `types[${typeIndex}].name`);
    const specifiers = strings(type.specifiers ?? [], `types[${typeIndex}].specifiers`);
    nodes.push({ id: `unreal:type:${id}`, kind: `unreal-${kind}`, name, type: null, specifiers, source: source('unreal', 'types', id) });

    if (type.base != null) {
      relations.push({ id: `unreal:base:${id}`, kind: 'declared-base', from: `unreal:type:${id}`, to_symbol: requireString(type.base, `types[${typeIndex}].base`), source: source('unreal', 'types.base', id) });
    }

    for (const property of array(type.properties ?? [], `types[${typeIndex}].properties`)) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) throw new TypeError('property must be an object');
      assertOnlyKeys(property, ['name', 'type', 'specifiers'], 'property');
      const propertyName = requireString(property.name, 'property.name');
      const propertyType = requireString(property.type, 'property.type');
      const ps = strings(property.specifiers ?? [], 'property.specifiers');
      const pid = `${id}:${propertyName}`;
      nodes.push({ id: `unreal:property:${pid}`, kind: 'unreal-property', name: propertyName, type: propertyType, specifiers: ps, source: source('unreal', 'types.properties', pid) });
      relations.push({ id: `unreal:declares-property:${pid}`, kind: 'declares', from: `unreal:type:${id}`, to: `unreal:property:${pid}`, source: source('unreal', 'types.properties', pid) });
      const rep = ps.find((s) => s === 'Replicated' || s.startsWith('ReplicatedUsing='));
      if (rep) declarations.replication.push({ id: `unreal:replication:${pid}`, subject: `unreal:property:${pid}`, mode: rep === 'Replicated' ? 'Replicated' : 'ReplicatedUsing', notify: rep.startsWith('ReplicatedUsing=') ? rep.slice('ReplicatedUsing='.length) : null, evidence: 'declared-specifier' });
    }

    for (const fn of array(type.functions ?? [], `types[${typeIndex}].functions`)) {
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) throw new TypeError('function must be an object');
      assertOnlyKeys(fn, ['name', 'specifiers'], 'function');
      const functionName = requireString(fn.name, 'function.name');
      const fs = strings(fn.specifiers ?? [], 'function.specifiers');
      const fid = `${id}:${functionName}`;
      nodes.push({ id: `unreal:function:${fid}`, kind: 'unreal-function', name: functionName, type: null, specifiers: fs, source: source('unreal', 'types.functions', fid) });
      relations.push({ id: `unreal:declares-function:${fid}`, kind: 'declares', from: `unreal:type:${id}`, to: `unreal:function:${fid}`, source: source('unreal', 'types.functions', fid) });
      const rpc = fs.find((s) => ['Client', 'Server', 'Remote', 'NetMulticast', 'ServiceRequest', 'ServiceResponse'].includes(s));
      if (rpc) declarations.rpc.push({ id: `unreal:rpc:${fid}`, subject: `unreal:function:${fid}`, mode: rpc, reliability: fs.includes('Reliable') ? 'reliable' : fs.includes('Unreliable') ? 'unreliable' : 'unspecified', evidence: 'declared-specifier' });
    }
  }
  return { nodes, relations, declarations };
}

function unity(payload) {
  assertOnlyKeys(payload, ['schema', 'documents'], 'Unity payload');
  const nodes = [];
  const relations = [];
  const declarations = { replication: [], rpc: [], signals: [] };
  for (const [index, doc] of array(payload.documents, 'documents').entries()) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError(`documents[${index}] must be an object`);
    assertOnlyKeys(doc, ['file_id', 'class_id', 'type', 'name', 'game_object_file_id', 'parent_file_id', 'references'], `documents[${index}]`);
    const fileId = String(doc.file_id ?? '');
    if (!/^-?[0-9]+$/.test(fileId)) throw new TypeError(`documents[${index}].file_id must be an integer identifier`);
    if (!Number.isSafeInteger(doc.class_id)) throw new TypeError(`documents[${index}].class_id must be a safe integer`);
    const explicitType = optionalString(doc.type, `documents[${index}].type`);
    const known = doc.class_id === 1 ? 'GameObject' : doc.class_id === 4 ? 'Transform' : doc.class_id === 114 ? 'MonoBehaviour' : null;
    const id = `unity:object:${fileId}`;
    nodes.push({ id, kind: 'unity-serialized-object', name: optionalString(doc.name, `documents[${index}].name`), type: explicitType ?? known, class_id: doc.class_id, file_id: fileId, source: source('unity', 'documents', fileId) });
    if (doc.game_object_file_id != null) {
      const target = String(doc.game_object_file_id);
      if (!/^-?[0-9]+$/.test(target)) throw new TypeError('game_object_file_id must be an integer identifier');
      if (target !== '0') {
        relations.push({ id: `unity:game-object:${fileId}`, kind: 'component-of', from: id, to: `unity:object:${target}`, source: source('unity', 'documents.game_object_file_id', fileId) });
      }
    }
    if (doc.parent_file_id != null) {
      const target = String(doc.parent_file_id);
      if (!/^-?[0-9]+$/.test(target)) throw new TypeError('parent_file_id must be an integer identifier');
      if (target !== '0') {
        relations.push({ id: `unity:parent:${fileId}`, kind: 'declared-parent', from: id, to: `unity:object:${target}`, source: source('unity', 'documents.parent_file_id', fileId) });
      }
    }
    for (const [refIndex, ref] of array(doc.references ?? [], `documents[${index}].references`).entries()) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new TypeError('reference must be an object');
      assertOnlyKeys(ref, ['file_id', 'guid'], 'reference');
      const targetFile = String(ref.file_id ?? '');
      if (!/^-?[0-9]+$/.test(targetFile)) throw new TypeError('reference.file_id must be an integer identifier');
      const guid = optionalString(ref.guid, 'reference.guid');
      if (targetFile !== '0' || guid !== null) {
        relations.push({ id: `unity:reference:${fileId}:${refIndex}`, kind: 'serialized-reference', from: id, target_file_id: targetFile, target_guid: guid, source: source('unity', 'documents.references', `${fileId}:${refIndex}`) });
      }
    }
  }
  return { nodes, relations, declarations };
}

function godot(payload) {
  assertOnlyKeys(payload, ['schema', 'scenes'], 'Godot payload');
  const nodes = [];
  const relations = [];
  const declarations = { replication: [], rpc: [], signals: [] };
  for (const [sceneIndex, scene] of array(payload.scenes, 'scenes').entries()) {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new TypeError(`scenes[${sceneIndex}] must be an object`);
    assertOnlyKeys(scene, ['path', 'nodes', 'resources', 'signal_connections'], `scenes[${sceneIndex}]`);
    const scenePath = requireString(scene.path, `scenes[${sceneIndex}].path`);
    const sceneId = `godot:scene:${scenePath}`;
    nodes.push({ id: sceneId, kind: 'godot-scene', name: scenePath, type: 'PackedScene', source: source('godot', 'scenes', scenePath) });
    for (const node of array(scene.nodes ?? [], `scenes[${sceneIndex}].nodes`)) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError('node must be an object');
      assertOnlyKeys(node, ['path', 'name', 'type', 'parent_path', 'script'], 'node');
      const nodePath = requireString(node.path, 'node.path');
      const id = `godot:node:${scenePath}:${nodePath}`;
      nodes.push({ id, kind: 'godot-node', name: requireString(node.name, 'node.name'), type: requireString(node.type, 'node.type'), source: source('godot', 'scenes.nodes', `${scenePath}:${nodePath}`) });
      relations.push({ id: `godot:scene-member:${scenePath}:${nodePath}`, kind: 'scene-member', from: sceneId, to: id, source: source('godot', 'scenes.nodes', `${scenePath}:${nodePath}`) });
      if (node.parent_path != null) {
        const parentPath = requireString(node.parent_path, 'node.parent_path');
        relations.push({ id: `godot:parent:${scenePath}:${nodePath}`, kind: 'declared-parent', from: id, to: `godot:node:${scenePath}:${parentPath}`, source: source('godot', 'scenes.nodes.parent_path', `${scenePath}:${nodePath}`) });
      }
      if (node.script != null) {
        relations.push({ id: `godot:script:${scenePath}:${nodePath}`, kind: 'script-reference', from: id, target_uri: requireString(node.script, 'node.script'), source: source('godot', 'scenes.nodes.script', `${scenePath}:${nodePath}`) });
      }
    }
    for (const resource of array(scene.resources ?? [], `scenes[${sceneIndex}].resources`)) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new TypeError('resource must be an object');
      assertOnlyKeys(resource, ['id', 'path', 'type'], 'resource');
      const rid = requireString(resource.id, 'resource.id');
      nodes.push({ id: `godot:resource:${scenePath}:${rid}`, kind: 'godot-resource', name: optionalString(resource.path, 'resource.path') ?? rid, type: optionalString(resource.type, 'resource.type'), source: source('godot', 'scenes.resources', `${scenePath}:${rid}`) });
    }
    for (const [connectionIndex, connection] of array(scene.signal_connections ?? [], `scenes[${sceneIndex}].signal_connections`).entries()) {
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new TypeError('signal connection must be an object');
      assertOnlyKeys(connection, ['signal', 'from', 'to', 'method'], 'signal connection');
      declarations.signals.push({
        id: `godot:signal:${scenePath}:${connectionIndex}`,
        scene: sceneId,
        signal: requireString(connection.signal, 'signal'),
        from: requireString(connection.from, 'signal.from'),
        to: requireString(connection.to, 'signal.to'),
        method: requireString(connection.method, 'signal.method'),
        evidence: 'declared-connection',
      });
    }
  }
  return { nodes, relations, declarations };
}

export function normalizeNativeStructureExport(sourceBytes, envelope) {
  const raw = toBytes(sourceBytes);
  const envelopeCheck = verifyNativeExportEnvelope(envelope, { sourceBytes: raw });
  if (!envelopeCheck.valid) throw new Error(`native export envelope invalid: ${envelopeCheck.errors.join(', ')}`);
  const payload = parseJson(raw);
  const expected = PROFILE_SCHEMAS[envelope.engine];
  if (payload.schema !== expected) throw new Error(`native structure schema mismatch: expected ${expected}, got ${String(payload.schema)}`);

  const normalized = envelope.engine === 'unreal' ? unreal(payload) : envelope.engine === 'unity' ? unity(payload) : godot(payload);
  return {
    schema: NATIVE_STRUCTURE_SCHEMA,
    normalizer_revision: NATIVE_STRUCTURE_REVISION,
    status: 'declared-structure-only',
    engine: envelope.engine,
    evidence_class: envelope.evidence_class,
    source_artifact: { ...envelope.artifact },
    producer: { ...envelope.producer },
    nodes: sortedUnique(normalized.nodes, (item) => item.id, 'native node id'),
    relations: sortedUnique(normalized.relations, (item) => item.id, 'native relation id'),
    declarations: {
      replication: sortedUnique(normalized.declarations.replication, (item) => item.id, 'replication declaration id'),
      rpc: sortedUnique(normalized.declarations.rpc, (item) => item.id, 'rpc declaration id'),
      signals: sortedUnique(normalized.declarations.signals, (item) => item.id, 'signal declaration id'),
    },
    claims: {
      source_structure_verified: false,
      runtime_behavior_verified: false,
      causal_edges_verified: false,
      state_transitions_verified: false,
    },
  };
}

export function verifyNativeStructureInvariants(value) {
  const errors = [];
  if (value?.schema !== NATIVE_STRUCTURE_SCHEMA) errors.push('schema');
  if (value?.status !== 'declared-structure-only') errors.push('status');
  for (const key of ['source_structure_verified', 'runtime_behavior_verified', 'causal_edges_verified', 'state_transitions_verified']) {
    if (value?.claims?.[key] !== false) errors.push(`claims.${key}`);
  }
  const nodeIds = (value?.nodes ?? []).map((item) => item.id);
  if (nodeIds.length !== new Set(nodeIds).size) errors.push('nodes.duplicate-id');
  const relationIds = (value?.relations ?? []).map((item) => item.id);
  if (relationIds.length !== new Set(relationIds).size) errors.push('relations.duplicate-id');
  return { valid: errors.length === 0, errors };
}
