import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { buildRegisteredProjectGraph } from '../../scanners/project-graph/registered.mjs';
import { executeProjectScanPlan } from '../../scanners/project-graph/shadow.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-project-shadow-'));
  for (const [rel, content = ''] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('shadow execution reuses legacy runScan independently for every selected project', () => {
  const root = fixture({
    'package.json': '{"private":true}',
    'spring/pom.xml': '<project/>',
    'spring/src/main/java/com/example/App.java': [
      'package com.example;',
      'import org.springframework.web.bind.annotation.*;',
      '@RestController',
      '@RequestMapping("/spring")',
      'class App { @GetMapping("/health") String health() { return "ok"; } }',
    ].join('\\n'),
    'fastapi/pyproject.toml': '[project]\\ndependencies = ["fastapi>=0.100"]\\n',
    'fastapi/app/main.py': [
      'from fastapi import FastAPI, APIRouter',
      'app = FastAPI()',
      'router = APIRouter(prefix="/fast")',
      '@router.get("/health")',
      'def health(): return {"ok": True}',
      'app.include_router(router)',
    ].join('\\n'),
  });

  const graph = buildRegisteredProjectGraph(root);
  const out = executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: ADAPTERS });

  assert.equal(out.schema, 'sbf.project-scan-shadow/draft-1');
  assert.deepEqual(out.scans.map((x) => [x.project_root, x.adapter_id]), [
    ['fastapi', 'python-fastapi'],
    ['spring', 'java-spring'],
  ]);
  assert.ok(out.scans.every((x) => x.report.schema === 'sbf.scan-report/2'));
  assert.ok(out.scans.every((x) => x.report.verdict === 'inventory'));
  assert.ok(out.scans.every((x) => x.report.adapter === x.adapter_id));
  assert.ok(out.scans.every((x) => x.report.files_read.every((f) => !path.isAbsolute(f))));
});

test('shadow execution rejects graph/repository mismatches before scanning', () => {
  const root = fixture({ 'service/package.json': '{}' });
  const graph = buildRegisteredProjectGraph(root);
  const other = fixture({ 'package.json': '{}' });
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: other, graph, terms: [], adapters: ADAPTERS }),
    (err) => err?.code === 'PROJECT_GRAPH_ROOT_MISMATCH',
  );
});

test('shadow execution refuses a plan whose selected adapter is unavailable', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\\ndependencies = ["fastapi>=0.100"]\\n',
    'app/main.py': 'from fastapi import FastAPI\\napp = FastAPI()\\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: [] }),
    (err) => err?.code === 'PROJECT_ADAPTER_UNAVAILABLE',
  );
});


test('shadow execution rejects marker drift instead of running a stale graph', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  fs.appendFileSync(path.join(root, 'app', 'pyproject.toml'), '# drift\n');
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: ADAPTERS }),
    (err) => err?.code === 'PROJECT_GRAPH_STALE' &&
      err?.marker_path === 'app/pyproject.toml' &&
      err?.expected_digest !== err?.actual_digest,
  );
});


test('graph captures the selected adapter source read-set with content hashes and source roles', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'app/tests/helper.py': 'VALUE = 1\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  const project = graph.projects.find((entry) => entry.root === 'app');
  assert.ok(project?.selected_adapter_read_set);
  assert.equal(project.selected_adapter_read_set.adapter_id, 'python-fastapi');
  assert.match(project.selected_adapter_read_set.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    project.selected_adapter_read_set.files.map((file) => [file.path, file.role]),
    [
      ['app/main.py', 'active'],
      ['app/tests/helper.py', 'reference'],
    ],
  );
  assert.ok(project.selected_adapter_read_set.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.digest)));
  assert.ok(graph.files_read.includes('app/main.py'));
  assert.ok(graph.files_read.includes('app/tests/helper.py'));
});

test('shadow execution rejects source-content drift even when project markers are unchanged', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  fs.appendFileSync(path.join(root, 'app', 'main.py'), '# source drift\n');
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: ADAPTERS }),
    (err) => err?.code === 'PROJECT_GRAPH_STALE' &&
      err?.stale_kind === 'adapter-read-set' &&
      err?.expected_fingerprint !== err?.actual_fingerprint,
  );
});

test('shadow execution rejects a newly-added source file that changes the adapter read-set', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  fs.writeFileSync(path.join(root, 'app', 'new_module.py'), 'VALUE = 1\n');
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: ADAPTERS }),
    (err) => err?.code === 'PROJECT_GRAPH_STALE' &&
      err?.stale_kind === 'adapter-read-set' &&
      !err?.expected_files.includes('app/new_module.py') &&
      err?.actual_files.includes('app/new_module.py'),
  );
});


test('serialized graph can execute on an equivalent checkout without persisting an absolute root', () => {
  const files = {
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  };
  const rootA = fixture(files);
  const rootB = fixture(files);
  const graphA = buildRegisteredProjectGraph(rootA);
  const portableGraph = JSON.parse(JSON.stringify(graphA));

  assert.equal(portableGraph.repo_root, '.');
  const out = executeProjectScanPlan({ repoRoot: rootB, graph: portableGraph, terms: [], adapters: ADAPTERS });
  assert.deepEqual(out.scans.map((scan) => [scan.project_root, scan.adapter_id]), [
    ['app', 'python-fastapi'],
  ]);
});


test('shadow execution rejects a deleted source file that changes the adapter read-set', () => {
  const root = fixture({
    'app/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const graph = buildRegisteredProjectGraph(root);
  fs.unlinkSync(path.join(root, 'app', 'main.py'));
  assert.throws(
    () => executeProjectScanPlan({ repoRoot: root, graph, terms: [], adapters: ADAPTERS }),
    (err) => err?.code === 'PROJECT_GRAPH_STALE' &&
      err?.stale_kind === 'adapter-read-set' &&
      err?.expected_files.includes('app/main.py') &&
      !err?.actual_files.includes('app/main.py'),
  );
});
