import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const OWNER_ID = 261965176;
const APP_ID = 5920902;
const INSTALLATION_ID = 185763944;
const APP_PRINCIPAL = `github:app:${APP_ID}`;
const CONTEXT = 't00-independent-approval/verified';
const API = 'https://api.github.com';
const SHA = /^[a-f0-9]{40}$/;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_BINDING_BYTES = 30_000;
const RECEIPT_LIFETIME_SECONDS = 15 * 60;

function requireIt(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalJson(value) {
  let nodes = 0;
  function sort(item, depth) {
    requireIt(++nodes <= 10_000 && depth <= 15, 'Invalid approval binding structure');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' ||
      Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(child => sort(child, depth + 1));
    requireIt(typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype,
      'Invalid approval binding structure');
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key], depth + 1)]));
  }
  return JSON.stringify(sort(value, 0));
}

function readBinding(binding) {
  const serialized = canonicalJson(binding);
  requireIt(Buffer.byteLength(serialized) <= MAX_BINDING_BYTES, 'Approval binding too large');
  const parsed = JSON.parse(serialized);
  requireIt(parsed?.repository === REPOSITORY && parsed.repositoryId === REPOSITORY_ID &&
    positiveInteger(parsed.number) && positiveInteger(parsed.publisherId) &&
    typeof parsed.track === 'string' && /^T[0-9]{2}$/.test(parsed.track) &&
    typeof parsed.base === 'string' && SHA.test(parsed.base) &&
    typeof parsed.head === 'string' && SHA.test(parsed.head) &&
    typeof parsed.tree === 'string' && SHA.test(parsed.tree) &&
    parsed.base !== parsed.head && Array.isArray(parsed.paths) && parsed.paths.length > 0,
  'Invalid approval binding identity');
  return { serialized, parsed };
}

function checkKeys(appPrivateKey, signingKey, publicKeyDer) {
  try {
    const appKey = appPrivateKey?.type === 'private' ? appPrivateKey : createPrivateKey(appPrivateKey);
    const receiptKey = signingKey?.type === 'private' ? signingKey : createPrivateKey(signingKey);
    const pinned = Buffer.isBuffer(publicKeyDer) ? publicKeyDer : Buffer.from(publicKeyDer, 'base64');
    const receiptPublic = createPublicKey(receiptKey);
    const derived = receiptPublic.export({ type: 'spki', format: 'der' });
    requireIt(appKey.asymmetricKeyType === 'rsa' && appKey.asymmetricKeyDetails.modulusLength >= 2048 &&
      receiptKey.asymmetricKeyType === 'ed25519' && derived.length === pinned.length &&
      timingSafeEqual(derived, pinned), 'Invalid keys');
    return { appKey, receiptKey, receiptPublic };
  } catch {
    throw new Error('Independent approval keys do not match policy');
  }
}

function appJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(APP_ID) }))
    .toString('base64url');
  const data = `${header}.${body}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  requireIt(reader, 'Invalid response');
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireIt(total <= MAX_RESPONSE_BYTES, 'Invalid response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function githubApi(fetchImpl) {
  return async (operation, path, bearer, body, expectedStatus = 200) => {
    const request = {
      redirect: 'error',
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearer}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(body);
    }
    try {
      const response = await fetchImpl(API + path, request);
      requireIt(response.status === expectedStatus && !response.redirected, 'Unexpected response');
      return await readJson(response);
    } catch {
      throw new Error(`GitHub ${operation} could not be verified`);
    }
  };
}

function isTargetRepository(repo) {
  return repo?.id === REPOSITORY_ID && repo.full_name === REPOSITORY;
}

function hasChecksWriteOnly(permissions) {
  return permissions?.checks === 'write' &&
    Object.keys(permissions).every(key => key === 'checks' ||
      (key === 'metadata' && permissions[key] === 'read'));
}

async function installationToken(api, appKey) {
  const jwt = appJwt(appKey);
  const app = await api('App identity', '/app', jwt);
  requireIt(app?.id === APP_ID && app.owner?.id === OWNER_ID &&
    app.owner.login === 'popixoxipop-collab', 'Unexpected independent approval App identity');

  const installationPath = `/app/installations/${INSTALLATION_ID}`;
  const installation = await api('App installation', installationPath, jwt);
  requireIt(installation?.id === INSTALLATION_ID && installation.app_id === APP_ID &&
    installation.repository_selection === 'selected' && installation.suspended_at === null &&
    installation.account?.id === OWNER_ID && installation.account.login === 'popixoxipop-collab' &&
    hasChecksWriteOnly(installation.permissions), 'Unexpected independent approval App installation');
  const auth = await api('installation token', `${installationPath}/access_tokens`, jwt,
    { repository_ids: [REPOSITORY_ID], permissions: { checks: 'write' } }, 201);
  requireIt(typeof auth?.token === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{19,8191}$/.test(auth.token) &&
    Date.parse(auth.expires_at) > Date.now() && auth.repository_selection === 'selected' &&
    hasChecksWriteOnly(auth.permissions),
  'Unexpected independent approval installation token scope');

  const repositories = await api('installation repository scope',
    '/installation/repositories?per_page=2', auth.token);
  requireIt(repositories?.total_count === 1 && repositories.repositories?.length === 1 &&
    isTargetRepository(repositories.repositories[0]), 'Unexpected independent approval repository scope');
  return auth.token;
}

export function createIssuer({ appPrivateKey, signingKey, publicKeyDer, fetchImpl = fetch }) {
  const { appKey, receiptKey, receiptPublic } = checkKeys(appPrivateKey, signingKey, publicKeyDer);
  const api = githubApi(fetchImpl);

  return {
    isCurrentReceipt(check, binding, minimumRemainingSeconds = 0) {
      try {
        const expected = readBinding(binding);
        const data = check?.output?.text;
        if (check?.app?.id !== APP_ID || check.name !== CONTEXT || check.head_sha !== expected.parsed.head ||
            check.status !== 'completed' || check.conclusion !== 'success' ||
            typeof data !== 'string' || Buffer.byteLength(data) > MAX_BINDING_BYTES + 1000 ||
            createHash('sha256').update(data).digest('hex') !== check.external_id) return false;
        const { receipt, signature } = JSON.parse(data);
        const now = Math.floor(Date.now() / 1000);
        const sig = Buffer.from(signature, 'base64');
        return receipt.schema === 't00.independent-approval-receipt/1' && receipt.issuer === APP_PRINCIPAL &&
          receipt.installationId === INSTALLATION_ID && Number.isSafeInteger(receipt.issuedAt) &&
          receipt.issuedAt <= now && receipt.expiresAt === receipt.issuedAt + RECEIPT_LIFETIME_SECONDS &&
          receipt.expiresAt > now + minimumRemainingSeconds &&
          canonicalJson(receipt.binding) === expected.serialized && sig.length === 64 &&
          verify(null, Buffer.from(canonicalJson(receipt)), receiptPublic, sig);
      } catch {
        return false;
      }
    },

    async publish(binding, revalidate) {
      requireIt(typeof revalidate === 'function', 'Approval revalidation callback required');
      const initial = readBinding(binding);
      const token = await installationToken(api, appKey);
      let fresh;
      try {
        fresh = readBinding(await revalidate());
      } catch {
        throw new Error('Approval candidate could not be revalidated');
      }
      requireIt(fresh.serialized === initial.serialized, 'Approval binding changed during validation');

      const issuedAt = Math.floor(Date.now() / 1000);
      const receipt = {
        schema: 't00.independent-approval-receipt/1',
        issuer: APP_PRINCIPAL,
        installationId: INSTALLATION_ID,
        issuedAt,
        expiresAt: issuedAt + RECEIPT_LIFETIME_SECONDS,
        binding: fresh.parsed,
      };
      const receiptBytes = Buffer.from(canonicalJson(receipt));
      const signature = sign(null, receiptBytes, receiptKey);
      requireIt(verify(null, receiptBytes, receiptPublic, signature), 'Approval receipt signature could not be verified');
      const text = canonicalJson({ receipt, signature: signature.toString('base64') });
      const externalId = createHash('sha256').update(text).digest('hex');
      const head = fresh.parsed.head;
      const checkRun = await api('Check Run publication', `/repos/${REPOSITORY}/check-runs`, token, {
        name: CONTEXT,
        head_sha: head,
        status: 'completed',
        conclusion: 'success',
        completed_at: new Date(issuedAt * 1000).toISOString(),
        external_id: externalId,
        output: {
          title: 'Independent T00 path approval',
          summary: `Path ownership verified for exact head ${head} of pull request #${fresh.parsed.number}.`,
          text,
        },
      }, 201);
      requireIt(positiveInteger(checkRun?.id) && checkRun.app?.id === APP_ID &&
        checkRun.head_sha === head && checkRun.external_id === externalId &&
        checkRun.name === CONTEXT && checkRun.status === 'completed' &&
        checkRun.conclusion === 'success' && checkRun.output?.text === text,
      'Unexpected independent approval Check Run result');
      return {
        checkRunId: checkRun.id,
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        head,
        receiptSha256: externalId,
      };
    },
  };
}
