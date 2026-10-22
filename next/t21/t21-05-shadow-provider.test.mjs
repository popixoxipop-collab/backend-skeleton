import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { buildRegisteredProjectGraph } from '../../scanners/project-graph/registered.mjs';
import { executeT21ShadowProvider } from './t21-05-shadow-provider.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = {
  'java-spring': 'test/fixtures/java-spring',
  'python-fastapi': 'test/fixtures/python-fastapi/backend',
  'javascript-express': 'test/fixtures/javascript-express/backend',
};

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't21-05-shadow-provider-'));
  const repoRoot = path.join(temp, 'sources');
  for (const [id, relative] of Object.entries(FIXTURES)) {
    const to = path.join(repoRoot, 'services', id);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(ROOT, relative), to, { recursive: true });
  }
  return {
    temp,
    repoRoot,
    cacheRoot: path.join(temp, 'cache'),
    graph: buildRegisteredProjectGraph(repoRoot, { adapters: ADAPTERS }),
    digests: Object.fromEntries(Object.keys(FIXTURES).map((id) => [
      id, digestJson({ track: 'T21-05', adapter: id, test_revision: 1 }),
    ])),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function options(f) {
  return { repoRoot: f.repoRoot, graph: f.graph, cacheRoot: f.cacheRoot,
    adapters: ADAPTERS, implementationDigests: f.digests, rgAvailable: false,
    maxConcurrency: 2, maxEstimatedBytesInFlight: 96 * 1024 * 1024 };
}

test('T21-05 opt-out returns T02 shadow provider unchanged without creating a cache', async () => {
  const f = fixture();
  try {
    const result = await executeT21ShadowProvider({ ...options(f), shadowEnabled: false, cacheRoot: null, implementationDigests: null });
    assert.equal(result.schema, 'sbf.project-scan-shadow/draft-1');
    assert.equal(result.scans.length, 3);
    assert.equal(fs.existsSync(f.cacheRoot), false);
  } finally { f.cleanup(); }
});

test('T21-05 explicit opt-in binds T02 to T21 and reports cache MISS then HIT with exact report parity', async () => {
  const f = fixture();
  try {
    const off = await executeT21ShadowProvider({ ...options(f), shadowEnabled: false });
    const first = await executeT21ShadowProvider({ ...options(f), shadowEnabled: true });
    const second = await executeT21ShadowProvider({ ...options(f), shadowEnabled: true });
    assert.equal(first.schema, 'sbf.t21-shadow-provider-comparison/1');
    assert.deepEqual(first.direct_provider, off);
    assert.deepEqual(second.direct_provider, off);
    assert.equal(first.shadow.metrics.passed, 3);
    assert.equal(second.shadow.metrics.passed, 3);
    assert.deepEqual(first.shadow.observations.map((x) => x.cache_hit), [false, false, false]);
    assert.deepEqual(second.shadow.observations.map((x) => x.cache_hit), [true, true, true]);
    assert.ok(second.shadow.observations.every((x) => x.semantic_equal && x.cache_key));
    assert.equal(second.shadow.release_authorized, false);

    fs.appendFileSync(path.join(f.repoRoot, 'services/python-fastapi/app/models.py'), '\n# isolated change\n');
    // A stale T02 read-set is never reused: refresh the graph before measuring invalidation.
    await assert.rejects(executeT21ShadowProvider({ ...options(f), shadowEnabled: true }),
      (error) => error?.code === 'PROJECT_GRAPH_STALE');
    f.graph = buildRegisteredProjectGraph(f.repoRoot, { adapters: ADAPTERS });
    const changed = await executeT21ShadowProvider({ ...options(f), shadowEnabled: true });
    const byAdapter = Object.fromEntries(changed.shadow.observations.map((x) => [x.adapter_id, x]));
    assert.equal(byAdapter['python-fastapi'].cache_hit, false);
    assert.equal(byAdapter['java-spring'].cache_hit, true);
    assert.equal(byAdapter['javascript-express'].cache_hit, true);
  } finally { f.cleanup(); }
});

test('T21-05 changed T02 graph marker fails closed and does not expose a stale cached report', async () => {
  const f = fixture();
  try {
    const opt = options(f);
    await executeT21ShadowProvider({ ...opt, shadowEnabled: true });
    fs.appendFileSync(path.join(f.repoRoot, 'services/python-fastapi/pyproject.toml'), '\n# drift\n');
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: true }),
      (error) => error?.code === 'PROJECT_GRAPH_STALE',
    );
  } finally { f.cleanup(); }
});

test('T21-05 corrupt stored blob is reported as failure, never returned as a HIT', async () => {
  const f = fixture();
  try {
    const opt = options(f);
    const first = await executeT21ShadowProvider({ ...opt, shadowEnabled: true });
    const artifact = first.shadow.observations.find((x) => x.adapter_id === 'java-spring').artifact;
    const blobPath = path.join(f.cacheRoot, '.sbf/cache-next/artifacts/blobs/sha256', artifact.digest.slice(0, 2), artifact.digest);
    fs.writeFileSync(blobPath, 'corrupted');
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: true }),
      (error) => error?.code === 'T21_SHADOW_TASK_FAILED' && Array.isArray(error.detail) &&
        error.detail.some((row) => row.status === 'failed' && /integrity check/i.test(row.error)),
    );
  } finally { f.cleanup(); }
});

test('T21-05 refuses non-isolated cache roots, missing digests and invalid opt-in types before execution', async () => {
  const f = fixture();
  try {
    const opt = options(f);
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: true, cacheRoot: path.join(f.repoRoot, 'inside') }),
      (error) => error.code === 'T21_CACHE_ROOT_INSIDE_REPO',
    );
    const link = path.join(f.temp, 'unsafe-cache-link');
    fs.symlinkSync(f.repoRoot, link);
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: true, cacheRoot: link }),
      (error) => error.code === 'T21_CACHE_ROOT_INSIDE_REPO',
    );
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: true, implementationDigests: {} }),
      (error) => error.code === 'T21_IMPLEMENTATION_DIGEST_MISSING',
    );
    await assert.rejects(
      executeT21ShadowProvider({ ...opt, shadowEnabled: 'yes' }),
      /shadowEnabled must be a boolean/,
    );
  } finally { f.cleanup(); }
});
