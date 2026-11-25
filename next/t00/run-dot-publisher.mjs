import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bindGitCandidate } from './independent-approval-policy.mjs';
import { parseSignedRequest } from './dot-publisher-request.mjs';
import { createPublisher } from './dot-publisher-github.mjs';

const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPO_ID = 1334919554;
const OWNER_ID = 261965176;
const INTAKE = 389;
const APP_ID = 5922170;
const INSTALLATION_ID = 185792757;
const WORKFLOW_PATH = '.github/workflows/t00-bskel-pr-path-authorization.yml';
const SHA = /^[a-f0-9]{40}$/;

function insist(ok, code) {
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

async function currentMain(token, sha) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/branches/main`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  insist(response.ok, 'HOLD_MAIN_READ');
  const branch = await response.json();
  insist(branch.name === 'main' && branch.protected === true && branch.commit?.sha === sha, 'HOLD_MAIN_CHANGED');
  return branch.commit.sha;
}

async function run() {
  const {
    GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GITHUB_WORKFLOW_REF, GITHUB_EVENT_NAME,
    GITHUB_EVENT_PATH, GITHUB_REF, GITHUB_SHA, GH_TOKEN,
    T00_DOT_REQUEST_PUBLIC_DER, T00_PUBLISHER_APP_KEY, T00_PUBLISHER_RULESET_ID,
  } = process.env;
  const rulesetId = Number(T00_PUBLISHER_RULESET_ID);
  insist(GITHUB_REPOSITORY === REPOSITORY && GITHUB_REPOSITORY_ID === String(REPO_ID) &&
    GITHUB_REF === 'refs/heads/main' && SHA.test(GITHUB_SHA ?? '') &&
    GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` &&
    GITHUB_EVENT_NAME === 'issue_comment' && GH_TOKEN && Number.isSafeInteger(rulesetId) && rulesetId > 0,
  'HOLD_PUBLISHER_WORKFLOW_IDENTITY');
  insist(git('rev-parse', 'HEAD') === GITHUB_SHA, 'HOLD_PUBLISHER_CHECKOUT');
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
  insist(event.action === 'created' && event.repository?.id === REPO_ID && event.repository.full_name === REPOSITORY &&
    event.issue?.number === INTAKE && event.issue?.pull_request && event.sender?.id === OWNER_ID &&
    event.comment?.user?.id === OWNER_ID && event.comment.issue_url === `https://api.github.com/repos/${REPOSITORY}/issues/${INTAKE}`,
  'HOLD_PUBLISHER_EVENT');
  const parse = () => parseSignedRequest({
    body: event.comment.body,
    publicKeyDer: T00_DOT_REQUEST_PUBLIC_DER,
    now: Math.floor(Date.now() / 1000),
    intakeNumber: INTAKE,
  });
  const request = parse();
  insist(request.base === await currentMain(GH_TOKEN, GITHUB_SHA), 'HOLD_PUBLISHER_REQUEST_BASE');
  git('fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=2',
    `https://github.com/${REPOSITORY}.git`, `refs/heads/dot-intake/${request.head}`);
  insist(git('rev-parse', 'FETCH_HEAD') === request.head, 'HOLD_PUBLISHER_INPUT_REF');
  const validate = async () => {
    const input = parse();
    const mainSha = await currentMain(GH_TOKEN, GITHUB_SHA);
    insist(mainSha === input.base, 'HOLD_PUBLISHER_REQUEST_BASE');
    const binding = await bindGitCandidate({ repoDir: process.cwd(), mainSha, head: input.head, track: input.track });
    insist(binding.tree === input.tree, 'HOLD_PUBLISHER_REQUEST_TREE');
    return binding;
  };
  const binding = await validate();
  const publisher = await createPublisher({ appId: APP_ID, installationId: INSTALLATION_ID, rulesetId, pem: T00_PUBLISHER_APP_KEY });
  const result = await publisher.publish(binding, validate);
  console.log(JSON.stringify({ status: 'DOT_SIGNED_DRAFT_PUBLISHED', signedCommentId: event.comment.id, ...result }));
}

try {
  await run();
} catch (error) {
  const reason = error.code ?? error.message;
  console.error(typeof reason === 'string' && /^[A-Z0-9_]{1,90}$/.test(reason) ? reason : 'HOLD_DOT_PUBLISHER');
  process.exitCode = 2;
}
