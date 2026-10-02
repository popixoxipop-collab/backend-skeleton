import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { legacyHttpBaseline } from '../../adapters/http-legacy-next/baselines.mjs';
import {
  runLegacyHttpShadowProjection,
  T11_SHADOW_PROJECTION_SCHEMA,
} from '../../adapters/http-legacy-next/shadow-projection.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fixture(id) {
  const baseline = legacyHttpBaseline(id);
  const report = runScan({ repoRoot: path.join(REPO_ROOT, baseline.fixture), terms: [] });
  const adapter = ADAPTERS.find((item) => item.id === id);
  return { report, adapter };
}

test('T11-03 shadow shell proves parity without making projection authoritative', () => {
  const { report, adapter } = fixture('python-fastapi');
  const result = runLegacyHttpShadowProjection({
    adapter,
    report,
    projectorId: 'fixture-identity-projector',
    projectorContract: 'fixture.projector/1',
    projector: ({ legacy_semantic_snapshot }) => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: structuredClone(legacy_semantic_snapshot),
    }),
  });

  assert.equal(result.schema, T11_SHADOW_PROJECTION_SCHEMA);
  assert.equal(result.mode, 'shadow-only');
  assert.equal(result.authoritative_source, 'sbf.scan-report/2');
  assert.equal(result.parity.equal, true);
  assert.deepEqual(result.parity.diffs, []);
  assert.equal(result.legacy_semantic_sha256, result.projected_semantic_sha256);
  assert.equal(result.promotion_allowed, false);
});

test('T11-03 shadow shell reports precise semantic drift from a candidate projector', () => {
  const { report, adapter } = fixture('javascript-express');
  const result = runLegacyHttpShadowProjection({
    adapter,
    report,
    projectorId: 'fixture-drift-projector',
    projectorContract: 'fixture.projector/1',
    projector: ({ legacy_semantic_snapshot }) => {
      const semantic_snapshot = structuredClone(legacy_semantic_snapshot);
      semantic_snapshot.modules[0].controllers[0].endpoints[0].path = '/wrong';
      return { projector_contract: 'fixture.projector/1', semantic_snapshot };
    },
  });

  assert.equal(result.parity.equal, false);
  assert.equal(result.promotion_allowed, false);
  assert.ok(result.parity.diffs.some((diff) => diff.path.endsWith('.path')));
  assert.notEqual(result.legacy_semantic_sha256, result.projected_semantic_sha256);
});

test('T11-03 shadow shell rejects projector schema, adapter, and contract mismatch', () => {
  const { report, adapter } = fixture('ruby-rails');

  assert.throws(() => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'bad-contract', projectorContract: 'fixture.projector/1',
    projector: ({ legacy_semantic_snapshot }) => ({
      projector_contract: 'fixture.projector/2',
      semantic_snapshot: legacy_semantic_snapshot,
    }),
  }), /projector contract mismatch/);

  assert.throws(() => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'bad-schema', projectorContract: 'fixture.projector/1',
    projector: () => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: { schema: 'something-else', adapter: 'ruby-rails' },
    }),
  }), /semantic_snapshot/);

  assert.throws(() => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'bad-adapter', projectorContract: 'fixture.projector/1',
    projector: ({ legacy_semantic_snapshot }) => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: { ...legacy_semantic_snapshot, adapter: 'java-spring' },
    }),
  }), /does not match legacy adapter/);
});

test('T11-03 projector input is deeply frozen and cannot mutate the legacy oracle', () => {
  const { report, adapter } = fixture('java-spring');
  const before = structuredClone(report);

  assert.throws(() => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'mutator', projectorContract: 'fixture.projector/1',
    projector: (input) => {
      input.legacy_semantic_snapshot.modules[0].module = 'mutated';
      return {
        projector_contract: 'fixture.projector/1',
        semantic_snapshot: input.legacy_semantic_snapshot,
      };
    },
  }), TypeError);

  assert.deepEqual(report, before);
});

test('T11-03 synchronous shell rejects a Promise projector result', () => {
  const { report, adapter } = fixture('typescript-express');
  assert.throws(() => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'async-projector', projectorContract: 'fixture.projector/1',
    projector: async ({ legacy_semantic_snapshot }) => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: legacy_semantic_snapshot,
    }),
  }), /async projector/);
});

test('T11-03 a rejecting async projector leaves the caller running', () => {
  const href = (...parts) => pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
  const baseline = legacyHttpBaseline('python-fastapi');
  const script = `
    import { runScan } from ${JSON.stringify(href('scanners', 'index.mjs'))};
    import { ADAPTERS } from ${JSON.stringify(href('scanners', 'registry.mjs'))};
    import { runLegacyHttpShadowProjection } from ${JSON.stringify(href('adapters', 'http-legacy-next', 'shadow-projection.mjs'))};
    const report = runScan({ repoRoot: ${JSON.stringify(path.join(REPO_ROOT, baseline.fixture))}, terms: [] });
    const adapter = ADAPTERS.find((item) => item.id === 'python-fastapi');
    try {
      runLegacyHttpShadowProjection({
        adapter, report, projectorId: 'rejecting', projectorContract: 'fixture.projector/1',
        projector: async () => { throw new Error('projector failed'); },
      });
      console.log('NO-THROW');
    } catch (err) {
      console.log('caught ' + err.constructor.name + ': ' + err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log('caller still running');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /caught TypeError: async projector results are not accepted/);
  assert.match(child.stdout, /caller still running/);
  assert.doesNotMatch(child.stderr, /projector failed/);
});

test('T11-03 a thenable whose then fails is still rejected as an async projector result', () => {
  const { report, adapter } = fixture('python-fastapi');
  const run = (projector) => () => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'thenable', projectorContract: 'fixture.projector/1', projector,
  });
  const asyncRejection = (err) => err instanceof TypeError && /async projector/.test(err.message);

  assert.throws(run(() => ({ then() { throw new Error('then exploded'); } })), asyncRejection);
  assert.throws(run(() => Object.defineProperty({}, 'then', {
    get() { throw new Error('getter exploded'); },
  })), asyncRejection);
  assert.throws(run(() => ({ then: () => {} })), asyncRejection);
});

test('T11-03 a projector cannot change the adapter by rewriting the report it closes over', () => {
  const rewrite = (id, projectedAdapter) => {
    const { report, adapter } = fixture(id);
    return runLegacyHttpShadowProjection({
      adapter, report, projectorId: 'rewriter', projectorContract: 'fixture.projector/1',
      projector: ({ legacy_semantic_snapshot }) => {
        report.adapter = 'python-fastapi';
        return {
          projector_contract: 'fixture.projector/1',
          semantic_snapshot: { ...structuredClone(legacy_semantic_snapshot), adapter: projectedAdapter },
        };
      },
    });
  };

  assert.throws(() => rewrite('java-spring', 'python-fastapi'), /does not match legacy adapter "java-spring"/);
  const result = rewrite('java-spring', 'java-spring');
  assert.equal(result.adapter_id, 'java-spring');
  assert.equal(result.parity.equal, true);
});
