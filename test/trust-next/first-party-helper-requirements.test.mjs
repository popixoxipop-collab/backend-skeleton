import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_PARTY_HELPER_REQUIREMENTS_CONTRACT,
  buildFirstPartyHelperRequirements,
} from '../../lib/trust-next/first-party-helper-requirements.mjs';

const NODE = 'a'.repeat(64);
const WORKER = 'b'.repeat(64);
const JAVA = 'c'.repeat(64);
const GRADLEW = 'd'.repeat(64);
const WRAPPER = 'e'.repeat(64);

function policy(entries) {
  return {
    schema: 'bskel.trust-artifact-policy/1',
    generation: 6,
    allow: entries.map((sha256) => ({ usage: 'helper', sha256 })),
    revoked: [],
  };
}

test('T08-style static worker uses runner-owned exact assets, bounded stdin, empty env and no target filesystem roots', () => {
  const r = buildFirstPartyHelperRequirements({
    helperId: 't08-native-server-worker',
    helperClass: 'static-worker',
    inputMode: 'bounded-stdin',
    launcher: { basename: 'node', sha256: NODE },
    assets: [{ id: 'worker-module', sha256: WORKER }],
    artifactTrustPolicy: policy([NODE, WORKER]),
    executableBasenames: ['node'],
    readRoots: [],
    writeRoots: [],
    environment: [],
    maxChildren: 1,
    limits: {
      wall_ms: 30_000,
      cpu_ms: 30_000,
      memory_bytes: 536_870_912,
      pids: 4,
      stdout_bytes: 4_194_304,
      stderr_bytes: 65_536,
      scratch_bytes: 1_048_576,
    },
  });
  assert.equal(r.contract, FIRST_PARTY_HELPER_REQUIREMENTS_CONTRACT);
  assert.equal(r.helper_class, 'static-worker');
  assert.equal(r.input_mode, 'bounded-stdin');
  assert.deepEqual(r.runtime.permission_manifest.read_roots, []);
  assert.deepEqual(r.runtime.permission_manifest.write_roots, []);
  assert.deepEqual(r.runtime.permission_manifest.environment, { allow: [] });
  assert.deepEqual(r.runtime.permission_manifest.network, { mode: 'deny', allow: [] });
  assert.equal(r.runner_owned_assets_outside_repository_roots, true);
  assert.equal(r.target_code_execution, false);
  assert.equal(r.executable_now, false);
  assert.equal(r.runtime_binding_required, true);
  assert.equal(r.acquisition, null);
});

test('static worker refuses target filesystem/env/acquisition widening', () => {
  const base = {
    helperId: 't08-native-server-worker',
    helperClass: 'static-worker',
    inputMode: 'bounded-stdin',
    launcher: { basename: 'node', sha256: NODE },
    assets: [{ id: 'worker-module', sha256: WORKER }],
    artifactTrustPolicy: policy([NODE, WORKER]),
    executableBasenames: ['node'],
    readRoots: [],
    writeRoots: [],
    environment: [],
    maxChildren: 1,
  };
  for (const patch of [
    { readRoots: ['src'] },
    { writeRoots: ['scratch'] },
    { environment: ['CI'] },
    { acquisition: { networkAllow: [{ host: 'repo1.maven.org', ports: [443] }] } },
  ]) {
    assert.throws(() => buildFirstPartyHelperRequirements({ ...base, ...patch }), /static-worker/);
  }
});

