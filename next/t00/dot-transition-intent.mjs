import { createHash, createPublicKey, verify } from 'node:crypto';

export const DOT_TRANSITION_PREFIX = 'T00-DOT-TRANSITION-V1';
export const DOT_TRANSITION_SCHEMA = 't00.dot-ready-merge/1';
const REPO = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const INTAKE = 389;
const CONNECTOR_ACTOR_ID = 261965176;
const INTAKE_ISSUE_URL = `https://api.github.com/repos/${REPO}/issues/${INTAKE}`;
const DOT_NATIVE_PUBLIC_DER = 'MCowBQYDK2VwAyEAS/MHuNBaVdwLobRLZ8sMydOQIsYO3YhzG3+wxyqKmM0=';
const MAX_VALIDITY_SECONDS = 900;
const SHA = /^[0-9a-f]{40}$/u;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ENVELOPE = /^T00-DOT-TRANSITION-V1 ([A-Za-z0-9_-]{1,1200})\.([A-Za-z0-9_-]{86})$/u;

function requireIntent(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalIntent(value, now) {
  requireIntent(value && typeof value === 'object' && !Array.isArray(value), 'HOLD_DOT_TRANSITION_PAYLOAD');
  const { schema, repo, repositoryId, intake, pr, task, scope, base, head, tree, issuedAt, expiresAt } = value;
  requireIntent(schema === DOT_TRANSITION_SCHEMA && repo === REPO && repositoryId === REPOSITORY_ID &&
    intake === INTAKE && positiveId(pr) && pr !== INTAKE, 'HOLD_DOT_TRANSITION_SCOPE');
  requireIntent(typeof task === 'string' && /^T[0-9]{2}-[0-9]{2}$/u.test(task) &&
    typeof scope === 'string' && /^[a-z][a-z0-9-]{0,119}$/u.test(scope) && base !== head &&
    [base, head, tree].every(sha => typeof sha === 'string' && SHA.test(sha)), 'HOLD_DOT_TRANSITION_PAYLOAD');
  requireIntent(positiveId(now) && positiveId(issuedAt) && positiveId(expiresAt) && issuedAt <= now &&
    now < expiresAt && expiresAt - issuedAt <= MAX_VALIDITY_SECONDS, 'HOLD_DOT_TRANSITION_TIME');
  const canonical = { schema, repo, repositoryId, intake, pr, task, scope, base, head, tree, issuedAt, expiresAt };
  requireIntent(Object.keys(value).length === Object.keys(canonical).length && Object.keys(canonical)
    .every(key => Object.hasOwn(value, key)), 'HOLD_DOT_TRANSITION_PAYLOAD');
  return canonical;
}

// Dot can use this canonical encoder before signing inside its native computer.
export function encodeDotTransitionIntent(value, now) {
  return Buffer.from(JSON.stringify(canonicalIntent(value, now)));
}

function decodeSegment(text) {
  const bytes = Buffer.from(text, 'base64url');
  requireIntent(bytes.toString('base64url') === text, 'HOLD_DOT_TRANSITION_FORMAT');
  return bytes;
}

function readPublicKey(value) {
  requireIntent(typeof value === 'string', 'HOLD_DOT_TRANSITION_KEY');
  const der = Buffer.from(value, 'base64');
  requireIntent(der.toString('base64') === value && der.length === 44 &&
    der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX), 'HOLD_DOT_TRANSITION_KEY');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function postedAt(comment) {
  const iso = comment?.created_at;
  requireIntent(typeof iso === 'string' && UTC_SECONDS.test(iso) && comment.updated_at === iso,
    'HOLD_DOT_TRANSITION_COMMENT');
  const milliseconds = Date.parse(iso);
  requireIntent(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === iso.replace(/Z$/u, '.000Z'),
    'HOLD_DOT_TRANSITION_COMMENT');
  return milliseconds / 1000;
}

// Pass comment and repository metadata fetched by the protected verifier from GitHub.
// The configured public key comes from the verifier's own trust policy.
export function verifyDotTransitionIntent({ repository, repositoryId, intake, comment, now,
  publicKeyDer = DOT_NATIVE_PUBLIC_DER }) {
  requireIntent(repository === REPO && repositoryId === REPOSITORY_ID && intake === INTAKE &&
    positiveId(comment?.id) && comment.user?.id === CONNECTOR_ACTOR_ID && comment.issue_url === INTAKE_ISSUE_URL,
  'HOLD_DOT_TRANSITION_COMMENT');
  const timestamp = postedAt(comment);
  const envelope = typeof comment.body === 'string' && comment.body.length <= 1320 ? ENVELOPE.exec(comment.body) : null;
  requireIntent(envelope && envelope[0] === comment.body, 'HOLD_DOT_TRANSITION_FORMAT');
  const payload = decodeSegment(envelope[1]);
  const signature = decodeSegment(envelope[2]);
  let fields;
  try {
    fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw Object.assign(new Error('HOLD_DOT_TRANSITION_PAYLOAD'), { code: 'HOLD_DOT_TRANSITION_PAYLOAD' });
  }
  const intent = canonicalIntent(fields, now);
  requireIntent(Buffer.from(JSON.stringify(intent)).equals(payload), 'HOLD_DOT_TRANSITION_PAYLOAD');
  requireIntent(intent.issuedAt <= timestamp && timestamp <= now, 'HOLD_DOT_TRANSITION_TIME');
  requireIntent(signature.length === 64 && verify(null, payload, readPublicKey(publicKeyDer), signature),
    'HOLD_DOT_TRANSITION_SIGNATURE');
  const { repo, repositoryId: id, pr, task, scope, base, head, tree, issuedAt, expiresAt } = intent;
  const subject = Object.freeze({ repo, repositoryId: id, pr, task, scope, base, head, tree });
  // Refreshed signatures and duplicate comments refer to the same exact per-stage operation.
  const stageKeys = Object.freeze({
    ready: hash(JSON.stringify([DOT_TRANSITION_SCHEMA, 'ready', subject])),
    merge: hash(JSON.stringify([DOT_TRANSITION_SCHEMA, 'merge', subject])),
  });
  return Object.freeze({ subject, issuedAt, expiresAt, commentId: comment.id, dotIntentSha256: hash(payload), stageKeys });
}
