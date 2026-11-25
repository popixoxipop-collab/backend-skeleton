import { createHash, createPublicKey, verify } from 'node:crypto';

const REQUEST_SCHEMA = 't00.met-promotion-request/1';
const ATTESTATION_SCHEMA = 't00.met-product-attestation/1';
const POLICY_SCHEMA = 't00.met-promotion-authority/1';
const taskId = /^T[0-9]{2}-[0-9]{2}$/u;
const oid = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const scopeName = /^[a-z][a-z0-9-]{0,119}$/u;
const targetFields = ['task', 'repository', 'repositoryId', 'scope', 'pr', 'head', 'merge', 'tree'];
const requestFields = ['schema', ...targetFields, 'revision', 'stateSha256', 'auditSha256',
  'attestationSha256', 'issuedAt', 'expiresAt'];
const attestationFields = ['schema', ...targetFields, 'prCiRun', 'mainCiRun', 'reviewEvidenceSha256',
  'independentManifestSha256', 'adjudicationManifestSha256', 'issuedAt', 'expiresAt'];
export const PRODUCT_ATTESTATION_VALIDITY_SECONDS = 86_400;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function orderedBody(value, keys) {
  return Buffer.from(JSON.stringify(Object.fromEntries(keys.map(key => [key, value[key]]))));
}

function keyFromDer(encoded) {
  requireIt(typeof encoded === 'string' && /^[A-Za-z0-9+/]{59}=$/u.test(encoded), 'HOLD_AUTHORITY_KEY');
  const der = Buffer.from(encoded, 'base64');
  requireIt(der.length === 44 && der.toString('base64') === encoded &&
    der.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex')), 'HOLD_AUTHORITY_KEY');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function checkedEnvelope(envelope, keys, publicKey, schema, reason) {
  requireIt(exactKeys(envelope, ['body', 'signature']) && typeof envelope.body === 'string' &&
    /^[A-Za-z0-9_-]{1,4096}$/u.test(envelope.body) && typeof envelope.signature === 'string' &&
    /^[A-Za-z0-9_-]{86}$/u.test(envelope.signature), reason);
  const bytes = Buffer.from(envelope.body, 'base64url');
  const signature = Buffer.from(envelope.signature, 'base64url');
  requireIt(bytes.toString('base64url') === envelope.body && signature.length === 64 &&
    signature.toString('base64url') === envelope.signature && verify(null, bytes, publicKey, signature), reason);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(reason);
  }
  requireIt(exactKeys(value, keys) && value.schema === schema, reason);
  const canonical = orderedBody(value, keys);
  requireIt(bytes.equals(canonical), reason);
  return { value, digest: hash(bytes) };
}

function validateTarget(value) {
  requireIt(typeof value.task === 'string' && taskId.test(value.task) &&
    typeof value.scope === 'string' && scopeName.test(value.scope) &&
    typeof value.repository === 'string' && /^popixoxipop-collab\/[A-Za-z0-9-]{1,80}$/u.test(value.repository) &&
    positiveId(value.repositoryId) && positiveId(value.pr) &&
    [value.head, value.merge, value.tree].every(sha => typeof sha === 'string' && oid.test(sha)) &&
    value.head !== value.merge, 'HOLD_PROMOTION_TARGET');
}

function validWindow(value, now, limit) {
  return positiveId(value.issuedAt) && positiveId(value.expiresAt) &&
    value.issuedAt <= now && value.expiresAt > value.issuedAt &&
    value.expiresAt - value.issuedAt <= limit;
}

function validateAuthority(authority) {
  requireIt(exactKeys(authority, ['schema', 'dotPublicDer', 'productPublicDer', 'scopes']) &&
    authority.schema === POLICY_SCHEMA && authority.dotPublicDer !== authority.productPublicDer &&
    plain(authority.scopes), 'HOLD_PROMOTION_AUTHORITY');
}

function validateStandingScope(authority, target) {
  const scope = Object.hasOwn(authority.scopes, target.task) ? authority.scopes[target.task] : null;
  requireIt(exactKeys(scope, ['repository', 'repositoryId', 'scope']) && target.repository === scope.repository &&
    target.repositoryId === scope.repositoryId && target.scope === scope.scope, 'HOLD_STANDING_PROMOTION_SCOPE');
}

function validateAttestationEvidence(value) {
  requireIt([value.reviewEvidenceSha256, value.independentManifestSha256, value.adjudicationManifestSha256]
    .every(item => typeof item === 'string' && digest.test(item)) &&
    positiveId(value.prCiRun) && positiveId(value.mainCiRun) && value.prCiRun !== value.mainCiRun,
  'HOLD_PROMOTION_EVIDENCE');
}

export function authorizeProductAttestationTarget(authority, target) {
  validateAuthority(authority);
  requireIt(exactKeys(target, targetFields), 'HOLD_PROMOTION_TARGET');
  validateTarget(target);
  validateStandingScope(authority, target);
  keyFromDer(authority.dotPublicDer);
  keyFromDer(authority.productPublicDer);
  return Object.fromEntries(targetFields.map(key => [key, target[key]]));
}

