// Fixed first-party installed-package probe. Never loads external adapters.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [prefix, mode] = process.argv.slice(2);
assert.ok(path.isAbsolute(prefix || ''));
assert.ok(['present', 'absent'].includes(mode));
const root = path.join(prefix, 'node_modules', 'backend-skeleton');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'backend-skeleton');
const entry = path.join(root, 'sdk/next/index.mjs');
if (mode === 'absent') {
  assert.equal(fs.existsSync(entry), false);
} else {
  const sdk = await import(pathToFileURL(entry).href);
  assert.equal(Object.keys(sdk.SDK_SCHEMA_FILES).length, 9);
  for (const [name, rel] of Object.entries(sdk.SDK_SCHEMA_FILES)) {
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'sdk/next', rel), 'utf8'));
    assert.equal(schema.$id, sdk.SDK_SCHEMA_IDS[name]);
  }
  const manifest = {
    contract: sdk.SDK_MANIFEST_CONTRACT,
    adapter: { id: 'typescript-nestjs', title: 'NestJS', version: '0.1.0',
      descriptorContract: sdk.CURRENT_ADAPTER_DESCRIPTOR_CONTRACT },
    compatibility: { bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' } },
    entrypoint: { protocol: sdk.SDK_ENTRYPOINT_PROTOCOL, path: 'worker.mjs', export: 'adapterWorker' },
    permissions: { readRoots: ['.'], writeRoots: [], network: 'deny-by-default',
      environment: [], subprocess: 'deny-by-default' },
    fixtures: ['fixtures/minimal'], verificationBasis: 'synthetic-only',
    activation: { mode: sdk.ACTIVATION_MODE },
  };
  assert.equal(sdk.validateAdapterSdkManifest(manifest).ok, true);
  const activation = sdk.planExternalAdapterActivation(manifest);
  assert.equal(activation.executable, false);
  assert.equal(activation.autoImport, false);
  assert.equal(activation.requiresApproval, true);
  const result = await sdk.runAdapterSdkConformance({
    manifest, snapshotRef: 'fixture:T22-06-installed-replay',
    cases: [{ operation: 'detect', payload: {}, expectStatus: 'unknown' }],
    invoke: async request => ({
      contract: sdk.SDK_ENTRYPOINT_PROTOCOL, direction: 'response',
      requestId: request.requestId, adapterId: request.adapterId,
      status: 'unknown', result: {}, diagnostics: [],
    }),
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.observations[0].status, 'unknown');
  assert.equal(result.activation.executable, false);
}
console.log(JSON.stringify({ package: pkg.name, version: pkg.version, sdk: mode, ok: true }));
