import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { LEGACY_HTTP_ADAPTER_IDS, legacyHttpBaseline } from '../../adapters/http-legacy-next/baselines.mjs';
import { bridgeLegacyHttpScan } from '../../adapters/http-legacy-next/bridge.mjs';
import {
  LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
  legacyHttpSemanticDigest,
  legacyHttpSemanticSnapshot,
} from '../../adapters/http-legacy-next/parity.mjs';
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

const identityProjector = ({ legacy_semantic_snapshot }) => ({
  projector_contract: 'fixture.projector/1',
  semantic_snapshot: structuredClone(legacy_semantic_snapshot),
});

function shadow(id, overrides = {}) {
  const { report, adapter } = fixture(id);
  const result = runLegacyHttpShadowProjection({
    adapter,
    report,
    projectorId: 'fixture-identity-projector',
    projectorContract: 'fixture.projector/1',
    projector: identityProjector,
    ...overrides,
  });
  return { report, adapter, result };
}

test('T11-03 each legacy adapter gets a shadow result that names it, its projector and its digests', () => {
  for (const id of LEGACY_HTTP_ADAPTER_IDS) {
    const { report, result } = shadow(id);
    assert.equal(result.adapter_id, id, id);
    assert.equal(result.projector_id, 'fixture-identity-projector', id);
    assert.equal(result.projector_contract, 'fixture.projector/1', id);
    assert.equal(result.legacy_semantic_sha256, legacyHttpSemanticDigest(report), id);
    assert.equal(result.projected_semantic_sha256, result.legacy_semantic_sha256, id);
    assert.deepEqual(result.parity, { equal: true, diffs: [], truncated: false }, id);
    assert.equal(result.promotion_allowed, false, id);
  }
});

test('T11-03 the legacy digest comes from the legacy snapshot and the projected digest from the projection', () => {
  const { report, result } = shadow('javascript-express', {
    projector: ({ legacy_semantic_snapshot }) => {
      const semantic_snapshot = structuredClone(legacy_semantic_snapshot);
      semantic_snapshot.verdict = 'drifted';
      return { projector_contract: 'fixture.projector/1', semantic_snapshot };
    },
  });
  const drifted = legacyHttpSemanticSnapshot(report);
  drifted.verdict = 'drifted';

  assert.equal(result.legacy_semantic_sha256, legacyHttpSemanticDigest(report));
  assert.equal(result.projected_semantic_sha256, legacyHttpSemanticDigest(drifted));
  assert.notEqual(result.legacy_semantic_sha256, result.projected_semantic_sha256);
});

test('T11-03 the projector receives the bridge and the legacy snapshot, both frozen, and nothing else', () => {
  const { report, adapter } = fixture('ruby-rails');
  let seen;
  runLegacyHttpShadowProjection({
    adapter,
    report,
    projectorId: 'spy',
    projectorContract: 'fixture.projector/1',
    projector: (input) => {
      seen = input;
      return identityProjector(input);
    },
  });

  assert.deepEqual(Object.keys(seen).sort(), ['bridge', 'legacy_semantic_snapshot']);
  assert.equal(seen.legacy_semantic_snapshot.schema, LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA);
  assert.deepEqual(seen.legacy_semantic_snapshot, legacyHttpSemanticSnapshot(report));
  assert.deepEqual(seen.bridge, bridgeLegacyHttpScan({ adapter, report }));
  assert.equal(seen.bridge.source_adapter.id, 'ruby-rails');
  for (const part of [seen, seen.bridge, seen.bridge.legacy_report, seen.legacy_semantic_snapshot]) {
    assert.ok(Object.isFrozen(part));
  }
});

