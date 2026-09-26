import {
  createNativeExportEnvelope,
  createNativeSourceRef,
} from './native-export-envelope.mjs';

export const NATIVE_SOURCE_EXPORTER_REVISION = 1;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('native source bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function decode(raw, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

function portablePath(value, extensions, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty path`);
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new TypeError(`${label} must be a repo-relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
  if (!extensions.some((ext) => value.endsWith(ext))) {
    throw new TypeError(`${label} must end in ${extensions.join(' or ')}`);
  }
  return value;
}

function bounded(raw, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  if (raw.byteLength > maxBytes) throw new RangeError(`native source exceeds byte budget: ${raw.byteLength} > ${maxBytes}`);
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function producer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('producer is required');
  return value;
}

function inlineUnityRef(text) {
  const match = text.match(/\{\s*fileID:\s*(-?\d+)(?:\s*,\s*guid:\s*([0-9a-fA-F]+))?(?:\s*,\s*type:\s*\d+)?\s*\}/);
  if (!match) return null;
  const ref = { file_id: match[1] };
  if (match[2]) ref.guid = match[2].toLowerCase();
  return ref;
}

function unityTypeName(classId) {
  if (classId === 1) return 'GameObject';
  if (classId === 4) return 'Transform';
  if (classId === 114) return 'MonoBehaviour';
  return null;
}

export function parseUnityTextScene(sourceBytes, { path, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const raw = toBytes(sourceBytes);
  bounded(raw, maxBytes);
  const sourcePath = portablePath(path, ['.unity', '.prefab'], 'Unity source path');
  const text = decode(raw, 'Unity source');
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith('%YAML ')) || !lines.some((line) => line.startsWith('%TAG !u!'))) {
    throw new Error('Unity source must declare YAML and !u! tag headers');
  }

  const documents = [];
  const diagnostics = [];
  let current = null;
  let currentBodyType = null;

  function finish() {
    if (!current) return;
    if (!currentBodyType) throw new Error(`Unity document ${current.file_id} is missing an object body`);
    documents.push(current);
    current = null;
    currentBodyType = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = line.match(/^--- !u!(\d+) &(-?\d+)\s*$/);
    if (header) {
      finish();
      const classId = Number(header[1]);
      if (!Number.isSafeInteger(classId)) throw new Error(`Unity class ID out of range on line ${i + 1}`);
      current = {
        file_id: header[2],
        class_id: classId,
        references: [],
      };
      const known = unityTypeName(classId);
      if (known) current.type = known;
      continue;
    }
    if (!current) continue;

    if (currentBodyType === null) {
      const body = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
      if (!body) {
        if (line.trim() === '') continue;
        throw new Error(`Unity document ${current.file_id} has unsupported body header on line ${i + 1}`);
      }
      currentBodyType = body[1];
      if (!current.type) current.type = currentBodyType;
      continue;
    }

    const name = line.match(/^\s*m_Name:\s*(.*)$/);
    if (name) {
      const value = name[1].trim();
      if (value) current.name = value.replace(/^"(.*)"$/, '$1');
      continue;
    }

    const gameObject = line.match(/^\s*m_GameObject:\s*(.*)$/);
    if (gameObject) {
      const ref = inlineUnityRef(gameObject[1]);
      if (!ref) throw new Error(`Unity m_GameObject reference is unsupported on line ${i + 1}`);
      current.game_object_file_id = ref.file_id;
      continue;
    }

    const father = line.match(/^\s*m_Father:\s*(.*)$/);
    if (father) {
      const ref = inlineUnityRef(father[1]);
      if (!ref) throw new Error(`Unity m_Father reference is unsupported on line ${i + 1}`);
      current.parent_file_id = ref.file_id;
      continue;
    }

    const ref = inlineUnityRef(line);
    if (ref && (ref.guid || ref.file_id !== '0')) {
      current.references.push(ref);
      continue;
    }

    if (line.trim() && !line.trimStart().startsWith('#')) diagnostics.push({
      line: i + 1,
      code: 'UNITY_UNMODELED_LINE',
    });
  }
  finish();

  const ids = documents.map((doc) => String(doc.file_id));
  if (ids.length !== new Set(ids).size) throw new Error('Unity source contains duplicate document file IDs');

  return {
    payload: {
      schema: 'sbf.game-unity-serialized-export/draft-1',
      documents,
    },
    diagnostics,
    source_ref: createNativeSourceRef(raw, {
      path: sourcePath,
      role: 'active',
      mediaType: 'text/yaml',
    }),
  };
}

function parseGodotAttrs(text, label) {
  const attrs = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s\]]+))/g;
  let match;
  let consumed = '';
  while ((match = re.exec(text)) !== null) {
    attrs[match[1]] = match[2] !== undefined ? match[2].replace(/\\"/g, '"') : match[3];
    consumed += match[0];
  }
  const compactInput = text.replace(/\s+/g, '');
  const compactConsumed = consumed.replace(/\s+/g, '');
  if (compactInput !== compactConsumed) throw new Error(`${label} contains unsupported attributes`);
  return attrs;
}

function godotNodePath(name, parent) {
  if (parent == null) return '.';
  if (parent === '.') return name;
  return `${parent}/${name}`;
}

