import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const schema = 't00.dot-transition-permit/1';
const repo = 'popixoxipop-collab/backend-skeleton';
const repositoryId = 1334919554;
const scope = 'historical-installed-package-replay';
const publicDer = Buffer.from('MCowBQYDK2VwAyEARSKqohZkpsVC29H4Sgo9gzvdwh5hzOLqpbT3DcOt/s8=', 'base64');
const publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
const keyPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const o = /^[a-f0-9]{40}$/u;
const d = /^[a-f0-9]{64}$/u;
const id = value => Number.isSafeInteger(value) && value > 0;
const match = (pattern, value) => typeof value === 'string' && pattern.test(value);
const seconds = () => Math.floor(Date.now() / 1000);
const flags = ['strictCurrentBase', 'mainBlocksForcePushes', 'publisherCannotBypassMain', 'publisherOwnsHeadRef',
  'requiredChecksPassed', 'requiredReviewsSatisfied'];

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function canonical(fields, now, allowExpired) {
  const { subject, baseTree, productEvidenceSha256, receiptSha256, productRunId, productAttempt, commentId,
    dotIntentSha256, independentReviewSha256, prCiRunId, policy, verifiedAt, expiresAt } = fields;
  requireIt(subject?.repo === repo && subject.repositoryId === repositoryId && id(subject.pr) && subject.pr !== 389 &&
    subject.task === 'T03-06' && subject.scope === scope &&
    [subject.base, subject.head, subject.tree, baseTree].every(x => match(o, x)) && subject.base !== subject.head,
  'HOLD_TRANSITION_PERMIT_SUBJECT');
  requireIt([productEvidenceSha256, receiptSha256, dotIntentSha256, independentReviewSha256].every(x => match(d, x)) &&
    [productRunId, productAttempt, commentId, prCiRunId].every(id) && prCiRunId !== productRunId,
  'HOLD_TRANSITION_PERMIT_EVIDENCE');
  requireIt([verifiedAt, expiresAt, now].every(id) && verifiedAt <= now && expiresAt > verifiedAt &&
    expiresAt - verifiedAt <= 300 && (allowExpired ? now - verifiedAt <= 86_400 : now < expiresAt),
  'HOLD_TRANSITION_PERMIT_TIME');
  const required = policy?.requiredChecks;
  requireIt(flags.every(flag => policy?.[flag] === true) && Array.isArray(required) && required.length === 17 &&
    required.every(item => typeof item?.context === 'string' && item.context.length > 0 && item.context.length <= 180 &&
      !/[\u0000-\u001f\u007f]/u.test(item.context) && id(item.appId)) &&
    new Set(required.map(check => check.context)).size === required.length, 'HOLD_TRANSITION_PERMIT_POLICY');
  const checks = required.map(({ context, appId }) => ({ context, appId }))
    .sort((a, b) => a.context < b.context ? -1 : a.context > b.context ? 1 : 0);
  const { pr, task, base, head, tree } = subject;
  return { schema, subject: { repo, repositoryId, pr, task, scope, base, head, tree }, baseTree,
    productEvidenceSha256, receiptSha256, productRunId, productAttempt, commentId, dotIntentSha256,
    independentReviewSha256, prCiRunId, policy: {
      strictCurrentBase: true, mainBlocksForcePushes: true, publisherCannotBypassMain: true,
      publisherOwnsHeadRef: true, requiredChecksPassed: true, requiredReviewsSatisfied: true, requiredChecks: checks,
    }, verifiedAt, expiresAt };
}

export function issueTransitionPermit(fields, { privateDerBase64, now = seconds() } = {}) {
  const bytes = Buffer.from(JSON.stringify(canonical(fields, now, false)));
  requireIt(match(/^[A-Za-z0-9+/]{64}$/u, privateDerBase64), 'HOLD_TRANSITION_PERMIT_SIGNER');
  const der = Buffer.from(privateDerBase64, 'base64');
  try {
    requireIt(der.length === 48 && der.subarray(0, keyPrefix.length).equals(keyPrefix), 'HOLD_TRANSITION_PERMIT_SIGNER');
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    requireIt(key.asymmetricKeyType === 'ed25519' &&
      createPublicKey(key).export({ format: 'der', type: 'spki' }).equals(publicDer), 'HOLD_TRANSITION_PERMIT_SIGNER');
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url') };
  } finally {
    der.fill(0);
  }
}

// Recovery and postmerge may authenticate a past permit. Live mutation callers use the default time check.
export function verifyTransitionPermit(envelope, { now = seconds(), allowExpired = false } = {}) {
  requireIt(envelope && Object.keys(envelope).length === 2 && match(/^[A-Za-z0-9_-]{1,6200}$/u, envelope.body) &&
    match(/^[A-Za-z0-9_-]{86}$/u, envelope.signature), 'HOLD_TRANSITION_PERMIT_FORMAT');
  const bytes = Buffer.from(envelope.body, 'base64url');
  const signature = Buffer.from(envelope.signature, 'base64url');
  requireIt(bytes.toString('base64url') === envelope.body && signature.toString('base64url') === envelope.signature &&
    verify(null, bytes, publicKey, signature), 'HOLD_TRANSITION_PERMIT_SIGNATURE');
  const receipt = canonical(JSON.parse(bytes), now, allowExpired === true);
  requireIt(Buffer.from(JSON.stringify(receipt)).equals(bytes), 'HOLD_TRANSITION_PERMIT_FORMAT');
  return receipt;
}
