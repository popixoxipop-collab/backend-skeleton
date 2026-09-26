import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_EXPORT_REQUIREMENTS_CONTRACT,
  buildNativeEngineExportRequirements,
} from '../../lib/trust-next/native-engine-export-requirements.mjs';

const A = 'a'.repeat(64);

function trust() {
  return {
    schema: 'bskel.trust-artifact-policy/1',
    generation: 5,
    allow: [{ usage: 'helper', sha256: A }],
    revoked: [],
  };
}

test('Godot headless export requirements are data-only, exact-digest and network-denied', () => {
  const r = buildNativeEngineExportRequirements({
    engine: 'godot',
    executable: 'godot4',
    executableSha256: A,
    artifactTrustPolicy: trust(),
    readRoots: ['project'],
    writeRoots: ['scratch/export'],
    environment: ['LANG'],
    maxChildren: 8,
    limits: { wall_ms: 120_000, cpu_ms: 120_000, memory_bytes: 2_147_483_648, pids: 16, scratch_bytes: 1_073_741_824 },
  });
  assert.equal(r.contract, NATIVE_EXPORT_REQUIREMENTS_CONTRACT);
  assert.equal(r.engine, 'godot');
  assert.equal(r.executable.trust.decision, 'trusted');
  assert.deepEqual(r.permission_manifest.network, { mode: 'deny', allow: [] });
  assert.deepEqual(r.permission_manifest.devices, { mode: 'deny', allow: [] });
  assert.equal(r.permission_manifest.process.executables[0], 'godot4');
  assert.equal(r.executable_now, false);
  assert.equal(r.runtime_binding_required, true);
  assert.equal(r.cleanup_proof_required, true);
  assert.equal(r.runtime_behavior_certified, false);
  assert.match(r.trust_requirements.permission.sha256, /^[0-9a-f]{64}$/);
});

test('Unreal/Unity metadata exports can request explicit GPU/display classes without gaining network or secrets', () => {
  for (const [engine, executable] of [['unreal', 'UnrealEditor'], ['unity', 'Unity']]) {
    const r = buildNativeEngineExportRequirements({
      engine,
      executable,
      executableSha256: A,
      artifactTrustPolicy: trust(),
      readRoots: ['project'],
      writeRoots: ['scratch/export'],
      environment: ['LANG'],
      deviceClasses: ['gpu', 'display'],
      maxChildren: 32,
      limits: { wall_ms: 300_000, cpu_ms: 300_000, memory_bytes: 8_589_934_592, pids: 64, scratch_bytes: 10_737_418_240 },
    });
    assert.deepEqual(r.permission_manifest.devices, { mode: 'allowlist', allow: ['display', 'gpu'] });
    assert.deepEqual(r.permission_manifest.secret_refs, []);
    assert.equal(r.permission_manifest.network.mode, 'deny');
  }
});

test('native export refuses untrusted/revoked engine executable bytes', () => {
  assert.throws(
    () => buildNativeEngineExportRequirements({
      engine: 'godot', executable: 'godot4', executableSha256: A,
      artifactTrustPolicy: { schema: 'bskel.trust-artifact-policy/1', generation: 1, allow: [], revoked: [] },
      readRoots: ['project'], writeRoots: ['scratch'], maxChildren: 2,
    }),
    (e) => e?.code === 'NATIVE_EXPORT_EXECUTABLE_UNTRUSTED',
  );
  assert.throws(
    () => buildNativeEngineExportRequirements({
      engine: 'godot', executable: 'godot4', executableSha256: A,
      artifactTrustPolicy: { schema: 'bskel.trust-artifact-policy/1', generation: 2, allow: [], revoked: [{ sha256: A, reason: 'revoked engine executable' }] },
      readRoots: ['project'], writeRoots: ['scratch'], maxChildren: 2,
    }),
    (e) => e?.code === 'NATIVE_EXPORT_EXECUTABLE_REVOKED',
  );
});

test('native export refuses paths/shells, ambient injection env and missing resource/process scopes', () => {
  for (const executable of ['/Applications/Unity', '../godot', 'sh -c']) {
    assert.throws(
      () => buildNativeEngineExportRequirements({
        engine: 'unity', executable, executableSha256: A, artifactTrustPolicy: trust(),
        readRoots: ['project'], writeRoots: ['scratch'], maxChildren: 2,
      }),
      (e) => e?.code === 'NATIVE_EXPORT_EXECUTABLE_INVALID',
      executable,
    );
  }

  assert.throws(
    () => buildNativeEngineExportRequirements({
      engine: 'unreal', executable: 'UnrealEditor', executableSha256: A, artifactTrustPolicy: trust(),
      readRoots: ['project'], writeRoots: ['scratch'], environment: ['NODE_OPTIONS'], maxChildren: 2,
    }),
    (e) => e?.code === 'NATIVE_EXPORT_PERMISSION_REJECTED',
  );

  for (const bad of [
    { readRoots: [], writeRoots: ['scratch'], maxChildren: 2 },
    { readRoots: ['project'], writeRoots: [], maxChildren: 2 },
    { readRoots: ['project'], writeRoots: ['scratch'], maxChildren: 0 },
  ]) {
    assert.throws(
      () => buildNativeEngineExportRequirements({
        engine: 'godot', executable: 'godot4', executableSha256: A, artifactTrustPolicy: trust(), ...bad,
      }),
      (e) => ['NATIVE_EXPORT_ARGUMENT_INVALID', 'NATIVE_EXPORT_CHILD_LIMIT_REQUIRED'].includes(e?.code),
    );
  }
});

test('native export has no implicit all-devices or broad network escape hatch', () => {
  assert.throws(
    () => buildNativeEngineExportRequirements({
      engine: 'unreal', executable: 'UnrealEditor', executableSha256: A, artifactTrustPolicy: trust(),
      readRoots: ['project'], writeRoots: ['scratch'], deviceClasses: ['all-devices'], maxChildren: 4,
    }),
    (e) => e?.code === 'NATIVE_EXPORT_PERMISSION_REJECTED',
  );
});