export function parseGodotTextScene(sourceBytes, { path, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const raw = toBytes(sourceBytes);
  bounded(raw, maxBytes);
  const sourcePath = portablePath(path, ['.tscn'], 'Godot scene path');
  const text = decode(raw, 'Godot scene');
  const lines = text.split(/\r?\n/);
  const firstSection = lines.find((line) => line.trim().startsWith('['));
  if (!firstSection || !/^\[gd_scene(?:\s|\])/.test(firstSection.trim())) {
    throw new Error('Godot source must begin with a gd_scene declaration');
  }

  const resources = [];
  const resourcePaths = new Map();
  const nodes = [];
  const signalConnections = [];
  const diagnostics = [];
  let currentNode = null;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith(';')) continue;

    const section = trimmed.match(/^\[([A-Za-z_][A-Za-z0-9_]*)\s*(.*?)\]$/);
    if (section) {
      currentNode = null;
      const kind = section[1];
      const attrs = parseGodotAttrs(section[2], `Godot ${kind} line ${i + 1}`);
      if (kind === 'gd_scene') continue;
      if (kind === 'ext_resource' || kind === 'sub_resource') {
        if (!attrs.id) throw new Error(`Godot ${kind} requires id on line ${i + 1}`);
        const id = `${kind === 'ext_resource' ? 'ext' : 'sub'}:${attrs.id}`;
        const item = { id };
        if (attrs.path) item.path = attrs.path;
        if (attrs.type) item.type = attrs.type;
        resources.push(item);
        if (attrs.path) resourcePaths.set(`${kind === 'ext_resource' ? 'ExtResource' : 'SubResource'}:${attrs.id}`, attrs.path);
        continue;
      }
      if (kind === 'node') {
        if (!attrs.name || !attrs.type) throw new Error(`Godot node requires name and type on line ${i + 1}`);
        const parent = attrs.parent ?? null;
        currentNode = {
          path: godotNodePath(attrs.name, parent),
          name: attrs.name,
          type: attrs.type,
        };
        if (parent !== null) currentNode.parent_path = parent;
        nodes.push(currentNode);
        continue;
      }
      if (kind === 'connection') {
        for (const key of ['signal', 'from', 'to', 'method']) {
          if (!attrs[key]) throw new Error(`Godot connection requires ${key} on line ${i + 1}`);
        }
        signalConnections.push({
          signal: attrs.signal,
          from: attrs.from,
          to: attrs.to,
          method: attrs.method,
        });
        continue;
      }
      diagnostics.push({ line: i + 1, code: 'GODOT_UNMODELED_SECTION', section: kind });
      continue;
    }

    if (currentNode) {
      const script = trimmed.match(/^script\s*=\s*(ExtResource|SubResource)\("([^"]+)"\)$/);
      if (script) {
        const key = `${script[1]}:${script[2]}`;
        currentNode.script = resourcePaths.get(key) ?? `${script[1]}("${script[2]}")`;
        continue;
      }
    }
    diagnostics.push({ line: i + 1, code: 'GODOT_UNMODELED_LINE' });
  }

  const nodePaths = nodes.map((node) => node.path);
  if (nodePaths.length !== new Set(nodePaths).size) throw new Error('Godot source contains duplicate derived node paths');
  const resourceIds = resources.map((resource) => resource.id);
  if (resourceIds.length !== new Set(resourceIds).size) throw new Error('Godot source contains duplicate resource IDs');

  return {
    payload: {
      schema: 'sbf.game-godot-scene-export/draft-1',
      scenes: [{
        path: sourcePath,
        nodes,
        resources,
        signal_connections: signalConnections,
      }],
    },
    diagnostics,
    source_ref: createNativeSourceRef(raw, {
      path: sourcePath,
      role: 'active',
      mediaType: 'text/plain',
    }),
  };
}

function finishSourceExport(parsed, {
  engine,
  engineVersion,
  platform,
  producer: producerMeta,
}) {
  const payloadBytes = jsonBytes(parsed.payload);
  const envelope = createNativeExportEnvelope(payloadBytes, {
    engine,
    evidenceClass: 'source-export',
    engineVersion,
    platform,
    producer: producer(producerMeta),
    sourceInputs: [parsed.source_ref],
  });
  return {
    payload: parsed.payload,
    payload_bytes: payloadBytes,
    source_inputs: [parsed.source_ref],
    diagnostics: parsed.diagnostics,
    envelope,
  };
}

export function buildUnityTextSceneExport(sourceBytes, {
  path,
  engineVersion,
  platform,
  producer: producerMeta,
  maxBytes = MAX_SOURCE_BYTES,
} = {}) {
  return finishSourceExport(parseUnityTextScene(sourceBytes, { path, maxBytes }), {
    engine: 'unity',
    engineVersion,
    platform,
    producer: producerMeta,
  });
}

export function buildGodotTextSceneExport(sourceBytes, {
  path,
  engineVersion,
  platform,
  producer: producerMeta,
  maxBytes = MAX_SOURCE_BYTES,
} = {}) {
  return finishSourceExport(parseGodotTextScene(sourceBytes, { path, maxBytes }), {
    engine: 'godot',
    engineVersion,
    platform,
    producer: producerMeta,
  });
}
