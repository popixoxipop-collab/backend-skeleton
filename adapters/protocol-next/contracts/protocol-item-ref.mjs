import { createHash } from 'node:crypto';
import { PROTOCOL_CONTRACT_VERSION, PROTOCOL_FAMILIES } from './protocol.mjs';

export const PROTOCOL_ITEM_REF_VERSION = 'sbf.protocol-item-ref/draft-1';
const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
const SHA256_RE = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;

const PLANES = Object.freeze({
  grpc: new Set(['packages', 'services', 'methods', 'messages']),
  graphql: new Set(['schemas', 'types', 'fields', 'operations']),
  asyncapi: new Set(['channels', 'operations', 'messages']),
  websocket: new Set(['connections', 'messages']),
});

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) throw new TypeError(label + ' must be a plain object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new TypeError(label + ' must contain exactly: ' + expected.join(', '));
  }
}

function toBytes(bytes) {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('contractBytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (plainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function parseExactProtocolContractBytes(ref, bytes) {
  if (!protocolArtifactRefMatchesBytes(ref, bytes)) {
    throw new TypeError('ProtocolItemRef contract bytes do not match ArtifactRef');
  }
  const raw = toBytes(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new TypeError('protocol contract bytes must be valid UTF-8');
  }
  let contract;
  try {
    contract = JSON.parse(text);
  } catch {
    throw new TypeError('protocol contract bytes must contain valid JSON');
  }
  if (!plainObject(contract) || contract.sbf_protocol_contract !== PROTOCOL_CONTRACT_VERSION) {
    throw new TypeError('ProtocolItemRef requires an sbf_protocol_contract/' + PROTOCOL_CONTRACT_VERSION + ' document');
  }
  return contract;
}

function assertContractViewMatchesExactBytes(contract, exactContract) {
  if (!plainObject(contract)) throw new TypeError('protocol contract context view must be a plain object');
  if (JSON.stringify(canonicalJson(contract)) !== JSON.stringify(canonicalJson(exactContract))) {
    throw new TypeError('protocol contract context object does not match exact contract bytes');
  }
}

// Shadow consumer of T01's draft sbf.artifact-ref/1 shape. T01 remains the canonical owner.
export function assertT01ArtifactRefShape(ref) {
  exactKeys(ref, ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'], 'ArtifactRef');
  if (ref.artifact_ref !== ARTIFACT_REF_VERSION) throw new TypeError('unsupported artifact_ref: ' + String(ref.artifact_ref));
  if (typeof ref.family !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(ref.family)) throw new TypeError('ArtifactRef.family is invalid');
  if (typeof ref.version !== 'string' || ref.version.length === 0) throw new TypeError('ArtifactRef.version is invalid');
  if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) throw new TypeError('ArtifactRef.media_type is invalid');
  if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
  if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes must be a non-negative safe integer');
  return ref;
}

export function assertProtocolContractArtifactRef(ref) {
  assertT01ArtifactRefShape(ref);
  if (ref.family !== 'protocol-contract') throw new TypeError('protocol item ref requires ArtifactRef.family=protocol-contract');
  if (ref.version !== PROTOCOL_CONTRACT_VERSION) throw new TypeError('protocol contract ArtifactRef.version mismatch');
  if (ref.media_type !== 'application/json') throw new TypeError('protocol contract ArtifactRef.media_type must be application/json');
  return ref;
}

export function protocolArtifactRefMatchesBytes(ref, bytes) {
  assertProtocolContractArtifactRef(ref);
  const raw = toBytes(bytes);
  const digest = createHash('sha256').update(raw).digest('hex');
  return raw.byteLength === ref.size_bytes && digest === ref.byte_sha256;
}

export function assertProtocolItemRefShape(ref) {
  exactKeys(ref, ['protocol_item_ref', 'contract', 'family', 'plane', 'item_id'], 'ProtocolItemRef');
  if (ref.protocol_item_ref !== PROTOCOL_ITEM_REF_VERSION) throw new TypeError('unsupported protocol_item_ref: ' + String(ref.protocol_item_ref));
  assertProtocolContractArtifactRef(ref.contract);
  if (!PROTOCOL_FAMILIES.includes(ref.family)) throw new TypeError('ProtocolItemRef.family is invalid');
  if (!PLANES[ref.family]?.has(ref.plane)) throw new TypeError('ProtocolItemRef.plane is invalid for family=' + ref.family);
  if (typeof ref.item_id !== 'string' || ref.item_id.length === 0) throw new TypeError('ProtocolItemRef.item_id must be a non-empty string');
  return ref;
}

export function assertProtocolItemRefBound({ reference, contract, contractBytes }) {
  assertProtocolItemRefShape(reference);
  const exactContract = parseExactProtocolContractBytes(reference.contract, contractBytes);
  assertContractViewMatchesExactBytes(contract, exactContract);
  if (exactContract.protocol?.family !== reference.family) {
    throw new TypeError('ProtocolItemRef.family does not match protocol contract family');
  }
  const items = exactContract.planes?.[reference.family]?.[reference.plane];
  if (!Array.isArray(items)) throw new TypeError('ProtocolItemRef plane is absent from protocol contract');
  const item = items.find((candidate) => candidate?.id === reference.item_id);
  if (!item) throw new TypeError('ProtocolItemRef.item_id does not exist in the exact protocol contract');
  return item;
}

export function bindProtocolItemRef({ contractRef, contract, contractBytes, family, plane, itemId }) {
  const reference = {
    protocol_item_ref: PROTOCOL_ITEM_REF_VERSION,
    contract: contractRef,
    family,
    plane,
    item_id: itemId,
  };
  assertProtocolItemRefBound({ reference, contract, contractBytes });
  return reference;
}

export function contractContextKey(ref) {
  assertProtocolContractArtifactRef(ref);
  return ref.byte_sha256 + ':' + ref.size_bytes;
}

export function indexProtocolContractContexts(contexts) {
  const index = new Map();
  for (const context of contexts ?? []) {
    if (!plainObject(context)) throw new TypeError('protocol contract context must be an object');
    const ref = assertProtocolContractArtifactRef(context.contract_ref);
    const key = contractContextKey(ref);
    if (index.has(key)) throw new TypeError('duplicate protocol contract context: ' + key);
    const exactContract = parseExactProtocolContractBytes(ref, context.contract_bytes);
    assertContractViewMatchesExactBytes(context.contract, exactContract);
    index.set(key, context);
  }
  return index;
}

export function assertProtocolItemRefAgainstContexts(reference, contexts) {
  assertProtocolItemRefShape(reference);
  const index = contexts instanceof Map ? contexts : indexProtocolContractContexts(contexts);
  const context = index.get(contractContextKey(reference.contract));
  if (!context) throw new TypeError('ProtocolItemRef contract context is not available');
  return assertProtocolItemRefBound({
    reference,
    contract: context.contract,
    contractBytes: context.contract_bytes,
  });
}
