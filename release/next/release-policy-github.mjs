// Read-only GitHub transport for `release-policy.mjs verify --online`: one GET per pinned CI run, nothing else.
const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REPO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];
const MIN_SECRET_LENGTH = 8;
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'];

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function safeString(value) {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function secretsFromEnv(env) {
  return TOKEN_VARIABLES
    .map((name) => env?.[name])
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim());
}

export function redactSecrets(text, secrets = []) {
  let out = safeString(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('[redacted]');
  }
  return out;
}

// Transport errors may echo request headers; scrub anything shaped like a credential even if it is not the one in use.
function describeFailure(error, secrets) {
  const code = error?.cause?.code ?? error?.code;
  const base = error instanceof Error ? `${error.name}: ${error.message}` : safeString(error);
  return redactSecrets(typeof code === 'string' ? `${base} (${code})` : base, secrets)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .slice(0, 300);
}

const retriable = (status) => status === 429 || (status >= 500 && status <= 599);

// Returns fetchRun({repo, runId}) -> {status, body}. `body` is the parsed JSON for a 200 and null for every other
// status. Network errors, 5xx and 429 are retried up to three attempts; everything else is returned as is. A transport
// that still fails after the last attempt rejects with a message that cannot contain the token.
export function createGithubFetchRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createGithubFetchRun: no fetch implementation is available');
  const secrets = secretsFromEnv(env);
  const token = secrets[0] ?? null;

  async function attempt(url, headers) {
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // the body of a non-200 reply is never used
      }
      return { status: response.status, body: null };
    }
    const text = await response.text();
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      return { status: 200, body: null };
    }
  }

  return async function fetchRun(request) {
    const { repo, runId } = request;
    const match = typeof repo === 'string' ? REPO_PATTERN.exec(repo) : null;
    if (!match || match[2] === '.' || match[2] === '..') throw new TypeError('fetchRun: repo must be "<owner>/<name>"');
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new TypeError('fetchRun: runId must be a positive safe integer');

    const url = `${API_ORIGIN}/repos/${match[1]}/${match[2]}/actions/runs/${runId}`;
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'bskel-release-policy',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    for (let attemptNumber = 1; ; attemptNumber += 1) {
      let outcome;
      try {
        outcome = await attempt(url, headers);
      } catch (error) {
        if (attemptNumber >= MAX_ATTEMPTS) throw new Error(`GitHub API request failed after ${MAX_ATTEMPTS} attempts: ${describeFailure(error, secrets)}`);
        await sleep(RETRY_DELAYS_MS[attemptNumber - 1]);
        continue;
      }
      if (!retriable(outcome.status) || attemptNumber >= MAX_ATTEMPTS) return outcome;
      await sleep(RETRY_DELAYS_MS[attemptNumber - 1]);
    }
  };
}
