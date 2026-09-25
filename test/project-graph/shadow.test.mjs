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
