// T22-05 actual npm-packed SDK consumer validation.
// All package creation and consumer installation are offline, disposable and
// do not execute lifecycle hooks, untrusted adapter code, or shared registry.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.env.T22_TEST_NPM || 'npm';
const sha256 = data => createHash('sha256').update(data).digest('hex');
let scratch, installed, exported, packageMetadata, packedNames;

function run(program, args, cwd, ms = 20000) {
  const proc = spawnSync(program, args, {
    cwd, encoding: 'utf8', timeout: ms,
    env: { ...process.env, npm_config_audit: 'false',
      npm_config_fund: 'false', npm_config_update_notifier: 'false',
      npm_config_progress: 'false' },
  });
  assert.equal(proc.status, 0,
    'failed command: ' + args[0] + ', exit=' + proc.status + ', stderr=' +
    (proc.stderr || '').slice(-500));
  assert.equal(proc.stderr, '');
  return proc.stdout.trim();
}
function manifest() {
  return {
    contract: exported.SDK_MANIFEST_CONTRACT,
    adapter: {
      id: 'typescript-nestjs', title: 'NestJS', version: '0.1.0',
      descriptorContract: exported.CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
    },
    compatibility: { bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' } },
    entrypoint: {
      protocol: exported.SDK_ENTRYPOINT_PROTOCOL,
      path: 'adapter-worker.mjs', export: 'adapterWorker',
    },
    permissions: {
      readRoots: ['.'], writeRoots: [], network: 'deny-by-default',
      environment: [], subprocess: 'deny-by-default',
    },
    fixtures: ['fixtures/minimal'], verificationBasis: 'synthetic-only',
    activation: { mode: exported.ACTIVATION_MODE },
  };
}
before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t22-pack-consumer-'));
  const out = run(NPM, ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', scratch], ROOT, 30000);
  const result = JSON.parse(out);
  assert.equal(result.length, 1);
  packageMetadata = result[0];
  const packed = path.join(scratch, packageMetadata.filename);
  assert.ok(fs.statSync(packed).size > 10000);
  packedNames = new Set(packageMetadata.files.map(f => f.path));
  const consumer = path.join(scratch, 'consumer');
  fs.mkdirSync(consumer);
  run(NPM, ['install', '--offline', '--ignore-scripts', '--no-audit',
    '--no-fund', '--no-save', '--prefix', consumer, packed], scratch, 35000);
  installed = path.join(consumer, 'node_modules', 'backend-skeleton', 'sdk', 'next');
  exported = await import(pathToFileURL(path.join(installed, 'index.mjs')).href);
}, { timeout: 85000 });

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test('T22P01 real pack contains SDK entry, imports and nine schema assets', () => {
  for (const name of ['sdk/next/index.mjs', 'sdk/next/manifest.mjs',
    'sdk/next/package-inventory.mjs', 'sdk/next/DISTRIBUTION_V1.md']) {
    assert.ok(packedNames.has(name), 'missing: ' + name);
  }
  assert.equal(Object.keys(exported.SDK_SCHEMA_FILES).length, 9);
  for (const name of Object.values(exported.SDK_SCHEMA_FILES)) {
    assert.ok(packedNames.has('sdk/next/' + name), 'missing schema: ' + name);
  }
});

test('T22P02 installed SDK is byte-identical to source, not a checkout import', () => {
  for (const name of ['index.mjs', 'manifest.mjs', 'package-inventory.mjs',
    'protocol.mjs', 'schema-catalog.mjs', 'testkit.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, 'sdk', 'next', name));
    const customer = fs.readFileSync(path.join(installed, name));
    assert.equal(sha256(source), sha256(customer), name);
  }
  assert.equal(fs.realpathSync(installed).startsWith(fs.realpathSync(ROOT) + path.sep), false);
});

test('T22P03 all nine installed JSON schemas load correctly', () => {
  assert.equal(Object.keys(exported.SDK_SCHEMA_IDS).length, 9);
  for (const [name, rel] of Object.entries(exported.SDK_SCHEMA_FILES)) {
    const parsed = JSON.parse(fs.readFileSync(path.join(installed, rel), 'utf8'));
    assert.equal(parsed.$id, exported.SDK_SCHEMA_IDS[name], name);
  }
});

test('T22P04 installed manifest validates, but activation remains manual', () => {
  const accepted = manifest();
  assert.equal(exported.validateAdapterSdkManifest(accepted).ok, true);
  assert.equal(exported.supportsBskelVersion(accepted, '1.9.0'), true);
  const plan = exported.planExternalAdapterActivation(accepted);
  assert.equal(plan.valid, true);
  assert.equal(plan.executable, false);
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.autoInstall, false);
  assert.equal(plan.autoImport, false);
});

