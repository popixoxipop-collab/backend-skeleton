import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { HTTP_WAVE_BC_TARGETS } from '../../adapters/http-wave-bc/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const waveRoot = path.join(repoRoot, 'adapters', 'http-wave-bc');

function leafDirectories() {
  return fs.readdirSync(waveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(waveRoot, name, 'adapter.mjs')))
    .sort();
}

test('every experimental Wave B/C leaf maps to exactly one catalog target and current adapter schema', async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'adapter.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const catalogIds = new Set(HTTP_WAVE_BC_TARGETS.map((target) => target.id));
  const leaves = leafDirectories();

  assert.deepEqual(leaves, ['node-hono', 'node-koa', 'typescript-nextjs']);

  for (const id of leaves) {
    assert.ok(catalogIds.has(id), `experimental leaf ${id} is missing from catalog.mjs`);
    const moduleUrl = pathToFileURL(path.join(waveRoot, id, 'adapter.mjs')).href;
    const mod = await import(moduleUrl);
    const descriptor = mod.adapter;
    assert.ok(descriptor, `${id} does not export adapter`);
    assert.equal(descriptor.id, id);
    const { detect, scan, diagnostics, listReadSet, introspectRoutes, ...data } = descriptor;
    assert.equal(validate(data), true, `${id}: ${JSON.stringify(validate.errors)}`);
  }
});

test('T13 fan-out is scope-locked until the profile evidence hold is deliberately cleared', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(waveRoot, 'profile-evidence.json'), 'utf8'));
  assert.equal(evidence.new_framework_fanout, 'DEFER_UNTIL_PROFILE_REVIEW');
  assert.deepEqual(leafDirectories(), ['node-hono', 'node-koa', 'typescript-nextjs']);
});

test('experimental leaf inventory is deterministic and contains no uncatalogued directories', () => {
  const leaves = leafDirectories();
  assert.deepEqual(leaves, [...leaves].sort());
  const catalogIds = new Set(HTTP_WAVE_BC_TARGETS.map((target) => target.id));
  assert.deepEqual(leaves.filter((id) => !catalogIds.has(id)), []);
});