test('T11-03 the shadow result is deeply frozen and states that the legacy scan stays authoritative', () => {
  const { result } = shadow('java-spring', {
    projector: ({ legacy_semantic_snapshot }) => {
      const semantic_snapshot = structuredClone(legacy_semantic_snapshot);
      semantic_snapshot.confidence = 'drifted';
      return { projector_contract: 'fixture.projector/1', semantic_snapshot };
    },
  });

  for (const part of [result, result.parity, result.parity.diffs, result.parity.diffs[0], result.notes]) {
    assert.ok(Object.isFrozen(part));
  }
  assert.throws(() => { result.promotion_allowed = true; }, TypeError);
  assert.throws(() => { result.parity.equal = true; }, TypeError);
  assert.throws(() => { result.parity.diffs.push({}); }, TypeError);
  assert.throws(() => { result.notes.push('extra'); }, TypeError);
  assert.equal(result.notes.length, 3);
  assert.match(result.notes[0], /The stable legacy scan remains authoritative/);
});

test('T11-03 the shell validates its own arguments before it runs the projector', () => {
  const { report, adapter } = fixture('python-fastapi');
  let calls = 0;
  const countingProjector = (input) => {
    calls += 1;
    return identityProjector(input);
  };
  const run = (overrides = {}) => () => runLegacyHttpShadowProjection({
    adapter,
    report,
    projectorId: 'id',
    projectorContract: 'fixture.projector/1',
    projector: countingProjector,
    ...overrides,
  });

  for (const bad of [undefined, null, 'projector', 42, {}]) {
    assert.throws(run({ projector: bad }), /projector must be a function/, String(bad));
  }
  for (const bad of [undefined, null, '', '   ', 7, {}]) {
    assert.throws(run({ projectorId: bad }), /projectorId must be a non-empty string/, String(bad));
    assert.throws(run({ projectorContract: bad }), /projectorContract must be a non-empty string/, String(bad));
  }
  assert.throws(() => runLegacyHttpShadowProjection(), /projector must be a function/);
  assert.equal(calls, 0);

  assert.equal(run()().parity.equal, true);
  assert.equal(calls, 1);
});

test('T11-03 a projector must return an object carrying its contract, a snapshot and the same adapter', () => {
  const { report, adapter } = fixture('typescript-express');
  const run = (projector) => () => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'id', projectorContract: 'fixture.projector/1', projector,
  });
  const snapshot = () => legacyHttpSemanticSnapshot(report);

  for (const bad of [undefined, null, 'text', 42, true, []]) {
    assert.throws(run(() => bad), /^TypeError: projector must return an object$/, String(bad));
  }
  assert.throws(
    run(() => ({ semantic_snapshot: snapshot() })),
    /projector contract mismatch: expected "fixture\.projector\/1", got "\(missing\)"/,
  );
  assert.throws(
    run(() => ({ projector_contract: 'other/9', semantic_snapshot: snapshot() })),
    /projector contract mismatch: expected "fixture\.projector\/1", got "other\/9"/,
  );
  for (const bad of [undefined, null, {}, { schema: 'other' }]) {
    assert.throws(
      run(() => ({ projector_contract: 'fixture.projector/1', semantic_snapshot: bad })),
      (err) => err.message === `projector must return semantic_snapshot with schema ${LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA}`,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    run(() => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: { schema: LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA },
    })),
    /projected adapter "\(missing\)" does not match legacy adapter "typescript-express"/,
  );
  assert.throws(
    run(() => ({
      projector_contract: 'fixture.projector/1',
      semantic_snapshot: { ...snapshot(), adapter: 'java-spring' },
    })),
    /projected adapter "java-spring" does not match legacy adapter "typescript-express"/,
  );
});

