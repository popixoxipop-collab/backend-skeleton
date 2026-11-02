import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverProjects } from './project-discovery.mjs';
import { parseWebgameSource } from '../tools/webgame/parsers/index.mjs';
import { collectThreeJsRuntime } from './planes/threejs-runtime.mjs';
import { collectAssets } from './planes/assets.mjs';
import { collectNetwork } from './planes/network.mjs';
import { collectWorkers } from './planes/worker.mjs';
import { collectApi } from './planes/api.mjs';

const COLLECTORS = [collectThreeJsRuntime, collectApi, collectAssets, collectWorkers, collectNetwork];

function sortEvidence(evidence) {
  return [...evidence].sort((a, b) =>
    String(a.provenance?.source_path ?? '').localeCompare(String(b.provenance?.source_path ?? '')) ||
    (a.provenance?.line ?? 0) - (b.provenance?.line ?? 0) ||
    (a.provenance?.column ?? 0) - (b.provenance?.column ?? 0) ||
    a.kind.localeCompare(b.kind) || String(a.value ?? '').localeCompare(String(b.value ?? ''))
  );
}

function domainSort(a, b) {
  return a.project_id.localeCompare(b.project_id) || a.kind.localeCompare(b.kind);
}

function buildGraph(projects, domains) {
  const nodes = [];
  const edges = [];
  const fileNodes = new Set();

  for (const project of projects) {
    nodes.push({ id: project.project_id, kind: 'project', label: project.name, root: project.root });
  }
  for (const domain of domains) {
    nodes.push({ id: domain.domain_id, kind: 'domain', label: domain.kind, status: domain.status });
    edges.push({ from: domain.project_id, to: domain.domain_id, kind: 'contains-domain' });
    for (const ev of domain.evidence) {
      const source = ev.provenance?.source_path;
      if (!source) continue;
      const fileId = `file:${source}`;
      if (!fileNodes.has(fileId)) {
        fileNodes.add(fileId);
        nodes.push({ id: fileId, kind: 'file', label: source, role: ev.role });
      }
      edges.push({ from: domain.domain_id, to: fileId, kind: 'evidenced-by', evidence_kind: ev.kind });
    }
  }

  const byProject = new Map();
  for (const domain of domains) {
    if (!byProject.has(domain.project_id)) byProject.set(domain.project_id, new Map());
    byProject.get(domain.project_id).set(domain.kind, domain);
  }
  for (const [, map] of byProject) {
    const runtime = map.get('game-runtime');
    if (!runtime) continue;
    for (const dep of ['asset', 'worker', 'network']) {
      const target = map.get(dep);
      if (target) edges.push({ from: runtime.domain_id, to: target.domain_id, kind: `uses-${dep}` });
    }
  }

  const edgeKey = (e) => `${e.from}\0${e.to}\0${e.kind}\0${e.evidence_kind ?? ''}`;
  const uniqueEdges = [...new Map(edges.map((e) => [edgeKey(e), e])).values()];
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  uniqueEdges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return { nodes, edges: uniqueEdges };
}

function normalizeUnresolved(items) {
  return [...items]
    .map((x) => ({
      kind: x.kind ?? 'unknown',
      message: x.message ?? String(x),
      source_path: x.source_path ?? null,
      line: Number.isInteger(x.line) ? x.line : null,
      column: Number.isInteger(x.column) ? x.column : null,
      project_id: x.project_id ?? null,
      role: x.role ?? null,
      confidence: x.confidence ?? 'unresolved',
    }))
    .sort((a, b) => String(a.source_path ?? '').localeCompare(String(b.source_path ?? '')) || (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind));
}

export function scanMultiplane({ repoRoot }) {
  const discovery = discoverProjects(repoRoot);
  const absRoot = path.resolve(repoRoot);
  const filesRead = new Set(discovery.files_read);
  const unresolved = [...discovery.unresolved];
  const projectAnalyses = [];
  const domains = [];

  for (const project of discovery.projects) {
    const units = [];
    for (const source of project.source_files) {
      const abs = path.resolve(absRoot, source.path);
      try {
        const text = fs.readFileSync(abs, 'utf8');
        filesRead.add(source.path);
        const unit = parseWebgameSource({ sourcePath: source.path, text, role: source.role });
        const sourceDigest = `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
        unit.source_digest = sourceDigest;
        for (const key of ['imports', 'dynamicImports', 'constructions', 'calls', 'assets']) {
          for (const node of unit[key] ?? []) node.source_digest = sourceDigest;
        }
        units.push(unit);
        for (const item of unit.unresolved) unresolved.push({ ...item, project_id: project.project_id, role: source.role });
      } catch (err) {
        unresolved.push({
          kind: 'source-read', message: `could not read ${source.path}: ${err.message}`,
          source_path: source.path, line: null, column: null, project_id: project.project_id,
          role: source.role, confidence: 'unresolved',
        });
      }
    }

    const collected = COLLECTORS.map((collector) => collector(project, units)).filter(Boolean);
    for (const d of collected) {
      d.evidence = sortEvidence(d.evidence);
      d.unresolved = normalizeUnresolved(d.unresolved ?? []);
      domains.push(d);
    }

    const roleCounts = {};
    for (const f of project.source_files) roleCounts[f.role] = (roleCounts[f.role] ?? 0) + 1;
    projectAnalyses.push({
      ...project,
      source_role_counts: Object.fromEntries(Object.entries(roleCounts).sort(([a], [b]) => a.localeCompare(b))),
      parsed_source_files: units.length,
    });
  }

  domains.sort(domainSort);
  const graph = buildGraph(projectAnalyses, domains);
  const gameDomains = domains.filter((d) => d.kind === 'game-runtime');
  const apiDomains = domains.filter((d) => d.kind === 'api');
  const networkDomains = domains.filter((d) => d.kind === 'network');

  return {
    schema: 'sbf.multiplane-scan/1',
    repo_root: '.',
    projects: projectAnalyses,
    domains,
    graph,
    unresolved: normalizeUnresolved(unresolved),
    files_read: [...filesRead].sort(),
    summary: {
      project_count: projectAnalyses.length,
      domain_count: domains.length,
      active_game_runtime_count: gameDomains.filter((d) => d.capabilities?.playable_runtime_claimed).length,
      partial_game_runtime_count: gameDomains.filter((d) => !d.capabilities?.playable_runtime_claimed).length,
      api_domain_count: apiDomains.length,
      websocket_server_project_count: networkDomains.filter((d) => d.capabilities?.websocket_server).length,
      unresolved_count: normalizeUnresolved(unresolved).length,
    },
  };
}
