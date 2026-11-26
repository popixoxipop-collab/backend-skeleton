// DOT-T08-06-T19-INSTALLED-20261122: local candidate review, never an approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packetDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(packetDir, '../../..');
const head = 'c45eb5aefd6ca3dc787389db337f016177a03757';
const tree = 'bd187ad9a6cb7d93f367d59ee5ee1495e6547184';
const lockSha = 'c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const git = args => execFileSync('git', ['-C', repo, ...args],
  { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });

function command(executable, args, cwd, cache, timeout = 120000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '',
      npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_update_notifier: 'false' } });
  const receipt = { argv: [executable, ...args], exit_code: result.status,
    signal: result.signal, stdout_sha256: sha(Buffer.from(result.stdout ?? '')),
    stderr_sha256: sha(Buffer.from(result.stderr ?? '')) };
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, JSON.stringify(receipt));
  assert.equal(result.status, 0, result.stderr?.slice(-1200));
  return { receipt, stdout: result.stdout };
}

function inventory(root) {
  const out = [];
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name, full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, relative + '/');
      else {
        assert.ok(fs.lstatSync(full).isFile(), 'nonregular installed member: ' + relative);
        const bytes = fs.readFileSync(full);
        out.push({ path: relative, size: bytes.length,
          mode: fs.statSync(full).mode & 0o777, sha256: sha(bytes) });
      }
    }
  }
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function assertSameInventory(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + ' count');
  for (let i = 0; i < actual.length; i++)
    assert.deepEqual(actual[i], expected[i], `${label} first mismatch at ${i}`);
}

const outputDir = process.env.T19_T08_OUTPUT_DIR;
assert.ok(outputDir && path.isAbsolute(outputDir) && !fs.existsSync(outputDir),
  'T19_T08_OUTPUT_DIR must name a new absolute directory');
const goldenBytes = fs.readFileSync(process.env.T19_T08_GOLDEN_FILE ??
  path.join(packetDir, 'golden-candidate.json'));
