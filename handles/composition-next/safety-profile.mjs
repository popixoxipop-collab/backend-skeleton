const PROFILES = Object.freeze({
  'java-spring': Object.freeze({
    fetch: 'provider-backed-read',
    authorization: 'provider-policy',
    patch: 'provider-policy',
    recover: 'provider-policy',
  }),
  'python-fastapi': Object.freeze({
    fetch: 'provider-backed-read',
    authorization: 'fail-closed-stub',
    patch: 'fail-closed-stub',
    recover: 'gated-by-access-stub',
  }),
  'typescript-express': Object.freeze({
    fetch: 'provider-backed-read',
    authorization: 'fail-closed-stub',
    patch: 'fail-closed-stub',
    recover: 'gated-by-access-stub',
  }),
});

export function describeResourceGeneration({ providerId, handlesPlan, resourceFilter = null }) {
  const profile = PROFILES[providerId];
  if (!profile) throw new Error(`no conservative generation profile for provider ${providerId}`);
  const wanted = resourceFilter ? new Set(resourceFilter) : null;
  const resources = Array.isArray(handlesPlan?.resources) ? handlesPlan.resources : [];
  const selected = resources.filter((resource) => !wanted || wanted.has(resource?.type));
  const decisions = selected.map((resource) => {
    const generated = resource?.willGenerateResolver === true;
    const reasons = [];
    if (!generated) reasons.push('provider plan did not mark this resource as safe for resolver generation');
    if (resource?.idFieldIsUuid === false) reasons.push('resource primary key is explicitly non-UUID');
    return {
      resourceType: resource?.type ?? null,
      generated,
      fetch: generated ? profile.fetch : 'not-generated',
      authorization: generated ? profile.authorization : 'not-generated',
      patch: generated ? profile.patch : 'not-generated',
      recover: generated ? profile.recover : 'not-generated',
      reasons,
    };
  });

  const manualCompletions = [];
  for (const decision of decisions) {
    if (!decision.generated) continue;
    if (decision.authorization === 'fail-closed-stub') {
      manualCompletions.push({
        resourceType: decision.resourceType,
        area: 'authorization',
        required: true,
        reason: 'generated access check intentionally denies until the target application wires its own authorization semantics',
      });
    }
    if (decision.patch === 'fail-closed-stub') {
      manualCompletions.push({
        resourceType: decision.resourceType,
        area: 'patch',
        required: true,
        reason: 'generated patch path intentionally returns/throws not-implemented until the target application wires its own update semantics',
      });
    }
  }

  const requestedMissing = wanted
    ? [...wanted].filter((type) => !selected.some((resource) => resource?.type === type))
    : [];

  return {
    decisions,
    generatedResourceTypes: decisions.filter((d) => d.generated).map((d) => d.resourceType),
    skippedResourceTypes: decisions.filter((d) => !d.generated).map((d) => d.resourceType),
    requestedMissing,
    manualCompletions,
  };
}
