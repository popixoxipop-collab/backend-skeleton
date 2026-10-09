import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_MANIFEST_SCHEMA, validatePermissionManifest } from '../../lib/trust-next/permission-manifest.mjs';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { parseStructuredProtocolText } from '../../adapters/protocol-next/scanners/protocol-loaders.mjs';

// Wave-2 product invariants owned by the T19 independent-QA track.
//
// Each test below exists because an executable wave-2 mutant (see
// product-mutations-wave2.json) SURVIVED the owning track's own tests in the
// exploratory run on the base commit. The mutants named in each header are the
// ones these tests are meant to kill; the recorded official run is
// evidence/next/T19-WAVE2-MUTATION-RECORD.json.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const FORBIDDEN_ENV_NAMES = [
  'BASH_ENV', 'CLASSPATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'ENV',
  'GEM_HOME', 'GEM_PATH', 'JDK_JAVA_OPTIONS', 'JAVA_TOOL_OPTIONS', 'LD_LIBRARY_PATH',
  'LD_PRELOAD', 'NODE_OPTIONS', 'NODE_PATH', 'PERL5LIB', 'PERL5OPT', 'PYTHONPATH',
  'PYTHONSTARTUP', 'RUBYLIB', 'RUBYOPT', '_JAVA_OPTIONS',
];

test('wave-2 TRUST-05: the declared code-loading environment denylist matches the reviewed list exactly', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/trust-next/permission-manifest.mjs'), 'utf8');
  const match = source.match(/const FORBIDDEN_ENV = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, 'FORBIDDEN_ENV declaration not found in permission-manifest.mjs');
  const declared = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, [...FORBIDDEN_ENV_NAMES].sort(), 'adding or removing a forbidden name needs an explicit review of this list');
});

test('wave-2 TRUST-05: every code-loading environment name is refused as an inheritable variable', () => {
  for (const name of FORBIDDEN_ENV_NAMES) {
    const result = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: [name] } });
    assert.equal(result.ok, false, `${name} must not be inheritable`);
    assert.equal(result.errors.some((e) => e.code === 'FORBIDDEN_ENV_NAME'), true, name);
  }
  const control = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI', 'LANG'] } });
  assert.equal(control.ok, true, 'harmless names stay allowed');
});

test('wave-2 TRUST-08: absolute, drive-letter, empty-segment and traversal roots are refused for read and write roots', () => {
  const refused = ['/etc/passwd', '/var/run/docker.sock', '/', 'C:/Windows', 'c:/x', 'a//b', 'a/', './..', 'a/../b', '../x', '', 'a\\b'];
  for (const field of ['read_roots', 'write_roots']) {
    for (const root of refused) {
      const result = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, [field]: [root] });
      assert.equal(result.ok, false, `${field}: ${JSON.stringify(root)} must be refused`);
      assert.equal(result.errors.some((e) => e.code === 'INVALID_PERMISSION_ROOT'), true, `${field}: ${JSON.stringify(root)}`);
    }
    for (const root of ['.', 'src', 'src/lib', 'a.b/c-d']) {
      const result = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, [field]: [root] });
      assert.equal(result.ok, true, `${field}: ${JSON.stringify(root)} is a valid repo-relative root`);
    }
  }
});

test('wave-2 CACHE-06: a stored artifact whose bytes were replaced by same-size different bytes fails the read-time integrity check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-wave2-store-'));
  try {
    const store = createArtifactStore(dir);
    const ref = store.put(Buffer.from('artifact-bytes-0123456789', 'utf8'));
    assert.deepEqual(store.read(ref), Buffer.from('artifact-bytes-0123456789', 'utf8'), 'control: untouched bytes read back');
    const blob = store.pathForDigest(ref.digest);
    fs.chmodSync(blob, 0o600);
    fs.writeFileSync(blob, Buffer.from('artifact-bytes-012345678X', 'utf8'));
    assert.equal(fs.statSync(blob).size, ref.size, 'the corruption keeps the size, so only a re-hash can see it');
    assert.throws(() => store.read(ref), (error) => error.code === 'ARTIFACT_CORRUPT');
    fs.writeFileSync(blob, Buffer.from('short', 'utf8'));
    assert.throws(() => store.read(ref), (error) => error.code === 'ARTIFACT_CORRUPT', 'control: a size change is refused too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wave-2 SCHEMA-03: structured protocol documents deeper than maxDepth are refused, at the limit they parse', () => {
  const nested = (levels) => JSON.stringify(Array.from({ length: levels }).reduceRight((inner) => ({ k: inner }), 1));
  assert.throws(() => parseStructuredProtocolText(nested(8), { file: 'deep.json', maxDepth: 3 }), /exceeds maxDepth=3/);
  assert.doesNotThrow(() => parseStructuredProtocolText(nested(2), { file: 'shallow.json', maxDepth: 3 }));
  assert.throws(() => parseStructuredProtocolText(nested(80), { file: 'default-depth.json' }), /exceeds maxDepth=64/, 'the default budget is enforced too');
});
