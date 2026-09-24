import { makeEvidence, domainRecord } from './_evidence.mjs';

const API_PACKAGES = new Set(['express', 'fastify', 'koa', 'hono', '@hapi/hapi']);

export function collectApi(project, units) {
  const evidence = [];
  const deps = project.dependencies ?? {};
  for (const dep of Object.keys(deps).sort()) {
    if (!API_PACKAGES.has(dep)) continue;
    evidence.push({
      project_id: project.project_id, kind: 'api-dependency', value: dep, role: project.package_role ?? 'active',
      provenance: { source_path: project.package_json, source_digest: project.package_digest, line: null, column: null, collector: 'api-static', confidence: 'direct' },
    });
  }
  const projectHasApiPackage = Object.keys(deps).some((dep) => API_PACKAGES.has(dep));
  for (const unit of units) {
    const unitHasApiImport = unit.imports.some((imp) => API_PACKAGES.has(imp.specifier));
    for (const imp of unit.imports) {
      if (API_PACKAGES.has(imp.specifier)) evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'api-static', kind: 'api-import', value: imp.specifier, node: imp }));
    }
    if (!(projectHasApiPackage || unitHasApiImport)) continue;
    for (const call of unit.calls) {
      if (['express', 'fastify', 'koa', 'hono'].some((n) => call.name === n || call.name.endsWith(`.${n}`))) {
        evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'api-static', kind: 'api-bootstrap', value: call.name, node: call }));
      }
      if (/\.(?:get|post|put|patch|delete|use)$/.test(call.name)) {
        evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'api-static', kind: 'route-call', value: call.name, node: call }));
      }
    }
  }
  if (!evidence.length) return null;
  const active = evidence.filter((e) => e.role === 'active');
  const bootstrap = active.some((e) => e.kind === 'api-bootstrap' || e.kind === 'route-call');
  return domainRecord({
    projectId: project.project_id,
    kind: 'api',
    status: bootstrap ? 'complete' : 'partial',
    evidence,
    capabilities: { active_api_source: bootstrap },
    notes: bootstrap ? [] : ['API dependency/import detected without an active bootstrap or route call.'],
  });
}
