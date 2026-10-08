// Synthetic repositories shared by the RFC probe and the RFC test. Not a test file.
// Every graph here is built with adapters defined in interface-rfc.fixtures.mjs, except the
// registered case, which uses the registry on purpose and is therefore not hash-pinned.
import path from 'node:path';
import { buildProjectGraph } from '../../scanners/project-graph/index.mjs';
import { buildRegisteredProjectScanPlan } from '../../scanners/project-graph/registered.mjs';
import {
  adapter, express, fallback, fixture, hasFile, listJs, markerAdapter, scanStub, spring,
} from './interface-rfc.fixtures.mjs';

export const pkg = (value) => JSON.stringify(value);
export const withReadSet = { listReadSet: (projectRoot) => listJs(projectRoot), scan: scanStub };

export const NORMAL_FILES = {
  'services/api/package.json': pkg({ name: '@demo/api', dependencies: { '@demo/shared': 'workspace:*', express: '^5.0.0' } }),
  'services/api/src/server.js': 'app.get("/health", () => {});\n',
  'services/api/tests/helper.js': 'module.exports = {};\n',
  'packages/shared/package.json': pkg({ name: '@demo/shared' }),
  'packages/shared/index.js': 'module.exports = {};\n',
  'examples/demo/package.json': pkg({ name: '@demo/example', dependencies: { express: '^5.0.0' } }),
  'examples/demo/server.js': 'app.get("/demo", () => {});\n',
  'backend-java/pom.xml': '<project/>\n',
  'backend-java/src/main/java/App.java': 'class App {}\n',
};

export function normalCase() {
  const root = fixture(NORMAL_FILES);
  const graph = buildProjectGraph({ repoRoot: root, adapters: [fallback, spring(), express(withReadSet)] });
  return { root, graph };
}

export function negativeCases() {
  const build = (files, adapters) => buildProjectGraph({ repoRoot: fixture(files), adapters });
  const named = (name) => pkg({ name });
  return {
    specificity_tie: build({ 'package.json': '{}' }, [
      markerAdapter('b-http', 90, hasFile('package.json')), markerAdapter('a-http', 90, hasFile('package.json')), fallback]),
    duplicate_local_package: build({
      'consumer/package.json': pkg({ name: '@demo/consumer', dependencies: { '@demo/shared': 'workspace:*' } }),
      'shared-a/package.json': named('@demo/shared'), 'shared-b/package.json': named('@demo/shared'),
    }, [fallback]),
    unlocated_detection: build({ 'package.json': '{}' }, [adapter('weird-http', 70, () => true), fallback]),
    out_of_scope_detection: build({ 'service/package.json': '{}' }, [
      adapter('escape-http', 70, (dir) => (path.basename(dir) === 'service' ? path.dirname(dir) : null)), fallback]),
    detect_error: build({ 'service/package.json': '{"x":"express"}' }, [
      adapter('broken-http', 99, () => { throw new Error('boom'); }), express(), fallback]),
    malformed_metadata: build({ 'broken/package.json': '{ nope', 'good/package.json': named('@demo/good') }, [fallback]),
    read_set_escape: build({ 'app/package.json': '{}' }, [
      markerAdapter('escaping-http', 90, hasFile('package.json'), 'root', { listReadSet: () => ['../outside.js'] }), fallback]),
  };
}

export function registeredCase() {
  const root = fixture({
    'package.json': '{"private":true}',
    'spring/pom.xml': '<project/>',
    'spring/src/main/java/com/example/App.java': [
      'package com.example;', 'import org.springframework.web.bind.annotation.*;', '@RestController',
      'class App { @GetMapping("/health") String health() { return "ok"; } }',
    ].join('\n'),
    'fastapi/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'fastapi/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  return { root, ...buildRegisteredProjectScanPlan(root) };
}
