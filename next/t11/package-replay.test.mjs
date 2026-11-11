// T11-06: bounded, opt-in installed-package promotion/rollback/replay proof.
// Historical Git revisions are fixed; only disposable consumers are changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materializePinnedSource, resolveNpmInvocation } from '../../scripts/t22-distribution-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = path.join(ROOT, 'next/t11/installed-replay-probe.mjs');
const PREVIOUS = 'db29fc35d1bfc37b1a948b4be2df8517a230aa95';
const CANDIDATE = '1e73710d5672f1f01d76dcf0f9d6fc19d2a529b6';
const LOCKS = {
  previous: 'f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087',
  candidate: 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = object => Buffer.from(JSON.stringify(object, null, 2) + '\n');
const safePath = name => typeof name === 'string' && name.length > 0 && name.length < 1024 &&
  !path.posix.isAbsolute(name) && !/[\\:\x00-\x1f]/.test(name) &&
  !name.split('/').some(part => part === '' || part === '.' || part === '..');

function env() {
  const value = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  delete value.NODE_TEST_CONTEXT;
  for (const key of Object.keys(value)) if (key.startsWith('GIT_')) delete value[key];
  value.GIT_CONFIG_NOSYSTEM = '1';
  value.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return value;
}
function git(args, encoding = null) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    env: env(), encoding, timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  });
}
function command(program, args, cwd, timeout = 90000, input, extraEnv = {}) {
  const result = spawnSync(program, args, { cwd, env: { ...env(), ...extraEnv }, input,
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `${program} signal ${result.signal}`);
  assert.equal(result.status, 0, `${program} ${args.slice(0, 3).join(' ')}: ${result.stderr?.slice(-1200)}`);
  return result.stdout.trim();
}
function npm(identity, args, cwd) {
  assert.equal(sha256(fs.readFileSync(identity.executable)), identity.sha256, 'npm identity changed');
  return command(process.execPath, [identity.executable, ...args], cwd);
}
function lockedOverrides() {
  const old = git(['show', `${PREVIOUS}:package-lock.json`]);
  const current = git(['show', `${CANDIDATE}:package-lock.json`]);
  assert.equal(sha256(old), LOCKS.previous);
  assert.equal(sha256(current), LOCKS.candidate);
  const a = JSON.parse(old), b = JSON.parse(current);
  const dependencies = lock => Object.fromEntries(Object.entries(lock.packages)
    .filter(([name]) => name.startsWith('node_modules/')));
  assert.deepEqual(dependencies(a), dependencies(b), 'transitive dependency lock changed');
  const entries = Object.entries(dependencies(b));
  assert.equal(entries.length, 21);
  return Object.fromEntries(entries.map(([name, entry]) => {
    const packageName = name.slice('node_modules/'.length);
    assert.match(packageName, /^[a-z0-9][a-z0-9._-]*$/);
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    return [packageName, entry.version];
  }));
}
function packageSnapshot(identity, scratch, slot, revision) {
  assert.equal(git(['cat-file', '-t', revision], 'utf8').trim(), 'commit');
  const tree = git(['rev-parse', `${revision}^{tree}`], 'utf8').trim();
  const source = materializePinnedSource(ROOT, revision, path.join(scratch, `${slot}-source`), []);
  const destination = path.join(scratch, `${slot}-pack`);
  fs.mkdirSync(destination);
  const packed = JSON.parse(npm(identity, ['pack', '--offline', '--ignore-scripts',
    '--json', '--pack-destination', destination], source));
  assert.equal(packed.length, 1);
  const metadata = packed[0];
  assert.equal(metadata.name, 'backend-skeleton');
  assert.equal(metadata.version, '1.9.0');
  assert.equal(path.basename(metadata.filename), metadata.filename);
  const archive = path.join(destination, metadata.filename);
  const archiveBytes = fs.readFileSync(archive);
  assert.ok(archiveBytes.length > 0 && archiveBytes.length < 32 * 1024 * 1024);
  const packageJson = JSON.parse(git(['show', `${revision}:package.json`], 'utf8'));
  const bins = new Set(Object.values(packageJson.bin));
  const seen = new Set();
  const inventory = metadata.files.map(file => {
    assert.ok(safePath(file.path) && !seen.has(file.path), `unsafe/duplicate ${file.path}`);
    seen.add(file.path);
    const sourceBytes = git(['cat-file', 'blob', `${revision}:${file.path}`]);
    const modeLine = git(['ls-tree', revision, '--', file.path], 'utf8');
    assert.match(modeLine, /^(100644|100755) blob /, file.path);
    const mode = modeLine.startsWith('100755 ') ? 0o755 : 0o644;
    assert.equal(file.size, sourceBytes.length, file.path);
    assert.equal(file.mode, mode, file.path);
    assert.equal(sha256(fs.readFileSync(path.join(source, file.path))), sha256(sourceBytes), file.path);
    return { path: file.path, size: file.size, mode: bins.has(file.path) ? 0o755 : mode,
      sha256: sha256(sourceBytes) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const cliPresent = seen.has('next/t11/observed-report-cli-v1.mjs');
  assert.equal(cliPresent, slot === 'candidate');
  assert.equal(Object.hasOwn(packageJson.bin, 'bskel-t11-observe'), cliPresent);
  return { revision, tree, archive, archive_sha256: sha256(archiveBytes),
    archive_size: archiveBytes.length, file_count: inventory.length, inventory, cli_present: cliPresent };
}
function installedInventory(directory) {
  const out = [];
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, `${name}/`);
      else {
        assert.ok(entry.isFile(), `non-regular installed entry ${name}`);
        const bytes = fs.readFileSync(file);
        out.push({ path: name, size: bytes.length, mode: fs.statSync(file).mode & 0o777,
          sha256: sha256(bytes) });
      }
    }
  }
  visit(directory);
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function verifyPin(manifestBytes, pin, packages) {
  assert.match(pin, /^[0-9a-f]{64}$/);
  assert.equal(sha256(manifestBytes), pin, 'manifest pin mismatch');
  for (const slot of ['previous', 'candidate']) {
    const entry = packages[slot];
    assert.equal(sha256(fs.readFileSync(entry.archive)), entry.archive_sha256, `${slot} archive changed`);
  }
}
function replay(identity, scratch, manifestBytes, pin, packages, overrides, injectFailure) {
  verifyPin(manifestBytes, pin, packages);
  const consumer = fs.mkdtempSync(path.join(scratch, injectFailure ? 'fault-consumer-' : 'normal-consumer-'));
  fs.writeFileSync(path.join(consumer, 'package.json'), json({
    name: 't11-disposable-replay-consumer', version: '0.0.0', private: true, overrides,
  }));
  const stages = [], failures = [];
  let baselineReady = false;
  function install(slot, stage) {
    // This is the newly allocated disposable consumer, never an existing app.
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
    npm(identity, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-save', '--package-lock=false', '--prefix', consumer, packages[slot].archive], scratch);
    const inventory = installedInventory(path.join(consumer, 'node_modules', 'backend-skeleton'));
    assert.deepEqual(inventory, packages[slot].inventory, `${stage} installed/source inventory differs`);
    const stageRecord = { stage, slot, file_count: inventory.length,
      inventory_sha256: sha256(json(inventory)), probe: null };
    stages.push(stageRecord);
    const probe = JSON.parse(command(process.execPath,
      [PROBE, consumer, ROOT, slot === 'previous' ? 'absent' : 'present'], scratch,
      90000, undefined, injectFailure && slot === 'candidate' ?
        { T11_TEST_FAULT_DURING_CANDIDATE_PROBE: '1' } : {}));
    assert.equal(probe.adapters.length, 5);
    stageRecord.probe = probe;
  }
  try {
    install('previous', 'baseline'); baselineReady = true;
    install('candidate', 'candidate');
  } catch (error) {
    failures.push(injectFailure && error.message.includes('signal SIGTERM') ?
      'T11_CANDIDATE_PROBE_SIGTERM' : error.message);
  } finally {
    if (baselineReady) {
      try { install('previous', 'rollback'); }
      catch (error) { failures.push(`ROLLBACK_FAILED: ${error.message}`); }
    }
  }
  const restored = stages.length === 3 && stages[0].inventory_sha256 === stages[2].inventory_sha256;
  return { schema: 'bskel.t11-package-replay/1', status: failures.length === 0 ? 'pass' : 'fail',
    injected_failure: injectFailure, manifest_sha256: pin, rollback_restored: restored,
    release_authorized: false, runtime_certified: false, publication_performed: false,
    stages, failures, environment: { node: process.version, npm_sha256: identity.sha256 } };
}

test('T11-06 authentic package promotion, rollback and controlled-failure replay',
  { timeout: 300000 }, t => {
    assert.notEqual(process.platform, 'win32', 'POSIX archive/mode checks only');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-package-replay-'));
    try {
      const identity = resolveNpmInvocation();
      const overrides = lockedOverrides();
      assert.equal(git(['merge-base', '--is-ancestor', PREVIOUS, CANDIDATE], 'utf8'), '');
      const packages = {
        previous: packageSnapshot(identity, scratch, 'previous', PREVIOUS),
        candidate: packageSnapshot(identity, scratch, 'candidate', CANDIDATE),
      };
      assert.notEqual(packages.previous.archive_sha256, packages.candidate.archive_sha256);
      const manifest = { schema: 'bskel.t11-package-replay-manifest/1',
        source: { previous: PREVIOUS, candidate: CANDIDATE, locks: LOCKS },
        packages: Object.fromEntries(Object.entries(packages).map(([slot, value]) =>
          [slot, { ...value, archive: `${slot}.tgz` }])),
        scope: 'disposable installed-package rehearsal', release_authorized: false,
        runtime_certified: false, publication_performed: false };
      const manifestBytes = json(manifest), pin = sha256(manifestBytes);
      assert.throws(() => verifyPin(manifestBytes, '0'.repeat(64), packages), /pin mismatch/);
      const normal = replay(identity, scratch, manifestBytes, pin, packages, overrides, false);
      assert.equal(normal.status, 'pass', normal.failures.join('; '));
      assert.equal(normal.rollback_restored, true);
      assert.deepEqual(normal.stages.map(stage => stage.slot), ['previous', 'candidate', 'previous']);
      const fault = replay(identity, scratch, manifestBytes, pin, packages, overrides, true);
      assert.equal(fault.status, 'fail');
      assert.deepEqual(fault.failures, ['T11_CANDIDATE_PROBE_SIGTERM']);
      assert.equal(fault.rollback_restored, true);
      assert.equal(fault.stages[1].probe, null);
      assert.equal(fault.stages[0].inventory_sha256, fault.stages[2].inventory_sha256);
      for (const receipt of [normal, fault])
        for (const key of ['release_authorized', 'runtime_certified', 'publication_performed'])
          assert.equal(receipt[key], false);
      const retained = process.env.T11_REPLAY_OUTPUT_DIR;
      if (retained) {
        assert.ok(path.isAbsolute(retained));
        fs.mkdirSync(retained, { mode: 0o700 }); // refuse an existing evidence directory
        for (const slot of ['previous', 'candidate'])
          fs.copyFileSync(packages[slot].archive, path.join(retained, `${slot}.tgz`));
        fs.writeFileSync(path.join(retained, 'manifest.json'), manifestBytes);
        fs.writeFileSync(path.join(retained, 'manifest.sha256'), `${pin}\n`);
        fs.writeFileSync(path.join(retained, 'normal-receipt.json'), json(normal));
        fs.writeFileSync(path.join(retained, 'fault-receipt.json'), json(fault));
      }
      t.diagnostic(JSON.stringify({ previous: PREVIOUS, candidate: CANDIDATE,
        manifest_sha256: pin, file_counts: normal.stages.map(stage => stage.file_count),
        normal_status: normal.status, fault_status: fault.status,
        rollback_restored: normal.rollback_restored && fault.rollback_restored,
        retained: retained ?? null }));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
