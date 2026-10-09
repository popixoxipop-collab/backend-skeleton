import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT, repoPath } from './_target-helpers.mjs';
import { LOCK_DIR, ORACLE_PINS, TOOL_PATH, isInsideRepository } from './tools/target-oracle.mjs';

const TOOL = repoPath(TOOL_PATH);
const TARGETS = repoPath('test/protocol-next/fixtures/targets');
const SRI = 'sha512-' + 'A'.repeat(86) + '==';
const [FIRST_GRAPHQL, SECOND_GRAPHQL] = ORACLE_PINS.graphql;
const [ASYNCAPI] = ORACLE_PINS.asyncapi;

function readTree(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else files.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

const digests = (files) => [...files].map(([name, bytes]) => name + ' ' + crypto.createHash('sha256').update(bytes).digest('hex'));

function restoreTree(dir, files) {
  const current = readTree(dir);
  for (const name of current.keys()) if (!files.has(name)) fs.rmSync(path.join(dir, name));
  for (const [name, bytes] of files) {
    if (current.get(name)?.equals(bytes)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  }
}

// The decoy lives inside the checkout but under the git-ignored node_modules, so clean-checkout tests never see it.
function inSandbox(body) {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-tool-'));
  const modules = path.join(REPO_ROOT, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  const decoy = fs.mkdtempSync(path.join(modules, '.oracle-tool-decoy-'));
  const oracleDir = path.join(external, 'oracle');
  const home = path.join(external, 'home');
  fs.mkdirSync(oracleDir);
  fs.mkdirSync(home);
  const tracked = readTree(TARGETS);
  const run = (args) => spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      npm_config_cache: path.join(home, 'npm-cache'),
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  try {
    return body({
      oracleDir,
      decoy,
      run,
      assertCheckoutUntouched: () => assert.deepEqual(digests(readTree(TARGETS)), digests(tracked), 'the tracked evidence and locks are byte-identical'),
    });
  } finally {
    restoreTree(TARGETS, tracked);
    fs.rmSync(decoy, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
}

function writeLock(groupDir, group, entry = (pkg) => ({ version: pkg.version, integrity: SRI })) {
  const packages = {};
  for (const pkg of group.packages) {
    const value = entry(pkg);
    if (value) packages['node_modules/' + pkg.name] = value;
  }
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }, null, 2) + '\n');
}

function writeInstalled(groupDir, group, version = (pkg) => pkg.version) {
  for (const pkg of group.packages) {
    const dir = path.join(groupDir, 'node_modules', ...pkg.name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: version(pkg) }) + '\n');
  }
}

