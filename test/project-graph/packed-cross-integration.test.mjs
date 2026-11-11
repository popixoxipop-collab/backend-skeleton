// T02-05: exercise the real registry and T21 consumer from an installed package.
// This is a disposable package-level shadow check, not live routing or activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function npm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
      npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `npm signal ${result.signal}`);
  assert.equal(result.status, 0, result.stderr?.slice(-1500));
  return result.stdout.trim();
}

function fixture(root) {
  const files = {
    'package.json': '{"private":true}',
    'services/spring/pom.xml': '<project/>',
    'services/spring/src/main/java/com/example/App.java': 'package com.example; class App {}',
    'services/fastapi/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'services/fastapi/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/express/package.json': '{"type":"module","dependencies":{"express":"^5.0.0"}}',
    'services/express/src/routes.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/x', handler);\n",
    'services/express/src/routes.js': "import express from 'express';\nconst route = express.Router();\nroute.get('/y', handler);\n",
    'services/express-js/package.json': '{"type":"module","dependencies":{"express":"^5.0.0"}}',
    'services/express-js/src/routes.js': "import express from 'express';\nconst route = express.Router();\nroute.get('/z', handler);\n",
    'services/rails/Gemfile': 'gem "rails", "~> 8.0"\n',
    'services/rails/config/application.rb': 'class Demo < Rails::Application\nend\n',
    'services/rails/config/routes.rb': 'Rails.application.routes.draw do\n  get "/health", to: "health#show"\nend\n',
  };
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

test('T02-05 packed registry graph feeds a T21 cache plan across all five first-party HTTP adapters',
  { timeout: 180000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t02-packed-cross-'));
    try {
      const pack = JSON.parse(npm(['pack', '--offline', '--ignore-scripts', '--json',
        '--pack-destination', scratch], ROOT));
      assert.equal(pack.length, 1);
      const tarball = path.join(scratch, pack[0].filename);
      const listed = new Map(pack[0].files.map(file => [file.path, file]));
      const required = [
        'scanners/project-graph/registered.mjs',
        'scanners/registry.mjs',
        'lib/scan-scheduler-next/project-cache-plan.mjs',
      ];
      for (const rel of required) assert.ok(listed.has(rel), `not packed: ${rel}`);
      const consumer = path.join(scratch, 'consumer');
      fs.mkdirSync(consumer);
      npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
        '--no-save', '--package-lock=false', '--prefix', consumer, tarball], scratch);
      const installed = path.join(consumer, 'node_modules', 'backend-skeleton');
      assert.equal(fs.realpathSync(installed).startsWith(fs.realpathSync(ROOT) + path.sep), false);
      for (const rel of required) {
        const bytes = fs.readFileSync(path.join(installed, rel));
        assert.equal(bytes.length, listed.get(rel).size, rel);
        assert.equal(sha256(bytes), sha256(fs.readFileSync(path.join(ROOT, rel))), rel);
      }
      const { buildRegisteredProjectScanPlan } = await import(pathToFileURL(
        path.join(installed, 'scanners/project-graph/registered.mjs')).href);
      const { buildProjectCachePlan } = await import(pathToFileURL(
        path.join(installed, 'lib/scan-scheduler-next/project-cache-plan.mjs')).href);
      const { runProjectGraphCached } = await import(pathToFileURL(
        path.join(installed, 'lib/scan-scheduler-next/project-cache-runner.mjs')).href);
      const { digestJson } = await import(pathToFileURL(
        path.join(installed, 'lib/scan-scheduler-next/cache-key.mjs')).href);
      const { ADAPTERS } = await import(pathToFileURL(
        path.join(installed, 'scanners/registry.mjs')).href);
      const repo = path.join(scratch, 'polyglot');
      fixture(repo);
      const { graph, plan } = buildRegisteredProjectScanPlan(repo);
      assert.deepEqual(graph.registry_load_errors, []);
      const selected = [
        ['services/express', 'typescript-express'],
        ['services/express-js', 'javascript-express'],
        ['services/fastapi', 'python-fastapi'],
        ['services/rails', 'ruby-rails'],
        ['services/spring', 'java-spring'],
      ];
      assert.deepEqual(plan.map(item => [item.project_root, item.adapter_id]), selected);
      const cachePlan = buildProjectCachePlan(graph);
      assert.deepEqual(cachePlan.projects.map(item => [item.project_root, item.adapter_id]), selected);
      assert.ok(cachePlan.projects.every(item => /^[0-9a-f]{64}$/.test(item.cache_namespace)));
      assert.equal(cachePlan.graph_schema, graph.schema);
      assert.equal(graph.projects.find(item => item.root === '.').kind, 'aggregate');
      assert.ok(!cachePlan.projects.some(item => item.project_root === '.'));
      const adapters = ADAPTERS.filter(adapter => selected.some(([, id]) => id === adapter.id));
      assert.equal(adapters.length, selected.length);
      const implementationDigests = Object.fromEntries(adapters.map(adapter => [
        adapter.id, digestJson({ adapter: adapter.id, test_revision: 1 }),
      ]));
      const options = {
        repoRoot: repo, cacheRoot: path.join(scratch, 'cache'), graph, adapters,
        implementationDigests, rgAvailable: false, useCache: false,
        maxConcurrency: 1, maxEstimatedBytesInFlight: 64 * 1024 * 1024,
      };
      const shadow = await runProjectGraphCached(options);
      const miss = await runProjectGraphCached({ ...options, useCache: true });
      const hit = await runProjectGraphCached({ ...options, useCache: true });
      assert.equal(shadow.schema, 'sbf.project-scan-cache-shadow/draft-1');
      for (const run of [shadow, miss, hit]) assert.equal(run.metrics.passed, selected.length);
      assert.deepEqual(shadow.results.map(item => [item.value.project_root, item.value.adapter_id])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0), selected);
      assert.ok(shadow.results.every(item => item.value.cache_hit === false && item.value.report));
      const values = run => new Map(run.results.map(item => [item.id, item.value]));
      const offValues = values(shadow), missValues = values(miss), hitValues = values(hit);
      for (const [id, off] of offValues) {
        assert.equal(missValues.get(id).cache_hit, false, id);
        assert.equal(hitValues.get(id).cache_hit, true, id);
        assert.deepEqual(missValues.get(id).report, off.report, id);
        assert.deepEqual(hitValues.get(id).report, off.report, id);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
