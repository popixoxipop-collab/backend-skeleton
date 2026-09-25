import { createHash } from 'node:crypto';

export const PROTOCOL_CONTRACT_VERSION = '1';
export const PROTOCOL_SCAN_SCHEMA = 'sbf.protocol-scan/1';
export const PROTOCOL_FAMILIES = Object.freeze(['grpc', 'graphql', 'asyncapi', 'websocket']);

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

function stableId(prefix, value) {
  const digest = createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 20);
  return prefix + ':' + digest;
}

function sorted(items) {
  return clone(items ?? []).sort((a, b) =>
    String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
    Number(a.line ?? 0) - Number(b.line ?? 0) ||
    JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))),
  );
}

function addressed(prefix, items) {
  return sorted(items).map((item) => ({ id: stableId(prefix, item), ...item }));
}

function requireFamily(family) {
  if (!PROTOCOL_FAMILIES.includes(family)) {
    throw new Error('unsupported protocol family: ' + JSON.stringify(family));
  }
}

function emptyPlanes() {
  return {
    grpc: { packages: [], services: [], methods: [], messages: [] },
    graphql: { schemas: [], types: [], fields: [], operations: [] },
    asyncapi: { channels: [], operations: [], messages: [] },
    websocket: { connections: [], messages: [] },
  };
}

export function buildProtocolContract({ featureId, featureUid, scan }) {
  if (!scan || scan.schema !== PROTOCOL_SCAN_SCHEMA) {
    throw new Error('buildProtocolContract requires an ' + PROTOCOL_SCAN_SCHEMA + ' document');
  }
  requireFamily(scan.family);
  if (scan.completeness?.status === 'blocked') {
    throw new Error('cannot emit a protocol contract from a blocked protocol scan');
  }

  const planes = emptyPlanes();
  if (scan.family === 'grpc') {
    planes.grpc = {
      packages: addressed('grpc-package', scan.grpc?.packages),
      services: addressed('grpc-service', scan.grpc?.services),
      methods: addressed('grpc-method', scan.grpc?.methods),
      messages: addressed('grpc-message', scan.grpc?.messages),
    };
  } else if (scan.family === 'graphql') {
    planes.graphql = {
      schemas: addressed('graphql-schema', scan.graphql?.schemas),
      types: addressed('graphql-type', scan.graphql?.types),
      fields: addressed('graphql-field', scan.graphql?.fields),
      operations: addressed('graphql-operation', scan.graphql?.operations),
    };
  } else if (scan.family === 'asyncapi') {
    planes.asyncapi = {
      channels: addressed('asyncapi-channel', scan.asyncapi?.channels),
      operations: addressed('asyncapi-operation', scan.asyncapi?.operations),
      messages: addressed('asyncapi-message', scan.asyncapi?.messages),
    };
  } else if (scan.family === 'websocket') {
    planes.websocket = {
      connections: addressed('websocket-connection', scan.websocket?.connections),
      messages: addressed('websocket-message', scan.websocket?.messages),
    };
  }

  return {
    sbf_protocol_contract: PROTOCOL_CONTRACT_VERSION,
    feature_id: featureId,
    feature_uid: featureUid,
    protocol: {
      family: scan.family,
      dialect: scan.dialect ?? null,
    },
    source: {
      adapter: scan.adapter,
      adapter_revision: scan.adapter_revision,
      source_hash: scan.source_hash,
      source_hash_basis: scan.source_hash_basis ?? 'raw-bytes',
      files: [...(scan.files_read ?? [])].sort(),
    },
    planes,
    warnings: clone(scan.warnings ?? []),
    completeness: clone(scan.completeness ?? {}),
  };
}

export function protocolContractDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function verifyProtocolContractSnapshot({ contract, scan, featureId, featureUid }) {
  const changes = [];
  if (contract?.sbf_protocol_contract !== PROTOCOL_CONTRACT_VERSION) {
    changes.push({ field: 'sbf_protocol_contract', expected: PROTOCOL_CONTRACT_VERSION, actual: contract?.sbf_protocol_contract ?? null });
  }
  if (contract?.feature_id !== featureId) {
    changes.push({ field: 'feature_id', expected: featureId, actual: contract?.feature_id ?? null });
  }
  if (contract?.feature_uid !== featureUid) {
    changes.push({ field: 'feature_uid', expected: featureUid, actual: contract?.feature_uid ?? null });
  }
  if (contract?.protocol?.family !== scan?.family) {
    changes.push({ field: 'protocol.family', expected: scan?.family ?? null, actual: contract?.protocol?.family ?? null });
  }
  if (contract?.source?.adapter !== scan?.adapter) {
    changes.push({ field: 'source.adapter', expected: scan?.adapter ?? null, actual: contract?.source?.adapter ?? null });
  }
  if (contract?.source?.adapter_revision !== scan?.adapter_revision) {
    changes.push({ field: 'source.adapter_revision', expected: scan?.adapter_revision ?? null, actual: contract?.source?.adapter_revision ?? null });
  }
  if (contract?.source?.source_hash !== scan?.source_hash) {
    changes.push({ field: 'source.source_hash', expected: scan?.source_hash ?? null, actual: contract?.source?.source_hash ?? null });
  }
  const expectedHashBasis = scan?.source_hash_basis ?? 'raw-bytes';
  if (contract?.source?.source_hash_basis !== expectedHashBasis) {
    changes.push({ field: 'source.source_hash_basis', expected: expectedHashBasis, actual: contract?.source?.source_hash_basis ?? null });
  }
  if (scan?.completeness?.status !== 'blocked') {
    const expected = buildProtocolContract({ featureId, featureUid, scan });
    const expectedDigest = protocolContractDigest(expected);
    const actualDigest = protocolContractDigest(contract);
    if (expectedDigest !== actualDigest) {
      changes.push({ field: 'contract_digest', expected: expectedDigest, actual: actualDigest });
    }
  }
  return {
    current: changes.length === 0,
    changes,
    source_hash: scan?.source_hash ?? null,
    adapter_revision: scan?.adapter_revision ?? null,
  };
}
