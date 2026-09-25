import { createHash } from 'node:crypto';
import { buildProtocolContract } from '../../adapters/protocol-next/contracts/protocol.mjs';
import { bindProtocolItemRef } from '../../adapters/protocol-next/contracts/protocol-item-ref.mjs';

export function artifactRefForBytes(bytes, {
  family = 'protocol-contract',
  version = '1',
  mediaType = 'application/json',
} = {}) {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return {
    artifact_ref: 'sbf.artifact-ref/1',
    family,
    version,
    media_type: mediaType,
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  };
}

export function protocolContext(scan, {
  featureId = 'protocol-test',
  featureUid = 'uid-protocol-test',
} = {}) {
  const contract = buildProtocolContract({ featureId, featureUid, scan });
  const contractBytes = Buffer.from(JSON.stringify(contract, null, 2) + '\n', 'utf8');
  return {
    contract_ref: artifactRefForBytes(contractBytes),
    contract,
    contract_bytes: contractBytes,
  };
}

export function protocolItem(context, { family, plane, index = 0 }) {
  const item = context.contract?.planes?.[family]?.[plane]?.[index];
  if (!item) throw new Error('test helper could not find protocol item at ' + family + '.' + plane + '[' + index + ']');
  return bindProtocolItemRef({
    contractRef: context.contract_ref,
    contract: context.contract,
    contractBytes: context.contract_bytes,
    family,
    plane,
    itemId: item.id,
  });
}
