import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPythonFastApi } from '../scanners/adapters/python-fastapi.mjs';
import { analyzePythonFiles, findPythonRuntime } from '../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../scanners/language/python/resolver.mjs';
import { buildFastApiShadow, diffFastApiShadow } from '../scanners/language/python/fastapi-shadow.mjs';

const runtime = findPythonRuntime();

function fixture({ dynamicPrefix = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-shadow-'));
  fs.mkdirSync(path.join(root, 'app', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="shadow"\ndependencies=["fastapi>=0.100","sqlmodel>=0.0.24"]\n');
  fs.writeFileSync(path.join(root, 'app', 'api', 'items.py'), `
from fastapi import APIRouter
PREFIX = "/items"
router = APIRouter(prefix=${dynamicPrefix ? 'PREFIX' : '"/items"'})

@router.get("/{id}", response_model=ItemPublic)
def read_item(id: str):
    pass
`);
  fs.writeFileSync(path.join(root, 'app', 'models.py'), `
from sqlmodel import Field, SQLModel

class Item(SQLModel, table=True):
    id: int = Field(primary_key=True)
    title: str

class ItemPublic(SQLModel):
    id: int
    title: str
`);
  return root;
}

function astShadow(root) {
  const batch = analyzePythonFiles({ repoRoot: root, files: ['app/api/items.py', 'app/models.py'] });
  assert.ok(batch.results.length === 2);
  const project = buildPythonProjectFacts(batch.results);
  return buildFastApiShadow(project);
}

test('T06 FastAPI shadow reaches parity with the existing scanner on the supported literal subset', { skip: !runtime }, () => {
  const root = fixture();
  const legacy = scanPythonFastApi(root, root);
  const shadow = astShadow(root);
  const diff = diffFastApiShadow(legacy, shadow);
  assert.equal(diff.parity, true, JSON.stringify(diff, null, 2));
  assert.deepEqual(diff.counts, {
    legacy: { endpoints: 1, entities: 1, dtos: 1 },
    shadow: { endpoints: 1, entities: 1, dtos: 1 },
  });
});

test('T06 FastAPI shadow abstains on a symbolic router prefix instead of inheriting the legacy empty-prefix guess', { skip: !runtime }, () => {
  const root = fixture({ dynamicPrefix: true });
  const legacy = scanPythonFastApi(root, root);
  const shadow = astShadow(root);
  assert.equal(shadow.endpoints.length, 0);
  assert.ok(shadow.unknowns.some((x) => x.reason === 'router-prefix-not-literal'));
  const diff = diffFastApiShadow(legacy, shadow);
  assert.equal(diff.parity, false);
  assert.equal(diff.differences.endpoints.missingInShadow.length, 1);
  assert.match(diff.differences.endpoints.missingInShadow[0], /^GET \/\{id\}#read_item$/);
});
