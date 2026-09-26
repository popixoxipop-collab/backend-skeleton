import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySourceRole, discoverProjects } from '../../scanners/project-discovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../fixtures/webgame-static');

test('role classifier separates active/reference/generated/vendor/template inputs', () => {
  assert.equal(classifySourceRole('src/main.ts'), 'active');
  assert.equal(classifySourceRole('reference/upstream.ts'), 'reference');
  assert.equal(classifySourceRole('forge/tests/fixtures/reference_target_oracle.ts'), 'reference');
  assert.equal(classifySourceRole('dist/app.js'), 'generated');
  assert.equal(classifySourceRole('vendor/lib.js'), 'vendor');
  assert.equal(classifySourceRole('templates/game.ts'), 'template');
});

test('nested package roots are preserved as separate projects', () => {
  const result = discoverProjects(path.join(FIX, 'mixed-repo'));
  assert.deepEqual(result.projects.map((p) => p.root), ['backend', 'frontend']);
  assert.ok(result.projects.every((p) => p.source_files.length === 1));
  assert.ok(result.files_read.includes('backend/package.json'));
  assert.ok(result.files_read.includes('frontend/package.json'));
});