const golden = JSON.parse(goldenBytes);
assert.equal(golden.status, 'UNAPPROVED_PROPOSAL');
assert.equal(golden.source_commit, head);
assert.equal(golden.source_tree, tree);
assert.equal(git(['cat-file', '-t', head]).toString().trim(), 'commit');
assert.equal(git(['rev-parse', head + '^{tree}']).toString().trim(), tree);
assert.equal(sha(git(['show', head + ':package-lock.json'])), lockSha);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't19-t08-installed-'));
const oldUmask = process.umask(0o022);
try {
  const source = path.join(scratch, 'source');
  const consumer = path.join(scratch, 'consumer');
  const packed = path.join(scratch, 'packed');
  const unpacked = path.join(scratch, 'unpacked');
  const cache = path.join(scratch, 'npm-cache');
  fs.mkdirSync(source);
  fs.mkdirSync(consumer);
  fs.mkdirSync(packed);
  fs.mkdirSync(unpacked);
  const archive = path.join(scratch, 'source.tar');
  const archiveGit = command('git', ['-C', repo, 'archive', '--format=tar', '-o', archive, head], repo, cache);
  const extract = command('tar', ['-xf', archive, '-C', source], repo, cache);
  const lock = JSON.parse(git(['show', head + ':package-lock.json']));
  const pack = command('npm', ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', packed], source, cache);
  const [meta] = JSON.parse(pack.stdout);
  assert.equal(meta.name, 'backend-skeleton');
  const packedFile = path.join(packed, meta.filename);
  const bins = new Set(Object.values(JSON.parse(git(['show', head + ':package.json'])).bin));
  const gitTree = new Map(git(['ls-tree', '-r', head]).toString().trim().split('\n')
    .map(line => {
      const match = line.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
      assert.ok(match, 'unexpected git tree entry: ' + line);
      return [match[3], { mode: match[1], blob: match[2] }];
    }));
  const expected = meta.files.map(file => {
    assert.ok(!path.posix.isAbsolute(file.path) &&
      !file.path.split('/').some(part => !part || part === '.' || part === '..'),
    'unsafe member path: ' + file.path);
    const member = gitTree.get(file.path);
    assert.ok(member, 'packed member absent from exact Git head: ' + file.path);
    const gitMode = member.mode === '100755' ? 0o755 : 0o644;
    const bytes = git(['cat-file', 'blob', member.blob]);
    assert.equal(file.size, bytes.length, file.path + ' size');
    assert.equal(file.mode, gitMode, file.path + ' packed mode');
    const sourcePath = path.join(source, file.path);
    assert.equal(sha(fs.readFileSync(sourcePath)), sha(bytes), file.path + ' source bytes');
    assert.equal(fs.statSync(sourcePath).mode & 0o777, gitMode, file.path + ' source mode');
    return { path: file.path, size: bytes.length, sha256: sha(bytes),
      mode: bins.has(file.path) ? 0o755 : gitMode, git_mode: gitMode };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  assert.equal(new Set(expected.map(row => row.path)).size, expected.length);
  const packSha = sha(fs.readFileSync(packedFile));
  const unpack = command('tar', ['-xf', packedFile, '-C', unpacked], repo, cache);
  const archiveMembers = inventory(path.join(unpacked, 'package'));
  assertSameInventory(archiveMembers, expected.map(({ git_mode, ...row }) =>
    ({ ...row, mode: git_mode })), 'archive differs from exact Git members');
  // Bind every transitive install to the pinned source lock, not just versions.
  assert.equal(lock.lockfileVersion, 3);
  const { '': rootPackage, ...lockedDeps } = lock.packages;
  for (const [name, dep] of Object.entries(lockedDeps)) {
    assert.ok(name.startsWith('node_modules/') && name !== 'node_modules/backend-skeleton');
    assert.match(dep.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.equal(new URL(dep.resolved).origin, 'https://registry.npmjs.org');
  }
  const tarSpec = 'file:../packed/' + path.basename(packedFile);
  const consumerRoot = { name: 't19-t08-disposable-review', version: '0.0.0',
    dependencies: { 'backend-skeleton': tarSpec } };
  const integrity = 'sha512-' + createHash('sha512').update(fs.readFileSync(packedFile)).digest('base64');
  const consumerLockBytes = json({
    name: consumerRoot.name, version: consumerRoot.version, lockfileVersion: 3, requires: true,
    packages: { '': consumerRoot, 'node_modules/backend-skeleton': {
      ...rootPackage, resolved: tarSpec, integrity,
    }, ...lockedDeps },
  });
  fs.writeFileSync(path.join(consumer, 'package.json'), json({ ...consumerRoot, private: true }));
  fs.writeFileSync(path.join(consumer, 'package-lock.json'), consumerLockBytes);
  const installed = command('npm', ['ci', '--ignore-scripts', '--prefix', consumer], repo, cache);
  assert.deepEqual(fs.readFileSync(path.join(consumer, 'package-lock.json')), consumerLockBytes);
  const installedRoot = path.join(consumer, 'node_modules/backend-skeleton');
  const observed = inventory(installedRoot);
  assertSameInventory(observed, expected.map(({ git_mode, ...row }) => row),
    'installed package differs from exact Git bytes and expected bin modes');
  const index = path.join(installedRoot, 'scanners/language/native-server/index.mjs');
  const { NATIVE_SERVER_PROTOCOL, NATIVE_WORKER_PATH, runNativeServerWorker } =
    await import(pathToFileURL(index).href);
  assert.equal(NATIVE_WORKER_PATH,
    path.join(installedRoot, 'scanners/language/native-server/worker.mjs'));
  assert.equal(fs.existsSync(NATIVE_WORKER_PATH), true);
  const observations = [];
  for (const [filename, want] of Object.entries(golden.fixtures)) {
    const sourceBytes = fs.readFileSync(path.join(packetDir, 'fixtures', filename));
    const request = { protocol: NATIVE_SERVER_PROTOCOL, kind: 'analyze-request',
      requestId: 't19-installed-' + filename, language: want.language,
      file: filename, source: sourceBytes.toString('utf8'), budget: { wallTimeMs: 5000 } };
    const first = runNativeServerWorker(request);
    const second = runNativeServerWorker(request);
    assert.deepEqual(first, second, filename + ': nondeterministic installed worker');
    const routes = first.routes.map(route => route.method + ' ' + route.path).sort();
    assert.deepEqual(routes, [...want.route_pairs].sort(), filename + ': route facts differ');
    const unknowns = first.diagnostics.filter(item => item.severity === 'unknown')
      .map(item => item.code).sort();
    for (const code of want.required_unknown_codes)
      assert.ok(unknowns.includes(code), filename + ': missing unknown ' + code);
    for (const forbidden of want.forbidden_paths)
      assert.ok(!first.routes.some(route => route.path === forbidden),
        filename + ': invented ' + forbidden);
    observations.push({ filename, source_sha256: sha(sourceBytes), routes,
      unknown_codes: unknowns, deterministic: true });
  }
  const worker = path.join(installedRoot, 'scanners/language/native-server/worker.mjs');
  const original = fs.readFileSync(worker);
  const originalMode = fs.statSync(worker).mode & 0o777;
  try {
    fs.appendFileSync(worker, '\n');
    assert.notDeepEqual(inventory(installedRoot), observed, 'byte tamper not detected');
    fs.writeFileSync(worker, original);
    fs.chmodSync(worker, originalMode === 0o644 ? 0o755 : 0o644);
    assert.notDeepEqual(inventory(installedRoot), observed, 'mode tamper not detected');
  } finally { fs.writeFileSync(worker, original); fs.chmodSync(worker, originalMode); }
  assert.deepEqual(inventory(installedRoot), observed, 'installed package not restored');
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.writeFileSync(path.join(outputDir, 'pack-members.json'), json(expected));
  fs.writeFileSync(path.join(outputDir, 'archive-members.json'), json(archiveMembers));
  fs.writeFileSync(path.join(outputDir, 'installed-members.json'), json(observed));
  const receipt = { schema: 't19.t08-installed-review-candidate/1',
    status: 'CANDIDATE_OBSERVATION_NOT_APPROVAL', source_commit: head,
    source_tree: tree, source_lock_sha256: lockSha,
    golden_sha256: sha(goldenBytes), archive_sha256: packSha,
    pack_member_count: expected.length, pack_members_sha256: sha(json(expected)),
    archive_members_sha256: sha(json(archiveMembers)),
    installed_members_sha256: sha(json(observed)), npm_version: command('npm', ['--version'], repo, cache).stdout.trim(),
    node_version: process.version, worker_inside_installed_package: true,
    commands: { git_archive: archiveGit.receipt, tar_extract: extract.receipt,
      npm_pack: pack.receipt, tar_unpack: unpack.receipt, npm_install: installed.receipt },
    consumer_lock_sha256: sha(consumerLockBytes), pinned_dependency_count: Object.keys(lockedDeps).length,
    observations, byte_mode_tamper_detected: true,
    independent_t19_attestation: false, release_approved: false };
  fs.writeFileSync(path.join(outputDir, 'receipt.json'), json(receipt));
  console.log(JSON.stringify(receipt));
} finally {
  process.umask(oldUmask);
  fs.rmSync(scratch, { recursive: true, force: true });
}
