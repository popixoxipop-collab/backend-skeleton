import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const workflow = '.github/workflows/t00-product-transition.yml';
const ciWorkflow = '.github/workflows/ci.yml';
const ciWorkflowId = 338234334;
const publisherId = 361175685;
const api = `https://api.github.com/repos/${repo}`;
const id = value => Number.isSafeInteger(value) && value > 0;
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const sameRepo = value => value?.id === repoId && value.full_name === repo;
const publisher = value => value?.id === publisherId && value.type === 'Bot' &&
  value.login === 't00-dot-draft-publisher[bot]';
const recoveryWindow = 23 * 60 * 60 * 1000;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function isExactCIPush(source) {
  return id(source?.id) && id(source.run_attempt) && source.workflow_id === ciWorkflowId &&
    source.path === ciWorkflow && source.event === 'push' && source.status === 'completed' &&
    source.conclusion === 'success' && source.head_branch === 'main' && oid(source.head_sha) &&
    sameRepo(source.repository) && sameRepo(source.head_repository) && publisher(source.actor);
}

// The WorkflowRun payload selects a run. Its latest REST identity and exact
// protected commit are authenticated again before considering any failed job.
export async function recoveryCILineage(event, get, now) {
  const source = event?.workflow_run;
  requireIt(event?.action === 'completed' && sameRepo(event.repository) && isExactCIPush(source),
    'HOLD_POSTMERGE_RECOVERY_CI_EVENT');
  const [registration, run, merged, associated, branch] = await Promise.all([
    get('/actions/workflows/ci.yml'),
    get('/actions/runs/' + source.id),
    get('/git/commits/' + source.head_sha),
    get('/commits/' + source.head_sha + '/pulls?per_page=100'),
    get('/branches/main'),
  ]);
  const created = Date.parse(run?.created_at);
  const completed = Date.parse(run?.updated_at);
  requireIt(registration?.id === ciWorkflowId && registration.name === 'CI' && registration.path === ciWorkflow &&
    registration.state === 'active' && isExactCIPush(run) && run.id === source.id &&
    run.run_attempt === source.run_attempt && run.head_sha === source.head_sha && publisher(run.triggering_actor) &&
    created <= completed && completed <= now && now - created < recoveryWindow, 'HOLD_POSTMERGE_RECOVERY_CI_PROOF');
  const parents = merged?.parents;
  requireIt(merged?.sha === run.head_sha && oid(merged.tree?.sha) && Array.isArray(parents) && parents.length === 2 &&
    parents.every(parent => oid(parent.sha)) && parents[0].sha !== parents[1].sha &&
    Array.isArray(associated) && associated.length < 100, 'HOLD_POSTMERGE_RECOVERY_CI_MERGE');
  const pulls = associated.filter(pull => pull?.merge_commit_sha === run.head_sha && pull.base?.ref === 'main');
  requireIt(pulls.length === 1 && id(pulls[0].number), 'HOLD_POSTMERGE_RECOVERY_CI_MERGE');
  const [base, head] = parents.map(parent => parent.sha);
  const [pull, candidate] = await Promise.all([get('/pulls/' + pulls[0].number), get('/git/commits/' + head)]);
  const mergedAt = Date.parse(pull?.merged_at);
  requireIt(pull?.number === pulls[0].number && pull.state === 'closed' && pull.draft === false && pull.merged === true &&
    pull.merge_commit_sha === run.head_sha && publisher(pull.user) && publisher(pull.merged_by) &&
    sameRepo(pull.base?.repo) && pull.base.ref === 'main' && sameRepo(pull.head?.repo) &&
    pull.head.sha === head && pull.head.ref === 'dot/t00-publisher/' + head &&
    candidate?.sha === head && candidate.tree?.sha === merged.tree.sha && candidate.parents?.length === 1 &&
    candidate.parents[0].sha === base && mergedAt <= completed && now - mergedAt < recoveryWindow &&
    branch?.name === 'main' && branch.protected === true && oid(branch.commit?.sha),
  'HOLD_POSTMERGE_RECOVERY_CI_MERGE');
  const main = branch.commit.sha;
  if (main !== run.head_sha) {
    const ancestry = await get('/compare/' + run.head_sha + '...' + main + '?per_page=1');
    requireIt(ancestry?.status === 'ahead' && ancestry.merge_base_commit?.sha === run.head_sha,
      'HOLD_POSTMERGE_RECOVERY_CI_LINEAGE');
  }
  return { base, head, merge: run.head_sha, mergedAt, ciRunId: run.id, ciAttempt: run.run_attempt, pr: pull.number };
}

