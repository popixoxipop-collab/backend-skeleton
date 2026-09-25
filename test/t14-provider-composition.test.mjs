import test from 'node:test';
import assert from 'node:assert/strict';
import { provider as javaSpring } from '../handles/providers/java-spring.mjs';
import { provider as pythonFastApi } from '../handles/providers/python-fastapi.mjs';
import { provider as typeScriptExpress } from '../handles/providers/typescript-express.mjs';
import { auditLegacyProviders } from '../handles/composition-next/legacy-baseline.mjs';
import { listApprovedCombinations, resolveApprovedCombination } from '../handles/composition-next/catalog.mjs';
import { previewGeneration } from '../handles/composition-next/plan.mjs';
import { describeResourceGeneration } from '../handles/composition-next/safety-profile.mjs';

function fakeProvider(id = 'java-spring', result = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      id,
      contract: 'sbf.handles-provider/1',
      requiresCapabilities: ['resource.fetch'],
      outputs: { spec: ['handles/migration.sql'] },
      plan() {},
      emit(args) {
        calls.push(args);
        return result;
      },
    },
  };
}

test('T14 baseline: existing providers still expose the semantics composition-next relies on', () => {
  const result = auditLegacyProviders([javaSpring, pythonFastApi, typeScriptExpress]);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('T14 baseline auditor ignores future providers but catches semantic drift in a legacy provider', () => {
  const providers = ['java-spring', 'python-fastapi', 'typescript-express'].map((id) => fakeProvider(id).provider);
  providers.push(fakeProvider('future-provider').provider);
  assert.equal(auditLegacyProviders(providers).ok, true);
  providers[0].outputs.spec = [];
  const failed = auditLegacyProviders(providers);
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some((message) => message.includes('java-spring: outputs.spec changed')));
});

test('T14 combination catalog is explicit and fail-closed', () => {
  assert.equal(listApprovedCombinations().length, 3);
  assert.equal(resolveApprovedCombination({ providerId: 'typescript-express', persistenceId: 'typeorm', keyType: 'uuid' })?.id, 'typescript-express+typeorm+uuid');
  assert.equal(resolveApprovedCombination({ providerId: 'typescript-express', persistenceId: 'prisma', keyType: 'uuid' }), null);
  assert.equal(resolveApprovedCombination({ providerId: 'java-spring', persistenceId: 'jpa-hibernate', keyType: 'integer' }), null);
});

test('T14 preview forces provider dryRun and never grants apply permission', () => {
  const { provider, calls } = fakeProvider('java-spring', {
    written: ['src/handles/registry.java'],
    actions: [{ path: 'src/handles/registry.java', kind: 'infra', action: 'create' }],
    conflicts: [],
    orphans: [],
    notes: ['preview only'],
  });
  const plan = previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    handlesPlan: { provider: 'java-spring', resources: [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }] },
    persistenceId: 'jpa-hibernate',
    keyType: 'uuid',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].force, false);
  assert.equal(calls[0].computeDiff, false);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.applyAllowed, false);
  assert.deepEqual(plan.plannedWrites, ['src/handles/registry.java']);
});

test('T14 preview blocks unsupported compositions before provider emit is called', () => {
  const { provider, calls } = fakeProvider('typescript-express');
  const plan = previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    handlesPlan: { provider: 'typescript-express', resources: [] },
    persistenceId: 'prisma',
    keyType: 'uuid',
  });
  assert.equal(calls.length, 0);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.blockers[0].code, 'unsupported-combination');
});

test('T14 preview turns conflicts, orphans, and registry gaps into apply blockers', () => {
  const { provider } = fakeProvider('python-fastapi', {
    written: ['pkg/handles/router.py'],
    conflicts: [{ path: 'pkg/handles/router.py', reason: 'hand edited' }],
    orphans: [{ path: 'pkg/handles/resolvers/old.py', reason: 'stale generated resolver' }],
    registrationGaps: [{ file: 'pkg/routes/users.py', resourceType: 'User', note: 'no snapshot registration' }],
  });
  const plan = previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    handlesPlan: { provider: 'python-fastapi', resources: [{ type: 'User', willGenerateResolver: true }] },
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    enforceRegistry: true,
  });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.applyAllowed, false);
  assert.deepEqual(plan.blockers.map((b) => b.code), ['generated-file-conflict', 'generated-file-orphan', 'registry-bootstrap-gap']);
});

test('T14 preview rejects a provider/handles-plan mismatch', () => {
  const { provider } = fakeProvider('java-spring');
  assert.throws(() => previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    handlesPlan: { provider: 'python-fastapi', resources: [] },
    persistenceId: 'jpa-hibernate',
    keyType: 'uuid',
  }), /provider mismatch/);
});


test('T14 safety profile exposes Python/TypeScript authorization and patch as manual fail-closed completions', () => {
  for (const providerId of ['python-fastapi', 'typescript-express']) {
    const result = describeResourceGeneration({
      providerId,
      handlesPlan: { resources: [{ type: 'User', willGenerateResolver: true }] },
    });
    assert.equal(result.decisions[0].authorization, 'fail-closed-stub');
    assert.equal(result.decisions[0].patch, 'fail-closed-stub');
    assert.deepEqual(result.manualCompletions.map((x) => x.area), ['authorization', 'patch']);
  }
});

test('T14 preview refuses to emit when explicitly requested resource is not generatable', () => {
  const { provider, calls } = fakeProvider('java-spring');
  const result = previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    persistenceId: 'jpa-hibernate',
    keyType: 'uuid',
    resourceFilter: ['LegacyUser'],
    handlesPlan: {
      provider: 'java-spring',
      resources: [{ type: 'LegacyUser', willGenerateResolver: false, idFieldIsUuid: false }],
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.some((b) => b.code === 'requested-resource-not-generatable'));
  assert.ok(result.blockers.some((b) => b.code === 'no-generatable-resources'));
});

test('T14 preview keeps skipped resources visible while allowing safe resources in an unfiltered plan', () => {
  const { provider, calls } = fakeProvider('typescript-express', { written: ['src/handles/user.ts'] });
  const result = previewGeneration({
    provider,
    repoRoot: '/repo',
    featureId: '001-demo',
    persistenceId: 'typeorm',
    keyType: 'uuid',
    handlesPlan: {
      provider: 'typescript-express',
      resources: [
        { type: 'User', willGenerateResolver: true, idFieldIsUuid: true },
        { type: 'LegacyUser', willGenerateResolver: false, idFieldIsUuid: false },
      ],
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.resourceDecisions.map((r) => [r.resourceType, r.generated]), [['User', true], ['LegacyUser', false]]);
  assert.deepEqual(result.manualCompletions.map((x) => x.area), ['authorization', 'patch']);
});
