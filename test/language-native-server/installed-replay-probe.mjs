// DOT-T00-T08-06-20261122. Executed only from a disposable installed package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, slot] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(slot));
const modulePath = path.join(root, 'scanners/language/native-server/index.mjs');
if (slot === 'previous') {
  assert.equal(fs.existsSync(modulePath), false);
  console.log(JSON.stringify({ slot, installed_static_worker: false, vectors: 1,
    compiler_certified: false, release_authorized: false }));
} else {
  assert.equal(fs.existsSync(modulePath), true);
  const { NATIVE_SERVER_PROTOCOL, NATIVE_WORKER_PATH, runNativeServerWorker } =
    await import(pathToFileURL(modulePath).href);
  assert.equal(NATIVE_WORKER_PATH, path.join(root, 'scanners/language/native-server/worker.mjs'));
  assert.equal(fs.existsSync(NATIVE_WORKER_PATH), true);
  const analyze = (requestId, source) => runNativeServerWorker({
    protocol: NATIVE_SERVER_PROTOCOL, kind: 'analyze-request', requestId,
    language: 'go', file: 'routes.go', source, budget: { wallTimeMs: 5000 },
  });
  const normal = analyze('t08-normal', 'package main\nfunc setup(){ r := gin.Default(); api := r.Group("/api"); api.GET("/health", health) }');
  assert.equal(normal.requestId, 't08-normal');
  assert.deepEqual(normal.routes.map(route => [route.method, route.path]), [['GET', '/api/health']]);
  assert.deepEqual(normal.diagnostics, []);

  const negative = analyze('t08-negative', 'package main\nfunc setup(){ r := gin.Default(); r.GET(prefix + "/secret", handler) }');
  assert.equal(negative.requestId, 't08-negative');
  assert.deepEqual(negative.routes, []);
  assert.ok(negative.diagnostics.some(item => item.code === 'GO_GIN_DYNAMIC_ROUTE_PATH' && item.severity === 'unknown'));

  if (process.env.T08_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
  console.log(JSON.stringify({ slot, installed_static_worker: true, vectors: 2,
    compiler_certified: false, release_authorized: false }));
}
