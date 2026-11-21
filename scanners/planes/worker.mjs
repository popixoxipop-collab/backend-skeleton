import { makeEvidence, domainRecord } from './_evidence.mjs';

export function collectWorkers(project, units) {
  const evidence = [];
  for (const unit of units) {
    for (const c of unit.constructions) {
      if (/(?:^|\.)(?:Worker|SharedWorker)$/.test(c.name)) {
        evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'worker-static', kind: c.name.endsWith('SharedWorker') ? 'shared-worker' : 'worker', value: c.name, node: c }));
      }
    }
  }
  if (!evidence.length) return null;
  return domainRecord({
    projectId: project.project_id,
    kind: 'worker',
    status: evidence.some((e) => e.role === 'active') ? 'complete' : 'partial',
    evidence,
    capabilities: { active_worker: evidence.some((e) => e.role === 'active') },
  });
}
