import test from 'node:test';
import assert from 'node:assert/strict';
import { installedCrossIntegration } from './t21-05-installed-integration.mjs';

test('T21-05 installed package imports all T21 modules and runs registered T02 provider through a bounded three-adapter T21 shadow', { timeout: 120000 }, async () => {
  const result = await installedCrossIntegration();
  assert.equal(result.schema, 't21-05.installed-cross-shadow/1');
  assert.equal(result.task, 'T21-05');
  assert.match(result.source_head, /^[0-9a-f]{40}$/);
  assert.match(result.source_tree, /^[0-9a-f]{40}$/);
  assert.match(result.tarball_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.imported_modules.length, 13);
  assert.deepEqual(result.registry_adapter_ids, ['java-spring', 'javascript-express', 'python-fastapi']);
  assert.deepEqual(Object.values(result.checks), [true, true, true, true, true, true]);
  assert.ok(result.imported_modules.every((item) => Number.isInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256)));
  assert.ok(result.packed_file_count >= 13);
  assert.ok(!result.packed_paths.some((p) => p.startsWith('next/t21/')));
  for (const value of Object.values(result.observations_ms_non_slo)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(result.release_authorized, false);
  assert.equal(result.production_routing_changed, false);
  assert.equal(result.gc_deletion_performed, false);
  assert.ok(result.limitations.some((s) => s.includes('stable CLI')));
  assert.ok(result.limitations.some((s) => s.includes('T21-06')));
});

test('T21-05 permanent source changes are restricted to the T21-owned next/t21 scope', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  for (const line of changed.split('\n').filter(Boolean)) {
    const name = line.slice(3);
    assert.ok(name.startsWith('next/t21/'), 'T21-05 does not own ' + name);
  }
});
