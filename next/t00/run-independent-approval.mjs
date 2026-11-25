import { execFileSync } from 'node:child_process';
import { bindCandidate } from './independent-approval-policy.mjs';
import { createIssuer } from './independent-approval-issuer.mjs';

const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const CHECK_NAME = 't00-independent-approval/verified';
const API = `/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const NUMBER = /^[1-9][0-9]{0,11}$/;
const DRAFT_REF_PREFIX = 'dot/t00-publisher/';

function expect(ok, code) {
  if (!ok) throw new Error(code);
}

function git(...args) {
  return execFileSync('/usr/bin/git', ['--no-replace-objects', ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https',
    },
    encoding: 'utf8',
    timeout: 45_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.ok, `GITHUB_READ_${response.status}`);
  return response.json();
}

async function liveBase(workflowSha) {
  const branch = await github(`${API}/branches/main`);
  expect(branch.name === 'main' && branch.protected === true && branch.commit?.sha === workflowSha, 'HOLD_MAIN_CHANGED_OR_UNPROTECTED');
  return workflowSha;
}

function acceptsDraft(pull, publisherId) {
  return pull?.state === 'open' && pull.draft === true && pull.head?.repo?.id === REPOSITORY_ID &&
    SHA.test(pull.head.sha ?? '') && pull.head.ref === DRAFT_REF_PREFIX + pull.head.sha &&
    pull.user?.type === 'Bot' && pull.user.id === publisherId;
}

async function verifyPublicationRules(ref, rulesetId) {
  const rules = await github(`${API}/rules/branches/${encodeURIComponent(ref)}`);
  expect(Array.isArray(rules) && ['creation', 'update', 'deletion'].every(type =>
    rules.some(rule => rule.type === type && rule.ruleset_id === rulesetId)), 'HOLD_PUBLISHER_NAMESPACE');
}

async function listDrafts(publisherId) {
  const eligible = [];
  for (let page = 1; page <= 10; page++) {
    const entries = await github(`${API}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100&page=${page}`);
    expect(Array.isArray(entries), 'HOLD_PULL_LIST');
    eligible.push(...entries.filter(pull => acceptsDraft(pull, publisherId)));
    if (entries.length < 100) return eligible;
  }
  throw new Error('HOLD_PULL_LIST_TRUNCATED');
}

async function hasCurrentReceipt(issuer, binding) {
  const checks = await github(`${API}/commits/${binding.head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest&per_page=100`);
  expect(Array.isArray(checks.check_runs) && checks.total_count <= checks.check_runs.length, 'HOLD_CHECK_LIST');
  return checks.check_runs.some(check => issuer.isCurrentReceipt(check, binding, 300));
}

async function run() {
  const { GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GITHUB_REF, GITHUB_SHA, GITHUB_EVENT_NAME,
    GITHUB_WORKFLOW_REF, GH_TOKEN, T00_DOT_PUBLISHER_ID, T00_PULL_NUMBER, T00_EXPECTED_HEAD,
    T00_APP_KEY, T00_SIGNING_KEY, T00_SIGNING_PUBLIC_DER, T00_PUBLISHER_RULESET_ID } = process.env;
  expect(GITHUB_REPOSITORY === REPOSITORY && GITHUB_REPOSITORY_ID === String(REPOSITORY_ID) &&
    GITHUB_REF === 'refs/heads/main' && SHA.test(GITHUB_SHA) &&
    GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/t00-bskel-pr-path-authorization.yml@refs/heads/main` &&
    ['schedule', 'workflow_dispatch'].includes(GITHUB_EVENT_NAME), 'HOLD_WORKFLOW_IDENTITY');
  expect(git('rev-parse', 'HEAD') === GITHUB_SHA, 'HOLD_CHECKOUT');
  expect(GH_TOKEN && NUMBER.test(T00_DOT_PUBLISHER_ID ?? ''), 'HOLD_PUBLISHER_UNREGISTERED');
  const publisherId = Number(T00_DOT_PUBLISHER_ID);
  const rulesetId = Number(T00_PUBLISHER_RULESET_ID);
  expect(NUMBER.test(T00_PUBLISHER_RULESET_ID ?? ''), 'HOLD_PUBLISHER_NAMESPACE');
  const base = await liveBase(GITHUB_SHA);
  const scheduled = GITHUB_EVENT_NAME === 'schedule';
  if (!scheduled) expect(NUMBER.test(T00_PULL_NUMBER ?? '') && SHA.test(T00_EXPECTED_HEAD ?? ''), 'HOLD_DISPATCH_TARGET');
  const candidates = scheduled ? await listDrafts(publisherId) : [{
    number: Number(T00_PULL_NUMBER),
    head: { sha: T00_EXPECTED_HEAD },
  }];
  if (!candidates.length) {
    console.log('No open drafts from the enrolled Dot publisher');
    return;
  }
  const issuer = createIssuer({
    appPrivateKey: T00_APP_KEY, signingKey: T00_SIGNING_KEY, publicKeyDer: T00_SIGNING_PUBLIC_DER,
  });
  let blocked = 0;
  let published = 0;
  for (const candidate of candidates) {
    const number = candidate.number;
    const head = candidate.head?.sha;
    let publicationStarted = false;
    try {
      expect(NUMBER.test(String(number)) && SHA.test(head ?? ''), 'HOLD_CANDIDATE_TARGET');
      const load = async () => {
        const mainSha = await liveBase(base);
        const pull = await github(`${API}/pulls/${number}`);
        expect(acceptsDraft(pull, publisherId) && pull.number === number && pull.head.sha === head, 'HOLD_GITHUB_CANDIDATE_CHANGED');
        await verifyPublicationRules(pull.head.ref, rulesetId);
        return { pull, mainSha, repoDir: process.cwd(), publisherId };
      };
      const input = await load();
      git('fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=2',
        `https://github.com/${REPOSITORY}.git`, `refs/pull/${number}/head`);
      expect(git('rev-parse', 'FETCH_HEAD') === head, 'HOLD_FETCH_HEAD_CHANGED');
      const bind = async observation => ({
        repository: REPOSITORY, repositoryId: REPOSITORY_ID, ...await bindCandidate(observation),
      });
      const binding = await bind(input);
      if (await hasCurrentReceipt(issuer, binding)) continue;
      publicationStarted = true;
      const result = await issuer.publish(binding, async () => bind(await load()));
      console.log(JSON.stringify({ status: 'VERIFIED_CHECK_PUBLISHED', pull: number, head, result }));
      if (++published === 3) break;
    } catch (error) {
      blocked++;
      const code = /^[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : 'HOLD_APPROVAL_EXECUTION';
      console.error(`PR ${number}: ${code}`);
      // Do not retry a request whose publication outcome may be unknown.
      if (publicationStarted) break;
    }
  }
  if (blocked) process.exitCode = 2;
}

try {
  await run();
} catch (error) {
  const code = /^[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : 'HOLD_APPROVAL_EXECUTION';
  console.error(code);
  process.exitCode = 2;
}
