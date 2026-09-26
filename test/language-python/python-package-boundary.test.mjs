import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, cwd) {
  const run = spawnSync(NPM, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(
    run.status,
    0,
    `npm ${args.join(' ')} failed: ${String(run.stderr || run.error?.message || run.stdout || '').slice(0, 2000)}`,
  );
  return run.stdout;
}

test('T06 npm package includes the Python analyzer, helper and shadow modules', () => {
  const out = runNpm(['pack', REPO_ROOT, '--dry-run', '--json'], REPO_ROOT);
  const packed = JSON.parse(out)[0];
  const paths = new Set((packed.files || []).map((entry) => entry.path));
  for (const required of [
    'scanners/language/python/analyzer.mjs',
    'scanners/language/python/ast-helper.py',
    'scanners/language/python/resolver.mjs',
    'scanners/language/python/model-shape.mjs',
    'scanners/language/python/type-shape.mjs',
    'scanners/language/python/fastapi-shadow.mjs',
    'scanners/language/python/django-shadow.mjs',
    'scanners/language/python/flask-shadow.mjs',
  ]) {
    assert.ok(paths.has(required), `packed artifact is missing ${required}`);
  }
});

test('T06 analyzer works after install from the packed tarball without target imports', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-package-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const packDir = path.join(temp, 'pack');
  fs.mkdirSync(packDir);
  const out = runNpm(['pack', REPO_ROOT, '--json', '--pack-destination', packDir], REPO_ROOT);
  const packed = JSON.parse(out)[0];
  const tarball = path.join(packDir, packed.filename);
  assert.ok(fs.statSync(tarball).isFile());

  const installRoot = path.join(temp, 'install');
  runNpm(['install', tarball, '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund'], temp);

  const modulePath = path.join(
    installRoot,
    'node_modules',
    'backend-skeleton',
    'scanners',
    'language',
    'python',
    'analyzer.mjs',
  );
  const helperPath = path.join(path.dirname(modulePath), 'ast-helper.py');
  assert.ok(fs.statSync(modulePath).isFile(), 'installed analyzer is missing');
  assert.ok(fs.statSync(helperPath).isFile(), 'installed Python AST helper is missing');

  const installed = await import(pathToFileURL(modulePath).href);
  const runtime = installed.findPythonRuntime();
  if (!runtime) {
    t.diagnostic('No approved Python >=3.8 runtime available; package bytes/import verified, helper execution skipped.');
    return;
  }

  const sourceRoot = path.join(temp, 'source');
  fs.mkdirSync(sourceRoot);
  const marker = path.join(sourceRoot, 'MUST_NOT_EXIST');
  fs.writeFileSync(path.join(sourceRoot, 'module.py'), `
from pathlib import Path
from fastapi import APIRouter
router = APIRouter(prefix="/items")
Path(${JSON.stringify(marker)}).write_text("executed")

@router.get("/{item_id}")
def read_item(item_id: int):
    pass
`);

  const result = installed.analyzePythonFile({ repoRoot: sourceRoot, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(fs.existsSync(marker), false, 'installed static analyzer must not execute target module statements');
  assert.ok(result.facts.functions.some((fn) => fn.name === 'read_item'));
  assert.equal(result.source.path, 'module.py');
});
