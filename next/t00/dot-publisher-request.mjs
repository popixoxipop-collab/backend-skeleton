import { createPublicKey, verify } from 'node:crypto';

const SCHEMA = 't00.dot-publish/1';
const REPOSITORY_ID = 1334919554;
const INTAKE_NUMBER = 389;
const MAX_VALIDITY_SECONDS = 900;
const SHA = /^[0-9a-f]{40}$/;
const TRACK = /^T[0-9]{2}$/;
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const ENVELOPE = /^T00-DOT-PUBLISH-V1 ([A-Za-z0-9_-]{1,800})\.([A-Za-z0-9_-]{86})$/;

function requireRequest(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function decodeBase64Url(text) {
  const bytes = Buffer.from(text, 'base64url');
  requireRequest(bytes.toString('base64url') === text, 'REQUEST_FORMAT');
  return bytes;
}

function readPublicKey(value) {
  try {
    const der = Buffer.isBuffer(value) ? value : Buffer.from(value, 'base64');
    requireRequest(Buffer.isBuffer(value) || (typeof value === 'string' && der.toString('base64') === value),
      'REQUEST_KEY');
    requireRequest(der.length === 44 && der.subarray(0, ED25519_SPKI_HEADER.length).equals(ED25519_SPKI_HEADER),
      'REQUEST_KEY');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    requireRequest(key.asymmetricKeyType === 'ed25519', 'REQUEST_KEY');
    return key;
  } catch {
    requireRequest(false, 'REQUEST_KEY');
  }
}

export function parseSignedRequest({ body, publicKeyDer, now, intakeNumber = INTAKE_NUMBER }) {
  requireRequest(typeof body === 'string' && body.length <= 1024, 'REQUEST_FORMAT');
  const envelope = ENVELOPE.exec(body);
  requireRequest(envelope?.[0] === body, 'REQUEST_FORMAT');
  const payload = decodeBase64Url(envelope[1]);
  const signature = decodeBase64Url(envelope[2]);

  let fields;
  try {
    fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    requireRequest(false, 'REQUEST_PAYLOAD');
  }
  requireRequest(fields !== null && typeof fields === 'object' && !Array.isArray(fields), 'REQUEST_PAYLOAD');
  const { schema, repositoryId, intake, base, head, tree, track, issuedAt, expiresAt } = fields;
  const request = { schema, repositoryId, intake, base, head, tree, track, issuedAt, expiresAt };
  // Reconstruct the exact wire representation to reject duplicate fields, unknown
  // fields, alternate spellings, other key orders and non-canonical whitespace.
  requireRequest(Object.keys(request).every((key) => Object.hasOwn(fields, key)) &&
    Buffer.from(JSON.stringify(request)).equals(payload), 'REQUEST_PAYLOAD');
  requireRequest(schema === SCHEMA && repositoryId === REPOSITORY_ID && intakeNumber === INTAKE_NUMBER &&
    intake === intakeNumber, 'REQUEST_SCOPE');
  requireRequest([base, head, tree].every((value) => typeof value === 'string' && value.length === 40 && SHA.test(value)) &&
    base !== head && typeof track === 'string' && track.length === 3 && TRACK.test(track), 'REQUEST_PAYLOAD');
  requireRequest(Number.isSafeInteger(now) && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
    issuedAt > 0 && issuedAt <= now && now < expiresAt && expiresAt - issuedAt <= MAX_VALIDITY_SECONDS,
  'REQUEST_TIME');
  requireRequest(signature.length === 64 && verify(null, payload, readPublicKey(publicKeyDer), signature),
    'REQUEST_SIGNATURE');
  return request;
}
