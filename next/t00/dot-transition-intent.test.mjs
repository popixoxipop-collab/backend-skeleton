import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { DOT_TRANSITION_PREFIX, DOT_TRANSITION_SCHEMA, encodeDotTransitionIntent,
  verifyDotTransitionIntent } from './dot-transition-intent.mjs';

const NOW = 1_795_622_400;
const REPO = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const INTAKE = 389;
const SCOPE = 'historical-installed-package-replay';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function fields(changes = {}) {
  return { schema: DOT_TRANSITION_SCHEMA, repo: REPO, repositoryId: REPOSITORY_ID, intake: INTAKE,
    pr: 395, task: 'T03-06', scope: SCOPE, base: 'a'.repeat(40), head: 'b'.repeat(40),
    tree: 'c'.repeat(40), issuedAt: NOW - 4, expiresAt: NOW + 200, ...changes };
}

function frame(payload, prefix = DOT_TRANSITION_PREFIX) {
  const bytes = Buffer.from(payload);
  return `${prefix} ${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`;
}

function trustedReply(body = frame(encodeDotTransitionIntent(fields(), NOW))) {
  const time = new Date((NOW - 2) * 1000).toISOString().replace('.000Z', 'Z');
  return { repository: REPO, repositoryId: REPOSITORY_ID, intake: INTAKE, publicKeyDer, now: NOW,
    comment: { id: 21192, body, user: { id: 261965176 }, created_at: time, updated_at: time,
      issue_url: `https://api.github.com/repos/${REPO}/issues/${INTAKE}` } };
}

function checkSignedFields(changes) {
  return verifyDotTransitionIntent(trustedReply(frame(JSON.stringify(fields(changes)))));
}

test('encodes one canonical wire order and reads the exact signed target from scoped ingress', () => {
  const intent = fields();
  const bytes = encodeDotTransitionIntent(Object.fromEntries(Object.entries(intent).reverse()), NOW);
  assert.equal(bytes.toString(), JSON.stringify(intent));
  const result = verifyDotTransitionIntent(trustedReply(frame(bytes)));
  assert.deepEqual(result.subject, { repo: REPO, repositoryId: REPOSITORY_ID, pr: 395, task: 'T03-06',
    scope: SCOPE, base: intent.base, head: intent.head, tree: intent.tree });
  assert.equal(result.issuedAt, intent.issuedAt);
  assert.equal(result.expiresAt, intent.expiresAt);
  assert.equal(result.dotIntentSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.subject) && Object.isFrozen(result.stageKeys));
});

test('separates ready and merge while deduplicating refreshed signatures and reposted comments', () => {
  const original = verifyDotTransitionIntent(trustedReply());
  const next = trustedReply(frame(encodeDotTransitionIntent(fields({ issuedAt: NOW - 3, expiresAt: NOW + 300 }), NOW)));
  next.comment.id += 1;
  const refreshed = verifyDotTransitionIntent(next);
  assert.notEqual(original.commentId, refreshed.commentId);
  assert.notEqual(original.dotIntentSha256, refreshed.dotIntentSha256);
  assert.notEqual(original.stageKeys.ready, original.stageKeys.merge);
  assert.deepEqual(original.stageKeys, refreshed.stageKeys);
  const changed = verifyDotTransitionIntent(trustedReply(frame(encodeDotTransitionIntent(fields({ head: 'd'.repeat(40) }), NOW))));
  assert.notEqual(changed.stageKeys.merge, original.stageKeys.merge);
});

test('rejects publisher request framing and purpose even with an enrolled signature', () => {
  assert.throws(() => verifyDotTransitionIntent(trustedReply(frame(JSON.stringify(fields()), 'T00-DOT-PUBLISH-V1'))),
    { code: 'HOLD_DOT_TRANSITION_FORMAT' });
  assert.throws(() => checkSignedFields({ schema: 't00.dot-publish/1' }),
    { code: 'HOLD_DOT_TRANSITION_SCOPE' });
});

