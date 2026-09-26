import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROJECT_SOURCE_ROLES,
  classifyProjectSourceRole,
  groupProjectSourcesByRole,
} from '../../scanners/project-graph/source-role.mjs';

test('source-role vocabulary stays aligned with the reconciled legacy Track A categories', () => {
  assert.deepEqual(PROJECT_SOURCE_ROLES, ['active', 'reference', 'generated', 'vendor', 'template']);
});

test('source-role classifier preserves Track A precedence without language semantics', () => {
  assert.equal(classifyProjectSourceRole('src/main.ts'), 'active');
  assert.equal(classifyProjectSourceRole('reference/upstream.ts'), 'reference');
  assert.equal(classifyProjectSourceRole('forge/tests/fixtures/reference_target_oracle.ts'), 'reference');
  assert.equal(classifyProjectSourceRole('dist/app.js'), 'generated');
  assert.equal(classifyProjectSourceRole('vendor/examples/app.js'), 'vendor');
  assert.equal(classifyProjectSourceRole('templates/game.ts'), 'template');
  assert.equal(classifyProjectSourceRole('scaffold/readme.md'), 'template');
  assert.equal(classifyProjectSourceRole('foo/component.mustache'), 'template');
  assert.equal(classifyProjectSourceRole('.next/generated.js'), 'generated');
  assert.equal(classifyProjectSourceRole('tests/vendor/copied.js'), 'vendor');
});

test('source-role classifier normalizes Windows separators deterministically', () => {
  assert.equal(classifyProjectSourceRole('src\\tests\\fixture.ts'), 'reference');
  assert.equal(classifyProjectSourceRole('.\\generated\\x.ts'), 'generated');
});

test('grouping is deterministic and keeps every input path exactly once', () => {
  const grouped = groupProjectSourcesByRole([
    'templates/z.ts',
    'src/b.ts',
    'src/a.ts',
    'vendor/x.ts',
    'examples/demo.ts',
  ]);
  assert.deepEqual(grouped, {
    active: ['src/a.ts', 'src/b.ts'],
    reference: ['examples/demo.ts'],
    generated: [],
    vendor: ['vendor/x.ts'],
    template: ['templates/z.ts'],
  });
});

test('empty/invalid path inputs fail instead of becoming active source', () => {
  assert.throws(() => classifyProjectSourceRole(''), TypeError);
  assert.throws(() => classifyProjectSourceRole(null), TypeError);
  assert.throws(() => groupProjectSourcesByRole('src/a.ts'), TypeError);
});