test('oracle tool refuses an --oracle-dir inside the repository, including names that begin with two dots, symlinks and other letter cases', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-dir-guard-'));
  try {
    const link = path.join(scratch, 'link-to-repo');
    fs.symlinkSync(REPO_ROOT, link, 'dir');
    const inside = [
      REPO_ROOT,
      path.join(REPO_ROOT, 'oracle'),
      path.join(REPO_ROOT, '..oracle'),
      path.join(REPO_ROOT, '..oracle', 'gql16'),
      path.join(REPO_ROOT, 'a', '..b', 'c'),
      link,
      path.join(link, 'child'),
      path.join(link, '..oracle'),
    ];
    const swapped = REPO_ROOT.replace(/[A-Za-z]/g, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
    if (swapped !== REPO_ROOT && fs.existsSync(swapped) && fs.statSync(swapped).ino === fs.statSync(REPO_ROOT).ino) {
      inside.push(swapped, path.join(swapped, 'oracle'));
    }
    const outside = [path.dirname(REPO_ROOT), path.join(path.dirname(REPO_ROOT), 'oracle'), path.join(path.dirname(REPO_ROOT), path.basename(REPO_ROOT) + '..x'), path.join(scratch, 'oracle')];
    for (const candidate of inside) assert.equal(isInsideRepository(candidate), true, 'inside: ' + candidate);
    for (const candidate of outside) assert.equal(isInsideRepository(candidate), false, 'outside: ' + candidate);

    const run = (dir) => spawnSync(process.execPath, [TOOL, '--family', 'graphql', '--oracle-dir', dir], { encoding: 'utf8' });
    for (const dir of [path.join(REPO_ROOT, '..oracle-guard-probe'), path.join(link, '..oracle-guard-probe')]) {
      const refused = run(dir);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /--oracle-dir must be outside the repository/);
      assert.equal(fs.existsSync(path.join(REPO_ROOT, '..oracle-guard-probe')), false, 'nothing was created in the repository');
    }
    const outsideDir = path.join(scratch, 'not-created');
    const passed = run(outsideDir);
    assert.notEqual(passed.status, 0);
    assert.doesNotMatch(passed.stderr, /must be outside the repository/);
    assert.match(passed.stderr, /missing package-lock\.json/);
    assert.equal(fs.existsSync(outsideDir), false, 'without --install the tool creates nothing');
    assert.equal(fs.existsSync(path.join(REPO_ROOT, '..oracle-guard-probe')), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

for (const [family, groups] of Object.entries(ORACLE_PINS)) {
  for (const group of groups) {
    test(family + ' group ' + group.dir + ': a symlink into the repository is refused before anything is written or installed', () => {
      inSandbox(({ oracleDir, decoy, run, assertCheckoutUntouched }) => {
        fs.symlinkSync(decoy, path.join(oracleDir, group.dir), 'dir');
        const result = run(['--family', family, '--oracle-dir', oracleDir, '--install']);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(path.join(oracleDir, group.dir) + ' resolves inside the repository'), 'the error names the symlinked group directory');
        assert.deepEqual(fs.readdirSync(decoy), [], 'nothing was written through the symlink');
        assertCheckoutUntouched();
      });
    });
  }
}

test('a symlinked group directory is refused without --install as well', () => {
  inSandbox(({ oracleDir, decoy, run, assertCheckoutUntouched }) => {
    fs.symlinkSync(decoy, path.join(oracleDir, FIRST_GRAPHQL.dir), 'dir');
    const result = run(['--family', 'graphql', '--oracle-dir', oracleDir]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(path.join(oracleDir, FIRST_GRAPHQL.dir) + ' resolves inside the repository'));
    assertCheckoutUntouched();
  });
});

test('every group is checked before the first one is installed', () => {
  inSandbox(({ oracleDir, decoy, run, assertCheckoutUntouched }) => {
    fs.mkdirSync(path.join(oracleDir, FIRST_GRAPHQL.dir));
    fs.symlinkSync(decoy, path.join(oracleDir, SECOND_GRAPHQL.dir), 'dir');
    const result = run(['--family', 'graphql', '--oracle-dir', oracleDir, '--install']);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(path.join(oracleDir, SECOND_GRAPHQL.dir) + ' resolves inside the repository'), 'the error names the second group');
    assert.deepEqual(fs.readdirSync(path.join(oracleDir, FIRST_GRAPHQL.dir)), [], 'the first group was not touched');
    assert.deepEqual(fs.readdirSync(decoy), []);
    assertCheckoutUntouched();
  });
});

const CHILDREN = [
  { family: 'graphql', group: FIRST_GRAPHQL, name: 'package.json', kind: 'file' },
  { family: 'graphql', group: FIRST_GRAPHQL, name: 'package-lock.json', kind: 'file' },
  { family: 'graphql', group: FIRST_GRAPHQL, name: 'node_modules', kind: 'dir' },
  { family: 'graphql', group: FIRST_GRAPHQL, name: path.join('node_modules', '.package-lock.json'), kind: 'file' },
  { family: 'asyncapi', group: ASYNCAPI, name: path.join('node_modules', '@asyncapi'), kind: 'dir' },
  { family: 'asyncapi', group: ASYNCAPI, name: path.join('node_modules', '@asyncapi', 'parser'), kind: 'dir' },
];

for (const child of CHILDREN) {
  test(child.family + ' group ' + child.group.dir + ': a symlinked ' + child.name + ' that resolves into the repository is refused', () => {
    inSandbox(({ oracleDir, decoy, run, assertCheckoutUntouched }) => {
      const link = path.join(oracleDir, child.group.dir, child.name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      const sentinel = 'SENTINEL\n';
      const target = path.join(decoy, 'target');
      if (child.kind === 'file') fs.writeFileSync(target, sentinel);
      else fs.mkdirSync(target);
      fs.symlinkSync(target, link, child.kind === 'dir' ? 'dir' : 'file');
      const result = run(['--family', child.family, '--oracle-dir', oracleDir, '--install']);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(link + ' resolves inside the repository'), 'the error names the symlink itself');
      if (child.kind === 'file') assert.equal(fs.readFileSync(target, 'utf8'), sentinel, 'the repository file behind the symlink is unchanged');
      else assert.deepEqual(fs.readdirSync(target), [], 'the repository directory behind the symlink is unchanged');
      assert.deepEqual(fs.readdirSync(decoy), ['target']);
      assertCheckoutUntouched();
    });
  });
}

test('a dangling symbolic link in place of a group directory is refused with its own error', () => {
  inSandbox(({ oracleDir, decoy, run, assertCheckoutUntouched }) => {
    const link = path.join(oracleDir, FIRST_GRAPHQL.dir);
    for (const target of [path.join(decoy, 'missing'), path.join(oracleDir, 'missing')]) {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(target, link, 'dir');
      const result = run(['--family', 'graphql', '--oracle-dir', oracleDir, '--install']);
      assert.notEqual(result.status, 0, target);
      assert.match(result.stderr, /dangling symbolic link/, target);
      assert.deepEqual(fs.readdirSync(decoy), [], 'nothing was created behind the link');
      assert.equal(fs.existsSync(path.join(oracleDir, 'missing')), false);
    }
    assertCheckoutUntouched();
  });
});

test('a group with a package lock but no installed packages fails and the tracked lock stays byte-identical', () => {
  inSandbox(({ oracleDir, run, assertCheckoutUntouched }) => {
    writeLock(path.join(oracleDir, FIRST_GRAPHQL.dir), FIRST_GRAPHQL);
    const result = run(['--family', 'graphql', '--oracle-dir', oracleDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /graphql is not installed in /);
    assertCheckoutUntouched();
  });
});

test('a wrong direct package version fails and the tracked lock stays byte-identical', () => {
  inSandbox(({ oracleDir, run, assertCheckoutUntouched }) => {
    const groupDir = path.join(oracleDir, FIRST_GRAPHQL.dir);
    writeLock(groupDir, FIRST_GRAPHQL);
    writeInstalled(groupDir, FIRST_GRAPHQL, () => '16.0.0');
    const result = run(['--family', 'graphql', '--oracle-dir', oracleDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /graphql resolved to 16\.0\.0, expected the pin 16\.14\.2/);
    assertCheckoutUntouched();
  });
});

const BAD_LOCK_ENTRIES = {
  'no lock entry for the package': () => undefined,
  'a lock entry for another version': () => ({ version: '0.0.1', integrity: SRI }),
  'a lock entry without an integrity': (pkg) => ({ version: pkg.version }),
  'a lock entry with a sha1 integrity': (pkg) => ({ version: pkg.version, integrity: 'sha1-' + 'A'.repeat(27) + '=' }),
};

for (const [name, entry] of Object.entries(BAD_LOCK_ENTRIES)) {
  test('a package lock with ' + name + ' fails and the tracked lock stays byte-identical', () => {
    inSandbox(({ oracleDir, run, assertCheckoutUntouched }) => {
      const groupDir = path.join(oracleDir, FIRST_GRAPHQL.dir);
      writeLock(groupDir, FIRST_GRAPHQL, entry);
      writeInstalled(groupDir, FIRST_GRAPHQL);
      const result = run(['--family', 'graphql', '--oracle-dir', oracleDir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not lock graphql@16\.14\.2 with a sha512 integrity/);
      assertCheckoutUntouched();
    });
  });
}

test('when the second group fails, the lock of the first group is not published either', () => {
  inSandbox(({ oracleDir, run, assertCheckoutUntouched }) => {
    const firstDir = path.join(oracleDir, FIRST_GRAPHQL.dir);
    writeLock(firstDir, FIRST_GRAPHQL, (pkg) => ({ version: pkg.version, integrity: SRI }));
    writeInstalled(firstDir, FIRST_GRAPHQL);
    const secondDir = path.join(oracleDir, SECOND_GRAPHQL.dir);
    writeLock(secondDir, SECOND_GRAPHQL);
    const before = fs.readFileSync(repoPath(LOCK_DIR + '/' + FIRST_GRAPHQL.dir + '.lock.json'), 'utf8');
    const result = run(['--family', 'graphql', '--oracle-dir', oracleDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /graphql is not installed in /);
    assert.ok(result.stderr.includes(secondDir), 'the error names the failing group');
    assert.equal(fs.readFileSync(repoPath(LOCK_DIR + '/' + FIRST_GRAPHQL.dir + '.lock.json'), 'utf8'), before);
    assertCheckoutUntouched();
  });
});
