import { createHash } from 'node:crypto';
// Converts a source-backed webgame scan into an immutable, deterministic contract artifact.
// This is intentionally separate from feature-contract.schema.json: HTTP API completeness and
// game-runtime completeness are different truth domains and must not silently satisfy each other.
export const WEBGAME_CONTRACT_VERSION = '1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stableItemId(plane, item) {
  const digest = createHash('sha256').update(JSON.stringify(canonical(item))).digest('hex').slice(0, 20);
  return plane + ':' + digest;
}

function addressed(plane, items) {
  return sortByLocation(items).map((item) => ({ id: stableItemId(plane, item), ...item }));
}

function sortByLocation(items) {
  return clone(items).sort((a, b) =>
    String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
    Number(a.line ?? 0) - Number(b.line ?? 0) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

export function buildWebgameContract({ featureId, featureUid, scan }) {
  if (!scan || scan.schema !== 'sbf.webgame-scan/1') throw new Error('buildWebgameContract requires an sbf.webgame-scan/1 document');
  if (scan.completeness?.status === 'blocked') throw new Error('cannot emit a webgame contract: no supported webgame engine was detected');

  return {
    sbf_webgame_contract: WEBGAME_CONTRACT_VERSION,
    feature_id: featureId,
    feature_uid: featureUid,
    source: {
      adapter: scan.adapter,
      engines: [...scan.engines].sort(),
      engine_packages: clone(scan.engine_packages).sort((a, b) =>
        (a.project_root + ':' + a.package).localeCompare(b.project_root + ':' + b.package)),
      project_roots: [...scan.project_roots].sort(),
      source_hash: scan.source_hash,
      files: [...scan.files_read].sort(),
    },
    planes: {
      scene: {
        scenes: addressed('scene', scan.scenes),
        hierarchy: addressed('scene-edge', scan.hierarchy),
      },
      entity: {
        entities: addressed('entity', scan.entities),
      },
      input: {
        listeners: addressed('input-listener', scan.input.listeners),
        keys: addressed('input-key', scan.input.keys),
      },
      simulation: {
        systems: addressed('simulation-system', scan.simulation.systems),
        loops: addressed('simulation-loop', scan.simulation.loops),
        physics: clone(scan.simulation.physics).sort((a, b) =>
          (a.project_root + ':' + a.package).localeCompare(b.project_root + ':' + b.package)),
      },
      render: {
        renderers: addressed('render', scan.render.renderers),
      },
      network: {
        sockets: addressed('network', scan.network.sockets),
      },
      asset: {
        assets: addressed('asset', scan.assets),
      },
      behavior: {
        triggers: addressed('behavior-trigger', [
          ...scan.input.listeners.map((x) => ({ kind: 'input-listener', ...x })),
          ...scan.input.keys.map((x) => ({ kind: 'key-check', ...x })),
        ]),
        systems: addressed('behavior-system', scan.simulation.systems),
      },
    },
    warnings: clone(scan.warnings),
    completeness: clone(scan.completeness),
  };
}