test('T22P05 invalid traversal and permissive privilege rules fail closed', () => {
  const invalid = manifest();
  invalid.entrypoint.path = '../escape.mjs';
  invalid.permissions.network = 'allow';
  invalid.permissions.subprocess = 'allow';
  const check = exported.validateAdapterSdkManifest(invalid);
  assert.equal(check.ok, false);
  assert.match(check.errors.map(x => x.message).join(' '), /package-relative path/);
  assert.match(check.errors.map(x => x.message).join(' '), /deny-by-default/);
  assert.equal(exported.planExternalAdapterActivation(invalid).executable, false);
});

test('T22P06 installed package review is read-only and cannot authorize execution', () => {
  const inventory = exported.createAdapterPackageInventory({
    packageSha256: 'a'.repeat(64),
    files: [
      { path: 'adapter-worker.mjs', sha256: 'b'.repeat(64), sizeBytes: 10, kind: 'file' },
      { path: 'fixtures/minimal/example.ts', sha256: 'c'.repeat(64), sizeBytes: 5, kind: 'file' },
    ],
  });
  const r = exported.reviewAdapterPackage({
    manifest: manifest(), inventory, observedPackageSha256: 'a'.repeat(64),
  });
  assert.equal(r.inventoryValid, true);
  assert.equal(r.referencesSatisfied, true);
  assert.equal(r.digestMatch, true);
  assert.equal(r.packageBytesTrusted, false);
  assert.equal(r.executable, false);
  assert.equal(r.requiresApproval, true);
});

test('T22P07 installed review rejects duplicate/path traversal and wrong digest', () => {
  const common = {
    contract: exported.PACKAGE_INVENTORY_CONTRACT, packageSha256: 'a'.repeat(64),
  };
  const candidates = [
    [{ path: '../outside', sha256: 'b'.repeat(64), sizeBytes: 1, kind: 'file' }],
    [
      { path: 'same.js', sha256: 'b'.repeat(64), sizeBytes: 1, kind: 'file' },
      { path: 'same.js', sha256: 'c'.repeat(64), sizeBytes: 1, kind: 'file' },
    ],
  ];
  for (const files of candidates) {
    assert.equal(exported.validateAdapterPackageInventory({ ...common, files }).ok, false);
  }
  const wrong = exported.reviewAdapterPackage({
    manifest: manifest(),
    inventory: exported.createAdapterPackageInventory({
      packageSha256: 'a'.repeat(64),
      files: [{ path: 'README.md', sha256: 'b'.repeat(64), sizeBytes: 1, kind: 'file' }],
    }),
    observedPackageSha256: '0'.repeat(64),
  });
  assert.equal(wrong.referencesSatisfied, false);
  assert.equal(wrong.digestMatch, false);
  assert.equal(wrong.executable, false);
});

test('T22P08 packed files exclude tests and local caches; baseline README unchanged', () => {
  assert.ok(packageMetadata.files.length > 0);
  assert.ok([...packedNames].every(
    name => !name.startsWith('test/') && !name.startsWith('node_modules/')));
  const original = fs.readFileSync(path.join(ROOT, 'sdk/next/README.md'));
  const customer = fs.readFileSync(path.join(installed, 'README.md'));
  assert.equal(sha256(original), sha256(customer));
});

test('T22P09 installed SDK refuses inverted version compatibility', () => {
  const bad = manifest();
  bad.compatibility.bskel = { minInclusive: '2.0.0', maxExclusive: '1.9.0' };
  assert.equal(exported.validateAdapterSdkManifest(bad).ok, false);
  assert.equal(exported.planExternalAdapterActivation(bad).executable, false);
});
