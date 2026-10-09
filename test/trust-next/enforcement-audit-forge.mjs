import { createHash } from 'node:crypto';
import { PERMISSION_MANIFEST_DIGEST_FORMAT } from '../../lib/trust-next/permission-manifest.mjs';
import { ENFORCEMENT_AUDIT_CONTRACT } from '../../lib/trust-next/enforcement-gate.mjs';

// Test-support for the audit tests: an independent re-implementation of the audit chain, so the gate's hashes are
// recomputed rather than trusted, and a re-chain function that makes an edited log hash-consistent again. A log
// that went through rechain() can only be rejected by the content checks of verifyAuditLog().

export const canon = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
};

export const sha = (text) => createHash('sha256').update(text).digest('hex');

export const genesis = (digest) => sha(`${ENFORCEMENT_AUDIT_CONTRACT}\n${PERMISSION_MANIFEST_DIGEST_FORMAT}\n${digest}`);

export function rechain(entries, digest) {
  let prev = genesis(digest);
  return entries.map((entry, seq) => {
    const body = { ...entry, seq, prev_sha256: prev };
    delete body.sha256;
    const out = { ...body, sha256: sha(canon(body)) };
    prev = out.sha256;
    return out;
  });
}