test('T05-style compiler helper separates dependency acquisition from network-denied runtime', () => {
  const r = buildFirstPartyHelperRequirements({
    helperId: 'java-ast-helper',
    helperClass: 'compiler-helper',
    inputMode: 'approved-files',
    launcher: { basename: 'gradlew', sha256: GRADLEW },
    assets: [
      { id: 'gradle-wrapper-jar', sha256: WRAPPER },
      { id: 'java-runtime', sha256: JAVA },
    ],
    artifactTrustPolicy: policy([GRADLEW, WRAPPER, JAVA]),
    executableBasenames: ['gradlew', 'java'],
    readRoots: ['src/main/java'],
    writeRoots: ['scratch/ast'],
    environment: ['LANG'],
    maxChildren: 8,
    limits: {
      wall_ms: 120_000,
      cpu_ms: 120_000,
      memory_bytes: 2_147_483_648,
      pids: 16,
      stdout_bytes: 16_777_216,
      stderr_bytes: 1_048_576,
      scratch_bytes: 536_870_912,
    },
    acquisition: {
      networkAllow: [{ host: 'repo1.maven.org', ports: [443] }],
      limits: { wall_ms: 300_000, scratch_bytes: 1_073_741_824, memory_bytes: 1_073_741_824, pids: 8 },
    },
  });
  assert.equal(r.helper_class, 'compiler-helper');
  assert.equal(r.input_mode, 'approved-files');
  assert.equal(r.runtime.permission_manifest.network.mode, 'deny');
  assert.deepEqual(r.runtime.permission_manifest.secret_refs, []);
  assert.equal(r.acquisition.separated_from_runtime, true);
  assert.equal(r.acquisition.permission_manifest.network.mode, 'allowlist');
  assert.deepEqual(r.acquisition.permission_manifest.network.allow, [{ host: 'repo1.maven.org', ports: [443] }]);
  assert.equal(r.acquisition.permission_manifest.process.mode, 'deny');
});

test('compiler helper never authorizes target build-script execution', () => {
  assert.throws(
    () => buildFirstPartyHelperRequirements({
      helperId: 'java-ast-helper',
      helperClass: 'compiler-helper',
      inputMode: 'approved-files',
      launcher: { basename: 'gradlew', sha256: GRADLEW },
      assets: [{ id: 'java-runtime', sha256: JAVA }],
      artifactTrustPolicy: policy([GRADLEW, JAVA]),
      executableBasenames: ['gradlew', 'java'],
      readRoots: ['src/main/java'],
      writeRoots: ['scratch'],
      maxChildren: 4,
      targetCodeExecution: true,
    }),
    (e) => e?.code === 'FIRST_PARTY_HELPER_TARGET_EXECUTION_FORBIDDEN',
  );
});

test('launcher and every runner-owned asset must be exact trusted helper bytes', () => {
  assert.throws(
    () => buildFirstPartyHelperRequirements({
      helperId: 'static-worker',
      helperClass: 'static-worker',
      inputMode: 'bounded-stdin',
      launcher: { basename: 'node', sha256: NODE },
      assets: [{ id: 'worker-module', sha256: WORKER }],
      artifactTrustPolicy: policy([NODE]),
      executableBasenames: ['node'],
      maxChildren: 1,
    }),
    (e) => e?.code === 'FIRST_PARTY_HELPER_ASSET_UNTRUSTED',
  );
  assert.throws(
    () => buildFirstPartyHelperRequirements({
      helperId: 'static-worker',
      helperClass: 'static-worker',
      inputMode: 'bounded-stdin',
      launcher: { basename: 'node', sha256: NODE },
      assets: [{ id: 'worker-module', sha256: WORKER }],
      artifactTrustPolicy: policy([WORKER]),
      executableBasenames: ['node'],
      maxChildren: 1,
    }),
    (e) => e?.code === 'FIRST_PARTY_HELPER_LAUNCHER_UNTRUSTED',
  );
});

test('launcher basename must be part of the runtime executable allowlist', () => {
  assert.throws(
    () => buildFirstPartyHelperRequirements({
      helperId: 'static-worker',
      helperClass: 'static-worker',
      inputMode: 'bounded-stdin',
      launcher: { basename: 'node', sha256: NODE },
      assets: [{ id: 'worker-module', sha256: WORKER }],
      artifactTrustPolicy: policy([NODE, WORKER]),
      executableBasenames: ['python3'],
      maxChildren: 1,
    }),
    (e) => e?.code === 'FIRST_PARTY_HELPER_LAUNCHER_NOT_ALLOWED',
  );
});
