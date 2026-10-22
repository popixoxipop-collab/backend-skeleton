// T21-05: explicit, compare-only shadow provider. The default remains unmodified T02.
// This file is next/t21-owned, is not an installed package entry, and cannot turn
// on production scan/cache behavior. Its caller must request shadow mode explicitly.
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { buildRegisteredProjectGraph } from '../../scanners/project-graph/registered.mjs';
import { executeProjectScanPlan } from '../../scanners/project-graph/shadow.mjs';
import { runProjectGraphCached } from '../../lib/scan-scheduler-next/project-cache-runner.mjs';
import { buildProjectCachePlan } from '../../lib/scan-scheduler-next/project-cache-plan.mjs';

const DIGEST = /^[a-f0-9]{64}$/;

function fail(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  if (detail !== null) error.detail = detail;
  throw error;
}

function realOrParent(candidate) {
  const base = path.resolve(candidate);
  if (fs.existsSync(base)) return fs.realpathSync(base);
  const parent = path.dirname(base);
  if (base === parent || !fs.existsSync(parent)) fail('T21_CACHE_ROOT_UNVERIFIED', 'cache root parent must already exist');
  return path.join(fs.realpathSync(parent), path.basename(base));
}

function requireIsolatedCacheRoot(repoRoot, cacheRoot) {
  if (typeof cacheRoot !== 'string' || cacheRoot.trim() === '') {
    fail('T21_CACHE_ROOT_REQUIRED', 'shadow mode requires an explicit external cacheRoot');
  }
  const repo = fs.realpathSync(repoRoot);
  const cache = realOrParent(cacheRoot);
  const rel = path.relative(repo, cache);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
    fail('T21_CACHE_ROOT_INSIDE_REPO', 'cacheRoot must be outside the source repository');
  }
}

function requireDigests(graph, implementationDigests, includeFallback) {
  const selected = buildProjectCachePlan(graph, { includeFallback }).projects;
  if (!implementationDigests || typeof implementationDigests !== 'object') {
    fail('T21_IMPLEMENTATION_DIGESTS_REQUIRED', 'shadow mode requires caller-pinned implementationDigests');
  }
  for (const project of selected) {
    const id = project.adapter_id;
    if (!Object.hasOwn(implementationDigests, id) || !DIGEST.test(implementationDigests[id] ?? '')) {
      fail('T21_IMPLEMENTATION_DIGEST_MISSING', 'missing trusted implementation digest for ' + id);
    }
  }
}

// The existing T02 execution is the authority. With shadowEnabled=false, its
// exact output is returned and T21 is not invoked. With shadowEnabled=true,
// T02 executes first and T21 executes separately; the complete JSON report
// for every selected project MUST agree before any shadow observation is emitted.
// Running the direct provider on every invocation is intentional: this is an
// integration acceptance comparator, NOT a low-latency cache production rollout.
export async function executeT21ShadowProvider({
  repoRoot,
  graph = null,
  adapters = ADAPTERS,
  terms = [],
  rgAvailable = false,
  includeFallback = false,
  shadowEnabled = false,
  cacheRoot = null,
  implementationDigests = null,
  policyFingerprint = null,
  maxConcurrency = 2,
  maxEstimatedBytesInFlight = 96 * 1024 * 1024,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') throw new TypeError('repoRoot is required');
  if (typeof shadowEnabled !== 'boolean') throw new TypeError('shadowEnabled must be a boolean');
  if (!Array.isArray(terms) || terms.some((term) => typeof term !== 'string')) throw new TypeError('terms must be a string array');
  if (!Array.isArray(adapters)) throw new TypeError('adapters must be an array');

  const selectedGraph = graph ?? buildRegisteredProjectGraph(repoRoot, { adapters });
  if (shadowEnabled) {
    requireIsolatedCacheRoot(repoRoot, cacheRoot);
    requireDigests(selectedGraph, implementationDigests, includeFallback);
  }
  const reference = executeProjectScanPlan({
    repoRoot, graph: selectedGraph, adapters, terms, rgAvailable, includeFallback,
  });
  if (!shadowEnabled) return reference;

  const candidate = await runProjectGraphCached({
    repoRoot, cacheRoot, graph: selectedGraph, adapters, terms, rgAvailable,
    includeFallback, implementationDigests, policyFingerprint,
    maxConcurrency, maxEstimatedBytesInFlight, useCache: true,
  });
  if (candidate.metrics.failed || candidate.metrics.blocked || candidate.metrics.passed !== reference.scans.length) {
    fail('T21_SHADOW_TASK_FAILED', 'shadow cached execution did not pass every task', candidate.results);
  }
  const byId = new Map(candidate.results.map((entry) => [entry.id, entry]));
  if (byId.size !== reference.scans.length) {
    fail('T21_SHADOW_PROJECT_MISMATCH', 'T02 and T21 selected different project counts');
  }
  const observations = [];
  for (const scan of reference.scans) {
    const entry = byId.get(scan.project_id);
    const value = entry?.value;
    if (!entry || entry.status !== 'passed' || !value ||
        value.project_root !== scan.project_root || value.adapter_id !== scan.adapter_id) {
      fail('T21_SHADOW_PROJECT_MISMATCH', 'T21 selected a different project or adapter');
    }
    if (JSON.stringify(scan.report) !== JSON.stringify(value.report)) {
      fail('T21_SHADOW_SEMANTIC_MISMATCH', 'T21 returned a different legacy scan report');
    }
    observations.push({
      project_id: scan.project_id,
      project_root: scan.project_root,
      adapter_id: scan.adapter_id,
      cache_hit: value.cache_hit,
      cache_key: value.cache_key,
      source_digest: value.source_digest,
      artifact: value.artifact,
      semantic_equal: true,
    });
  }
  return {
    schema: 'sbf.t21-shadow-provider-comparison/1',
    direct_provider: reference,
    shadow: {
      schema: candidate.schema,
      observations,
      metrics: candidate.metrics,
      source: 'explicit T21 comparison runner; T02 remains authority',
      verified_equal: true,
      release_authorized: false,
    },
  };
}
