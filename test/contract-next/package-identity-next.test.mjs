import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('npm pack contains the T01 next identity lane and the installed module replays conformance vectors', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t01-pack-'));
  try {
    const packJson = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], {
      cwd: ROOT,
      encoding: 'utf8',
    }));
    assert.equal(packJson.length, 1);
    const packed = packJson[0];
    const names = new Set(packed.files.map((entry) => entry.path));
    for (const required of [
      'contracts/next/identity.mjs',
      'contracts/next/README.md',
      'schemas/next/artifact-ref.schema.json',
      'schemas/next/identity-envelope.schema.json',
      'schemas/next/identity.golden.json',
      'schemas/next/identity-conformance.json',
    ]) {
      assert.equal(names.has(required), true, `packed artifact is missing ${required}`);
    }

    const installDir = path.join(scratch, 'install');
    fs.mkdirSync(installDir);
    execFileSync('npm', ['init', '--yes', '--silent'], { cwd: installDir, stdio: 'pipe' });
    execFileSync('npm', ['install', '--silent', '--ignore-scripts', path.join(scratch, packed.filename)], {
      cwd: installDir,
      stdio: 'pipe',
    });

    const installedRoot = path.join(installDir, 'node_modules', 'backend-skeleton');
    const identity = await import(pathToFileURL(path.join(installedRoot, 'contracts', 'next', 'identity.mjs')).href);
    const pack = JSON.parse(fs.readFileSync(path.join(installedRoot, 'schemas', 'next', 'identity-conformance.json'), 'utf8'));

    for (const vector of pack.positive_cases) {
      assert.deepEqual(identity.readIdentity(vector.input), vector.expected, vector.name);
    }
    for (const vector of pack.negative_cases) {
      assert.throws(() => identity.readIdentity(vector.input), new RegExp(vector.error_pattern), vector.name);
    }
    for (const vector of pack.artifact_cases) {
      const actual = identity.createArtifactRef(vector.utf8, vector.options);
      assert.deepEqual(actual, vector.expected_ref, vector.name);
      assert.equal(identity.artifactRefMatches(vector.utf8, actual), true, vector.name);
    }

    assert.match(packed.shasum, /^[a-f0-9]{40}$/);
    assert.match(packed.integrity, /^sha512-/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