test('T11-03 the shell hands maxDiffs to the comparison and reports truncation', () => {
  const { report, adapter } = fixture('java-spring');
  const threeDifferences = ({ legacy_semantic_snapshot }) => {
    const semantic_snapshot = structuredClone(legacy_semantic_snapshot);
    semantic_snapshot.confidence = 'drift-1';
    semantic_snapshot.verdict = 'drift-2';
    semantic_snapshot.api_surface_source = 'drift-3';
    return { projector_contract: 'fixture.projector/1', semantic_snapshot };
  };
  const run = (extra = {}) => runLegacyHttpShadowProjection({
    adapter, report, projectorId: 'id', projectorContract: 'fixture.projector/1', projector: threeDifferences, ...extra,
  });

  const all = run();
  assert.equal(all.parity.diffs.length, 3);
  assert.equal(all.parity.truncated, false);

  const capped = run({ maxDiffs: 2 });
  assert.equal(capped.parity.diffs.length, 2);
  assert.equal(capped.parity.truncated, true);
  assert.equal(capped.parity.equal, false);

  assert.throws(() => run({ maxDiffs: 0 }), /maxDiffs must be an integer from 1 through 1000/);
  assert.throws(() => run({ maxDiffs: 1001 }), /maxDiffs must be an integer from 1 through 1000/);
});

function checkoutOf(id, dir) {
  fs.cpSync(path.join(REPO_ROOT, legacyHttpBaseline(id).fixture), dir, { recursive: true });
  return {
    root: dir,
    report: runScan({ repoRoot: dir, terms: [] }),
    adapter: ADAPTERS.find((item) => item.id === id),
  };
}

test('T11-03 with a root, the legacy digest and the projector input do not depend on where the checkout lives', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't11-shadow-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const shadowOf = ({ report, adapter, root }, extra = {}) => {
    let seen;
    const result = runLegacyHttpShadowProjection({
      adapter,
      report,
      root,
      projectorId: 'fixture-identity-projector',
      projectorContract: 'fixture.projector/1',
      projector: (input) => {
        seen = input;
        return identityProjector(input);
      },
      ...extra,
    });
    return { result, seen };
  };

  for (const id of LEGACY_HTTP_ADAPTER_IDS) {
    const first = checkoutOf(id, path.join(tmp, 'first', id));
    const second = checkoutOf(id, path.join(tmp, 'second', 'deeper', id));
    const one = shadowOf(first);
    const other = shadowOf(second);

    assert.deepEqual(one.result.parity, { equal: true, diffs: [], truncated: false }, id);
    assert.equal(one.result.legacy_semantic_sha256, other.result.legacy_semantic_sha256, id);
    assert.equal(one.result.legacy_semantic_sha256, legacyHttpSemanticDigest(first.report, { root: first.root }), id);
    assert.deepEqual(one.seen.legacy_semantic_snapshot, legacyHttpSemanticSnapshot(first.report, { root: first.root }), id);
    assert.deepEqual(one.seen.legacy_semantic_snapshot, other.seen.legacy_semantic_snapshot, id);
    assert.ok(!JSON.stringify(one.seen.legacy_semantic_snapshot).includes(first.root), id);

    const without = shadowOf({ ...first, root: undefined });
    assert.deepEqual(without.seen.legacy_semantic_snapshot, legacyHttpSemanticSnapshot(first.report), `${id}: no root keeps the files as reported`);
    assert.notEqual(without.result.legacy_semantic_sha256, one.result.legacy_semantic_sha256, id);
  }
});

test('T11-03 a scan report file outside the root, or a bad root, stops the shell before the projector runs', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't11-shadow-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { root, report, adapter } = checkoutOf('python-fastapi', path.join(tmp, 'checkout'));
  let calls = 0;
  const run = (overrides) => () => runLegacyHttpShadowProjection({
    adapter,
    report,
    root,
    projectorId: 'id',
    projectorContract: 'fixture.projector/1',
    projector: (input) => {
      calls += 1;
      return identityProjector(input);
    },
    ...overrides,
  });

  assert.equal(run({})().parity.equal, true);
  assert.equal(calls, 1);

  assert.throws(run({ root: path.join(tmp, 'another-checkout') }), /is not under root/);
  assert.throws(run({ root: path.join(root, 'no-such-subdirectory') }), /is not under root/);
  for (const bad of ['', 5, null]) {
    assert.throws(run({ root: bad }), /root must be a non-empty string/, String(bad));
  }
  assert.equal(calls, 1, 'the projector did not run again');
});