export function encodeProductAttestation(value, now) {
  requireIt(exactKeys(value, attestationFields) && value.schema === ATTESTATION_SCHEMA,
    'HOLD_INDEPENDENT_ATTESTATION');
  validateTarget(value);
  validateAttestationEvidence(value);
  requireIt(positiveId(now) && validWindow(value, now, PRODUCT_ATTESTATION_VALIDITY_SECONDS) &&
    value.expiresAt > now, 'HOLD_PROMOTION_TIME');
  return orderedBody(value, attestationFields);
}

export function prepareDotPromotionRequest({ attestation, stateBytes, authority, now }) {
  validateAuthority(authority);
  requireIt(positiveId(now) && Buffer.isBuffer(stateBytes) && stateBytes.length > 0 && stateBytes.length <= 1024 * 1024,
    'HOLD_DOT_LEDGER_STATE');
  const checked = checkedEnvelope(attestation, attestationFields, keyFromDer(authority.productPublicDer),
    ATTESTATION_SCHEMA, 'HOLD_INDEPENDENT_ATTESTATION');
  const product = checked.value;
  validateTarget(product);
  validateStandingScope(authority, product);
  validateAttestationEvidence(product);
  requireIt(validWindow(product, now, PRODUCT_ATTESTATION_VALIDITY_SECONDS) && product.expiresAt > now + 30,
    'HOLD_PROMOTION_TIME');
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes));
  let revision;
  let stateSha256;
  let auditSha256;
  if (state?.schema === 't00.official-ledger-head/1') {
    requireIt(exactKeys(state, ['schema', 'revision', 'stateSha256', 'auditSha256', 'met', 'total', 'scopes']) &&
      state.total === 291 && Number.isSafeInteger(state.met) && state.met >= 0 && state.met <= state.total &&
      Array.isArray(state.scopes) && state.scopes.length > 0 && state.scopes.length <= state.total &&
      state.scopes.every(row => exactKeys(row, ['task', 'verdict']) && typeof row.task === 'string' && taskId.test(row.task) &&
        ['MET', 'PARTIAL', 'NOT_MET', 'NOT_CHECKED'].includes(row.verdict)) &&
      new Set(state.scopes.map(row => row.task)).size === state.scopes.length, 'HOLD_DOT_LEDGER_STATE');
    const row = state.scopes.find(item => item.task === product.task);
    requireIt(row && ['PARTIAL', 'NOT_MET'].includes(row.verdict), 'HOLD_DOT_LEDGER_STATE_NOT_ELIGIBLE');
    ({ revision, stateSha256, auditSha256 } = state);
  } else {
    requireIt(state?.schema === 't00-progress-state/1' && state.audit_291?.total === 291, 'HOLD_DOT_LEDGER_STATE');
    revision = state.rev;
    stateSha256 = hash(stateBytes);
    auditSha256 = state.basis?.audit_sha256;
  }
  requireIt(positiveId(revision) && [stateSha256, auditSha256].every(value =>
    typeof value === 'string' && digest.test(value)), 'HOLD_DOT_LEDGER_STATE');
  return orderedBody({ schema: REQUEST_SCHEMA, ...Object.fromEntries(targetFields.map(key => [key, product[key]])),
    revision, stateSha256, auditSha256,
    attestationSha256: checked.digest, issuedAt: now, expiresAt: Math.min(now + 900, product.expiresAt) }, requestFields);
}

// Authorization identifies intent and attestation. The official writer separately checks the current
// GitHub evidence and acquires the ledger lock before making the matching one-row transition.
export function verifyPromotionAuthorization({ envelope, authority, now }) {
  requireIt(positiveId(now), 'HOLD_PROMOTION_AUTHORITY');
  validateAuthority(authority);
  requireIt(exactKeys(envelope, ['request', 'attestation']), 'HOLD_PROMOTION_ENVELOPE');
  const request = checkedEnvelope(envelope.request, requestFields, keyFromDer(authority.dotPublicDer),
    REQUEST_SCHEMA, 'HOLD_DOT_INTENT');
  const attestation = checkedEnvelope(envelope.attestation, attestationFields, keyFromDer(authority.productPublicDer),
    ATTESTATION_SCHEMA, 'HOLD_INDEPENDENT_ATTESTATION');
  const req = request.value;
  const att = attestation.value;
  validateTarget(req);
  validateTarget(att);
  validateStandingScope(authority, req);
  requireIt(targetFields.every(key => req[key] === att[key]) && req.attestationSha256 === attestation.digest,
    'HOLD_PROMOTION_BINDING');
  requireIt(validWindow(req, now, 900) && validWindow(att, now, PRODUCT_ATTESTATION_VALIDITY_SECONDS) &&
    req.issuedAt >= att.issuedAt &&
    req.expiresAt <= att.expiresAt, 'HOLD_PROMOTION_TIME');
  validateAttestationEvidence(att);
  requireIt(positiveId(req.revision) && [req.stateSha256, req.auditSha256].every(value =>
    typeof value === 'string' && digest.test(value)), 'HOLD_PROMOTION_EVIDENCE');
  const operationId = 'met:' + hash(JSON.stringify(targetFields.map(key => req[key])));
  return {
    request: req,
    attestation: att,
    fresh: now < req.expiresAt,
    provenance: { operationId, requestSha256: request.digest, attestationSha256: attestation.digest },
  };
}
