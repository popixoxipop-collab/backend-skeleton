import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../scanners/language/python/resolver.mjs';
import { projectPythonModels } from '../scanners/language/python/model-shape.mjs';
import { annotatePythonModelTypes, normalizePythonType } from '../scanners/language/python/type-shape.mjs';

const runtime = findPythonRuntime();

test('T06 normalizes Python typing syntax without claiming runtime validation semantics', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-types-'));
  fs.writeFileSync(path.join(root, 'models.py'), `
from typing import Annotated, Literal, Optional
from pydantic import BaseModel, Field

class Payload(BaseModel):
    ids: list[int]
    maybe: str | None
    old_optional: Optional[int]
    name: Annotated[str, Field(min_length=1)]
    state: Literal["open", "closed"]
    parent: "Payload"
`);
  const entry = analyzePythonFile({ repoRoot: root, file: 'models.py' });
  assert.equal(entry.ok, true, JSON.stringify(entry));
  const project = buildPythonProjectFacts([entry]);
  const models = annotatePythonModelTypes(project, projectPythonModels(project));
  const payload = models.find((x) => x.className === 'Payload');
  const fields = Object.fromEntries(payload.fields.map((field) => [field.name, field.typeFact]));

  assert.deepEqual(fields.ids, {
    kind: 'generic',
    base: { kind: 'builtin', name: 'list' },
    args: [{ kind: 'builtin', name: 'int' }],
  });
  assert.deepEqual(fields.maybe, {
    kind: 'union',
    syntax: 'pep604',
    options: [{ kind: 'builtin', name: 'str' }, { kind: 'none' }],
  });
  assert.deepEqual(fields.old_optional, {
    kind: 'union',
    syntax: 'typing.Optional',
    options: [{ kind: 'builtin', name: 'int' }, { kind: 'none' }],
  });
  assert.equal(fields.name.kind, 'annotated');
  assert.deepEqual(fields.name.base, { kind: 'builtin', name: 'str' });
  assert.equal(fields.name.metadata[0].kind, 'call');
  assert.match(fields.name.note, /not executed/);
  assert.equal(fields.state.kind, 'literal');
  assert.deepEqual(fields.state.values.map((x) => x.value), ['open', 'closed']);
  assert.deepEqual(fields.parent, { kind: 'forward-reference', text: 'Payload' });
});

test('T06 unknown annotation expressions stay unknown rather than being evaluated', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-type-unknown-'));
  fs.writeFileSync(path.join(root, 'module.py'), 'x: make_type()\n');
  const entry = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  const project = buildPythonProjectFacts([entry]);
  const annotation = entry.facts.assignments[0].annotation;
  const fact = normalizePythonType(project, 'module', annotation);
  assert.equal(fact.kind, 'unknown');
  assert.equal(fact.reason, 'unsupported-annotation-expression');
});
