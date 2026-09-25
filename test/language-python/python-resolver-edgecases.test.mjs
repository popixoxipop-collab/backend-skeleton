import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts, resolvePythonSymbol } from '../../scanners/language/python/resolver.mjs';

const runtime = findPythonRuntime();
function project(root, files) {
  return buildPythonProjectFacts(files.map((file) => analyzePythonFile({ repoRoot: root, file })));
}

test('T06 bare dotted import binds the top-level package; an alias binds the full module', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-import-semantics-'));
  fs.mkdirSync(path.join(root, 'pkg', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'pkg', 'sub', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'consumer.py'), 'import pkg.sub\nimport pkg.sub as ps\n');
  const p = project(root, ['pkg/__init__.py', 'pkg/sub/__init__.py', 'consumer.py']);
  assert.deepEqual(resolvePythonSymbol(p, 'consumer', 'pkg'), { status: 'resolved', locality: 'local', module: 'pkg', name: null });
  assert.deepEqual(resolvePythonSymbol(p, 'consumer', 'ps'), { status: 'resolved', locality: 'local', module: 'pkg.sub', name: null });
});

test('T06 duplicate module identities are preserved as collisions and never silently selected', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-module-collision-'));
  fs.mkdirSync(path.join(root, 'foo'));
  fs.writeFileSync(path.join(root, 'foo.py'), 'x = 1\n');
  fs.writeFileSync(path.join(root, 'foo', '__init__.py'), 'y = 2\n');
  fs.writeFileSync(path.join(root, 'consumer.py'), 'import foo\n');
  const p = project(root, ['foo.py', 'foo/__init__.py', 'consumer.py']);
  assert.deepEqual(p.collisions, [{ moduleId: 'foo', sources: ['foo.py', 'foo/__init__.py'] }]);
  assert.equal(p.get('foo'), null);
  const resolved = resolvePythonSymbol(p, 'consumer', 'foo');
  assert.equal(resolved.status, 'unknown');
  assert.equal(resolved.reason, 'ambiguous-module');
});


test('T06 bare dotted import resolves attributes through the module that was actually imported', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-dotted-attribute-'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'pkg', 'models.py'), 'class Base:\n    pass\n');
  fs.writeFileSync(path.join(root, 'consumer.py'), 'import pkg.models\n');
  const p = project(root, ['pkg/__init__.py', 'pkg/models.py', 'consumer.py']);

  assert.deepEqual(resolvePythonSymbol(p, 'consumer', 'pkg.models.Base'), {
    status: 'resolved',
    locality: 'local',
    module: 'pkg.models',
    name: 'Base',
  });
});

test('T06 bare dotted import resolves a selected namespace-package module but no unimported sibling', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-namespace-package-'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', 'models.py'), 'class Base:\n    pass\n');
  fs.writeFileSync(path.join(root, 'consumer.py'), 'import pkg.models\n');
  const p = project(root, ['pkg/models.py', 'consumer.py']);

  assert.equal(p.get('pkg'), null, 'namespace package has no synthetic module fact');
  assert.deepEqual(resolvePythonSymbol(p, 'consumer', 'pkg.models.Base'), {
    status: 'resolved',
    locality: 'local',
    module: 'pkg.models',
    name: 'Base',
  });
  assert.deepEqual(resolvePythonSymbol(p, 'consumer', 'pkg.other.Base'), {
    status: 'resolved',
    locality: 'external',
    module: 'pkg',
    name: 'other.Base',
  }, 'one imported dotted module must not imply arbitrary sibling modules are local');
});
