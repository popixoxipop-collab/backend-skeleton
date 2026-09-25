import { resolveApprovedCombination } from './catalog.mjs';
import { describeResourceGeneration } from './safety-profile.mjs';

function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider is required');
  if (typeof provider.id !== 'string' || provider.id.length === 0) throw new TypeError('provider.id is required');
  if (typeof provider.emit !== 'function') throw new TypeError(`provider ${provider.id}: emit must be a function`);
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function normalizeActions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((action) => ({
    path: action?.path ?? null,
    kind: action?.kind ?? null,
    action: action?.action ?? null,
    ...(action?.resourceType ? { resourceType: action.resourceType } : {}),
  }));
}

export function previewGeneration({
  provider,
  repoRoot,
  featureId,
  revision = null,
  handlesPlan,
  persistenceId,
  keyType,
  resourceFilter = null,
  enforceRegistry = false,
}) {
  assertProvider(provider);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot is required');
  if (typeof featureId !== 'string' || featureId.length === 0) throw new TypeError('featureId is required');
  if (!handlesPlan || typeof handlesPlan !== 'object') throw new TypeError('handlesPlan is required');
  if (handlesPlan.provider && handlesPlan.provider !== provider.id) {
    throw new Error(`provider mismatch: handles plan belongs to ${handlesPlan.provider}, got ${provider.id}`);
  }

  const combination = resolveApprovedCombination({ providerId: provider.id, persistenceId, keyType });
  if (!combination) {
    return {
      schema: 'sbf.handles-composition-plan/0',
      status: 'blocked',
      applyAllowed: false,
      providerId: provider.id,
      featureId,
      revision,
      combination: null,
      plannedWrites: [],
      actions: [],
      blockers: [{
        code: 'unsupported-combination',
        message: `no approved handles composition for provider=${provider.id}, persistence=${String(persistenceId)}, keyType=${String(keyType)}`,
      }],
      notes: [],
    };
  }

  const resourceSafety = describeResourceGeneration({ providerId: provider.id, handlesPlan, resourceFilter });
  const preflightBlockers = [];
  if (resourceSafety.requestedMissing.length > 0) {
    preflightBlockers.push({
      code: 'requested-resource-missing',
      message: `requested resources not present in handles plan: ${resourceSafety.requestedMissing.join(', ')}`,
    });
  }
  if (resourceFilter && resourceSafety.skippedResourceTypes.length > 0) {
    preflightBlockers.push({
      code: 'requested-resource-not-generatable',
      message: `provider plan refused resolver generation for: ${resourceSafety.skippedResourceTypes.join(', ')}`,
    });
  }
  if (resourceSafety.generatedResourceTypes.length === 0) {
    preflightBlockers.push({
      code: 'no-generatable-resources',
      message: 'provider plan contains no resources approved for resolver generation',
    });
  }
  if (preflightBlockers.length > 0) {
    return {
      schema: 'sbf.handles-composition-plan/0',
      status: 'blocked',
      applyAllowed: false,
      providerId: provider.id,
      featureId,
      revision,
      combination,
      plannedWrites: [],
      actions: [],
      resourceDecisions: resourceSafety.decisions,
      manualCompletions: resourceSafety.manualCompletions,
      blockers: preflightBlockers,
      notes: [],
    };
  }

  const preview = provider.emit({
    repoRoot,
    featureId,
    plan: handlesPlan,
    resourceFilter,
    force: false,
    reason: '',
    dryRun: true,
    computeDiff: false,
    enforceRegistry,
  }) ?? {};

  const blockers = [];
  for (const conflict of Array.isArray(preview.conflicts) ? preview.conflicts : []) {
    blockers.push({ code: 'generated-file-conflict', path: conflict?.path ?? null, message: conflict?.reason ?? 'generated file conflict' });
  }
  for (const orphan of Array.isArray(preview.orphans) ? preview.orphans : []) {
    blockers.push({ code: 'generated-file-orphan', path: orphan?.path ?? null, message: orphan?.reason ?? 'generated file orphan requires review' });
  }
  for (const gap of Array.isArray(preview.registrationGaps) ? preview.registrationGaps : []) {
    blockers.push({ code: 'registry-bootstrap-gap', path: gap?.file ?? null, resourceType: gap?.resourceType ?? null, message: gap?.note ?? 'registry bootstrap gap' });
  }

  return {
    schema: 'sbf.handles-composition-plan/0',
    status: blockers.length === 0 ? 'ready' : 'blocked',
    applyAllowed: false,
    providerId: provider.id,
    featureId,
    revision,
    combination,
    resourceDecisions: resourceSafety.decisions,
    manualCompletions: resourceSafety.manualCompletions,
    plannedWrites: strings(preview.written),
    forcedWrites: strings(preview.forced),
    actions: normalizeActions(preview.actions),
    blockers,
    notes: [
      ...strings(preview.notes),
      ...strings(preview.postEmitNotes),
    ],
  };
}
