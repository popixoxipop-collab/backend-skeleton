import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../../scanners/language/python/resolver.mjs';
import { buildDjangoUrlShadow } from '../../scanners/language/python/django-shadow.mjs';
import { buildFastApiShadow } from '../../scanners/language/python/fastapi-shadow.mjs';

const runtime = findPythonRuntime();

function projectFrom(root, source) {
  fs.writeFileSync(path.join(root, 'module.py'), source);
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return { result, project: buildPythonProjectFacts([result]) };
}

function lineOf(source, needle) {
  return source.split('\n').findIndex((line) => line.includes(needle)) + 1;
}

test('T06 nested AST calls retain their own source lines for Django URL registration provenance', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-provenance-django-'));
  const source = `
from django.urls import path

def first(request):
    pass

def second(request):
    pass

urlpatterns = [
    path("first/", first, name="first"),
    path("second/", second, name="second"),
]
`;
  const { result, project } = projectFrom(root, source);
  const assignment = result.facts.assignments.find((x) => x.targets?.[0] === 'urlpatterns');
  assert.equal(assignment.value.items[0].line, lineOf(source, 'path("first/"'));
  assert.equal(assignment.value.items[1].line, lineOf(source, 'path("second/"'));

  const shadow = buildDjangoUrlShadow(project);
  const byName = Object.fromEntries(shadow.registrations.map((x) => [x.name, x]));
  assert.equal(byName.first.line, lineOf(source, 'path("first/"'));
  assert.equal(byName.second.line, lineOf(source, 'path("second/"'));
  assert.notEqual(byName.first.line, byName.second.line);
});

test('T06 framework decorator provenance points at the decorator call, not the function definition', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-provenance-fastapi-'));
  const source = `
from fastapi import APIRouter
router = APIRouter()

@router.get("/items")
def list_items():
    pass
`;
  const { project } = projectFrom(root, source);
  const shadow = buildFastApiShadow(project);
  assert.equal(shadow.endpoints.length, 1);
  assert.equal(shadow.endpoints[0].line, lineOf(source, '@router.get("/items")'));
  assert.notEqual(shadow.endpoints[0].line, lineOf(source, 'def list_items'));
});
