import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PROJECT_GRAPH_DRAFT,
  buildProjectGraph,
  buildProjectScanPlan,
  discoverProjectRoots,
  inferDetectionProjectRoot,
} from '../../scanners/project-graph/index.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-project-graph-'));
  for (const [rel, content = ''] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function adapter(id, specificity, detect, extra = {}) {
  return {
    id, title: id, specificity, confidence: 'high', verificationBasis: 'synthetic-only',
    capabilities: {}, detect, ...extra,
  };
}

function exactMarkerAdapter(id, specificity, marker, detectionShape = 'root') {
  return adapter(id, specificity, (candidateRoot) => {
    const direct = path.join(candidateRoot, marker);
    if (fs.existsSync(direct)) {
      if (detectionShape === 'srcRoot') return path.join(candidateRoot, 'src', 'main', 'java');
      if (detectionShape === 'object') return { projectRoot: candidateRoot, globs: ['*.js'] };
      return candidateRoot;
    }
    // Simulate the legacy adapters' recursive repo-level detection so aggregate ownership is tested.
    const stack = [candidateRoot];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name === 'node_modules') continue;
        const child = path.join(dir, ent.name);
        if (fs.existsSync(path.join(child, marker))) return child;
        stack.push(child);
      }
    }
    return null;
  });
}

const fallback = adapter('generic-grep', 0, () => true, { confidence: 'low' });

test('discovers current and future marker roots deterministically while ignoring generated/vendor trees', () => {
  const root = fixture({
    'z-api/pyproject.toml': '[project]',
    'a-api/package.json': '{}',
    'go-worker/go.mod': 'module example',
    'node_modules/fake/package.json': '{}',
    'dist/fake/package.json': '{}',
    'vendor/fake/Gemfile': "source 'x'",
  });
  const d = discoverProjectRoots(root);
  assert.deepEqual(d.roots.map((x) => x.root), ['a-api', 'go-worker', 'z-api']);
  assert.deepEqual(d.files_read, ['a-api/package.json', 'go-worker/go.mod', 'z-api/pyproject.toml']);
  assert.ok(d.roots.every((x) => x.markers.every((m) => /^sha256:[a-f0-9]{64}$/.test(m.digest))));
});

test('preserves a markerless repository as one candidate for legacy fallback', () => {
  const root = fixture({ 'src/server.js': 'app.get("/x", fn)' });
  const d = discoverProjectRoots(root);
  assert.deepEqual(d.roots.map((x) => x.root), ['.']);
  assert.deepEqual(d.roots[0].markers, []);
});

test('infers existing adapter detection-root shapes without adapter-specific imports', () => {
  const root = fixture({});
  assert.equal(inferDetectionProjectRoot(path.join(root, 'src/main/java')), root);
  assert.equal(inferDetectionProjectRoot(root), root);
  assert.equal(inferDetectionProjectRoot({ projectRoot: root }), root);
  assert.equal(inferDetectionProjectRoot({ srcRoot: path.join(root, 'src/main/java') }), root);
  assert.equal(inferDetectionProjectRoot(true), null);
});

test('polyglot child services are independent projects; aggregate root does not steal them', () => {
  const root = fixture({
    'package.json': '{"private":true}',
    'backend-java/pom.xml': '<project/>',
    'backend-python/pyproject.toml': '[project]',
  });
  const spring = exactMarkerAdapter('java-spring', 100, 'pom.xml', 'srcRoot');
  const fastapi = exactMarkerAdapter('python-fastapi', 90, 'pyproject.toml');
  const g = buildProjectGraph({ repoRoot: root, adapters: [fallback, fastapi, spring] });
  assert.equal(g.schema, PROJECT_GRAPH_DRAFT);
  const byRoot = new Map(g.projects.map((p) => [p.root, p]));
  assert.equal(byRoot.get('.').kind, 'aggregate');
  assert.equal(byRoot.get('.').facets.http.selected_adapter, null);
  assert.deepEqual(byRoot.get('.').nested_detections, [
    { adapter_id: 'java-spring', detected_root: 'backend-java' },
    { adapter_id: 'python-fastapi', detected_root: 'backend-python' },
  ]);
  assert.equal(byRoot.get('backend-java').facets.http.selected_adapter, 'java-spring');
  assert.equal(byRoot.get('backend-python').facets.http.selected_adapter, 'python-fastapi');
  assert.deepEqual(buildProjectScanPlan(g), [
    { project_id: 'project:backend-java', project_root: 'backend-java', adapter_id: 'java-spring', mode: 'first-class' },
    { project_id: 'project:backend-python', project_root: 'backend-python', adapter_id: 'python-fastapi', mode: 'first-class' },
  ]);
});

