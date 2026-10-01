import test from 'node:test';
import assert from 'node:assert/strict';

const load = async () => (await import('../release-policy-github.mjs')).createGithubFetchRun;
const REQUEST = { repo: 'popixoxipop-collab/backend-skeleton', runId: 36652996212 };
const URL_OK = 'https://api.github.com/repos/popixoxipop-collab/backend-skeleton/actions/runs/36652996212';
const TOKEN = 'ghp_SENTINEL_0123456789abcdef';
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bare = (status) => () => new Response(null, { status });
const header = (init, name) => new Headers(init.headers).get(name);

// fetch double: each step is an Error to throw or a factory returning a fresh Response; the last step repeats.
function scripted(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step instanceof Error) throw step;
    return step();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
function sleeper() {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  sleep.delays = delays;
  return sleep;
}

test('GETs the pinned run URL with fixed API headers, manual redirects, a timeout and no credentials by default', async () => {
  const create = await load();
  const fetchImpl = scripted(json(200, { id: 1 }));
  const reply = await create({ env: {}, fetchImpl, sleep: sleeper() })(REQUEST);
  assert.deepEqual(reply, { status: 200, body: { id: 1 } });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, URL_OK);
  assert.ok(init.method === undefined || init.method === 'GET');
  assert.equal(init.redirect, 'manual', 'a redirect must never be followed with credentials attached');
  assert.ok(init.signal instanceof AbortSignal, 'every attempt is bounded by a timeout');
  assert.match(header(init, 'accept'), /application\/vnd\.github\+json/);
  assert.ok(header(init, 'x-github-api-version'));
  assert.ok(header(init, 'user-agent'));
  assert.equal(header(init, 'authorization'), null);
});

test('Authorization comes from GH_TOKEN, then GITHUB_TOKEN, only when non-blank, and never from the URL', async () => {
  const create = await load();
  const cases = [
    [{ GH_TOKEN: 'AAA', GITHUB_TOKEN: 'BBB' }, 'Bearer AAA'],
    [{ GITHUB_TOKEN: 'BBB' }, 'Bearer BBB'],
    [{ GH_TOKEN: '   ', GITHUB_TOKEN: 'BBB' }, 'Bearer BBB'],
    [{ GH_TOKEN: ' AAA\n' }, 'Bearer AAA'],
    [{ GH_TOKEN: '', GITHUB_TOKEN: '' }, null],
    [{ GH_TOKEN: '  ' }, null],
    [{}, null],
  ];
  for (const [env, expected] of cases) {
    const fetchImpl = scripted(json(200, {}));
    await create({ env, fetchImpl, sleep: sleeper() })(REQUEST);
    assert.equal(header(fetchImpl.calls[0].init, 'authorization'), expected, JSON.stringify(env));
    assert.equal(fetchImpl.calls[0].url, URL_OK);
  }
});

test('returns the parsed body for 200 and no body for any other status', async () => {
  const create = await load();
  const run = (step) => create({ env: {}, fetchImpl: scripted(step), sleep: sleeper() })(REQUEST);
  assert.deepEqual(await run(json(200, { id: 7 })), { status: 200, body: { id: 7 } });
  assert.deepEqual(await run(() => new Response('<html>not json</html>', { status: 200 })), { status: 200, body: null });
  assert.deepEqual(await run(json(404, { message: 'Not Found' })), { status: 404, body: null });
  assert.deepEqual(await run(json(403, { message: 'rate limit exceeded' })), { status: 403, body: null });
  assert.deepEqual(await run(bare(302)), { status: 302, body: null });
});

test('retries only network errors, 5xx and 429, at most three attempts, sleeping between attempts', async () => {
  const create = await load();
  const boom = new TypeError('fetch failed');
  const cases = [
    { steps: [boom, boom, json(200, { id: 1 })], calls: 3, outcome: { status: 200, body: { id: 1 } } },
    { steps: [boom, boom, boom], calls: 3, outcome: 'reject' },
    { steps: [bare(503), bare(503), json(200, { id: 2 })], calls: 3, outcome: { status: 200, body: { id: 2 } } },
    { steps: [bare(503), bare(502), bare(500)], calls: 3, outcome: { status: 500, body: null } },
    { steps: [bare(429), json(200, { id: 3 })], calls: 2, outcome: { status: 200, body: { id: 3 } } },
    { steps: [bare(429)], calls: 3, outcome: { status: 429, body: null } },
    ...[200, 301, 400, 401, 403, 404, 410, 422].map((status) => ({ steps: [status === 200 ? json(200, {}) : bare(status)], calls: 1, outcome: status === 200 ? { status: 200, body: {} } : { status, body: null } })),
  ];
  for (const { steps, calls, outcome } of cases) {
    const fetchImpl = scripted(...steps);
    const sleep = sleeper();
    const fetchRun = create({ env: {}, fetchImpl, sleep });
    if (outcome === 'reject') await assert.rejects(fetchRun(REQUEST), /after 3 attempts/);
    else assert.deepEqual(await fetchRun(REQUEST), outcome);
    assert.equal(fetchImpl.calls.length, calls, JSON.stringify(outcome));
    assert.equal(sleep.delays.length, calls - 1, 'one pause between consecutive attempts and none after the last');
    assert.ok(sleep.delays.every((ms) => Number.isFinite(ms) && ms > 0 && ms <= 10000));
  }
});

