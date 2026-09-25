import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts, resolvePythonSymbol } from '../scanners/language/python/resolver.mjs';
import { projectPythonModels } from '../scanners/language/python/model-shape.mjs';

const runtime = findPythonRuntime();

function analyzeMany(root, files) {
  return buildPythonProjectFacts(files.map((file) => analyzePythonFile({ repoRoot: root, file })));
}

test('T06 resolver preserves relative-import aliases and external symbols', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-resolver-'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'pkg', 'models.py'), 'class User:\n    pass\n');
  fs.writeFileSync(path.join(root, 'pkg', 'api.py'), 'from .models import User as UserModel\nfrom pydantic import BaseModel as PM\n');
  const project = analyzeMany(root, ['pkg/__init__.py', 'pkg/models.py', 'pkg/api.py']);
  assert.deepEqual(resolvePythonSymbol(project, 'pkg.api', 'UserModel'), { status: 'resolved', locality: 'local', module: 'pkg.models', name: 'User' });
  assert.deepEqual(resolvePythonSymbol(project, 'pkg.api', 'PM'), { status: 'resolved', locality: 'external', module: 'pydantic', name: 'BaseModel' });
  assert.equal(resolvePythonSymbol(project, 'pkg.api', 'Missing').status, 'unknown');
});

test('T06 model projection resolves inherited SQLModel and Pydantic fields', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-models-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app', 'models.py'), `
from sqlmodel import SQLModel, Field
class UserBase(SQLModel):
    name: str
class User(UserBase, table=True):
    id: int = Field(primary_key=True)
`);
  fs.writeFileSync(path.join(root, 'app', 'schemas.py'), `
from pydantic import BaseModel, Field
from .models import UserBase as UB
class UserRead(UB):
    display_name: str = Field(alias="displayName")
class Request(BaseModel):
    query: str
`);
  const project = analyzeMany(root, ['app/__init__.py', 'app/models.py', 'app/schemas.py']);
  const models = projectPythonModels(project);
  const user = models.find((x) => x.ref === 'app.models#User');
  assert.equal(user.kind, 'entity');
  assert.deepEqual(user.primaryKeyFields, ['id']);
  assert.deepEqual(user.fields.map((x) => x.name), ['name', 'id']);
  const read = models.find((x) => x.ref === 'app.schemas#UserRead');
  assert.equal(read.kind, 'dto');
  assert.deepEqual(read.fields.map((x) => x.name), ['name', 'display_name']);
  assert.equal(read.fields.find((x) => x.name === 'display_name').metadata.alias, 'displayName');
  assert.equal(models.find((x) => x.ref === 'app.schemas#Request').kind, 'dto');
});

test('T06 BaseSettings is configuration, not an API DTO', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-settings-'));
  fs.writeFileSync(path.join(root, 'module.py'), 'from pydantic_settings import BaseSettings\nclass Settings(BaseSettings):\n    token: str\n');
  const project = analyzeMany(root, ['module.py']);
  const settings = projectPythonModels(project).find((x) => x.className === 'Settings');
  assert.equal(settings.kind, 'config');
});
