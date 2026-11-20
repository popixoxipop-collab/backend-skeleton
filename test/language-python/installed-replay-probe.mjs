// Exercise Python AST facts from the disposable installed package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [root, slot] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(slot));
const modulePath = name => path.join(root, 'scanners/language/python', name);
const members = ['analyzer.mjs', 'ast-helper.py', 'django-shadow.mjs',
  'fastapi-shadow.mjs', 'flask-shadow.mjs', 'model-shape.mjs',
  'resolver.mjs', 'type-shape.mjs'];
if (slot === 'previous') {
  for (const name of members) assert.equal(fs.existsSync(modulePath(name)), false, name);
  console.log(JSON.stringify({ expected: slot, vectors: 1, release_authorized: false }));
} else {
  for (const name of members) assert.equal(fs.existsSync(modulePath(name)), true, name);
  const { analyzePythonFile, findPythonRuntime, PYTHON_AST_RESPONSE_PROTOCOL } =
    await import(pathToFileURL(modulePath('analyzer.mjs')).href);
  const runtime = findPythonRuntime();
  assert.ok(runtime, 'an actual Python 3.8+ interpreter is required; no skip');
  assert.match(runtime.version, /^\d+\.\d+\.\d+$/);
  const pythonSha256 = createHash('sha256').update(fs.readFileSync(runtime.executable)).digest('hex');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-installed-probe-'));
  const marker = path.join(project, 'TARGET_EXECUTED');
  const run = (source, extra = {}) => {
    fs.writeFileSync(path.join(project, 'module.py'), source);
    const result = analyzePythonFile({ repoRoot: project, file: 'module.py',
      pythonCommand: runtime.executable, ...extra });
    assert.equal(result.protocol, PYTHON_AST_RESPONSE_PROTOCOL);
    return result;
  };
  try {
    const positive = run(`from typing import Annotated\nfrom fastapi import APIRouter, Path\nrouter = APIRouter(prefix="/users")\n@router.get("/{user_id}")\nasync def get_user(user_id: Annotated[int, Path(gt=0)]):\n    raise RuntimeError("must never execute")\n`);
    assert.equal(positive.ok, true, JSON.stringify(positive.error));
    const route = positive.facts.functions.find(f => f.name === 'get_user');
    assert.equal(route.async, true);
    assert.equal(route.decorators[0].callee.name, 'router.get');
    assert.equal(route.decorators[0].args[0].value, '/{user_id}');
    assert.equal(route.arguments[0].annotation.kind, 'subscript');

    const dynamic = run('prefix = "/" + get_prefix()\nrouter = APIRouter(prefix=prefix)\n');
    assert.equal(dynamic.ok, true);
    const prefix = dynamic.facts.assignments.find(a => a.targets[0] === 'prefix');
    assert.equal(prefix.value.kind, 'unknown');
    assert.equal(prefix.value.node, 'BinOp');
    assert.equal(dynamic.facts.assignments.find(a => a.targets[0] === 'router')
      .value.keywords[0].value.kind, 'symbol');

    const syntax = run('def broken(:\n    pass\n');
    assert.equal(syntax.ok, false);
    assert.equal(syntax.error.code, 'PYTHON_SYNTAX_ERROR');
    assert.equal(syntax.error.line, 1);

    const inert = run(`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("bad")\n`);
    assert.equal(inert.ok, true);
    assert.equal(inert.facts.calls.length, 1);
    assert.equal(fs.existsSync(marker), false, 'target top-level statement must not execute');

    const unavailable = run('value = 1\n', {
      pythonCommand: path.join(project, 'definitely-not-a-python-interpreter'),
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, 'PYTHON_RUNTIME_UNAVAILABLE');

    const limited = run('value = "' + 'x'.repeat(2048) + '"\n', { maxSourceBytes: 1024 });
    assert.equal(limited.ok, false);
    assert.equal(limited.error.code, 'PYTHON_SOURCE_TOO_LARGE');

    if (process.env.T06_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
    console.log(JSON.stringify({ expected: slot, vectors: 6, python_version: runtime.version,
      python_executable_sha256: pythonSha256, release_authorized: false }));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
}
