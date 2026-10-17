export function makeEvidence({ projectId, role, collector, kind, value = null, node, confidence = 'direct', details = null }) {
  if (!node?.source_digest) throw new Error(`evidence node for ${kind} is missing source_digest`);
  return {
    project_id: projectId,
    kind,
    value,
    role,
    provenance: {
      source_path: node.source_path,
      source_digest: node.source_digest,
      line: node.line ?? null,
      column: node.column ?? null,
      collector,
      confidence,
    },
    ...(details ? { details } : {}),
  };
}

export function isActiveEvidence(e) {
  return e.role === 'active';
}

export function domainRecord({ projectId, kind, status, evidence = [], unresolved = [], capabilities = {}, notes = [] }) {
  return {
    schema: 'sbf.plane-adapter/1',
    domain_id: `${projectId}:${kind}`,
    project_id: projectId,
    kind,
    status,
    capabilities,
    evidence,
    unresolved,
    notes,
  };
}
