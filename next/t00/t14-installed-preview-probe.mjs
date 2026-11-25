import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installed, repoRoot, revision, mode] = process.argv.slice(2);
assert.equal(realpathSync(installed), resolve(installed));
assert.match(revision, /^[0-9a-f]{40}$/u);
assert.ok(mode === 'once' || mode === 'hold');

async function packageModule(relative) {
  const file = join(installed, relative);
  assert.equal(realpathSync(file), file);
  assert.ok(lstatSync(file).isFile());
  return import(pathToFileURL(file));
}

const { previewGeneration } = await packageModule('handles/composition-next/plan.mjs');
const { evaluateCompositionCertification } = await packageModule('handles/composition-next/certification.mjs');
const { auditLegacyProviders } = await packageModule('handles/composition-next/legacy-baseline.mjs');
const { provider: realProvider } = await packageModule('handles/providers/typescript-express.mjs');
const { provider: javaProvider } = await packageModule('handles/providers/java-spring.mjs');
const { provider: pythonProvider } = await packageModule('handles/providers/python-fastapi.mjs');

let emitCalls = 0;
const provider = {
  ...realProvider,
  emit(input) {
    emitCalls++;
    assert.equal(input.dryRun, true);
    assert.equal(input.force, false);
    assert.equal(input.computeDiff, false);
    return realProvider.emit(input);
  },
};
const inputs = { provider, repoRoot, featureId: '001-t14-replay', revision, persistenceId: 'typeorm', keyType: 'uuid',
  handlesPlan: { provider: 'typescript-express', srcRoot: join(repoRoot, 'src'), resources: [{
    type: 'Account', willGenerateResolver: true, idFieldIsUuid: true, idField: 'id', modelImport: 'entities/Account',
    dataSource: { name: 'AppDataSource', file: join(repoRoot, 'src', 'data-source.ts') }, selectFields: ['id'],
  }] } };
const preview = previewGeneration(inputs);
assert.equal(preview.status, 'ready');
assert.equal(preview.applyAllowed, false);
assert.equal(preview.revision, revision);
assert.equal(preview.combination.id, 'typescript-express+typeorm+uuid');
assert.deepEqual(preview.blockers, []);
assert.equal(emitCalls, 1);
for (const path of ['src/handles/resolvers/account.ts', 'src/handles/resolvers/accountPolicy.ts', 'src/handles/router.ts']) {
  assert.ok(preview.plannedWrites.includes(path), path);
}
assert.deepEqual(preview.manualCompletions.filter(item => item.required).map(item => item.area).sort(),
  ['authorization', 'patch']);

const unsupported = previewGeneration({ ...inputs, persistenceId: 'prisma' });
assert.equal(unsupported.status, 'blocked');
assert.equal(unsupported.applyAllowed, false);
assert.deepEqual(unsupported.plannedWrites, []);
assert.deepEqual(unsupported.blockers.map(blocker => blocker.code), ['unsupported-combination']);
assert.equal(emitCalls, 1, 'unsupported request must stop before provider emit');

const audit = auditLegacyProviders([javaProvider, pythonProvider, realProvider]);
assert.equal(audit.ok, true, JSON.stringify(audit.errors));
const behavior = evaluateCompositionCertification({ providerId: realProvider.id, persistenceId: 'typeorm',
  keyType: 'uuid', revision, level: 'behavior-tested', generationPreview: preview,
  providerBaselineAudit: { ...audit, revision }, evidence: [] });
assert.equal(behavior.status, 'blocked');
assert.equal(behavior.certifiedLevel, null);
assert.equal(behavior.applyAllowed, false);
assert.ok(behavior.blockers.some(blocker => blocker.code === 'behavior-handoff-not-integrated'));

console.log(JSON.stringify({ combination: preview.combination.id, previewReady: preview.status === 'ready',
  plannedWrites: preview.plannedWrites.slice().sort(), unsupported: unsupported.blockers[0].code,
  requiredManualCompletions: ['authorization', 'patch'], behavior: 'behavior-handoff-not-integrated',
  behaviorCertified: false, applyAllowed: false, emitCalls }));
if (mode === 'hold') setInterval(() => {}, 60_000);
