#!/usr/bin/env node
// Live capture of the T00 baseline observation: read-only GitHub REST calls through an authenticated `gh`.
// The CI token cannot read the two private repositories, so this runs on a maintainer machine, not in CI.
// Only identities (SHAs, blob SHAs), workflow run results and a hash of package.json scripts are recorded; no file content.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalSha256 } from './verify-baseline.mjs';

export const REPOS = [
  { role: 'bskel', repo: 'popixoxipop-collab/backend-skeleton' },
  { role: 'becoder', repo: 'popixoxipop-collab/backend-decoder' },
  { role: 'beval', repo: 'popixoxipop-collab/Backend-evaluation' },
];
export const ARTIFACT_PATHS = ['package.json', 'package-lock.json', '.github/workflows/ci.yml'];
const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

const gh = (route) => JSON.parse(execFileSync('gh', ['api', route], { encoding: 'utf8', maxBuffer: 1 << 28 }));

export function captureRepo({ role, repo }) {
  const meta = gh(`repos/${repo}`);
  const branch = meta.default_branch;
  const head = gh(`repos/${repo}/commits/${branch}`);
  const tree = gh(`repos/${repo}/git/trees/${head.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo}: git tree response is truncated, cannot resolve artifact blobs`);
  const artifacts = ARTIFACT_PATHS.map((p) => {
    const entry = tree.tree.find((e) => e.path === p && e.type === 'blob');
    if (!entry) throw new Error(`${repo}: ${p} is not in the tree of ${head.sha}`);
    return { path: p, git_blob_sha: entry.sha };
  });
  const pkgBlob = gh(`repos/${repo}/git/blobs/${artifacts[0].git_blob_sha}`);
  const pkg = JSON.parse(Buffer.from(pkgBlob.content, 'base64').toString('utf8'));
  const runs = gh(`repos/${repo}/actions/runs?head_sha=${head.sha}&per_page=100`).workflow_runs
    .map((r) => ({
      run_id: r.id,
      workflow: r.name,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      created_at: r.created_at,
      failed_jobs: FAILING.has(r.conclusion)
        ? gh(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`).jobs
            .filter((j) => FAILING.has(j.conclusion))
            .map((j) => ({
              name: j.name,
              conclusion: j.conclusion,
              failed_steps: j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name),
              unfinished_steps: j.steps.filter((s) => s.conclusion === null).map((s) => s.name),
            }))
        : [],
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id - b.run_id);
  return {
    role,
    repo,
    visibility: meta.private ? 'private' : 'public',
    default_branch: branch,
    head_sha: head.sha,
    head_committed_at: head.commit.committer.date,
    dirty: null,
    dirty_note: 'remote GitHub observation: there is no work tree, so cleanliness is not observed',
    artifacts,
    package: {
      name: pkg.name,
      version: pkg.version,
      node_engine: pkg.engines?.node ?? null,
      script_names: Object.keys(pkg.scripts ?? {}).sort(),
      scripts_sha256: canonicalSha256(pkg.scripts ?? {}),
    },
    ci_runs_on_exact_head: runs,
  };
}

const INVENTORY_PATH = 'release/next/compatibility-inventory.json';

// The release inventory (owned by T23) pins one commit per repository; record how far each pin is behind the observed head.
export function captureInventory(repositories) {
  const bskel = repositories.find((r) => r.role === 'bskel');
  const file = gh(`repos/${bskel.repo}/contents/${INVENTORY_PATH}?ref=${bskel.head_sha}`);
  const pinned = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')).coordination_baseline.repositories;
  return {
    source: { repo: bskel.repo, path: INVENTORY_PATH, ref: bskel.head_sha, git_blob_sha: file.sha, pin_field: 'coordination_baseline.repositories.<role>' },
    pins: repositories.map((r) => {
      const cmp = gh(`repos/${r.repo}/compare/${pinned[r.role]}...${r.head_sha}?per_page=1`);
      return { role: r.role, pinned_sha: pinned[r.role], compare_status: cmp.status, head_ahead_by: cmp.ahead_by, head_behind_by: cmp.behind_by };
    }),
  };
}

export function captureObservation(repos = REPOS, now = new Date()) {
  const repositories = repos.map(captureRepo);
  return {
    schema: 'bskel.t00-observation/1',
    observed_at: now.toISOString(),
    source: 'GitHub REST API through an authenticated gh CLI, read-only',
    tooling: { node: process.version, gh: execFileSync('gh', ['--version'], { encoding: 'utf8' }).split('\n')[0] },
    routes: [
      'repos/{repo}',
      'repos/{repo}/commits/{default_branch}',
      'repos/{repo}/git/trees/{head_sha}?recursive=1',
      'repos/{repo}/git/blobs/{package_json_blob}',
      'repos/{repo}/actions/runs?head_sha={head_sha}&per_page=100',
      'repos/{repo}/actions/runs/{run_id}/jobs?per_page=100 (only for runs that did not succeed)',
      `repos/{bskel}/contents/${INVENTORY_PATH}?ref={bskel_head_sha}`,
      'repos/{repo}/compare/{pinned_sha}...{head_sha}?per_page=1 (status and counts only are kept)',
    ],
    repositories,
    inventory: captureInventory(repositories),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node next/t00/capture-observation.mjs <observation.json>');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(out, `${JSON.stringify(captureObservation(), null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}