test('rejects noncanonical JSON including duplicates, alternate order, unknown fields and spacing', () => {
  const intent = fields();
  for (const invalid of [JSON.stringify(intent, null, 1), JSON.stringify({ ...intent, extra: true }),
    JSON.stringify(Object.fromEntries(Object.entries(intent).reverse())), `{"pr":395,${JSON.stringify(intent).slice(1)}`]) {
    assert.throws(() => verifyDotTransitionIntent(trustedReply(frame(invalid))), { code: 'HOLD_DOT_TRANSITION_PAYLOAD' });
  }
});

test('rejects a valid signature by any other key and rejects changes to signed fields', () => {
  const reply = trustedReply();
  assert.throws(() => verifyDotTransitionIntent({ ...reply, publicKeyDer: undefined }),
    { code: 'HOLD_DOT_TRANSITION_SIGNATURE' });
  const oldSignature = reply.comment.body.split('.')[1];
  const tampered = encodeDotTransitionIntent(fields({ task: 'T04-06' }), NOW).toString('base64url');
  reply.comment.body = `${DOT_TRANSITION_PREFIX} ${tampered}.${oldSignature}`;
  assert.throws(() => verifyDotTransitionIntent(reply), { code: 'HOLD_DOT_TRANSITION_SIGNATURE' });
  assert.throws(() => verifyDotTransitionIntent({ ...trustedReply(), publicKeyDer: `${publicKeyDer}\n` }),
    { code: 'HOLD_DOT_TRANSITION_KEY' });
});

test('rejects trailing content, padded frames and invalid UTF-8', () => {
  const original = trustedReply().comment.body;
  for (const body of [`${original}\n`, original.replace('.', '=.'), `${original} additional`]) {
    assert.throws(() => verifyDotTransitionIntent(trustedReply(body)), { code: 'HOLD_DOT_TRANSITION_FORMAT' });
  }
  assert.throws(() => verifyDotTransitionIntent(trustedReply(frame(Buffer.from([0xc3, 0x01])))),
    { code: 'HOLD_DOT_TRANSITION_PAYLOAD' });
});

test('requires the exact repo identifiers, intake comment URL and GitHub connector author', () => {
  for (const changed of [{ repository: 'popixoxipop-collab/other' }, { repositoryId: 3334 }, { intake: 1 }]) {
    assert.throws(() => verifyDotTransitionIntent({ ...trustedReply(), ...changed }), { code: 'HOLD_DOT_TRANSITION_COMMENT' });
  }
  for (const changed of [{ user: { id: 5922170 } }, { issue_url: `https://api.github.com/repos/${REPO}/issues/395` },
    { id: -1 }, { updated_at: '2026-11-26T12:00:01Z' }, { created_at: '2026-11-31T12:00:00Z', updated_at: '2026-11-31T12:00:00Z' }]) {
    const reply = trustedReply();
    assert.throws(() => verifyDotTransitionIntent({ ...reply, comment: { ...reply.comment, ...changed } }),
      { code: 'HOLD_DOT_TRANSITION_COMMENT' });
  }
});

test('requires exact signed repo, positive non-intake PR, task, scope, and object identifiers', () => {
  for (const changes of [{ repo: 'popixoxipop-collab/other' }, { pr: 389 }, { repositoryId: 1 }, { intake: 395 }]) {
    assert.throws(() => checkSignedFields(changes),
      { code: 'HOLD_DOT_TRANSITION_SCOPE' });
  }
  for (const changes of [{ task: 'T03' }, { scope: '../../gate' }, { base: 'b'.repeat(40) }, { tree: 'C'.repeat(40) }]) {
    assert.throws(() => checkSignedFields(changes),
      { code: 'HOLD_DOT_TRANSITION_PAYLOAD' });
  }
});

test('closes admission at expiresAt and rejects future, overlong, or post-comment issuance', () => {
  for (const changes of [{ issuedAt: NOW + 1 }, { expiresAt: NOW }, { expiresAt: NOW + 897 }, { issuedAt: NOW - 1 }]) {
    assert.throws(() => checkSignedFields(changes),
      { code: 'HOLD_DOT_TRANSITION_TIME' });
  }
  assert.equal(checkSignedFields({ expiresAt: NOW + 896 }).expiresAt, NOW + 896);
});
