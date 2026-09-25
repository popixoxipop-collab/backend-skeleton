import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime, PYTHON_AST_RESPONSE_PROTOCOL } from '../../scanners/language/python/analyzer.mjs';

const runtime = findPythonRuntime();

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-language-'));
  fs.writeFileSync(path.join(root, 'module.py'), source);
  return root;
}

function analyze(root, extra = {}) {
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py', ...extra });
  assert.equal(result.protocol, PYTHON_AST_RESPONSE_PROTOCOL);
  return result;
}

test('T06: Python runtime probe is bounded and returns a semantic version when available', { skip: !runtime }, () => {
  assert.match(runtime.version, /^\d+\.\d+\.\d+$/);
  assert.ok(path.isAbsolute(runtime.executable));
});

test('T06: parses aliases, relative imports, decorators, Annotated arguments, classes and fields without importing target code', { skip: !runtime }, () => {
  const root = fixture(`
from __future__ import annotations
from typing import Annotated
from fastapi import APIRouter, Depends, Path
from .models import User as UserModel

router: APIRouter = APIRouter(prefix="/users")

@router.get("/{user_id}", response_model=UserRead)
async def get_user(user_id: Annotated[int, Path(gt=0)], current: UserModel = Depends(load_user)) -> UserRead:
    raise RuntimeError("must never execute")

class UserRead(BaseModel):
    id: int
    name: str = Field(alias="displayName")

class User(SQLModel, table=True):
    id: int = Field(primary_key=True)
`);
  const result = analyze(root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.facts.imports.find((x) => x.module === 'models').level, 1);
  const route = result.facts.functions.find((x) => x.name === 'get_user');
  assert.equal(route.async, true);
  assert.equal(route.decorators[0].kind, 'call');
  assert.equal(route.decorators[0].callee.name, 'router.get');
  assert.equal(route.decorators[0].args[0].value, '/{user_id}');
  assert.equal(route.arguments[0].annotation.kind, 'subscript');
  const user = result.facts.classes.find((x) => x.name === 'User');
  assert.equal(user.keywords.find((x) => x.name === 'table').value.value, true);
  assert.equal(user.fields.find((x) => x.targets[0] === 'id').value.callee.name, 'Field');
});

test('T06: top-level target statements are parsed but never executed', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-noexec-'));
  const marker = path.join(root, 'EXECUTED');
  fs.writeFileSync(path.join(root, 'module.py'), `
from pathlib import Path
Path(${JSON.stringify(marker)}).write_text("executed")
router = APIRouter(prefix="/safe")
`);
  const result = analyze(root);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(marker), false, 'AST analysis must not execute module statements');
  assert.equal(result.facts.calls.length, 1);
});

test('T06: inherited PYTHONPATH/sitecustomize cannot execute inside helper', { skip: !runtime }, () => {
  const root = fixture('x = 1\n');
  const marker = path.join(root, 'SITECUSTOMIZE_EXECUTED');
  fs.writeFileSync(path.join(root, 'sitecustomize.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("bad")\n`);
  const old = process.env.PYTHONPATH;
  process.env.PYTHONPATH = root;
  try {
    const result = analyze(root);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(marker), false, 'isolated -I -S helper must not load target sitecustomize');
  } finally {
    if (old === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = old;
  }
});

test('T06: syntax errors are structured facts gaps rather than crashes', { skip: !runtime }, () => {
  const root = fixture('def broken(:\n    pass\n');
  const result = analyze(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PYTHON_SYNTAX_ERROR');
  assert.equal(result.error.line, 1);
});

test('T06: dynamic expressions remain unknown instead of being guessed', { skip: !runtime }, () => {
  const root = fixture('prefix = "/" + get_prefix()\nrouter = APIRouter(prefix=prefix)\n');
  const result = analyze(root);
  assert.equal(result.ok, true);
  const prefix = result.facts.assignments.find((x) => x.targets[0] === 'prefix');
  assert.equal(prefix.value.kind, 'unknown');
  assert.equal(prefix.value.node, 'BinOp');
  const router = result.facts.assignments.find((x) => x.targets[0] === 'router');
  assert.equal(router.value.keywords[0].value.kind, 'symbol');
  assert.equal(router.value.keywords[0].value.name, 'prefix');
});

test('T06: repeated analysis of the same bytes is deterministic', { skip: !runtime }, () => {
  const root = fixture('from fastapi import APIRouter\nrouter = APIRouter(prefix="/x")\n');
  const a = analyze(root);
  const b = analyze(root);
  assert.deepEqual(a, b);
});

test('T06: symlink escapes outside repoRoot are rejected before Python starts', { skip: !runtime }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-outside-'));
  fs.writeFileSync(path.join(outside, 'outside.py'), 'x = 1\n');
  try {
    fs.symlinkSync(path.join(outside, 'outside.py'), path.join(root, 'module.py'));
  } catch (error) {
    t.skip(`symlink unsupported: ${error.code || error.message}`);
    return;
  }
  assert.throws(() => analyzePythonFile({ repoRoot: root, file: 'module.py' }), /escapes project root/);
});

test('T06: explicit missing interpreter fails closed without falling back', () => {
  const root = fixture('x = 1\n');
  const result = analyze(root, { pythonCommand: path.join(root, 'definitely-not-python') });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PYTHON_RUNTIME_UNAVAILABLE');
});

test('T06: a repo-local python3 earlier in PATH is never executed', { skip: !runtime }, () => {
  if (process.platform === 'win32') return;
  const root = fixture('x = 1\n');
  const fakeBin = path.join(root, 'fakebin');
  const marker = path.join(root, 'FAKE_PYTHON_EXECUTED');
  fs.mkdirSync(fakeBin);
  const fake = path.join(fakeBin, 'python3');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf bad > ${JSON.stringify(marker)}\nexit 0\n`);
  fs.chmodSync(fake, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${old || ''}`;
  try {
    const result = analyze(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(marker), false, 'repo-local PATH shadow must not be selected as interpreter');
  } finally {
    if (old === undefined) delete process.env.PATH;
    else process.env.PATH = old;
  }
});