test('same-framework sibling services remain two projects instead of one repository-wide winner', () => {
  const root = fixture({ 'a/package.json': '{}', 'b/package.json': '{}' });
  const express = exactMarkerAdapter('javascript-express', 80, 'package.json', 'object');
  const g = buildProjectGraph({ repoRoot: root, adapters: [express, fallback] });
  assert.deepEqual(buildProjectScanPlan(g).map((x) => [x.project_root, x.adapter_id]), [
    ['a', 'javascript-express'], ['b', 'javascript-express'],
  ]);
});

test('per-project arbitration preserves all first-class candidates and picks unique highest specificity', () => {
  const root = fixture({ 'package.json': '{}' });
  const js = exactMarkerAdapter('javascript-express', 80, 'package.json', 'object');
  const ts = exactMarkerAdapter('typescript-express', 85, 'package.json');
  const g = buildProjectGraph({ repoRoot: root, adapters: [js, fallback, ts] });
  const http = g.projects[0].facets.http;
  assert.deepEqual(http.candidates.map((x) => x.adapter_id), ['typescript-express', 'javascript-express']);
  assert.equal(http.selected_adapter, 'typescript-express');
  assert.equal(http.selection_reason, 'unique-highest-specificity');
});

test('equal-specificity competition is explicit ambiguity, never arbitrary selection', () => {
  const root = fixture({ 'package.json': '{}' });
  const a = exactMarkerAdapter('a-http', 90, 'package.json');
  const b = exactMarkerAdapter('b-http', 90, 'package.json');
  const g = buildProjectGraph({ repoRoot: root, adapters: [b, a, fallback] });
  const http = g.projects[0].facets.http;
  assert.equal(http.selected_adapter, null);
  assert.equal(http.selection_reason, 'specificity-tie');
  assert.equal(g.projects[0].kind, 'ambiguous');
  assert.equal(g.projects[0].fallback_adapter, null);
  assert.deepEqual(http.ambiguous_adapter_ids, ['a-http', 'b-http']);
  assert.deepEqual(buildProjectScanPlan(g), []);
});

test('fallback is opt-in in the scan plan and never overrides aggregate roots', () => {
  const root = fixture({ 'plain/package.json': '{}', 'plain/src/x.js': 'x' });
  const g = buildProjectGraph({ repoRoot: root, adapters: [fallback] });
  assert.equal(g.projects[0].kind, 'unrecognized');
  assert.deepEqual(buildProjectScanPlan(g), []);
  assert.deepEqual(buildProjectScanPlan(g, { includeFallback: true }), [
    { project_id: 'project:plain', project_root: 'plain', adapter_id: 'generic-grep', mode: 'fallback' },
  ]);
});

test('unknown non-fallback detection shape is recorded and not guessed', () => {
  const root = fixture({ 'package.json': '{}' });
  const weird = adapter('weird-http', 70, () => true);
  const g = buildProjectGraph({ repoRoot: root, adapters: [weird, fallback] });
  assert.equal(g.projects[0].facets.http.selected_adapter, null);
  assert.ok(g.unresolved.some((x) => x.kind === 'unlocated-detection' && x.adapter_id === 'weird-http'));
});

test('adapter detection exceptions are scoped to the project and do not abort the graph', () => {
  const root = fixture({ 'service/package.json': '{}' });
  const broken = adapter('broken-http', 99, () => { throw new Error('boom'); });
  const ok = exactMarkerAdapter('javascript-express', 80, 'package.json', 'object');
  const g = buildProjectGraph({ repoRoot: root, adapters: [broken, ok, fallback] });
  assert.equal(g.projects[0].facets.http.selected_adapter, 'javascript-express');
  assert.ok(g.unresolved.some((x) => x.kind === 'adapter-detect-error' && x.message === 'boom'));
});


