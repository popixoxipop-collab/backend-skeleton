#!/usr/bin/env node
// T22-06: package-level promotion/rollback rehearsal, never a deployment tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveNpmInvocation, materializePinnedSource } from '../../scripts/t22-distribution-report.mjs';

export const SCHEMA = 'bskel.t22-release-replay/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'installed-sdk-probe.mjs');
const SELF = fileURLToPath(import.meta.url);
const HEX = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}$/;
const MAX_TARBALL = 32 * 1024 * 1024;
const NO_AUTHORITY = Object.freeze({ release_authorized: false, runtime_certified: false, publication_performed: false });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = object => Buffer.from(JSON.stringify(object, null, 2) + '\n');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function regularBytes(file, limit) {
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && stat.size <= limit, 'not a bounded regular file: ' + file);
  const bytes = fs.readFileSync(file);
  requireValue(bytes.length <= limit, 'file grew beyond bound');
  return bytes;
}
function safeMember(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 1024 &&
    !path.posix.isAbsolute(name) && !/[\\:\x00-\x1f]/.test(name) &&
    !name.split('/').some(part => part === '' || part === '.' || part === '..');
}
function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'invalid ' + label + ' shape');
}
function cleanEnvironment() {
  const env = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('T22_DISTRIBUTION_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}
function command(argv, cwd, directory, records) {
  const id = String(records.length + 1).padStart(3, '0');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, env: cleanEnvironment(), encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = Buffer.from(result.stdout || ''), stderr = Buffer.from(result.stderr || '');
  fs.writeFileSync(path.join(directory, id + '.stdout'), stdout);
  fs.writeFileSync(path.join(directory, id + '.stderr'), stderr);
  const record = { command: argv, cwd, exit_code: result.status, signal: result.signal,
    error: result.error?.message ?? null,
    stdout: { file: id + '.stdout', sha256: sha256(stdout) },
    stderr: { file: id + '.stderr', sha256: sha256(stderr) } };
  records.push(record);
  requireValue(result.status === 0 && result.signal === null && !result.error,
    'command failed: ' + argv.slice(0, 3).join(' ') + ': ' + (result.error?.message || stderr.toString().slice(-500)));
  return stdout.toString().trim();
}
function gitBytes(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, env: cleanEnvironment(),
    timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  requireValue(result.status === 0 && !result.error && result.signal === null, 'Git read failed');
  return result.stdout;
}
function npmCommand(identity, args) {
  requireValue(sha256(regularBytes(identity.executable, 1024 * 1024)) === identity.sha256, 'npm executable changed');
  return [process.execPath, identity.executable, ...args];
}
function newOutput(output) {
  requireValue(path.isAbsolute(output), 'output must be absolute');
  fs.mkdirSync(output, { mode: 0o700 }); // Deliberately never overwrites existing evidence.
}
function inventoryAt(repo, revision, metadata) {
  requireValue(Array.isArray(metadata.files) && metadata.files.length > 0 && metadata.files.length <= 5000,
    'invalid pack inventory');
  const seen = new Set();
  return metadata.files.map(file => {
    requireValue(safeMember(file.path) && !seen.has(file.path), 'unsafe or duplicate package member');
    seen.add(file.path);
    const bytes = gitBytes(repo, ['cat-file', 'blob', revision + ':' + file.path]);
    requireValue(bytes.length === file.size, 'pack/source size mismatch: ' + file.path);
    return { path: file.path, size: bytes.length, sha256: sha256(bytes) };
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function harnessIdentity() {
  return { module_sha256: sha256(regularBytes(SELF, 1024 * 1024)),
    probe_sha256: sha256(regularBytes(PROBE, 1024 * 1024)),
    distribution_helper_sha256: sha256(regularBytes(path.resolve(HERE, '../../scripts/t22-distribution-report.mjs'), 1024 * 1024)),
    receipt_helper_sha256: sha256(regularBytes(path.resolve(HERE, '../../scripts/t22-distribution-receipt.mjs'), 1024 * 1024)) };
}

/** Creates two retained packages from exact Git objects. Existing source files are not edited. */
export function buildReplayBundle({ repoRoot, previous, candidate, output }) {
  requireValue(OID.test(previous) && OID.test(candidate) && previous !== candidate, 'distinct exact Git commits required');
  requireValue(path.isAbsolute(repoRoot), 'repoRoot must be absolute');
  for (const revision of [previous, candidate]) {
    requireValue(gitBytes(repoRoot, ['cat-file', '-t', revision]).toString().trim() === 'commit',
      'exact commit object required');
  }
  const npm = resolveNpmInvocation();
  newOutput(output);
  const commands = [], packages = {};
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't22-release-build-'));
  try {
    for (const [slot, revision] of Object.entries({ previous, candidate })) {
      const tree = gitBytes(repoRoot, ['rev-parse', revision + '^{tree}']).toString().trim();
      const root = materializePinnedSource(repoRoot, revision, path.join(scratch, slot), []);
      const destination = path.join(scratch, slot + '-pack'); fs.mkdirSync(destination);
      const packed = JSON.parse(command(npmCommand(npm, [
        'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination,
      ]), root, output, commands));
      requireValue(packed.length === 1 && packed[0].name === 'backend-skeleton', 'unexpected package');
      const metadata = packed[0];
      requireValue(path.basename(metadata.filename) === metadata.filename, 'unsafe packed filename');
      const bytes = regularBytes(path.join(destination, metadata.filename), MAX_TARBALL);
      const inventory = inventoryAt(repoRoot, revision, metadata);
      // Snapshot file bytes are compared too; pack runs with lifecycle hooks disabled.
      for (const file of inventory) {
        requireValue(sha256(regularBytes(path.join(root, file.path), MAX_TARBALL)) === file.sha256,
          'snapshot/source mismatch: ' + file.path);
      }
      const filename = slot + '.tgz'; fs.writeFileSync(path.join(output, filename), bytes);
      const sdk = inventory.some(file => file.path === 'sdk/next/index.mjs') ? 'present' : 'absent';
      packages[slot] = { revision, tree, filename, sha256: sha256(bytes), size: bytes.length,
        name: metadata.name, version: metadata.version, sdk, inventory };
    }
    requireValue(packages.candidate.sdk === 'present', 'candidate must contain the SDK');
    requireValue(packages.previous.sha256 !== packages.candidate.sha256, 'package bytes must differ');
    const manifest = { schema: SCHEMA, scope: 'disposable-package-rehearsal',
      ...NO_AUTHORITY, harness: harnessIdentity(),
      packages, preconditions: ['trusted Git/Node/npm/host', 'prewarmed npm dependency cache',
        'package-level reinstall, not zero-downtime service rollback'] };
    const bytes = jsonBytes(manifest), digest = sha256(bytes);
    fs.writeFileSync(path.join(output, 'manifest.json'), bytes);
    fs.writeFileSync(path.join(output, 'manifest.sha256'), digest + '\n');
    fs.writeFileSync(path.join(output, 'build-receipt.json'), jsonBytes({ status: 'pass', commands, manifest_sha256: digest }));
    return { manifest, manifestSha256: digest };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'build-receipt.json'), jsonBytes({ status: 'fail', error: error.message, commands }));
    throw error;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** Validates externally pinned bundle bytes before any package install or probe. */
export function verifyReplayBundle(directory, expectedManifestSha256) {
  requireValue(HEX.test(expectedManifestSha256 || ''), 'independent expected manifest SHA-256 required');
  const bytes = regularBytes(path.join(directory, 'manifest.json'), 4 * 1024 * 1024);
  requireValue(sha256(bytes) === expectedManifestSha256, 'manifest SHA-256 mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  requireValue(manifest.schema === SCHEMA && manifest.scope === 'disposable-package-rehearsal', 'unsupported bundle');
  for (const key of Object.keys(NO_AUTHORITY)) requireValue(manifest[key] === false, 'bundle cannot grant authority');
  requireValue(JSON.stringify(manifest.harness) === JSON.stringify(harnessIdentity()), 'replay harness identity mismatch');
  exactKeys(manifest.packages, ['previous', 'candidate'], 'packages');
  const tarballs = {};
  for (const slot of ['previous', 'candidate']) {
    const entry = manifest.packages[slot];
    requireValue(entry && OID.test(entry.revision) && OID.test(entry.tree) &&
      entry.filename === slot + '.tgz' && entry.name === 'backend-skeleton' &&
      ['present','absent'].includes(entry.sdk) && HEX.test(entry.sha256) &&
      Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MAX_TARBALL, 'invalid package identity');
    requireValue(Array.isArray(entry.inventory) && entry.inventory.length > 0 && entry.inventory.length <= 5000,
      'invalid package inventory');
    const seen = new Set();
    for (const file of entry.inventory) {
      requireValue(file && safeMember(file.path) && !seen.has(file.path) && HEX.test(file.sha256) &&
        Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_TARBALL, 'invalid package member');
      seen.add(file.path);
    }
    requireValue(seen.has('package.json'), 'missing package manifest');
    requireValue(seen.has('sdk/next/index.mjs') === (entry.sdk === 'present'), 'SDK inventory contradiction');
    tarballs[slot] = regularBytes(path.join(directory, entry.filename), MAX_TARBALL);
    requireValue(sha256(tarballs[slot]) === entry.sha256 && tarballs[slot].length === entry.size, 'tarball mismatch: ' + slot);
  }
  requireValue(manifest.packages.candidate.sdk === 'present', 'candidate must contain SDK');
  requireValue(manifest.packages.previous.revision !== manifest.packages.candidate.revision &&
    manifest.packages.previous.sha256 !== manifest.packages.candidate.sha256, 'no actual package transition');
  return { manifest, tarballs };
}
function installedInventory(root) {
  const result = [];
  function walk(directory, prefix = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file, name + '/');
      else {
        requireValue(item.isFile(), 'non-regular installed member: ' + name);
        const bytes = regularBytes(file, MAX_TARBALL);
        result.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  walk(root);
  return result.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Reuses the retained packages. All mutation is inside one newly created temporary consumer. */
export function replayBundle({ directory, expectedManifestSha256, output }) {
  const { manifest, tarballs } = verifyReplayBundle(directory, expectedManifestSha256);
  const npm = resolveNpmInvocation();
  newOutput(output);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't22-release-replay-'));
  const consumer = path.join(scratch, 'consumer'); fs.mkdirSync(consumer);
  const commands = [], stages = [], failures = [];
  let baselineReady = false, restored = false;
  for (const slot of ['previous', 'candidate']) fs.writeFileSync(path.join(scratch, slot + '.tgz'), tarballs[slot]);
  function install(slot, stage) {
    // Disposable consumer only; no caller-supplied destination or existing application.
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
    command(npmCommand(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-save', '--package-lock=false', '--prefix', consumer, path.join(scratch, slot + '.tgz')]),
      scratch, output, commands);
    const inventory = installedInventory(path.join(consumer, 'node_modules', 'backend-skeleton'));
    const expected = manifest.packages[slot];
    requireValue(JSON.stringify(inventory) === JSON.stringify(expected.inventory), 'installed package differs from pinned Git inventory');
    const probe = JSON.parse(command([process.execPath, PROBE, consumer, expected.sdk], scratch, output, commands));
    requireValue(probe.ok === true && probe.sdk === expected.sdk && probe.version === expected.version, 'installed probe failed');
    const row = { stage, slot, package_sha256: expected.sha256,
      inventory_sha256: sha256(Buffer.from(JSON.stringify(inventory))), file_count: inventory.length, probe };
    stages.push(row); return row;
  }
  try {
    install('previous', 'baseline'); baselineReady = true;
    install('candidate', 'candidate');
  } catch (error) { failures.push(error.message); }
  finally {
    if (baselineReady) {
      try { install('previous', 'rollback'); restored = true; }
      catch (error) { failures.push('ROLLBACK_FAILED: ' + error.message); }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const passed = failures.length === 0 && restored && stages.length === 3 &&
    stages[0].inventory_sha256 === stages[2].inventory_sha256;
  const receipt = { schema: SCHEMA + '/receipt', status: passed ? 'pass' : 'fail',
    manifest_sha256: expectedManifestSha256, ...NO_AUTHORITY,
    scope: 'disposable-package-rehearsal', baseline_ready: baselineReady, rollback_restored: restored,
    stages, failures, commands,
    environment: { node: process.version, node_executable: process.execPath,
      npm_executable: npm.executable, npm_sha256: npm.sha256, platform: process.platform },
    limitations: manifest.preconditions };
  const bytes = jsonBytes(receipt);
  fs.writeFileSync(path.join(output, 'receipt.json'), bytes);
  fs.writeFileSync(path.join(output, 'receipt.sha256'), sha256(bytes) + '\n');
  return receipt;
}
function main(args) {
  const action = args.shift(), parsed = {};
  while (args.length) {
    const key = args.shift();
    requireValue(['--repo', '--previous', '--candidate', '--output', '--bundle', '--manifest-sha256'].includes(key) &&
      args.length && !Object.hasOwn(parsed, key), 'invalid or duplicate argument');
    parsed[key] = args.shift();
  }
  if (action === 'build') {
    const r = buildReplayBundle({ repoRoot: parsed['--repo'], previous: parsed['--previous'],
      candidate: parsed['--candidate'], output: parsed['--output'] });
    console.log(JSON.stringify({ status: 'pass', manifest_sha256: r.manifestSha256, output: parsed['--output'] }));
  } else if (action === 'replay') {
    const r = replayBundle({ directory: parsed['--bundle'], expectedManifestSha256: parsed['--manifest-sha256'],
      output: parsed['--output'] });
    console.log(JSON.stringify({ status: r.status, rollback_restored: r.rollback_restored, output: parsed['--output'] }));
    if (r.status !== 'pass') process.exitCode = 2;
  } else throw new Error('use build or replay');
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
