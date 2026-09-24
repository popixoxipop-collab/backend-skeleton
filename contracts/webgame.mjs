// Converts a source-backed webgame scan into an immutable, deterministic contract artifact.
// This is intentionally separate from feature-contract.schema.json: HTTP API completeness and
// game-runtime completeness are different truth domains and must not silently satisfy each other.
export const WEBGAME_CONTRACT_VERSION = '1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
      project_roots: [...scan.project_roots].sort(),
      source_hash: scan.source_hash,
      files: [...scan.files_read].sort(),
    },
    planes: {
      scene: {
        scenes: sortByLocation(scan.scenes),
        hierarchy: sortByLocation(scan.hierarchy),
      },
      entity: {
        entities: sortByLocation(scan.entities),
      },
      input: {
        listeners: sortByLocation(scan.input.listeners),
        keys: sortByLocation(scan.input.keys),
      },
      simulation: {
        systems: sortByLocation(scan.simulation.systems),
        loops: sortByLocation(scan.simulation.loops),
        physics: clone(scan.simulation.physics).sort((a, b) =>
          (a.project_root + ':' + a.package).localeCompare(b.project_root + ':' + b.package)),
      },
      render: {
        renderers: sortByLocation(scan.render.renderers),
      },
      network: {
        sockets: sortByLocation(scan.network.sockets),
      },
      asset: {
        assets: sortByLocation(scan.assets),
      },
      behavior: {
        triggers: sortByLocation([
          ...scan.input.listeners.map((x) => ({ kind: 'input-listener', ...x })),
          ...scan.input.keys.map((x) => ({ kind: 'key-check', ...x })),
        ]),
        systems: sortByLocation(scan.simulation.systems),
      },
    },
    warnings: clone(scan.warnings),
    completeness: clone(scan.completeness),
  };
}