// Records the delay of every AbortSignal.timeout() call made while `body` runs.
async function recordingTimeouts(body) {
  const original = AbortSignal.timeout;
  const requested = [];
  AbortSignal.timeout = (ms) => { requested.push(ms); return original.call(AbortSignal, ms); };
  try {
    await body();
  } finally {
    AbortSignal.timeout = original;
  }
  return requested;
}

test('each attempt gets its own signal that aborts after timeoutMs (15 s by default) and the transport stops after three attempts', async () => {
  const create = await load();
  const signals = [];
  // Behaves like fetch: an already aborted signal rejects at once, any other settles when it aborts. The 1 s guard is
  // also the handle that keeps the event loop alive (AbortSignal.timeout() timers are unref-ed, a real socket is not),
  // and it turns a signal that never aborts into a quick, distinguishable failure instead of a hang.
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    if (init.signal.aborted) {
      reject(init.signal.reason);
      return;
    }
    const guard = setTimeout(() => reject(new Error('the signal did not abort within 1 s')), 1000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(init.signal.reason);
    });
  });
  const requested = await recordingTimeouts(() => assert.rejects(
    create({ env: {}, fetchImpl: hang, sleep: sleeper(), timeoutMs: 20 })(REQUEST),
    /^Error: GitHub API request failed after 3 attempts: TimeoutError/,
  ));
  assert.deepEqual(requested, [20, 20, 20], 'timeoutMs must reach every attempt');
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3, 'a signal that is reused stays aborted and fails the retries at once');

  const byDefault = await recordingTimeouts(() => create({ env: {}, fetchImpl: scripted(json(200, {})), sleep: sleeper() })(REQUEST));
  assert.deepEqual(byDefault, [15000]);
});

test('rejects a repository or run id that is not strictly well formed before any request is made', async () => {
  const create = await load();
  const fetchImpl = scripted(json(200, {}));
  const fetchRun = create({ env: {}, fetchImpl, sleep: sleeper() });
  const badRepos = ['a/b/../c', 'a/..', '../b', './b', 'a/b?x=1', 'a/b#x', 'a b/c', '', 'a', 'a/b/c', '/a/b', 'a/b/', null, 123];
  for (const repo of badRepos) await assert.rejects(fetchRun({ repo, runId: 1 }), Error, `repo ${String(repo)}`);
  for (const runId of [0, -1, 1.5, '12', NaN, Infinity, 2 ** 53, null, undefined]) {
    await assert.rejects(fetchRun({ repo: REQUEST.repo, runId }), Error, `runId ${String(runId)}`);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('credential-shaped text is scrubbed from failure messages even when it is not the token in use', async () => {
  const create = await load();
  const body = 'Ab3x'.repeat(8);
  const shaped = [
    ['Bearer', `Authorization: Bearer other.credential-${body}`, `other.credential-${body}`],
    ['bearer in lower case', `authorization: bearer lower.case-${body}`, `lower.case-${body}`],
    ...['p', 'o', 'u', 's', 'r'].map((kind) => [`gh${kind}_ token`, `echoed gh${kind}_${body} back`, `gh${kind}_${body}`]),
    ['fine-grained token', `echoed github_pat_${body}_${body} back`, `github_pat_${body}_${body}`],
  ];
  for (const env of [{}, { GH_TOKEN: TOKEN }]) {
    for (const [label, message, credential] of shaped) {
      const fetchRun = create({ env, fetchImpl: async () => { throw new Error(message); }, sleep: sleeper() });
      await assert.rejects(fetchRun(REQUEST), (error) => {
        assert.match(error.message, /^GitHub API request failed after 3 attempts: /, label);
        assert.ok(!error.message.includes(credential), `${label}: ${error.message}`);
        assert.match(error.message, /\[redacted\]/, label);
        return true;
      });
    }
  }
});

test('redactSecrets masks secrets of eight or more characters and leaves shorter ones alone, so a stray value cannot garble a message', async () => {
  const { redactSecrets } = await import('../release-policy-github.mjs');
  assert.equal(redactSecrets('a abcdefgh b abcdefgh', ['abcdefgh']), 'a [redacted] b [redacted]');
  assert.equal(redactSecrets('a abcdefg b', ['abcdefg']), 'a abcdefg b');
  assert.equal(redactSecrets('plain message', ['']), 'plain message');
  assert.equal(redactSecrets('plain message', [undefined, null, 7]), 'plain message');
  assert.equal(redactSecrets('plain message'), 'plain message');
  assert.equal(redactSecrets(undefined, ['abcdefgh']), 'undefined');
});

test('failure messages never contain the token, whatever the transport error says', async () => {
  const create = await load();
  const leaky = [new Error(`upstream rejected Authorization: Bearer ${TOKEN}`), `plain string with ${TOKEN}`];
  for (const thrown of leaky) {
    const fetchImpl = async () => { throw thrown; };
    const fetchRun = create({ env: { GH_TOKEN: TOKEN }, fetchImpl, sleep: sleeper() });
    await assert.rejects(fetchRun(REQUEST), (error) => {
      assert.ok(error instanceof Error);
      const everything = JSON.stringify(error, Object.getOwnPropertyNames(error));
      assert.ok(!everything.includes(TOKEN), 'the token must not survive in message, stack or cause');
      return true;
    });
  }
});
