import { createHash, createPublicKey, verify } from 'node:crypto';

const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const APPROVAL_APP_ID = 5920902;
const INSTALLATION_ID = 185763944;
const PUBLISHER_BOT_ID = 361175685;
const SHA = /^[a-f0-9]{40}$/u;
const DURATION = 900;
const approvalKey = createPublicKey({ type: 'spki', format: 'der', key: Buffer.from(
  'MCowBQYDK2VwAyEA70bwiWfdXHwXnRWaauVJFnTMEaz0D86aDZwwmOqZuZw=', 'base64') });
const validId = value => Number.isSafeInteger(value) && value > 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function requireIt(condition, code) {
  if (!condition) throw new Error(code);
}

// Read the Check through the isolated GitHub service and use only paths independently derived
// from the exact candidate tree. A green Check is accepted only with its signed current binding.
export function verifyGitHubPathApproval(check, target, paths, { now = Math.floor(Date.now() / 1000),
  minimumRemainingSeconds = 30 } = {}) {
  requireIt(target?.repo === REPOSITORY && target.repositoryId === REPOSITORY_ID && validId(target.pr) &&
    /^T[0-9]{2}-[0-9]{2}$/u.test(target.task) && [target.base, target.head, target.tree].every(value =>
      typeof value === 'string' && SHA.test(value)) && target.base !== target.head && validId(now) &&
    Number.isSafeInteger(minimumRemainingSeconds) && minimumRemainingSeconds >= 0 && minimumRemainingSeconds < DURATION &&
    Array.isArray(paths) && paths.length > 0 && paths.length <= 1000 && new Set(paths).size === paths.length &&
    paths.every(value => typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_.@+/\-]+$/u.test(value) &&
      value.split('/').every(segment => segment && segment !== '.' && segment !== '..')),
  'HOLD_PATH_APPROVAL_TARGET');
  const data = check?.output?.text;
  requireIt(validId(check?.id) && check.app?.id === APPROVAL_APP_ID && check.name === 't00-independent-approval/verified' &&
    check.head_sha === target.head && check.status === 'completed' && check.conclusion === 'success' &&
    typeof data === 'string' && Buffer.byteLength(data) <= 31_000 && sha256(data) === check.external_id,
  'HOLD_PATH_APPROVAL_CHECK');
  const parsed = JSON.parse(data);
  const issuedAt = parsed?.receipt?.issuedAt;
  const signature = parsed?.signature;
  requireIt(validId(issuedAt) && issuedAt <= now && issuedAt + DURATION > now + minimumRemainingSeconds &&
    Date.parse(check.completed_at) === issuedAt * 1000 && typeof signature === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(signature),
  'HOLD_PATH_APPROVAL_TIME_OR_SIGNATURE');
  const binding = { base: target.base, head: target.head, number: target.pr, paths: [...paths].sort(),
    publisherId: PUBLISHER_BOT_ID, repository: REPOSITORY, repositoryId: REPOSITORY_ID,
    track: target.task.slice(0, 3), tree: target.tree };
  // Match the issuer's alphabetic canonical JSON for this fixed schema.
  const receipt = { binding, expiresAt: issuedAt + DURATION, installationId: INSTALLATION_ID, issuedAt,
    issuer: `github:app:${APPROVAL_APP_ID}`, schema: 't00.independent-approval-receipt/1' };
  const bytes = Buffer.from(signature, 'base64');
  requireIt(JSON.stringify({ receipt, signature }) === data && bytes.length === 64 &&
    bytes.toString('base64') === signature && verify(null, Buffer.from(JSON.stringify(receipt)), approvalKey, bytes),
  'HOLD_PATH_APPROVAL_BINDING');
  return { checkRunId: check.id, independentReviewSha256: check.external_id, issuedAt, expiresAt: receipt.expiresAt };
}
