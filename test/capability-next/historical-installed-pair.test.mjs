// T03-06: opt-in historical installed-package promotion/rollback/replay proof.
// This never changes a running service or grants release authority.
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
const PROBE = path.join(ROOT, 'test/capability-next/historical-installed-probe.mjs');
const PREVIOUS = '271d5d747d7ef99fb7ce990a95db32fbdf4e46bd';
const CANDIDATE = 'f43c6e78279ec0921e5608359f1696946aef0fda';
const LOCKS = {
  previous: 'f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087',
  candidate: 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const safePath = name => typeof name === 'string' && name.length > 0 && name.length < 1024 &&
  !path.posix.isAbsolute(name) && !/[\\:\x00-\x1f]/.test(name) &&
  !name.split('/').some(part => part === '' || part === '.' || part === '..');

function cleanEnv(extra = {}) {
  const value = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  delete value.NODE_TEST_CONTEXT;
  for (const key of Object.keys(value)) if (key.startsWith('GIT_')) delete value[key];
  value.GIT_CONFIG_NOSYSTEM = '1';
  value.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return { ...value, ...extra };
}
function git(args, encoding = null) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    env: cleanEnv(), encoding, timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  });
}
function run(program, args, cwd, extraEnv = {}) {
  const result = spawnSync(program, args, { cwd, env: cleanEnv(extraEnv),
    encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `${program} signal ${result.signal}`);
  assert.equal(result.status, 0, `${program} ${args.slice(0, 3).join(' ')}: ${result.stderr?.slice(-1500)}`);
  return result.stdout.trim();
}
function npm(identity, args, cwd) {
  assert.equal(sha256(fs.readFileSync(identity.executable)), identity.sha256, 'npm identity changed');
  return run(process.execPath, [identity.executable, ...args], cwd);
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
  assert.equal(metadata.files.length, slot === 'previous' ? 217 : 424);
  assert.equal(metadata.version, '1.9.0');
  assert.equal(path.basename(metadata.filename), metadata.filename);
  const original = slot === 'candidate' && process.env.T03_REPLAY_ORIGINAL;
  const archive = original ? path.resolve(original) : path.join(destination, metadata.filename);
  const archiveBytes = fs.readFileSync(archive);
  if (original) assert.equal(sha256(archiveBytes),
    '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a');
  assert.equal(tree, slot === 'previous' ? 'c5f1da277f3858cc93cefa8b6c3c0d5956b23e07' :
    'bd187ad9a6cb7d93f367d59ee5ee1495e6547184');
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
  const t03Present = seen.has('scanners/capability-next/index.mjs');
  assert.equal(t03Present, slot === 'candidate');
  return { revision, tree, archive, archive_sha256: sha256(archiveBytes),
    archive_origin: original ? 'preserved' : 'packed-pinned-git', archive_size: archiveBytes.length, file_count: inventory.length, inventory,
    t03_present: t03Present };
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
  for (const slot of ['previous', 'candidate'])
    assert.equal(sha256(fs.readFileSync(packages[slot].archive)),
      packages[slot].archive_sha256, `${slot} archive changed`);
}
function replay(identity, scratch, manifestBytes, pin, packages, injectFailure) {
  verifyPin(manifestBytes, pin, packages);
  const consumer = fs.mkdtempSync(path.join(scratch,
    injectFailure ? 'fault-consumer-' : 'normal-consumer-'));
  fs.writeFileSync(path.join(consumer,'keep.txt'),'unrelated state');
  const stages = [], failures = [];
  let baselineReady = false;
  function install(slot, stage) {
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
    const archiveName = 'input.tgz';
    const archive = packages[slot].archive;
    fs.copyFileSync(archive, path.join(consumer, archiveName));
    const revision = packages[slot].revision;
    const locked = JSON.parse(git(['show', revision+':package-lock.json']));
    const pkg = JSON.parse(git(['show', revision+':package.json']));
    const consumerPkg = {name:'t03-disposable-replay-consumer', version:'0.0.0', private:true,
      dependencies:{'backend-skeleton':'file:'+archiveName}};
    locked.name=consumerPkg.name; locked.version=consumerPkg.version;
    locked.packages['']=consumerPkg;
    locked.packages['node_modules/backend-skeleton']={name:pkg.name, version:pkg.version,
      resolved:'file:'+archiveName, integrity:'sha512-'+createHash('sha512').update(fs.readFileSync(archive)).digest('base64'),
      dependencies:pkg.dependencies, engines:pkg.engines, bin:pkg.bin};
    fs.writeFileSync(path.join(consumer,'package.json'),json(consumerPkg));
    fs.writeFileSync(path.join(consumer,'package-lock.json'),json(locked));
    npm(identity,['ci','--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
    assert.equal(fs.readFileSync(path.join(consumer,'keep.txt'),'utf8'),'unrelated state');
    const inventory = installedInventory(path.join(consumer, 'node_modules', 'backend-skeleton'));
    assert.deepEqual(inventory, packages[slot].inventory, `${stage} installed/source inventory differs`);
    if (slot === 'candidate') {
      const modePath = path.join(consumer, 'node_modules', 'backend-skeleton', inventory[0].path);
      const mode = inventory[0].mode;
      fs.chmodSync(modePath,mode ^ 0o100);
      try { assert.throws(() => assert.deepEqual(installedInventory(path.join(consumer,'node_modules','backend-skeleton')),packages[slot].inventory)); }
      finally { fs.chmodSync(modePath,mode); }
    }
    const stageRecord = { stage, slot, file_count: inventory.length,
      inventory_sha256: sha256(json(inventory)), probe: null };
    stages.push(stageRecord);
    const result = spawnSync(process.execPath,
      [PROBE, consumer, slot === 'previous' ? 'absent' : 'present'],
      { cwd: scratch, env: cleanEnv(injectFailure && slot === 'candidate' ?
        { T03_TEST_INTERRUPT_PROBE: '1' } : {}), encoding: 'utf8', timeout: 90000 });
    if (injectFailure && slot === 'candidate') {
      assert.equal(result.signal, 'SIGTERM');
      assert.match(result.stdout, /T03_READY/);
      throw new Error('T03_CANDIDATE_PROBE_SIGTERM');
    }
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr?.slice(-1000));
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.expected, slot === 'previous' ? 'absent' : 'present');
    assert.equal(probe.release_authorized, false);
    assert.equal(probe.runtime_certified, false);
    stageRecord.probe = probe;
  }
  try {
    install('previous', 'baseline'); baselineReady = true;
    install('candidate', 'candidate');
  } catch (error) {
    failures.push(error.message);
  } finally {
    if (baselineReady) {
      try { install('previous', 'rollback'); }
      catch (error) { failures.push(`ROLLBACK_FAILED: ${error.message}`); }
    }
  }
  const restored = stages.length === 3 && stages[0].inventory_sha256 === stages[2].inventory_sha256;
  return { schema: 'bskel.t03-package-replay/1', status: failures.length === 0 ? 'pass' : 'fail',
    injected_failure: injectFailure, manifest_sha256: pin, rollback_restored: restored,
    release_authorized: false, runtime_certified: false, publication_performed: false,
    stages, failures, environment: { node: process.version, npm_sha256: identity.sha256 } };
}

test('T03-06 historical installed-package rollback and interrupted replay',
  { timeout: 300000 }, t => {
    assert.notEqual(process.platform, 'win32', 'POSIX archive/mode checks only');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t03-package-replay-'));
    try {
      const identity = resolveNpmInvocation();
      assert.equal(git(['merge-base', '--is-ancestor', PREVIOUS, CANDIDATE], 'utf8'), '');
      const packages = {
        previous: packageSnapshot(identity, scratch, 'previous', PREVIOUS),
        candidate: packageSnapshot(identity, scratch, 'candidate', CANDIDATE),
      };
      assert.notEqual(packages.previous.archive_sha256, packages.candidate.archive_sha256);
      const manifest = { schema: 'bskel.t03-package-replay-manifest/1',
        source: { previous: PREVIOUS, candidate: CANDIDATE, locks: LOCKS },
        packages: Object.fromEntries(Object.entries(packages).map(([slot, value]) =>
          [slot, { ...value, archive: `${slot}.tgz` }])),
        scope: 'disposable installed-package rehearsal', release_authorized: false,
        runtime_certified: false, publication_performed: false };
      const manifestBytes = json(manifest), pin = sha256(manifestBytes);
      assert.throws(() => verifyPin(manifestBytes, '0'.repeat(64), packages), /pin mismatch/);
      const tamper = path.join(scratch,'tampered.tgz');
      const raw = fs.readFileSync(packages.candidate.archive);
      fs.writeFileSync(tamper,raw.subarray(0,-1));
      assert.throws(() => verifyPin(manifestBytes,pin,{...packages,candidate:{...packages.candidate,archive:tamper}}), /archive changed/);
      const normal = replay(identity, scratch, manifestBytes, pin, packages, false);
      assert.equal(normal.status, 'pass', normal.failures.join('; '));
      assert.equal(normal.rollback_restored, true);
      assert.deepEqual(normal.stages.map(stage => stage.slot), ['previous', 'candidate', 'previous']);
      const fault = replay(identity, scratch, manifestBytes, pin, packages, true);
      assert.equal(fault.status, 'fail');
      assert.deepEqual(fault.failures, ['T03_CANDIDATE_PROBE_SIGTERM']);
      assert.equal(fault.rollback_restored, true);
      assert.equal(fault.stages[1].probe, null);
      for (const receipt of [normal, fault])
        for (const key of ['release_authorized', 'runtime_certified', 'publication_performed'])
          assert.equal(receipt[key], false);
      const retained = process.env.T03_REPLAY_OUTPUT_DIR;
      if (retained) {
        assert.ok(path.isAbsolute(retained));
        fs.mkdirSync(retained, { mode: 0o700 }); // Refuse an existing evidence directory.
        for (const slot of ['previous', 'candidate'])
          fs.copyFileSync(packages[slot].archive, path.join(retained, `${slot}.tgz`));
        fs.writeFileSync(path.join(retained, 'manifest.json'), manifestBytes);
        fs.writeFileSync(path.join(retained, 'manifest.sha256'), `${pin}\n`);
        fs.writeFileSync(path.join(retained, 'normal-receipt.json'), json(normal));
        fs.writeFileSync(path.join(retained, 'fault-receipt.json'), json(fault));
      }
      t.diagnostic(JSON.stringify({ previous: PREVIOUS, candidate: CANDIDATE,
        manifest_sha256: pin, previous_archive_sha256: packages.previous.archive_sha256, candidate_archive_sha256: packages.candidate.archive_sha256, candidate_origin: packages.candidate.archive_origin, file_counts: normal.stages.map(stage => stage.file_count),
        normal_status: normal.status, fault_status: fault.status,
        rollback_restored: normal.rollback_restored && fault.rollback_restored,
        retained: retained ?? null }));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
