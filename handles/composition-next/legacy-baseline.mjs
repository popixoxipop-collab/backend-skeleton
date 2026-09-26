const BASELINE = Object.freeze({
  'java-spring': Object.freeze({
    contract: 'sbf.handles-provider/1',
    requiresCapabilities: Object.freeze(['resource.fetch']),
    outputsSpec: Object.freeze(['handles/migration.sql']),
  }),
  'python-fastapi': Object.freeze({
    contract: 'sbf.handles-provider/1',
    requiresCapabilities: Object.freeze(['resource.fetch']),
    outputsSpec: Object.freeze(['handles/migration.sql']),
  }),
  'typescript-express': Object.freeze({
    contract: 'sbf.handles-provider/1',
    requiresCapabilities: Object.freeze(['resource.fetch']),
    outputsSpec: Object.freeze(['handles/migration.sql']),
  }),
});

export const LEGACY_PROVIDER_IDS = Object.freeze(Object.keys(BASELINE));

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function auditLegacyProviders(providers, { revision = null } = {}) {
  const errors = [];
  const byId = new Map((providers ?? []).map((provider) => [provider?.id, provider]));
  const observed = [];

  for (const id of LEGACY_PROVIDER_IDS) {
    const expected = BASELINE[id];
    const provider = byId.get(id);
    if (!provider) {
      errors.push(`${id}: provider missing`);
      continue;
    }
    if (provider.contract !== expected.contract) {
      errors.push(`${id}: contract changed from ${expected.contract} to ${String(provider.contract)}`);
    }
    if (!sameStrings(provider.requiresCapabilities, expected.requiresCapabilities)) {
      errors.push(`${id}: requiresCapabilities changed from [${expected.requiresCapabilities.join(', ')}] to [${Array.isArray(provider.requiresCapabilities) ? provider.requiresCapabilities.join(', ') : String(provider.requiresCapabilities)}]`);
    }
    if (!sameStrings(provider.outputs?.spec, expected.outputsSpec)) {
      errors.push(`${id}: outputs.spec changed from [${expected.outputsSpec.join(', ')}] to [${Array.isArray(provider.outputs?.spec) ? provider.outputs.spec.join(', ') : String(provider.outputs?.spec)}]`);
    }
    if (typeof provider.plan !== 'function') errors.push(`${id}: provider.plan is not a function`);
    if (typeof provider.emit !== 'function') errors.push(`${id}: provider.emit is not a function`);
    observed.push({
      id,
      contract: provider.contract,
      requiresCapabilities: Array.isArray(provider.requiresCapabilities) ? [...provider.requiresCapabilities] : provider.requiresCapabilities,
      outputsSpec: Array.isArray(provider.outputs?.spec) ? [...provider.outputs.spec] : provider.outputs?.spec,
    });
  }

  return {
    schema: 'sbf.handles-provider-baseline-audit/0',
    revision,
    ok: errors.length === 0,
    expectedProviderIds: [...LEGACY_PROVIDER_IDS],
    observed,
    errors,
  };
}
