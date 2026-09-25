import { createHash } from 'node:crypto';

export const GAME_GRAPH_DRAFT_SCHEMA = 'sbf.game-graph-draft/1';
export const LEGACY_WEBGAME_BRIDGE_REVISION = 2;
export const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex').slice(0, 20);
}

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('webgame contract bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function decodeJson(raw) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('webgame contract bytes must be valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('webgame contract bytes must contain valid JSON');
  }
}

function createSourceArtifactRef(raw) {
  return {
    artifact_ref: ARTIFACT_REF_VERSION,
    family: 'webgame-contract',
    version: '1',
    media_type: 'application/json',
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  };
}

function assertLegacyContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('game-next bridge requires an object contract');
  }
  if (contract.sbf_webgame_contract !== '1') {
    throw new Error('game-next bridge requires sbf.webgame-contract/1');
  }
  if (!contract.source || !contract.planes) {
    throw new Error('game-next bridge requires source and planes');
  }
}

function withoutId(item) {
  const copy = clone(item);
  delete copy.id;
  return copy;
}

function addressedNode(category, sourcePlane, item) {
  if (!item?.id) throw new Error(`missing legacy item id in ${sourcePlane}`);
  return {
    id: `legacy:${category}:${item.id}`,
    category,
    source: {
      family: 'sbf.webgame-contract',
      version: '1',
      plane: sourcePlane,
      item_id: item.id,
    },
    observed: withoutId(item),
  };
}

