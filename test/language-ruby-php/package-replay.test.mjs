// Historical installed-package replay, not parser approval or live release authority.
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
const PROBE = path.join(ROOT, 'test/language-ruby-php/installed-replay-probe.mjs');
const MARKER = 'DOT-T00-R262-T07-06-20261121';
const PREVIOUS = '271d5d747d7ef99fb7ce990a95db32fbdf4e46bd';
const CANDIDATE = '609c9410919d241186c9d912c8ffc152c8104011';
const LOCKS = {
  previous: 'f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087',
  candidate: 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function environment(extra = {}) {
  const result = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  delete result.NODE_TEST_CONTEXT;
  for (const key of Object.keys(result)) if (key.startsWith('GIT_')) delete result[key];
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return { ...result, ...extra };
}
function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { env: environment(), timeout: 30000,
    maxBuffer: 64 * 1024 * 1024 });
}
function npm(identity, args, cwd, scratch) {
  assert.equal(sha(fs.readFileSync(identity.executable)), identity.sha256);
  // npm applies the caller's umask on extraction; use the standard 022 mode
  // so the installed-mode oracle is deterministic even on a 077 runner.
  const originalUmask = process.umask(0o022);
  let result;
  try {
    result = spawnSync(process.execPath, [identity.executable, ...args], {
      cwd, env: environment({ npm_config_cache: path.join(scratch, 'npm-cache') }),
      encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
  } finally { process.umask(originalUmask); }
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `npm signal ${result.signal}`);
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
function assertGitSourceMember(source, revision, member) {
  const bytes = git(['cat-file', 'blob', `${revision}:${member}`]);
  const mode = git(['ls-tree', revision, '--', member]).toString();
  assert.match(mode, /^(100644|100755) blob /);
  const gitMode = mode.startsWith('100755 ') ? 0o755 : 0o644;
  assert.equal(sha(fs.readFileSync(path.join(source, member))), sha(bytes), member);
  assert.equal(fs.statSync(path.join(source, member)).mode & 0o777, gitMode, member);
  return { bytes, gitMode };
}
function packageSnapshot(identity, scratch, slot, revision) {
  assert.equal(git(['cat-file', '-t', revision]).toString().trim(), 'commit');
  const originalUmask = process.umask(0o022);
  let source;
  try {
    source = materializePinnedSource(ROOT, revision, path.join(scratch, `${slot}-source`), []);
  } finally { process.umask(originalUmask); }
  if (slot === 'candidate') {
    const member = 'scanners/language/ruby-php/dsl-facts.mjs';
    const full = path.join(source, member);
    const original = fs.readFileSync(full);
    const originalMode = fs.statSync(full).mode & 0o777;
    try {
      fs.appendFileSync(full, '\n');
      assert.throws(() => assertGitSourceMember(source, revision, member));
      fs.writeFileSync(full, original);
      fs.chmodSync(full, 0o755);
      assert.throws(() => assertGitSourceMember(source, revision, member));
    } finally {
      fs.writeFileSync(full, original);
      fs.chmodSync(full, originalMode);
    }
    assertGitSourceMember(source, revision, member);
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
  const expectedInventory = metadata.files.map(file => {
    assert.ok(!path.posix.isAbsolute(file.path) && !/[\\:\x00-\x1f]/.test(file.path) &&
      !file.path.split('/').some(part => !part || part === '.' || part === '..'));
    const { bytes, gitMode } = assertGitSourceMember(source, revision, file.path);
    assert.equal(file.size, bytes.length, file.path);
    assert.equal(file.mode, gitMode, file.path);
    return { path: file.path, size: file.size,
      mode: bins.has(file.path) ? 0o755 : gitMode, sha256: sha(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const name of ['_route-candidates.mjs', 'conformance.mjs', 'corpus.mjs',
    'dsl-expand.mjs', 'dsl-facts.mjs', 'expand-laravel.mjs',
    'expand-rails.mjs', 'expand-symfony.mjs', 'model-facts.mjs',
    'runtime-route-snapshot.mjs'].map(name => `scanners/language/ruby-php/${name}`)) {
    assert.equal(members.has(name), slot === 'candidate', name);
    if (slot === 'candidate') assert.equal(sha(fs.readFileSync(path.join(ROOT, name))),
      sha(git(['show', `${revision}:${name}`])), `${name} changed since pinned candidate`);
  }
  return { revision, tree: git(['rev-parse', `${revision}^{tree}`]).toString().trim(), archive,
    archive_sha256: sha(fs.readFileSync(archive)), members: metadata.files.length,
    expectedInventory };
}
function dependencyPins() {
  const locks = Object.fromEntries(Object.entries({ previous: PREVIOUS, candidate: CANDIDATE })
    .map(([slot, revision]) => {
      const bytes = git(['show', `${revision}:package-lock.json`]);
      assert.equal(sha(bytes), LOCKS[slot]);
      return [slot, JSON.parse(bytes)];
    }));
  const deps = lock => Object.fromEntries(Object.entries(lock.packages)
    .filter(([name]) => name.startsWith('node_modules/')));
  assert.deepEqual(deps(locks.previous), deps(locks.candidate));
  return Object.fromEntries(Object.entries(deps(locks.candidate)).map(([name, entry]) =>
    [name.slice('node_modules/'.length), entry.version]));
}
function verifyManifest(manifest, manifestSha, packages) {
  assert.equal(sha(manifest), manifestSha, 'manifest pin mismatch');
  for (const slot of ['previous', 'candidate'])
    assert.equal(sha(fs.readFileSync(packages[slot].archive)), packages[slot].archive_sha256);
}
function rehearse(identity, scratch, packages, pins, manifest, manifestSha, injectFailure) {
  verifyManifest(manifest, manifestSha, packages);
  const consumer = fs.mkdtempSync(path.join(scratch, injectFailure ? 'fault-' : 'normal-'));
  fs.writeFileSync(path.join(consumer, 'package.json'), json({ name: 't07-disposable-consumer',
    version: '0.0.0', private: true, overrides: pins }));
  const stages = [], failures = [], falsificationControls = [];
  let baselineReady = false;
  function install(slot) {
    assert.equal(sha(fs.readFileSync(packages[slot].archive)), packages[slot].archive_sha256);
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
    npm(identity, ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-save', '--package-lock=false', '--prefix', consumer, packages[slot].archive], scratch, scratch);
    const root = path.join(consumer, 'node_modules/backend-skeleton');
    const observed = inventory(root);
    assert.deepEqual(observed, packages[slot].expectedInventory,
      `${slot} installed bytes/modes differ from pinned Git source`);
    if (!injectFailure && slot === 'candidate') {
      const member = 'scanners/language/ruby-php/dsl-facts.mjs';
      const full = path.join(root, member);
      const original = fs.readFileSync(full);
      const originalMode = fs.statSync(full).mode & 0o777;
      try {
        fs.appendFileSync(full, '\n');
        assert.throws(() => assert.deepEqual(inventory(root), packages[slot].expectedInventory));
        falsificationControls.push('installed-byte-change-rejected');
        fs.writeFileSync(full, original);
        fs.chmodSync(full, originalMode === 0o644 ? 0o755 : 0o644);
        assert.throws(() => assert.deepEqual(inventory(root), packages[slot].expectedInventory));
        falsificationControls.push('installed-mode-change-rejected');
      } finally {
        fs.writeFileSync(full, original);
        fs.chmodSync(full, originalMode);
      }
      assert.deepEqual(inventory(root), packages[slot].expectedInventory);
    }
    const result = spawnSync(process.execPath, [PROBE, root, slot], {
      cwd: scratch, env: environment(injectFailure && slot === 'candidate' ?
        { T07_TEST_INTERRUPT_PROBE: '1' } : {}), encoding: 'utf8', timeout: 90000 });
    if (!injectFailure || slot !== 'candidate') {
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
    }
    const stage = { slot, inventory_sha256: sha(json(observed)), count: observed.length,
      probe_exit_code: result.status, probe_signal: result.signal,
      probe_stdout_sha256: sha(Buffer.from(result.stdout)),
      probe_stderr_sha256: sha(Buffer.from(result.stderr)),
      probe: result.signal ? null : JSON.parse(result.stdout) };
    stages.push(stage);
    if (injectFailure && slot === 'candidate') {
      assert.equal(result.signal, 'SIGTERM');
      throw new Error('T07_CANDIDATE_PROBE_SIGTERM');
    }
    assert.equal(stage.probe.expected, slot);
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
  return { schema: 'bskel.t07-package-replay/1', marker: MARKER,
    status: failures.length ? 'fail' : 'pass',
    injected_failure: injectFailure, stages, failures, falsification_controls: falsificationControls,
    rollback_restored: stages.length === 3 &&
      stages[0].inventory_sha256 === stages[2].inventory_sha256,
    release_authorized: false, independent_attestation: false };
}
test('T07 installed package rollback survives interrupted candidate probe',
  { timeout: 300000 }, () => {
    assert.notEqual(process.platform, 'win32', 'POSIX-only replay');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t07-package-replay-'));
    try {
      const identity = resolveNpmInvocation();
      const pins = dependencyPins();
      git(['merge-base', '--is-ancestor', PREVIOUS, CANDIDATE]);
      const packages = {
        previous: packageSnapshot(identity, scratch, 'previous', PREVIOUS),
        candidate: packageSnapshot(identity, scratch, 'candidate', CANDIDATE),
      };
      const manifest = json({ schema: 'bskel.t07-package-replay-manifest/1', marker: MARKER,
        toolchain: { node: process.version, npm_cli_sha256: identity.sha256,
          platform: process.platform, package_umask: '022' },
        source: { previous: PREVIOUS, candidate: CANDIDATE, locks: LOCKS },
        packages: Object.fromEntries(Object.entries(packages).map(([slot, value]) =>
          [slot, { ...value, archive: `${slot}.tgz` }])),
        scope: 'historical installed-package replay of pinned main candidate',
        source_falsification_controls: ['source-byte-change-rejected', 'source-mode-change-rejected'],
        release_authorized: false });
      const manifestSha = sha(manifest);
      assert.notEqual(packages.previous.archive_sha256, packages.candidate.archive_sha256);
      assert.throws(() => verifyManifest(manifest, '0'.repeat(64), packages), /pin mismatch/);
      const originalArchive = fs.readFileSync(packages.candidate.archive);
      try {
        const altered = Buffer.from(originalArchive);
        altered[altered.length - 1] ^= 1;
        fs.writeFileSync(packages.candidate.archive, altered);
        assert.throws(() => verifyManifest(manifest, manifestSha, packages));
      } finally { fs.writeFileSync(packages.candidate.archive, originalArchive); }
      const normal = rehearse(identity, scratch, packages, pins, manifest, manifestSha, false);
      assert.equal(normal.status, 'pass', normal.failures.join('; '));
      assert.equal(normal.rollback_restored, true);
      assert.equal(normal.stages[1].probe.vectors, 8);
      assert.deepEqual(normal.falsification_controls,
        ['installed-byte-change-rejected', 'installed-mode-change-rejected']);
      const fault = rehearse(identity, scratch, packages, pins, manifest, manifestSha, true);
      assert.deepEqual(fault.failures, ['T07_CANDIDATE_PROBE_SIGTERM']);
      assert.equal(fault.rollback_restored, true);
      assert.deepEqual(fault.stages.map(stage => stage.slot), ['previous', 'candidate', 'previous']);
      const retained = process.env.T07_REPLAY_OUTPUT_DIR;
      if (retained) {
        assert.ok(path.isAbsolute(retained));
        assert.equal(fs.existsSync(retained), false, 'evidence directory must be fresh');
        fs.mkdirSync(retained, { mode: 0o700 });
        for (const slot of ['previous', 'candidate'])
          fs.copyFileSync(packages[slot].archive, path.join(retained, `${slot}.tgz`));
        fs.writeFileSync(path.join(retained, 'manifest.json'), manifest);
        fs.writeFileSync(path.join(retained, 'manifest.sha256'), `${manifestSha}\n`);
        fs.writeFileSync(path.join(retained, 'normal-receipt.json'), json(normal));
        fs.writeFileSync(path.join(retained, 'fault-receipt.json'), json(fault));
      }
      console.log(JSON.stringify({ manifest_sha256: manifestSha, normal: normal.status,
        fault: fault.status, rollback_restored: fault.rollback_restored, retained: retained ?? null }));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
