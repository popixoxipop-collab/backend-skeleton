import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPythonFastApi } from '../../scanners/adapters/python-fastapi.mjs';
import { analyzePythonFiles, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../../scanners/language/python/resolver.mjs';
import { buildFastApiShadow, diffFastApiShadow } from '../../scanners/language/python/fastapi-shadow.mjs';

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


test('T06 FastAPI shadow matches the repository committed python-fastapi fixture', { skip: !runtime }, () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtureRoot = path.join(here, '..', 'fixtures', 'python-fastapi');
  const projectRoot = path.join(fixtureRoot, 'backend');
  const files = [
    'app/__init__.py',
    'app/api/__init__.py',
    'app/api/deps.py',
    'app/api/items.py',
    'app/models.py',
    'app/services/__init__.py',
    'app/services/item_service.py',
  ];
  const legacy = scanPythonFastApi(fixtureRoot, projectRoot);
  const batch = analyzePythonFiles({ repoRoot: projectRoot, files });
  assert.equal(batch.ok, true, JSON.stringify(batch, null, 2));
  const shadow = buildFastApiShadow(buildPythonProjectFacts(batch.results));
  const diff = diffFastApiShadow(legacy, shadow);
  assert.equal(diff.parity, true, JSON.stringify(diff, null, 2));
  assert.deepEqual(diff.counts, {
    legacy: { endpoints: 1, entities: 1, dtos: 1 },
    shadow: { endpoints: 1, entities: 1, dtos: 1 },
  });
});


test('T06 FastAPI shadow records include_router mounts without pretending router-local paths are final', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-fastapi-mount-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app', 'items.py'), `
from fastapi import APIRouter
router = APIRouter(prefix="/items")
@router.get("/{item_id}")
def read_item(item_id: int):
    pass
`);
  fs.writeFileSync(path.join(root, 'app', 'api.py'), `
from fastapi import APIRouter, FastAPI
from .items import router as items_router
api_router = APIRouter(prefix="/api")
api_router.include_router(items_router, prefix="/v1")
app = FastAPI()
app.include_router(api_router)
`);

  const batch = analyzePythonFiles({ repoRoot: root, files: ['app/__init__.py', 'app/items.py', 'app/api.py'] });
  assert.equal(batch.ok, true, JSON.stringify(batch, null, 2));
  const shadow = buildFastApiShadow(buildPythonProjectFacts(batch.results));

  assert.equal(shadow.endpoints.length, 1);
  assert.equal(shadow.endpoints[0].path, '/items/{item_id}', 'endpoint remains router-local until mount composition is implemented');
  assert.equal(shadow.mounts.length, 2);
  assert.ok(shadow.mounts.some((x) => x.receiver === 'api_router' && x.prefix === '/v1' && x.child.module === 'app.items' && x.child.name === 'router'));
  assert.ok(shadow.mounts.some((x) => x.receiver === 'app' && x.prefix === '' && x.child.module === 'app.api' && x.child.name === 'api_router'));
  assert.equal(shadow.unknowns.filter((x) => x.reason === 'include-router-mount-not-composed').length, 2);
});
