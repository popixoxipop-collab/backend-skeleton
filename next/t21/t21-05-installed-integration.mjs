// T21-05 opt-in installed-distribution/T02/T21 integration. No production routing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULES = {
  'artifact-store-next/cache-index.mjs': ['createCacheIndex'],
  'artifact-store-next/gc.mjs': ['collectArtifactGarbage'],
  'artifact-store-next/store.mjs': ['createArtifactStore'],
  'scan-scheduler-next/cache-key.mjs': ['buildScanCacheKey', 'digestJson', 'sha256Bytes', 'stableJson'],
  'scan-scheduler-next/cache-runtime.mjs': ['runCachedTask'],
  'scan-scheduler-next/file-index.mjs': ['DEFAULT_EXCLUDED_DIRS', 'buildFileIndex', 'indexEntryMap', 'portablePathIssuesForPaths'],
  'scan-scheduler-next/invalidation.mjs': ['computeInvalidation'],
  'scan-scheduler-next/legacy-cache.mjs': ['runLegacyScanCached'],
  'scan-scheduler-next/performance-policy.mjs': ['evaluatePerformanceGate'],
  'scan-scheduler-next/project-cache-plan.mjs': ['T21_PROJECT_CACHE_PLAN_DRAFT', 'T21_PROJECT_GRAPH_DRAFT', 'buildProjectCachePlan', 'propagateProjectInvalidation'],
  'scan-scheduler-next/project-cache-runner.mjs': ['runProjectGraphCached'],
  'scan-scheduler-next/resource-budget.mjs': ['deriveMemoryAdmission'],
  'scan-scheduler-next/scheduler.mjs': ['runTaskGraph'],
};
const FIXTURES = {
  'java-spring': 'test/fixtures/java-spring',
  'python-fastapi': 'test/fixtures/python-fastapi/backend',
  'javascript-express': 'test/fixtures/javascript-express/backend',
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file) => hash(fs.readFileSync(file));
function command(executable, args, cwd) {
  return execFileSync(executable, args, {
    cwd, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ''), npm_config_update_notifier: 'false' },
  }).trim();
}
function ensurePass(result, count) {
  assert.equal(result.schema, 'sbf.project-scan-cache-shadow/draft-1');
  assert.equal(result.metrics.tasks, count);
  assert.equal(result.metrics.passed, count);
  assert.equal(result.metrics.failed, 0);
  assert.equal(result.metrics.blocked, 0);
  assert.ok(result.metrics.peak_concurrency <= 2);
  assert.ok(result.metrics.peak_estimated_bytes_in_flight <= 96 * 1024 * 1024);
  assert.ok(result.results.every((entry) => entry.status === 'passed'));
  return new Map(result.results.map((entry) => [entry.value.project_root, entry.value]));
}

