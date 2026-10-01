import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, '../adapters/sim-next/mujoco/effective_model_helper.py');

function runClosure(xml, { files = {}, dependencies = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-m3-independent-q-'));
  try {
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'models', 'main.xml'), xml);
    for (const [relative, bytes] of Object.entries(files)) {
      const target = path.join(dir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }

    const script = String.raw`
import hashlib
import importlib.util
import json
import pathlib
import sys

helper_path = sys.argv[1]
deps = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("independent_m3_q_helper", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root = pathlib.Path.cwd()

def artifact(rel):
    data = (root / rel).read_bytes()
    return {
        "artifact_ref": "sbf.artifact-ref/1",
        "family": "simulation-source",
        "version": "draft-1",
        "media_type": "application/octet-stream",
        "byte_sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
    }

bundle = {
    "root": {
        "path": "models/main.xml",
        "artifact": artifact("models/main.xml"),
    },
    "dependencies": [
        {
            "path": entry["path"],
            "role": entry["role"],
            "artifact": artifact(entry["path"]),
        }
        for entry in deps
    ],
}
module.verify_staged_source_closure(bundle, root)
print("OK")
`;

    return spawnSync(
      'python3',
      ['-I', '-S', '-B', '-c', script, HELPER, JSON.stringify(dependencies)],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {},
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('independent Q: safe dot segments normalize through compiler dirs and asset refs', () => {
  const child = runClosure(
    '<mujoco><compiler meshdir="./assets/./meshes"/><asset><mesh name="m" file="./parts/./mesh.obj"/></asset></mujoco>',
    {
      files: {
        'models/assets/meshes/parts/mesh.obj': 'v 0 0 0\n',
      },
      dependencies: [
        { path: 'models/assets/meshes/parts/mesh.obj', role: 'asset' },
      ],
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout.trim(), 'OK');
});

test('independent Q: dot normalization never launders a parent traversal', () => {
  const child = runClosure(
    '<mujoco><asset><mesh name="m" file="./parts/../mesh.obj"/></asset></mujoco>',
    {
      files: {
        'models/mesh.obj': 'v 0 0 0\n',
      },
      dependencies: [
        { path: 'models/mesh.obj', role: 'asset' },
      ],
    },
  );
  assert.notEqual(child.status, 0, 'parent traversal was normalized into an approved dependency');
});

test('independent Q: nested include with safe dot segments binds to main-MJCF-relative dependency', () => {
  const child = runClosure(
    '<mujoco><include file="./parts/./component.xml"/></mujoco>',
    {
      files: {
        'models/parts/component.xml': '<mujoco><worldbody/></mujoco>',
      },
      dependencies: [
        { path: 'models/parts/component.xml', role: 'include' },
      ],
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout.trim(), 'OK');
});

test('independent Q: unreviewed file-bearing flexcomp remains fail-closed even when declared', () => {
  const child = runClosure(
    '<mujoco><worldbody><flexcomp name="f" file="./mesh.obj"/></worldbody></mujoco>',
    {
      files: {
        'models/mesh.obj': 'v 0 0 0\n',
      },
      dependencies: [
        { path: 'models/mesh.obj', role: 'asset' },
      ],
    },
  );
  assert.notEqual(child.status, 0, 'unreviewed file-bearing flexcomp was accepted');
});
