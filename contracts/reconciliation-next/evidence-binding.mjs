// T09 evidence binding.
//
// Cross-source promotion is allowed only when callers provide explicit repository/revision/build
// metadata proving that scan, OpenAPI and (optionally) runtime observations belong together.
// This module never infers equality from timestamps, filenames, branch names or operation names.

import {
  ROUTE_PROMOTION_FIELDS,
} from './decision-graph.mjs';
import {
  contextBoundPromotableOperationKeys,
} from './openapi-context.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeSource(name, value, { buildRequired = false, environmentRequired = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: name + '-metadata-missing' };
  }
  for (const key of ['ref', 'repository', 'revision']) {
    if (!nonEmptyString(value[key])) return { ok: false, reason: name + '-' + key + '-missing' };
  }
  if (buildRequired && !nonEmptyString(value.buildFingerprint)) {
    return { ok: false, reason: name + '-build-fingerprint-missing' };
  }
  if (environmentRequired && !nonEmptyString(value.environmentFingerprint)) {
    return { ok: false, reason: name + '-environment-fingerprint-missing' };
  }
  return {
    ok: true,
    value: {
      ref: value.ref,
      repository: value.repository,
      revision: value.revision,
      ...(nonEmptyString(value.buildFingerprint) ? { buildFingerprint: value.buildFingerprint } : {}),
      ...(nonEmptyString(value.environmentFingerprint) ? { environmentFingerprint: value.environmentFingerprint } : {}),
    },
  };
}

function sourceSpecDecision(source, openapi) {
  if (!source.ok) return { state: 'unknown', reason: source.reason };
  if (!openapi.ok) return { state: 'unknown', reason: openapi.reason };
  if (source.value.repository !== openapi.value.repository) {
    return { state: 'conflict', reason: 'source-openapi-repository-mismatch' };
  }
  if (source.value.revision !== openapi.value.revision) {
    return { state: 'conflict', reason: 'source-openapi-revision-mismatch' };
  }
  return {
    state: 'bound',
    reason: 'source-openapi-revision-bound',
    repository: source.value.repository,
    revision: source.value.revision,
  };
}

function runtimeDecision(source, openapi, runtime) {
  if (runtime == null) return { state: 'absent', reason: 'runtime-evidence-not-supplied' };
  if (!source.ok) return { state: 'unknown', reason: source.reason };
  if (!openapi.ok) return { state: 'unknown', reason: openapi.reason };
  if (!runtime.ok) return { state: 'unknown', reason: runtime.reason };

  const sourceSpec = sourceSpecDecision(source, openapi);
  if (sourceSpec.state !== 'bound') {
    return { state: sourceSpec.state, reason: sourceSpec.reason };
  }

  if (runtime.value.repository !== source.value.repository) {
    return { state: 'conflict', reason: 'source-runtime-repository-mismatch' };
  }
  if (runtime.value.revision !== source.value.revision) {
    return { state: 'conflict', reason: 'source-runtime-revision-mismatch' };
  }

  // Runtime conformance requires an exact build relation, not merely the same source revision.
  if (!nonEmptyString(openapi.value.buildFingerprint)) {
    return { state: 'unknown', reason: 'openapi-build-fingerprint-missing' };
  }
  if (!nonEmptyString(runtime.value.buildFingerprint)) {
    return { state: 'unknown', reason: 'runtime-build-fingerprint-missing' };
  }
  if (openapi.value.buildFingerprint !== runtime.value.buildFingerprint) {
    return { state: 'conflict', reason: 'openapi-runtime-build-mismatch' };
  }
  if (!nonEmptyString(runtime.value.environmentFingerprint)) {
    return { state: 'unknown', reason: 'runtime-environment-fingerprint-missing' };
  }

  return {
    state: 'bound',
    reason: 'source-openapi-runtime-build-bound',
    repository: source.value.repository,
    revision: source.value.revision,
    buildFingerprint: runtime.value.buildFingerprint,
    environmentFingerprint: runtime.value.environmentFingerprint,
  };
}

export function buildEvidenceBinding({ source, openapi, runtime = null }) {
  const sourceMeta = normalizeSource('source', source);
  const openapiMeta = normalizeSource('openapi', openapi);
  const runtimeMeta = runtime == null
    ? null
    : normalizeSource('runtime', runtime);

  return {
    version: 'bskel.reconciliation-evidence-binding/0-draft',
    source: sourceMeta.ok ? sourceMeta.value : null,
    openapi: openapiMeta.ok ? openapiMeta.value : null,
    runtime: runtimeMeta?.ok ? runtimeMeta.value : null,
    sourceSpec: sourceSpecDecision(sourceMeta, openapiMeta),
    runtimeBinding: runtimeDecision(sourceMeta, openapiMeta, runtimeMeta),
  };
}

function graphRefs(graph) {
  const source = new Set();
  const openapi = new Set();
  for (const endpoint of graph?.endpoints ?? []) {
    for (const field of endpoint.fields ?? []) {
      for (const item of field.evidence ?? []) {
        if (item?.role === 'scan' && nonEmptyString(item.ref)) source.add(item.ref);
        if (item?.role === 'openapi' && nonEmptyString(item.ref)) openapi.add(item.ref);
      }
    }
  }
  return { source, openapi };
}

export function attachEvidenceBinding(graph, binding) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  if (!binding || binding.version !== 'bskel.reconciliation-evidence-binding/0-draft') {
    throw new TypeError('binding must be a T09 evidence binding');
  }

  const refs = graphRefs(graph);
  if (binding.source?.ref && (refs.source.size !== 1 || !refs.source.has(binding.source.ref))) {
    throw new TypeError('source binding ref does not match decision graph provenance');
  }
  if (binding.openapi?.ref && (refs.openapi.size !== 1 || !refs.openapi.has(binding.openapi.ref))) {
    throw new TypeError('OpenAPI binding ref does not match decision graph provenance');
  }

  return {
    ...graph,
    evidenceBinding: {
      attached: true,
      version: binding.version,
      sourceSpecState: binding.sourceSpec.state,
      sourceSpecReason: binding.sourceSpec.reason,
      runtimeState: binding.runtimeBinding.state,
      runtimeReason: binding.runtimeBinding.reason,
      sourceRef: binding.source?.ref ?? null,
      openapiRef: binding.openapi?.ref ?? null,
      runtimeRef: binding.runtime?.ref ?? null,
    },
  };
}

export function bindingBoundPromotableOperationKeys(
  graph,
  binding,
  {
    requiredFields = ROUTE_PROMOTION_FIELDS,
    requireRuntime = false,
  } = {},
) {
  if (binding?.sourceSpec?.state !== 'bound') return [];
  if (requireRuntime && binding?.runtimeBinding?.state !== 'bound') return [];

  const attached = attachEvidenceBinding(graph, binding);
  return contextBoundPromotableOperationKeys(attached, requiredFields);
}