function physicsNode(item) {
  const observed = clone(item);
  return {
    id: `legacy:physics:${stableDigest(observed)}`,
    category: 'physics',
    source: {
      family: 'sbf.webgame-contract',
      version: '1',
      plane: 'simulation.physics',
      item_id: null,
    },
    observed,
  };
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

function hierarchyRelation(item) {
  if (!item?.id) throw new Error('missing legacy item id in scene.hierarchy');
  return {
    id: `legacy:relation:${item.id}`,
    kind: 'hierarchy-symbolic',
    source: {
      family: 'sbf.webgame-contract',
      version: '1',
      plane: 'scene.hierarchy',
      item_id: item.id,
    },
    parent_symbol: item.parent ?? null,
    child_symbol: item.child ?? null,
    observed: withoutId(item),
  };
}

export function bridgeLegacyWebgameContract(sourceBytes) {
  const raw = toBytes(sourceBytes);
  const contract = decodeJson(raw);
  assertLegacyContract(contract);
  const artifact = createSourceArtifactRef(raw);

  const p = contract.planes;
  const groups = [
    ['scene', 'scene.scenes', p.scene?.scenes ?? []],
    ['entity', 'entity.entities', p.entity?.entities ?? []],
    ['input', 'input.listeners', p.input?.listeners ?? []],
    ['input', 'input.keys', p.input?.keys ?? []],
    ['system', 'simulation.systems', p.simulation?.systems ?? []],
    ['loop', 'simulation.loops', p.simulation?.loops ?? []],
    ['renderer', 'render.renderers', p.render?.renderers ?? []],
    ['network', 'network.sockets', p.network?.sockets ?? []],
    ['asset', 'asset.assets', p.asset?.assets ?? []],
  ];

  const nodes = groups.flatMap(([category, plane, items]) =>
    items.map((item) => addressedNode(category, plane, item)));
  nodes.push(...(p.simulation?.physics ?? []).map(physicsNode));

  const relations = (p.scene?.hierarchy ?? []).map(hierarchyRelation);
  const uniqueNodes = sortedUnique(nodes, (item) => item.id, 'game-next node id');
  const uniqueRelations = sortedUnique(relations, (item) => item.id, 'game-next relation id');
  const warningCodes = new Set((contract.warnings ?? []).map((warning) => warning?.code));

  return {
    schema: GAME_GRAPH_DRAFT_SCHEMA,
    bridge_revision: LEGACY_WEBGAME_BRIDGE_REVISION,
    status: 'derived-static-only',
    source_contract: {
      artifact,
      family: 'sbf.webgame-contract',
      version: contract.sbf_webgame_contract,
      feature_id: contract.feature_id,
      feature_uid: contract.feature_uid,
      adapter: contract.source.adapter,
      adapter_revision: contract.source.adapter_revision,
      source_hash: contract.source.source_hash,
      engines: [...(contract.source.engines ?? [])].sort(),
      engine_packages: clone(contract.source.engine_packages ?? [])
        .sort((a, b) => `${a.project_root}:${a.package}:${a.version}`.localeCompare(`${b.project_root}:${b.package}:${b.version}`)),
      project_roots: [...(contract.source.project_roots ?? [])].sort(),
      files: [...(contract.source.files ?? [])].sort(),
    },
    nodes: uniqueNodes,
    relations: uniqueRelations,
    behavior: {
      causal_edges: [],
      transitions: [],
    },
    gaps: {
      input_effects_unresolved: warningCodes.has('WEBGAME_INPUT_EFFECT_UNRESOLVED'),
      runtime_state_unresolved: true,
      dynamic_scene_hierarchy_unresolved: true,
      notes: [
        'legacy behavior.trigger/system projections are not converted into causal edges',
        'runtime state and engine-only values require an approved runtime/exporter evidence path',
      ],
    },
    warnings: clone(contract.warnings ?? []),
    completeness: clone(contract.completeness ?? null),
  };
}

function artifactRefMatchesBytes(ref, sourceBytes) {
  if (
    !ref ||
    ref.artifact_ref !== ARTIFACT_REF_VERSION ||
    ref.family !== 'webgame-contract' ||
    ref.version !== '1' ||
    ref.media_type !== 'application/json' ||
    !Number.isSafeInteger(ref.size_bytes) ||
    ref.size_bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(ref.byte_sha256 ?? '')
  ) return false;
  const raw = toBytes(sourceBytes);
  return raw.byteLength === ref.size_bytes &&
    createHash('sha256').update(raw).digest('hex') === ref.byte_sha256;
}

export function verifyLegacyBridgeInvariants(graph, { sourceBytes } = {}) {
  const errors = [];
  if (graph?.schema !== GAME_GRAPH_DRAFT_SCHEMA) errors.push('schema');
  if (graph?.status !== 'derived-static-only') errors.push('status');
  if (!Array.isArray(graph?.behavior?.causal_edges) || graph.behavior.causal_edges.length !== 0) {
    errors.push('behavior.causal_edges');
  }
  if (!Array.isArray(graph?.behavior?.transitions) || graph.behavior.transitions.length !== 0) {
    errors.push('behavior.transitions');
  }

  const artifact = graph?.source_contract?.artifact;
  if (
    !artifact ||
    artifact.artifact_ref !== ARTIFACT_REF_VERSION ||
    artifact.family !== 'webgame-contract' ||
    artifact.version !== '1' ||
    artifact.media_type !== 'application/json' ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    artifact.size_bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.byte_sha256 ?? '')
  ) {
    errors.push('source_contract.artifact');
  }
  if (sourceBytes !== undefined && !artifactRefMatchesBytes(artifact, sourceBytes)) {
    errors.push('source_contract.artifact-bytes');
  }

  const nodeIds = (graph?.nodes ?? []).map((item) => item.id);
  if (nodeIds.length !== new Set(nodeIds).size) errors.push('nodes.duplicate-id');
  const relationIds = (graph?.relations ?? []).map((item) => item.id);
  if (relationIds.length !== new Set(relationIds).size) errors.push('relations.duplicate-id');

  for (const relation of graph?.relations ?? []) {
    if (relation.kind !== 'hierarchy-symbolic') errors.push(`relations.unsupported-kind:${relation.kind}`);
    if (relation.source?.plane !== 'scene.hierarchy') errors.push(`relations.untrusted-source:${relation.id}`);
  }
  return { valid: errors.length === 0, errors };
}
