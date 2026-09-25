import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildRegisteredProjectGraph, buildRegisteredProjectScanPlan, portableRegistryLoadErrors } from '../../scanners/project-graph/registered.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-project-graph-real-'));
  for (const [rel, content = ''] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('registered first-party adapters stay scoped to their own project roots in a polyglot monorepo', () => {
  const root = fixture({
    'package.json': '{"private":true}',
    'services/spring/pom.xml': '<project/>',
    'services/spring/src/main/java/com/example/App.java': 'package com.example; class App {}',
    'services/fastapi/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'services/fastapi/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/express/package.json': '{"type":"module","dependencies":{"express":"^5.0.0"}}',
    'services/express/src/routes.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/x', handler);\n",
    'services/express/src/routes.js': "import express from 'express';\nconst route = express.Router();\nroute.get('/y', handler);\n",
    'services/rails/Gemfile': 'gem "rails", "~> 8.0"\n',
    'services/rails/config/application.rb': 'class Demo < Rails::Application\nend\n',
    'services/rails/config/routes.rb': 'Rails.application.routes.draw do\n  get "/health", to: "health#show"\nend\n',
  });

  const graph = buildRegisteredProjectGraph(root);
  assert.deepEqual(graph.registry_load_errors, []);
  const byRoot = new Map(graph.projects.map((p) => [p.root, p]));
  assert.equal(byRoot.get('.').kind, 'aggregate');
  assert.equal(byRoot.get('services/spring').facets.http.selected_adapter, 'java-spring');
  assert.equal(byRoot.get('services/fastapi').facets.http.selected_adapter, 'python-fastapi');
  assert.equal(byRoot.get('services/express').facets.http.selected_adapter, 'typescript-express');
  assert.equal(byRoot.get('services/rails').facets.http.selected_adapter, 'ruby-rails');

  assert.deepEqual(
    byRoot.get('services/express').facets.http.candidates.map((x) => x.adapter_id),
    ['typescript-express', 'javascript-express'],
  );

  assert.deepEqual(buildRegisteredProjectScanPlan(root).plan.map((x) => [x.project_root, x.adapter_id]), [
    ['services/express', 'typescript-express'],
    ['services/fastapi', 'python-fastapi'],
    ['services/rails', 'ruby-rails'],
    ['services/spring', 'java-spring'],
  ]);
});


test('registry load diagnostics are portable and do not serialize checkout directories', () => {
  const portable = portableRegistryLoadErrors([
    {
      file: '/private/tmp/work-a/scanners/adapters/broken.mjs',
      message: 'failed to load /private/tmp/work-a/scanners/adapters/broken.mjs: boom',
    },
    {
      file: 'C:\\work-b\\scanners\\adapters\\other.mjs',
      message: 'failed to load C:\\work-b\\scanners\\adapters\\other.mjs: nope',
    },
  ]);
  assert.deepEqual(portable, [
    { file: 'broken.mjs', message: 'failed to load <adapter-dir>/broken.mjs: boom' },
    { file: 'other.mjs', message: 'failed to load <adapter-dir>/other.mjs: nope' },
  ]);
  const serialized = JSON.stringify(portable);
  assert.ok(!serialized.includes('/private/tmp/work-a'));
  assert.ok(!serialized.includes('work-b'));
});
