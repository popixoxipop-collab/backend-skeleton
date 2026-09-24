import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMultiplane } from '../../scanners/multiplane.mjs';
import { digestSourceTree } from '../../scanners/project-discovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../fixtures/webgame-static');
const scan = (name) => scanMultiplane({ repoRoot: path.join(FIX, name) });
const domain = (report, projectSuffix, kind) => report.domains.find((d) => d.project_id.endsWith(projectSuffix) && d.kind === kind);

test('mixed frontend/backend repo preserves API and game-runtime domains simultaneously', () => {
  const report = scan('mixed-repo');
  assert.equal(report.schema, 'sbf.multiplane-scan/1');
  assert.equal(report.summary.project_count, 2);

  const game = domain(report, 'frontend', 'game-runtime');
  const api = domain(report, 'backend', 'api');
  assert.ok(game, 'frontend game-runtime domain should remain present');
  assert.ok(api, 'backend API domain should remain present');
  assert.equal(game.status, 'complete');
  assert.equal(game.capabilities.playable_runtime_claimed, true);
  assert.equal(api.status, 'complete');

  const renderer = game.evidence.find((e) => e.kind === 'renderer');
  assert.equal(renderer.provenance.source_path, 'frontend/src/MessengerScene.svelte');
  assert.equal(renderer.provenance.line, 5);
  assert.ok(renderer.provenance.column > 1);
  assert.match(renderer.provenance.source_digest, /^sha256:[a-f0-9]{64}$/);

  const frontendNetwork = domain(report, 'frontend', 'network');
  const backendNetwork = domain(report, 'backend', 'network');
  assert.equal(frontendNetwork.capabilities.websocket_client, true);
  assert.equal(frontendNetwork.capabilities.websocket_server, false);
  assert.equal(backendNetwork.capabilities.websocket_server, true);

  assert.ok(report.graph.edges.some((e) => e.kind === 'uses-asset'));
  assert.ok(report.graph.edges.some((e) => e.kind === 'uses-worker'));
  assert.ok(report.graph.edges.some((e) => e.kind === 'uses-network'));
});

test('comment/template-string Three.js snippets are not promoted into a runtime', () => {
  const report = scan('comment-only');
  assert.equal(report.domains.some((d) => d.kind === 'game-runtime'), false);
});

test('reference bundle evidence remains partial and never claims an active playable runtime', () => {
  const report = scan('reference-only');
  const game = report.domains.find((d) => d.kind === 'game-runtime');
  assert.ok(game);
  assert.equal(game.status, 'partial');
  assert.equal(game.capabilities.playable_runtime_claimed, false);
  assert.ok(game.evidence.every((e) => e.role === 'reference'));
});

test('syntax errors are explicit unresolved findings', () => {
  const report = scan('syntax-error');
  assert.ok(report.unresolved.some((x) => x.kind === 'syntax' && x.source_path.endsWith('broken.ts')));
});

test('unresolved dynamic import stays visible in report', () => {
  const report = scan('dynamic-import');
  assert.ok(report.unresolved.some((x) => x.kind === 'dynamic-import' && x.source_path.endsWith('dynamic.ts')));
});

test('WebSocket client evidence alone does not claim a multiplayer server', () => {
  const report = scan('ws-client');
  const net = report.domains.find((d) => d.kind === 'network');
  assert.ok(net);
  assert.equal(net.capabilities.websocket_client, true);
  assert.equal(net.capabilities.websocket_server, false);
  assert.equal(net.capabilities.multiplayer_server_claimed, false);
});

test('Three.js dependency without runtime entry is only partial', () => {
  const report = scan('dependency-only');
  const game = report.domains.find((d) => d.kind === 'game-runtime');
  assert.ok(game);
  assert.equal(game.status, 'partial');
  assert.equal(game.capabilities.playable_runtime_claimed, false);
  assert.equal(game.capabilities.three_dependency, true);
});

test('generator template is not mistaken for playable runtime', () => {
  const report = scan('generator-template');
  const game = report.domains.find((d) => d.kind === 'game-runtime');
  assert.ok(game);
  assert.equal(game.capabilities.playable_runtime_claimed, false);
  assert.ok(game.evidence.every((e) => e.role === 'template'));
});

test('scan is read-only and deterministic for the same tree', () => {
  const root = path.join(FIX, 'mixed-repo');
  const before = digestSourceTree(root);
  const first = scanMultiplane({ repoRoot: root });
  const second = scanMultiplane({ repoRoot: root });
  const after = digestSourceTree(root);
  assert.equal(before, after);
  assert.deepEqual(first, second);
  assert.ok(first.files_read.includes('frontend/src/MessengerScene.svelte'));
  assert.ok(first.files_read.includes('backend/src/server.ts'));
  assert.ok(first.projects.every((p) => p.package_digest?.startsWith('sha256:')));
});

test('nested example package keeps package dependency and runtime evidence reference-only', () => {
  const report = scan('reference-package');
  const project = report.projects.find((p) => p.root === 'examples/demo');
  assert.ok(project);
  assert.equal(project.package_role, 'reference');
  const game = report.domains.find((d) => d.project_id === project.project_id && d.kind === 'game-runtime');
  assert.ok(game);
  assert.equal(game.status, 'partial');
  assert.equal(game.capabilities.playable_runtime_claimed, false);
  assert.ok(game.evidence.every((e) => e.role === 'reference'));
});

test('ws dependency plus unrelated http.Server does not claim a WebSocket server', () => {
  const report = scan('ws-http-server');
  const net = report.domains.find((d) => d.kind === 'network');
  assert.ok(net);
  assert.equal(net.capabilities.websocket_client, true);
  assert.equal(net.capabilities.websocket_server, false);
  assert.equal(net.capabilities.multiplayer_server_claimed, false);
  assert.ok(!net.evidence.some((e) => e.kind === 'websocket-server'));
});

test('unrelated object render call does not complete a Three.js runtime', () => {
  const report = scan('unrelated-render');
  const game = report.domains.find((d) => d.kind === 'game-runtime');
  assert.ok(game);
  assert.equal(game.capabilities.renderer, true);
  assert.equal(game.capabilities.scene, true);
  assert.equal(game.capabilities.render_call, false);
  assert.equal(game.capabilities.playable_runtime_claimed, false);
});