test('project graph records direct containment and unique local package dependencies', () => {
  const root = fixture({
    'package.json': '{"private":true,"workspaces":["packages/*"]}',
    'packages/api/package.json': JSON.stringify({
      name: '@demo/api',
      dependencies: { '@demo/shared': 'workspace:*', express: '^5.0.0' },
    }),
    'packages/api/plugin/package.json': JSON.stringify({ name: '@demo/plugin' }),
    'packages/shared/package.json': JSON.stringify({ name: '@demo/shared' }),
  });
  const g = buildProjectGraph({ repoRoot: root, adapters: [fallback] });
  const byRoot = new Map(g.projects.map((p) => [p.root, p]));
  assert.equal(byRoot.get('packages/api').local_package.name, '@demo/api');
  assert.deepEqual(byRoot.get('packages/api').local_package.dependency_names, ['@demo/shared', 'express']);
  assert.deepEqual(g.project_edges, [
    {
      kind: 'contains',
      from_project_id: 'project:.',
      to_project_id: 'project:packages/api',
      evidence: [],
    },
    {
      kind: 'contains',
      from_project_id: 'project:.',
      to_project_id: 'project:packages/shared',
      evidence: [],
    },
    {
      kind: 'contains',
      from_project_id: 'project:packages/api',
      to_project_id: 'project:packages/api/plugin',
      evidence: [],
    },
    {
      kind: 'local-package-dependency',
      from_project_id: 'project:packages/api',
      to_project_id: 'project:packages/shared',
      dependency_name: '@demo/shared',
      evidence: [byRoot.get('packages/api').local_package.evidence],
    },
  ]);
});

test('duplicate local package names remain ambiguous and do not create guessed dependency edges', () => {
  const root = fixture({
    'consumer/package.json': JSON.stringify({
      name: '@demo/consumer',
      dependencies: { '@demo/shared': 'workspace:*' },
    }),
    'shared-a/package.json': JSON.stringify({ name: '@demo/shared' }),
    'shared-b/package.json': JSON.stringify({ name: '@demo/shared' }),
  });
  const g = buildProjectGraph({ repoRoot: root, adapters: [fallback] });
  assert.equal(g.project_edges.filter((e) => e.kind === 'local-package-dependency').length, 0);
  assert.ok(g.unresolved.some((x) =>
    x.kind === 'ambiguous-local-package-name' &&
    x.package_name === '@demo/shared' &&
    x.project_ids.length === 2
  ));
  assert.ok(g.unresolved.some((x) =>
    x.kind === 'ambiguous-local-package-dependency' &&
    x.project_id === 'project:consumer' &&
    x.candidate_project_ids.length === 2
  ));
});

test('malformed package metadata is diagnostic, not a graph-wide failure', () => {
  const root = fixture({
    'broken/package.json': '{ nope',
    'good/package.json': JSON.stringify({ name: '@demo/good' }),
  });
  const g = buildProjectGraph({ repoRoot: root, adapters: [fallback] });
  assert.equal(g.projects.find((p) => p.root === 'broken').local_package, null);
  assert.equal(g.projects.find((p) => p.root === 'good').local_package.name, '@demo/good');
  assert.ok(g.unresolved.some((x) => x.kind === 'package-metadata-read' && x.project_id === 'project:broken'));
});


test('large sibling monorepo discovery and planning stay deterministic', () => {
  const files = {};
  const count = 200;
  for (let i = 0; i < count; i++) {
    const name = '@scale/service-' + String(i).padStart(3, '0');
    files['services/s' + String(i).padStart(3, '0') + '/package.json'] = JSON.stringify({
      name,
      ...(i > 0 ? { dependencies: { ['@scale/service-' + String(i - 1).padStart(3, '0')]: 'workspace:*' } } : {}),
    });
  }
  const root = fixture(files);
  const exactNode = adapter('node-http', 50, (candidateRoot) =>
    fs.existsSync(path.join(candidateRoot, 'package.json')) ? candidateRoot : null
  );

  const first = buildProjectGraph({ repoRoot: root, adapters: [exactNode, fallback] });
  const second = buildProjectGraph({ repoRoot: root, adapters: [fallback, exactNode] });

  assert.equal(first.projects.length, count);
  assert.equal(first.project_edges.filter((e) => e.kind === 'local-package-dependency').length, count - 1);
  assert.equal(buildProjectScanPlan(first).length, count);
  assert.deepEqual(first.projects, second.projects);
  assert.deepEqual(first.project_edges, second.project_edges);
  assert.deepEqual(first.unresolved, second.unresolved);
  assert.deepEqual(first.files_read, second.files_read);
});