export async function installedCrossIntegration() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't21-05-pack-'));
  try {
    const sourceHead = command('git', ['rev-parse', 'HEAD'], SOURCE);
    const sourceTree = command('git', ['rev-parse', 'HEAD^{tree}'], SOURCE);
    const clean = command('git', ['status', '--porcelain', '--', ':!next/t21/'], SOURCE);
    assert.equal(clean, '', 'non-owned source changes must not enter this measurement');
    const pack = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], SOURCE));
    assert.equal(pack.length, 1);
    const tarball = path.join(scratch, pack[0].filename);
    assert.ok(fs.statSync(tarball).isFile());
    const archiveDir = process.env.T21_05_ARCHIVE_DIR;
    if (archiveDir) {
      const folder = path.resolve(archiveDir);
      assert.ok(folder !== SOURCE && !folder.startsWith(SOURCE + path.sep), 'archive must stay outside source');
      assert.equal(path.basename(pack[0].filename), pack[0].filename);
      fs.mkdirSync(folder, { recursive: true });
      const archive = path.join(folder, pack[0].filename);
      if (fs.existsSync(archive)) assert.equal(shaFile(archive), shaFile(tarball), 'previous packed evidence differs');
      else fs.copyFileSync(tarball, archive);
      assert.equal(shaFile(archive), shaFile(tarball));
    }
    const packedPaths = pack[0].files.map((entry) => entry.path).sort();
    assert.ok(!packedPaths.some((p) => p.startsWith('next/t21/')), 'T21 evidence harness must not ship');
    const install = path.join(scratch, 'install');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'package.json'), '{"name":"t21-05-consumer","private":true,"type":"module"}\n');
    command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--silent', tarball], install);
    const pkg = path.join(install, 'node_modules/backend-skeleton');
    assert.ok(fs.statSync(path.join(pkg, 'bin/bskel.mjs')).isFile());
    const published = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    assert.equal(published.name, 'backend-skeleton');

    const imported = {}, importedFiles = [];
    for (const [rel, expected] of Object.entries(MODULES)) {
      const modulePath = 'lib/' + rel;
      assert.ok(packedPaths.includes(modulePath), 'missing packed module ' + modulePath);
      const abs = path.join(pkg, modulePath);
      const actual = await import(pathToFileURL(abs).href);
      assert.deepEqual(Object.keys(actual).sort(), [...expected].sort(), 'runtime export mismatch ' + rel);
      imported[rel] = actual;
      importedFiles.push({ path: modulePath, sha256: shaFile(abs), bytes: fs.statSync(abs).size });
    }

    const registry = await import(pathToFileURL(path.join(pkg, 'scanners/registry.mjs')).href);
    const discovery = await import(pathToFileURL(path.join(pkg, 'scanners/project-graph/registered.mjs')).href);
    const provider = await import(pathToFileURL(path.join(pkg, 'scanners/project-graph/shadow.mjs')).href);
    assert.deepEqual(registry.LOAD_ERRORS, []);
    const repoRoot = path.join(scratch, 'polyglot');
    const cacheRoot = path.join(scratch, 'cache');
    const ids = Object.keys(FIXTURES).sort();
    for (const id of ids) {
      const target = path.join(repoRoot, 'services', id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(SOURCE, FIXTURES[id]), target, { recursive: true });
    }
    const graph = discovery.buildRegisteredProjectGraph(repoRoot);
    assert.equal(graph.schema, 'sbf.project-graph/draft-1');
    assert.deepEqual(graph.registry_load_errors, []);
    const selected = graph.projects.filter((p) => p.root.startsWith('services/') && p.facets?.http?.selected_adapter);
    assert.equal(selected.length, 3);
    assert.deepEqual(selected.map((p) => p.facets.http.selected_adapter).sort(), ids);

    const impl = Object.fromEntries(ids.map((id) => [id, hash('t21-05-measurement/1\n' + id + '\n' + shaFile(tarball))]));
    const rgAvailable = spawnSync('rg', ['--version']).status === 0;
    const common = { repoRoot, cacheRoot, graph, adapters: registry.ADAPTERS, implementationDigests: impl,
      rgAvailable, terms: [], maxConcurrency: 2, maxEstimatedBytesInFlight: 96 * 1024 * 1024 };
    const gold = provider.executeProjectScanPlan({ repoRoot, graph, adapters: registry.ADAPTERS, rgAvailable });
    assert.equal(gold.schema, 'sbf.project-scan-shadow/draft-1');
    assert.equal(gold.scans.length, 3);
    const oracle = new Map(gold.scans.map((row) => [row.project_root, row.report]));
    const runShadow = imported['scan-scheduler-next/project-cache-runner.mjs'].runProjectGraphCached;
    const ms = {};
    const measure = async (label, useCache) => {
      const start = process.hrtime.bigint();
      const output = await runShadow({ ...common, useCache });
      ms[label] = Number(process.hrtime.bigint() - start) / 1e6;
      return ensurePass(output, 3);
    };
    const off = await measure('uncached_ms', false);
    const miss = await measure('cold_cache_ms', true);
    const hit = await measure('warm_cache_ms', true);
    for (const id of ids) {
      const rel = 'services/' + id;
      assert.ok(oracle.get(rel), 'missing independent T02 provider result ' + id);
      for (const row of [off.get(rel), miss.get(rel), hit.get(rel)]) {
        assert.equal(row.adapter_id, id);
        assert.equal(JSON.stringify(row.report), JSON.stringify(oracle.get(rel)), 'adapter semantic drift ' + id);
      }
      assert.equal(off.get(rel).cache_hit, false);
      assert.equal(off.get(rel).artifact, null);
      assert.equal(miss.get(rel).cache_hit, false);
      assert.equal(hit.get(rel).cache_hit, true);
      assert.equal(miss.get(rel).cache_key, hit.get(rel).cache_key);
      assert.deepEqual(miss.get(rel).artifact, hit.get(rel).artifact);
    }

    fs.appendFileSync(path.join(repoRoot, 'services/python-fastapi/app/models.py'), '\n# T21-05 isolated edit\n');
    const isolated = await measure('one_project_changed_ms', true);
    assert.equal(isolated.get('services/python-fastapi').cache_hit, false);
    for (const id of ['java-spring', 'javascript-express']) assert.equal(isolated.get('services/' + id).cache_hit, true);

    const markerFile = path.join(repoRoot, 'services/python-fastapi/pyproject.toml');
    const markerBytes = fs.readFileSync(markerFile);
    fs.appendFileSync(markerFile, '\n# T21-05 stale marker\n');
    await assert.rejects(runShadow(common), (error) => error?.code === 'PROJECT_GRAPH_STALE');

    fs.writeFileSync(markerFile, markerBytes);
    const store = imported['artifact-store-next/store.mjs'].createArtifactStore(path.join(cacheRoot, '.sbf/cache-next/artifacts'));
    const artifact = hit.get('services/java-spring').artifact;
    assert.ok(artifact?.digest);
    fs.writeFileSync(store.pathForDigest(artifact.digest), 'corrupt');
    const broken = await runShadow(common);
    assert.equal(broken.metrics.failed, 1);
    assert.equal(broken.metrics.passed, 2);
    assert.ok(broken.results.some((r) => r.status === 'failed' && /integrity check|corrupt/i.test(r.error)));

    return {
      schema: 't21-05.installed-cross-shadow/1', task: 'T21-05',
      source_head: sourceHead, source_tree: sourceTree,
      tarball_sha256: shaFile(tarball), tarball_bytes: fs.statSync(tarball).size,
      installed_version: published.version, packed_file_count: packedPaths.length,
      packed_paths: packedPaths, imported_modules: importedFiles,
      registry_adapter_ids: ids, rg_available: rgAvailable,
      provider: 'installed T02 registered discovery + shadow executeProjectScanPlan',
      runner: 'installed T21 runProjectGraphCached, explicit opt-in',
      checks: {
        packed_modules_13_all_exports: true, independent_t02_t21_semantic_parity_3_adapters: true,
        off_cold_warm: true, isolated_project_invalidation: true,
        stale_manifest_rejected: true, corrupted_artifact_rejected: true,
      }, observations_ms_non_slo: ms,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      release_authorized: false, production_routing_changed: false, gc_deletion_performed: false,
      limitations: [
        'Explicit shadow consumer only; stable CLI and live provider unchanged.',
        'Draft T02 graph, tested cohort only; not all providers or OS versions certified.',
        'Timing data is a smoke observation, not a performance/SLO gate.',
        'Rollback, signed independent review and production promotion remain T21-06.',
      ],
    };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  installedCrossIntegration().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
}