export function recoverablePostmergeJob(run, listing, { workflowId, now, ciLineage }) {
  const created = Date.parse(run?.created_at);
  const updated = Date.parse(run?.updated_at);
  if (!id(run?.id) || run.workflow_id !== workflowId || run.path !== workflow || run.event !== 'workflow_run' ||
    run.head_branch !== 'main' || run.repository?.id !== repoId || run.head_repository?.id !== repoId ||
    run.status !== 'completed' || !['failure', 'timed_out', 'cancelled'].includes(run.conclusion) ||
    !id(run.run_attempt) || run.run_attempt >= 3 || !(created <= updated && updated <= now &&
      now - created < recoveryWindow) || !Array.isArray(listing?.jobs) ||
    listing.total_count !== listing.jobs.length || listing.total_count >= 100) return null;
  if (ciLineage && (run.head_sha !== ciLineage.base || !(created <= ciLineage.mergedAt &&
    ciLineage.mergedAt <= updated))) return null;
  const jobs = listing.jobs;
  const originalMerge = jobs.filter(job => job.name === 'merge' && job.run_id === run.id && job.conclusion === 'success' &&
    job.status === 'completed' && job.head_sha === run.head_sha && id(job.run_attempt) && job.run_attempt <= run.run_attempt);
  const current = jobs.filter(job => job.run_attempt === run.run_attempt);
  const postmerge = current.filter(job => job.name === 'postmerge');
  if (originalMerge.length !== 1 || postmerge.length !== 1 || current.some(job => job.name === 'merge' &&
    job.conclusion !== 'success')) return null;
  if (ciLineage && !(Date.parse(originalMerge[0].started_at) <= ciLineage.mergedAt &&
    ciLineage.mergedAt <= Date.parse(originalMerge[0].completed_at))) return null;
  const job = postmerge[0];
  return id(job.id) && job.run_id === run.id && job.head_sha === run.head_sha && job.status === 'completed' &&
    ['failure', 'timed_out', 'cancelled'].includes(job.conclusion) ? job.id : null;
}

async function run() {
  const env = process.env;
  requireIt(env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === String(repoId) &&
    env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_WORKFLOW_REF === `${repo}/${workflow}@refs/heads/main` &&
    ['schedule', 'workflow_run'].includes(env.GITHUB_EVENT_NAME) &&
    typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length >= 20 &&
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
  const ciLineage = env.GITHUB_EVENT_NAME === 'workflow_run' ? await recoveryCILineage(event, get, Date.now()) : null;
  const registration = await get('/actions/workflows/t00-product-transition.yml');
  requireIt(id(registration.id) && registration.path === workflow && registration.state === 'active', 'HOLD_POSTMERGE_RECOVERY_WORKFLOW');
  const listing = await get(`/actions/workflows/${registration.id}/runs?event=workflow_run&branch=main&status=completed&per_page=25`);
  requireIt(Array.isArray(listing.workflow_runs) && listing.workflow_runs.length <= 25, 'HOLD_POSTMERGE_RECOVERY_LIST');
  const now = Date.now();
  for (const candidate of listing.workflow_runs) {
    if (!id(candidate?.id) || !['failure', 'timed_out', 'cancelled'].includes(candidate.conclusion) ||
      !(Date.parse(candidate.created_at) > now - recoveryWindow) || candidate.run_attempt >= 3 ||
      (ciLineage && candidate.head_sha !== ciLineage.base)) continue;
    const runPath = `/actions/runs/${candidate.id}`;
    const jobs = await get(`${runPath}/jobs?filter=all&per_page=100`);
    const live = await get(runPath);
    const jobId = recoverablePostmergeJob(live, jobs, { workflowId: registration.id, now, ciLineage });
    if (!jobId || live.run_attempt !== candidate.run_attempt) continue;
    if (ciLineage) {
      const current = await recoveryCILineage(event, get, Date.now());
      requireIt(Object.keys(ciLineage).every(key => current[key] === ciLineage[key]),
        'HOLD_POSTMERGE_RECOVERY_CI_MOVED');
      const refreshedJobs = await get(runPath + '/jobs?filter=all&per_page=100');
      const refreshedRun = await get(runPath);
      requireIt(refreshedRun.run_attempt === live.run_attempt &&
        recoverablePostmergeJob(refreshedRun, refreshedJobs, { workflowId: registration.id, now: Date.now(),
          ciLineage }) === jobId, 'HOLD_POSTMERGE_RECOVERY_JOB_MOVED');
    }
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
