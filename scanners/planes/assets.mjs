import { makeEvidence, domainRecord } from './_evidence.mjs';

export function collectAssets(project, units) {
  const evidence = [];
  for (const unit of units) {
    for (const asset of unit.assets) {
      evidence.push(makeEvidence({
        projectId: project.project_id,
        role: unit.role,
        collector: 'asset-static',
        kind: asset.kind,
        value: asset.value,
        node: asset,
      }));
    }
  }
  if (!evidence.length) return null;
  return domainRecord({
    projectId: project.project_id,
    kind: 'asset',
    status: evidence.some((e) => e.role === 'active') ? 'complete' : 'partial',
    evidence,
    capabilities: {
      active_asset_reference: evidence.some((e) => e.role === 'active'),
      reference_only: evidence.every((e) => e.role !== 'active'),
    },
  });
}
