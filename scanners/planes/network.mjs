import { makeEvidence, domainRecord } from './_evidence.mjs';

const CLIENT_RE = /(?:^|\.)WebSocket$/;

export function collectNetwork(project, units) {
  const evidence = [];
  const deps = project.dependencies ?? {};
  for (const unit of units) {
    for (const c of unit.constructions) {
      if (CLIENT_RE.test(c.name)) evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'network-static', kind: 'websocket-client', value: c.name, node: c }));
      const hasWs = unit.imports.some((i) => i.specifier === 'ws');
      const hasSocketIo = unit.imports.some((i) => i.specifier === 'socket.io');
      const isWsServer = hasWs && /(?:^|\.)(?:WebSocketServer|WebSocket\.Server)$/.test(c.name);
      const isSocketIoServer = hasSocketIo && /(?:^|\.)Server$/.test(c.name);
      if (isWsServer || isSocketIoServer) {
        evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'network-static', kind: 'websocket-server', value: c.name, node: c }));
      }
    }
    for (const call of unit.calls) {
      if (call.name === 'fetch') evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'network-static', kind: 'http-client', value: call.first_string_arg, node: call }));
      const hasHttpImport = unit.imports.some((i) => ['http', 'https', 'node:http', 'node:https'].includes(i.specifier));
      if (hasHttpImport && /(?:^|\.)createServer$/.test(call.name)) {
        evidence.push(makeEvidence({ projectId: project.project_id, role: unit.role, collector: 'network-static', kind: 'http-server', value: call.name, node: call }));
      }
    }
  }
  if (Object.hasOwn(deps, 'ws') || Object.hasOwn(deps, 'socket.io')) {
    evidence.push({
      project_id: project.project_id, kind: 'network-dependency', value: Object.hasOwn(deps, 'ws') ? 'ws' : 'socket.io', role: project.package_role ?? 'active',
      provenance: { source_path: project.package_json, source_digest: project.package_digest, line: null, column: null, collector: 'network-static', confidence: 'direct' },
    });
  }
  if (!evidence.length) return null;
  const active = evidence.filter((e) => e.role === 'active');
  const client = active.some((e) => e.kind === 'websocket-client');
  const server = active.some((e) => e.kind === 'websocket-server');
  const httpServer = active.some((e) => e.kind === 'http-server');
  const httpClient = active.some((e) => e.kind === 'http-client');
  const concrete = client || server || httpServer || httpClient;
  return domainRecord({
    projectId: project.project_id,
    kind: 'network',
    status: concrete ? 'complete' : 'partial',
    evidence,
    capabilities: {
      websocket_client: client,
      websocket_server: server,
      multiplayer_server_claimed: server,
      http_server: httpServer,
      http_client: httpClient,
    },
    notes: client && !server ? ['WebSocket client evidence exists without server evidence; multiplayer server is not claimed.'] : [],
  });
}
