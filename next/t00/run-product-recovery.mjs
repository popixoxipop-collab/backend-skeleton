import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const workflow = '.github/workflows/t00-product-transition.yml';
const api = `https://api.github.com/repos/${repo}`;
const id = value => Number.isSafeInteger(value) && value > 0;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

export function recoverablePostmergeJob(run, listing, { workflowId, now }) {
  const created = Date.parse(run?.created_at);
  const updated = Date.parse(run?.updated_at);
  if (!id(run?.id) || run.workflow_id !== workflowId || run.path !== workflow || run.event !== 'workflow_run' ||
    run.head_branch !== 'main' || run.repository?.id !== repoId || run.head_repository?.id !== repoId ||
    run.status !== 'completed' || !['failure', 'timed_out', 'cancelled'].includes(run.conclusion) ||
    !id(run.run_attempt) || run.run_attempt >= 3 || !(created <= updated && updated <= now &&
      now - created < 23 * 60 * 60 * 1000) || !Array.isArray(listing?.jobs) ||
    listing.total_count !== listing.jobs.length || listing.total_count >= 100) return null;
  const jobs = listing.jobs;
  const originalMerge = jobs.filter(job => job.name === 'merge' && job.run_id === run.id && job.conclusion === 'success' &&
    job.status === 'completed' && job.head_sha === run.head_sha && id(job.run_attempt) && job.run_attempt <= run.run_attempt);
  const current = jobs.filter(job => job.run_attempt === run.run_attempt);
  const postmerge = current.filter(job => job.name === 'postmerge');
  if (originalMerge.length !== 1 || postmerge.length !== 1 || current.some(job => job.name === 'merge' &&
    job.conclusion !== 'success')) return null;
  const job = postmerge[0];
  return id(job.id) && job.run_id === run.id && job.head_sha === run.head_sha && job.status === 'completed' &&
    ['failure', 'timed_out', 'cancelled'].includes(job.conclusion) ? job.id : null;
}

async function run() {
  const env = process.env;
  requireIt(env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === String(repoId) &&
    env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_WORKFLOW_REF === `${repo}/${workflow}@refs/heads/main` &&
    env.GITHUB_EVENT_NAME === 'schedule' && typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length >= 20 &&
    env.GITHUB_EVENT_PATH?.startsWith('/'), 'HOLD_POSTMERGE_RECOVERY_IDENTITY');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  requireIt(event.repository?.id === repoId && event.repository.full_name === repo, 'HOLD_POSTMERGE_RECOVERY_REPOSITORY');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 't00-postmerge-recovery' };
  async function get(path) {
    const response = await fetch(`${api}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    requireIt(response.status === 200 && !response.redirected, 'HOLD_POSTMERGE_RECOVERY_GITHUB_READ');
    return response.json();
  }
  const registration = await get('/actions/workflows/t00-product-transition.yml');
  requireIt(id(registration.id) && registration.path === workflow && registration.state === 'active', 'HOLD_POSTMERGE_RECOVERY_WORKFLOW');
  const listing = await get(`/actions/workflows/${registration.id}/runs?event=workflow_run&branch=main&status=completed&per_page=25`);
  requireIt(Array.isArray(listing.workflow_runs) && listing.workflow_runs.length <= 25, 'HOLD_POSTMERGE_RECOVERY_LIST');
  const now = Date.now();
  for (const candidate of listing.workflow_runs) {
    if (!id(candidate?.id) || !['failure', 'timed_out', 'cancelled'].includes(candidate.conclusion) ||
      !(Date.parse(candidate.created_at) > now - 23 * 60 * 60 * 1000) || candidate.run_attempt >= 3) continue;
    const runPath = `/actions/runs/${candidate.id}`;
    const jobs = await get(`${runPath}/jobs?filter=all&per_page=100`);
    const live = await get(runPath);
    const jobId = recoverablePostmergeJob(live, jobs, { workflowId: registration.id, now });
    if (!jobId || live.run_attempt !== candidate.run_attempt) continue;
    const response = await fetch(`${api}/actions/jobs/${jobId}/rerun`, { method: 'POST', headers: {
      ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enable_debug_logging: false }),
    redirect: 'error', signal: AbortSignal.timeout(12_000) });
    requireIt(response.status === 201 && !response.redirected, 'HOLD_POSTMERGE_RECOVERY_UNCONFIRMED');
    console.log(`Requested postmerge-only recovery for transition run ${live.id}, job ${jobId}`);
    return;
  }
  console.log('No eligible postmerge recovery');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch(error => {
    console.error(/^HOLD_[A-Z_0-9]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_POSTMERGE_RECOVERY_UNEXPECTED');
    process.exitCode = 1;
  });
}
