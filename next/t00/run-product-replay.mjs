import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDotTransitionIntent } from './dot-transition-intent.mjs';

const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const intake = 389;
const actor = 261965176;
const applicationScope = 'historical-installed-package-replay';
const endpoint = `https://api.github.com/repos/${repo}`;
const workflow = '.github/workflows/t00-product-replay.yml';
const sha = /^[0-9a-f]{40}$/u;
const replayPath = fileURLToPath(new URL('./product-t03-replay.py', import.meta.url));

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

async function readMain() {
  const response = await fetch(`${endpoint}/branches/main`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  requireIt(response.ok && !response.redirected, 'HOLD_PRODUCT_REPLAY_GITHUB_READ');
  return response.json();
}

async function run() {
  const env = process.env;
  requireIt(env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === String(repoId) &&
    env.GITHUB_EVENT_NAME === 'issue_comment' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === `${repo}/${workflow}@refs/heads/main` && sha.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_EVENT_PATH?.startsWith('/') && env.RUNNER_TEMP?.startsWith('/') &&
    /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''),
  'HOLD_PRODUCT_REPLAY_WORKFLOW_IDENTITY');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  requireIt(event.action === 'created' && event.sender?.id === actor && event.issue?.number === intake &&
    !!event.issue.pull_request && event.repository?.id === repoId && event.repository.full_name === repo,
  'HOLD_PRODUCT_REPLAY_EVENT');
  const intent = verifyDotTransitionIntent({ repository: repo, repositoryId: repoId, intake,
    comment: event.comment, now: Math.floor(Date.now() / 1000) });
  const { subject } = intent;
  requireIt(subject.base === env.GITHUB_SHA && subject.task === 'T03-06' && subject.scope === applicationScope,
    'HOLD_PRODUCT_REPLAY_SCOPE_OR_BASE');
  const branch = await readMain();
  const baseTree = branch.commit?.commit?.tree?.sha;
  requireIt(branch.name === 'main' && branch.protected === true && branch.commit?.sha === subject.base &&
    typeof baseTree === 'string' && sha.test(baseTree), 'HOLD_PRODUCT_REPLAY_MAIN');
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', replayPath, String(subject.pr), 'premerge',
    '--base', subject.base, '--base-tree', baseTree, '--head', subject.head, '--head-tree', subject.tree,
    '--reproduce-historical-archive'], { encoding: 'utf8', maxBuffer: 16384, timeout: 180_000,
    env: { PATH: env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  requireIt(result.status === 0 && result.stderr === '', 'HOLD_PRODUCT_REPLAY_EXECUTION');
  const replay = JSON.parse(result.stdout);
  requireIt(replay.schema === 't00.t03-exact-pr-replay/3' && replay.phase === 'premerge' &&
    replay.pull_request === subject.pr && replay.tested_commit === subject.head && replay.tested_tree === subject.tree &&
    replay.base === subject.base && replay.base_tree === baseTree && replay.source_head === subject.head &&
    replay.package_file_bytes_match_official_baseline === true && replay.normal_restore === true &&
    replay.sigterm_probe_restore === true && replay.candidate_tests_executed === false &&
    replay.release_authorized === false && replay.runtime_certified === false,
  'HOLD_PRODUCT_REPLAY_RECEIPT');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const receipt = { schema: 't00.t03-github-independent-premerge/1', workflow, commit: env.GITHUB_SHA,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), commentId: intent.commentId,
    dotIntentSha256: intent.dotIntentSha256, verifierSha256: hash(readFileSync(replayPath)),
    stdoutSha256: hash(result.stdout), completedAt: new Date().toISOString(), subject, replay };
  const bytes = `${JSON.stringify(receipt)}\n`;
  writeFileSync(join(env.RUNNER_TEMP, 't00-product-premerge.json'), bytes, { flag: 'wx', mode: 0o600 });
  console.log(`T03-06 independent premerge receipt ${hash(bytes)}`);
}

run().catch(error => {
  const code = /^HOLD_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_PRODUCT_REPLAY_UNEXPECTED';
  console.error(code);
  process.exitCode = 1;
});
