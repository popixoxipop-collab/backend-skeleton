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
