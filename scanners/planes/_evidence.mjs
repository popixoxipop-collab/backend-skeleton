export function makeEvidence({ projectId, role, collector, kind, value = null, node, confidence = 'direct', details = null }) {
  return {
    project_id: projectId,
    kind,
    value,
    role,
    provenance: {
      source_path: node.source_path,
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
