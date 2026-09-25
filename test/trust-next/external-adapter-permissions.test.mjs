import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_ADAPTER_SECURITY_REVIEW,
  reviewAdapterSdkSecurity,
  translateAdapterSdkPermissions,
} from '../../lib/trust-next/external-adapter-permissions.mjs';

function manifest() {
  return {
    contract: 'sbf.adapter-sdk-manifest/1',
    adapter: { id: 'typescript-nestjs' },
    activation: { mode: 'manual-approval-required' },
    permissions: {
      readRoots: ['src'],
      writeRoots: [],
      network: 'deny-by-default',
      environment: ['CI', 'LANG'],
      subprocess: 'deny-by-default',
    },
  };
}

test('T22 permission requests are revalidated into the T20 permission vocabulary', () => {
  const translated = translateAdapterSdkPermissions(manifest());
  assert.equal(translated.schema, 'bskel.trust-permissions/1');
  assert.deepEqual(translated.read_roots, ['src']);
  assert.deepEqual(translated.write_roots, []);
  assert.deepEqual(translated.network, { mode: 'deny', allow: [] });
  assert.deepEqual(translated.process, { mode: 'deny', executables: [], max_children: 0 });
  assert.deepEqual(translated.environment, { allow: ['CI', 'LANG'] });
  assert.deepEqual(translated.secret_refs, []);
});

test('security review remains non-executable and binds the normalized permission digest', () => {
  const review = reviewAdapterSdkSecurity(manifest());
  assert.equal(review.schema, EXTERNAL_ADAPTER_SECURITY_REVIEW);
  assert.equal(review.adapter_id, 'typescript-nestjs');
  assert.match(review.permission_manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(review.executable, false);
  assert.equal(review.requires_approval, true);
  assert.equal(review.package_trust_required, true);
  assert.equal(review.runtime_isolation_required, true);
  assert.equal(Object.isFrozen(review.permission_manifest), true);
});

test('T20 independently rejects code-loading environment requests accepted by a syntax-only SDK validator', () => {
  for (const name of ['NODE_OPTIONS', 'PYTHONPATH', 'RUBYOPT', 'LD_PRELOAD', 'JAVA_TOOL_OPTIONS']) {
    const x = manifest();
    x.permissions.environment = [name];
    assert.throws(
      () => translateAdapterSdkPermissions(x),
      (error) => error?.code === 'EXTERNAL_ADAPTER_PERMISSION_TRANSLATION_REJECTED'
        && error.details?.some((item) => item.code === 'FORBIDDEN_ENV_NAME'),
      name,
    );
  }
});

test('T20 refuses wider network/subprocess modes instead of guessing how to sandbox them', () => {
  const network = manifest();
  network.permissions.network = 'allow';
  assert.throws(() => translateAdapterSdkPermissions(network), (e) => e?.code === 'EXTERNAL_ADAPTER_NETWORK_UNSUPPORTED');

  const process = manifest();
  process.permissions.subprocess = 'allow';
  assert.throws(() => translateAdapterSdkPermissions(process), (e) => e?.code === 'EXTERNAL_ADAPTER_PROCESS_UNSUPPORTED');
});

test('unsafe roots are rejected by T20 even if supplied through an external SDK object', () => {
  for (const root of ['../outside', '/etc', 'C:/Windows']) {
    const x = manifest();
    x.permissions.readRoots = [root];
    assert.throws(
      () => translateAdapterSdkPermissions(x),
      (error) => error?.code === 'EXTERNAL_ADAPTER_PERMISSION_TRANSLATION_REJECTED',
      root,
    );
  }
});

test('activation mode, manifest contract, adapter id and permission keys are independently checked', () => {
  const badMode = manifest();
  badMode.activation.mode = 'auto';
  assert.throws(() => translateAdapterSdkPermissions(badMode), (e) => e?.code === 'EXTERNAL_ADAPTER_ACTIVATION_UNSAFE');

  const badContract = manifest();
  badContract.contract = 'sbf.adapter-sdk-manifest/99';
  assert.throws(() => translateAdapterSdkPermissions(badContract), (e) => e?.code === 'EXTERNAL_ADAPTER_MANIFEST_UNSUPPORTED');

  const badId = manifest();
  badId.adapter.id = '../evil';
  assert.throws(() => translateAdapterSdkPermissions(badId), (e) => e?.code === 'EXTERNAL_ADAPTER_MANIFEST_INVALID');

  const extra = manifest();
  extra.permissions.shell = true;
  assert.throws(() => translateAdapterSdkPermissions(extra), (e) => e?.code === 'EXTERNAL_ADAPTER_PERMISSIONS_INVALID');
});
