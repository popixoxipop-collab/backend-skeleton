// Historical installed-package replay for the T08 Node/static worker only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materializePinnedSource, resolveNpmInvocation } from '../../scripts/t22-distribution-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = path.join(ROOT, 'test/language-native-server/installed-replay-probe.mjs');
const EVIDENCE_DIR = path.join(ROOT, 'next/t08/evidence/T08_06');
const MARKER = 'DOT-T00-T08-06-20261122';
const PREVIOUS = '271d5d747d7ef99fb7ce990a95db32fbdf4e46bd';
const CANDIDATE = '0ecc6a27d026f8e5efbfdae36637534fd5d08a2d';
const LOCKS = {
  previous: 'f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087',
  candidate: 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0',
};
// Bind the checked-in receipt bytes. Live replay comparisons below are also
// required, so a valid old digest cannot bless stale installation results.
const EVIDENCE_HASHES = Object.freeze({
  'manifest.json': '7700e59db6f61128d38a9361a1396aaa6ff8ff5516c118e3baeff76ff9ec325d',
  'manifest.sha256': '1bf322717609e7c1d3f755bf9276f3f9b92dcefae4d4dc700e374e2ea9feca71',
  'previous-inventory.json': '23a79f2f67b01f95211de786c10e7e188150537f549820c48f4254709e8fbc4b',
  'candidate-inventory.json': '71395c605f3c98a5439e3c9bcae81c9c5a2d2dfeb9cc225695744c5e7064dcab',
  'normal-receipt.json': 'a1d149c2fb15575cf56e721ee1ea2b9968c7808174b7a45c208cc43b3e431ed6',
  'fault-receipt.json': 'f3e246343413f38c49bac4af40f0f0a4d46cca7ca95eb195e330b4eb8fafcc99',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function environment(extra = {}) {
  const result = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  delete result.NODE_TEST_CONTEXT;
  for (const key of Object.keys(result)) if (key.startsWith('GIT_')) delete result[key];
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = '/dev/null';
  return { ...result, ...extra };
}
function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { env: environment(), timeout: 30000,
    maxBuffer: 64 * 1024 * 1024 });
}
function npm(identity, args, cwd, scratch) {
  assert.equal(sha(fs.readFileSync(identity.executable)), identity.sha256);
  const oldUmask = process.umask(0o022);
  let result;
  try {
    result = spawnSync(process.execPath, [identity.executable, ...args], {
      cwd, env: environment({ npm_config_cache: path.join(scratch, 'npm-cache') }),
      encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
  } finally { process.umask(oldUmask); }
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr?.slice(-1500));
  return result.stdout.trim();
}
function inventory(root) {
  const rows = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, `${name}/`);
      else {
        assert.ok(entry.isFile(), `nonregular installed entry: ${name}`);
        const bytes = fs.readFileSync(full);
        rows.push({ path: name, size: bytes.length, mode: fs.statSync(full).mode & 0o777,
          sha256: sha(bytes) });
      }
    }
  }
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function gitMember(source, revision, member) {
  const bytes = git(['cat-file', 'blob', `${revision}:${member}`]);
  const mode = git(['ls-tree', revision, '--', member]).toString();
  assert.match(mode, /^(100644|100755) blob /);
  const gitMode = mode.startsWith('100755 ') ? 0o755 : 0o644;
  assert.equal(sha(fs.readFileSync(path.join(source, member))), sha(bytes), member);
  assert.equal(fs.statSync(path.join(source, member)).mode & 0o777, gitMode, member);
  return { bytes, gitMode };
}
function snapshot(identity, scratch, slot, revision) {
  assert.equal(git(['cat-file', '-t', revision]).toString().trim(), 'commit');
  const oldUmask = process.umask(0o022);
  let source;
  try { source = materializePinnedSource(ROOT, revision, path.join(scratch, `${slot}-source`), []); }
  finally { process.umask(oldUmask); }
  if (slot === 'candidate') {
    const member = 'scanners/language/native-server/worker.mjs';
    const full = path.join(source, member), original = fs.readFileSync(full);
    const mode = fs.statSync(full).mode & 0o777;
    try {
      fs.appendFileSync(full, '\n');
      assert.throws(() => gitMember(source, revision, member));
      fs.writeFileSync(full, original);
      fs.chmodSync(full, mode === 0o644 ? 0o755 : 0o644);
      assert.throws(() => gitMember(source, revision, member));
    } finally { fs.writeFileSync(full, original); fs.chmodSync(full, mode); }
    gitMember(source, revision, member);
  }
  const destination = path.join(scratch, `${slot}-pack`);
  fs.mkdirSync(destination);
  const [metadata] = JSON.parse(npm(identity, ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', destination], source, scratch));
  assert.equal(metadata.name, 'backend-skeleton');
  const archive = path.join(destination, metadata.filename);
  const members = new Map(metadata.files.map(file => [file.path, file]));
  assert.equal(members.size, metadata.files.length);
  const bins = new Set(Object.values(JSON.parse(git(['show', `${revision}:package.json`])).bin));
  const expected = metadata.files.map(file => {
    assert.ok(!path.posix.isAbsolute(file.path) && !/[\\:\x00-\x1f]/.test(file.path) &&
      !file.path.split('/').some(part => !part || part === '.' || part === '..'));
    const { bytes, gitMode } = gitMember(source, revision, file.path);
    assert.equal(file.size, bytes.length, file.path);
    assert.equal(file.mode, gitMode, file.path);
    return { path: file.path, size: file.size,
      mode: bins.has(file.path) ? 0o755 : gitMode, sha256: sha(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const worker = 'scanners/language/native-server/worker.mjs';
  assert.equal(members.has(worker), slot === 'candidate');
  assert.equal(members.has('test/language-native-server/package-replay.test.mjs'), false);
  return { revision, tree: git(['rev-parse', `${revision}^{tree}`]).toString().trim(), archive,
    archive_sha256: sha(fs.readFileSync(archive)), member_count: metadata.files.length, expected };
}
function pins() {
  const lock = Object.fromEntries(Object.entries({ previous: PREVIOUS, candidate: CANDIDATE })
    .map(([slot, revision]) => {
      const bytes = git(['show', `${revision}:package-lock.json`]);
      assert.equal(sha(bytes), LOCKS[slot]);
      return [slot, JSON.parse(bytes)];
    }));
  const deps = value => Object.fromEntries(Object.entries(value.packages)
    .filter(([name]) => name.startsWith('node_modules/')));
  assert.deepEqual(deps(lock.previous), deps(lock.candidate));
  return Object.fromEntries(Object.entries(deps(lock.candidate)).map(([name, entry]) =>
    [name.slice('node_modules/'.length), entry.version]));
}
function verifyArtifacts(manifestBytes, digest, packages) {
  assert.equal(sha(manifestBytes), digest, 'manifest bytes changed');
  const manifest = JSON.parse(manifestBytes);
  for (const slot of ['previous', 'candidate']) {
    assert.equal(manifest.packages[slot].archive_sha256,
      sha(fs.readFileSync(packages[slot].archive)), `${slot} archive changed`);
    assert.equal(manifest.packages[slot].inventory_sha256,
      sha(json(packages[slot].expected)), `${slot} inventory changed`);
  }
}
function readCommittedEvidence() {
  return Object.fromEntries(Object.keys(EVIDENCE_HASHES).map(name => {
    const full = path.join(EVIDENCE_DIR, name);
    assert.ok(fs.lstatSync(full).isFile(), `${name} is not a regular file`);
    return [name, fs.readFileSync(full)];
  }));
}
function bindCommittedEvidence(evidence, liveManifest, packages, normal, fault, identity) {
  for (const [name, expected] of Object.entries(EVIDENCE_HASHES))
    assert.equal(sha(evidence[name]), expected, `committed evidence changed: ${name}`);
  const recordedBytes = evidence['manifest.json'];
  const recordedDigest = sha(recordedBytes);
  assert.equal(evidence['manifest.sha256'].toString('utf8'), `${recordedDigest}\n`,
    'manifest.sha256 does not bind manifest.json');
  const recorded = JSON.parse(recordedBytes);
  assert.equal(recorded.schema, liveManifest.schema);
  assert.equal(recorded.marker, MARKER);
  assert.deepEqual(recorded.source, liveManifest.source, 'historical Git or lock pin drift');
  assert.equal(recorded.compiler_certified, false);
  assert.equal(recorded.release_authorized, false);
  assert.equal(recorded.toolchain.umask, '022');
  const sameToolchain = recorded.toolchain.node === process.version &&
    recorded.toolchain.npm_cli_sha256 === identity.sha256;
  for (const slot of ['previous', 'candidate']) {
    const { archive_sha256: recordedArchive, ...recordedStable } = recorded.packages[slot];
    const { archive_sha256: liveArchive, ...liveStable } = liveManifest.packages[slot];
    assert.deepEqual(recordedStable, liveStable, `${slot} source or installed inventory drift`);
    assert.deepEqual(JSON.parse(evidence[`${slot}-inventory.json`]), packages[slot].expected,
      `${slot} committed inventory differs from the installed package`);
    if (sameToolchain)
      assert.equal(recordedArchive, liveArchive, `${slot} same-toolchain archive drift`);
  }
  assert.deepEqual(JSON.parse(evidence['normal-receipt.json']), normal,
    'committed normal receipt differs from live replay');
  assert.deepEqual(JSON.parse(evidence['fault-receipt.json']), fault,
    'committed fault receipt differs from live replay');
  return { same_toolchain_archive_bytes_compared: sameToolchain };
}
function rehearse(identity, scratch, packages, dependencyPins, interrupt) {
  const consumer = fs.mkdtempSync(path.join(scratch, interrupt ? 'fault-' : 'normal-'));
  fs.writeFileSync(path.join(consumer, 'package.json'), json({ name: 't08-disposable-consumer',
    version: '0.0.0', private: true, overrides: dependencyPins }));
  const stages = [], failures = [];
  let baselineReady = false;
  function install(slot) {
    const pkg = packages[slot];
    assert.equal(sha(fs.readFileSync(pkg.archive)), pkg.archive_sha256);
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
    npm(identity, ['install', '--prefer-offline', '--ignore-scripts', '--no-save',
      '--package-lock=false', '--prefix', consumer, pkg.archive], scratch, scratch);
    const installed = path.join(consumer, 'node_modules/backend-skeleton');
    const observed = inventory(installed);
    assert.deepEqual(observed, pkg.expected, `${slot} installed inventory differs from Git`);
    if (slot === 'candidate' && !interrupt) {
      const worker = path.join(installed, 'scanners/language/native-server/worker.mjs');
      const original = fs.readFileSync(worker);
      const mode = fs.statSync(worker).mode & 0o777;
      try {
        fs.appendFileSync(worker, '\n');
        assert.notDeepEqual(inventory(installed), pkg.expected, 'installed byte tamper undetected');
        fs.writeFileSync(worker, original);
        fs.chmodSync(worker, mode === 0o644 ? 0o755 : 0o644);
        assert.notDeepEqual(inventory(installed), pkg.expected, 'installed mode tamper undetected');
      } finally { fs.writeFileSync(worker, original); fs.chmodSync(worker, mode); }
      assert.deepEqual(inventory(installed), pkg.expected);
    }
    const result = spawnSync(process.execPath, [PROBE, installed, slot], {
      cwd: scratch, env: environment(interrupt && slot === 'candidate'
        ? { T08_TEST_INTERRUPT_PROBE: '1' } : {}), encoding: 'utf8', timeout: 90000 });
    const stage = { slot, inventory_sha256: sha(json(observed)), member_count: observed.length,
      probe_exit_code: result.status, probe_signal: result.signal,
      probe_stdout_sha256: sha(Buffer.from(result.stdout)),
      probe_stderr_sha256: sha(Buffer.from(result.stderr)),
      probe: result.stdout.trim() ? JSON.parse(result.stdout) : null };
    stages.push(stage);
    if (interrupt && slot === 'candidate') {
      assert.equal(result.signal, 'SIGTERM');
      throw new Error('T08_CANDIDATE_PROBE_SIGTERM');
    }
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stage.probe.slot, slot);
    assert.equal(stage.probe.release_authorized, false);
  }
  try {
    install('previous'); baselineReady = true;
    install('candidate');
  } catch (error) { failures.push(error.message); }
  finally {
    if (baselineReady) {
      try { install('previous'); }
      catch (error) { failures.push(`ROLLBACK_FAILED: ${error.message}`); }
    }
  }
  assert.deepEqual(stages.map(stage => stage.slot), ['previous', 'candidate', 'previous']);
  assert.equal(stages[0].inventory_sha256, stages[2].inventory_sha256);
  return { schema: 'bskel.t08-static-package-replay/1', marker: MARKER,
    status: failures.length ? 'interrupted-restored' : 'pass', interrupt,
    stages, failures, rollback_restored: true,
    compiler_certified: false, release_authorized: false, independent_attestation: false };
}

test('T08 installed static worker previous→candidate→previous and interrupted recovery',
  { skip: process.platform === 'win32', timeout: 300000 }, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t08-package-replay-'));
    try {
      const identity = resolveNpmInvocation();
      git(['merge-base', '--is-ancestor', PREVIOUS, CANDIDATE]);
      const dependencyPins = pins();
      const packages = {
        previous: snapshot(identity, scratch, 'previous', PREVIOUS),
        candidate: snapshot(identity, scratch, 'candidate', CANDIDATE),
      };
      const liveManifest = { schema: 'bskel.t08-static-package-replay-manifest/1', marker: MARKER,
        source: { previous: PREVIOUS, candidate: CANDIDATE, locks: LOCKS },
        packages: Object.fromEntries(Object.entries(packages).map(([slot, value]) =>
          [slot, { revision: value.revision, tree: value.tree,
            archive_sha256: value.archive_sha256, member_count: value.member_count,
            inventory_sha256: sha(json(value.expected)) }])),
        toolchain: { node: process.version, npm_cli_sha256: identity.sha256, umask: '022' },
        compiler_certified: false, release_authorized: false };
      const manifest = json(liveManifest);
      const manifestSha = sha(manifest);
      verifyArtifacts(manifest, manifestSha, packages);
      assert.throws(() => verifyArtifacts(Buffer.concat([manifest, Buffer.from(' ')]),
        manifestSha, packages), /manifest bytes changed/);
      fs.appendFileSync(packages.candidate.archive, 'tampered');
      assert.throws(() => verifyArtifacts(manifest, manifestSha, packages),
        /candidate archive changed/);
      fs.truncateSync(packages.candidate.archive,
        fs.statSync(packages.candidate.archive).size - Buffer.byteLength('tampered'));
      verifyArtifacts(manifest, manifestSha, packages);
      const normal = rehearse(identity, scratch, packages, dependencyPins, false);
      assert.equal(normal.status, 'pass');
      assert.equal(normal.stages[1].probe.vectors, 2);
      const fault = rehearse(identity, scratch, packages, dependencyPins, true);
      assert.deepEqual(fault.failures, ['T08_CANDIDATE_PROBE_SIGTERM']);
      assert.equal(fault.rollback_restored, true);
      const evidence = readCommittedEvidence();
      const binding = bindCommittedEvidence(evidence, liveManifest, packages, normal, fault, identity);
      const tamperedManifest = { ...evidence,
        'manifest.json': Buffer.concat([evidence['manifest.json'], Buffer.from(' ')]) };
      assert.throws(() => bindCommittedEvidence(tamperedManifest, liveManifest, packages,
        normal, fault, identity), /committed evidence changed: manifest.json/);
      for (const name of ['manifest.sha256', 'normal-receipt.json', 'fault-receipt.json',
        'previous-inventory.json', 'candidate-inventory.json']) {
        const tampered = { ...evidence, [name]: Buffer.concat([evidence[name], Buffer.from(' ')]) };
        assert.throws(() => bindCommittedEvidence(tampered, liveManifest, packages,
          normal, fault, identity), /committed evidence changed/);
      }
      const staleNormal = structuredClone(normal);
      staleNormal.stages[2].inventory_sha256 = '0'.repeat(64);
      assert.throws(() => bindCommittedEvidence(evidence, liveManifest, packages,
        staleNormal, fault, identity), /committed normal receipt differs from live replay/);
      const staleFault = structuredClone(fault);
      staleFault.stages[1].probe_signal = null;
      assert.throws(() => bindCommittedEvidence(evidence, liveManifest, packages,
        normal, staleFault, identity), /committed fault receipt differs from live replay/);
      const differentRuntime = structuredClone(liveManifest);
      differentRuntime.toolchain.node = 'v22.0.0';
      differentRuntime.toolchain.npm_cli_sha256 = '0'.repeat(64);
      differentRuntime.packages.candidate.archive_sha256 = '0'.repeat(64);
      assert.deepEqual(bindCommittedEvidence(evidence, differentRuntime, packages,
        normal, fault, { sha256: differentRuntime.toolchain.npm_cli_sha256 }),
      { same_toolchain_archive_bytes_compared: false });
      differentRuntime.packages.candidate.inventory_sha256 = '0'.repeat(64);
      assert.throws(() => bindCommittedEvidence(evidence, differentRuntime, packages,
        normal, fault, { sha256: differentRuntime.toolchain.npm_cli_sha256 }),
      /candidate source or installed inventory drift/);
      const output = process.env.T08_REPLAY_OUTPUT_DIR;
      if (output) {
        assert.ok(path.isAbsolute(output) && !fs.existsSync(output));
        fs.mkdirSync(output, { mode: 0o700 });
        for (const slot of ['previous', 'candidate'])
          fs.copyFileSync(packages[slot].archive, path.join(output, `${slot}.tgz`));
        fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
        fs.writeFileSync(path.join(output, 'manifest.sha256'), manifestSha + '\n');
        for (const slot of ['previous', 'candidate'])
          fs.writeFileSync(path.join(output, `${slot}-inventory.json`), json(packages[slot].expected));
        fs.writeFileSync(path.join(output, 'normal-receipt.json'), json(normal));
        fs.writeFileSync(path.join(output, 'fault-receipt.json'), json(fault));
      }
      console.log(JSON.stringify({ marker: MARKER, manifest_sha256: manifestSha,
        committed_manifest_sha256: sha(evidence['manifest.json']), evidence_bound: true,
        ...binding,
        previous_archive_sha256: packages.previous.archive_sha256,
        candidate_archive_sha256: packages.candidate.archive_sha256,
        previous_members: packages.previous.member_count,
        candidate_members: packages.candidate.member_count,
        normal: normal.status, fault: fault.status, rollback_restored: true,
        retained: output ?? null }));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
