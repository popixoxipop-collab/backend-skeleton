// New, scoped backend-skeleton CLI↔SDK pinned Next.js integration contract.
// Run only this file, never historical P6 Node22 full/receipt/baseline suites.
// Synthetic Git fixtures under OS temp directory. No source registry writes,
// target-app evaluation, GitHub, credentials, release, or production DB changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pinnedNextSourceAdapter } from '../../scanners/pinned-next/next-product-sdk.mjs';
import { parseCommand } from '../../lib/cli.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(repoRoot, 'bin', 'bskel.mjs');
const GIT = '/usr/bin/git';
const GIT_SHA = '44a68ddc1983d6cff3fd35ba3f9ba5f82004216f1dcde69892b3d1b06e408698';
const EXEC_ENV = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: '/var/empty', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
});
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function fixtureGit(root, ...args) {
  const p = spawnSync(GIT, ['-C', root, ...args], {
    encoding: 'utf8', timeout: 15000, env: EXEC_ENV,
  });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function fixture(t, { multi = true, corrupted = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-pinned-product-integr-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'source-repo');
  fs.mkdirSync(repo);
  fixtureGit(repo, 'init', '-q');
  if (multi) {
    write(path.join(repo, 'package.json'), JSON.stringify({
      name: 'workspace', dependencies: { react: '19.0.0' },
    }));
    for (const id of ['apps/web', 'apps/admin']) {
      write(path.join(repo, id, 'package.json'), JSON.stringify({
        name: id, dependencies: { next: '15.1.0' },
      }));
    }
    write(path.join(repo, 'apps/web/app/api/route.ts'),
      'export async function GET() {}\nexport const POST = async () => {};\n');
    write(path.join(repo, 'apps/admin/next.config.js'),
      "module.exports = { basePath: '/portal' };\n");
    write(path.join(repo, 'apps/admin/app/users/[id]/route.ts'),
      'export async function DELETE() {}\n');
  } else {
    write(path.join(repo, 'package.json'), JSON.stringify({
      name: 'single-app', dependencies: { next: '15.1.0' },
    }));
    write(path.join(repo, 'app/api/route.ts'), 'export async function GET() {}\n');
  }
  if (corrupted) {
    write(path.join(repo, 'apps/corrupt/package.json'), '{invalid');
  }
  fixtureGit(repo, 'add', '-A');
  fixtureGit(repo, '-c', 'user.name=T13-integration',
    '-c', 'user.email=local@invalid.test', 'commit', '-qm', 'test fixture');
  const commit = fixtureGit(repo, 'rev-parse', 'HEAD');
  const pinnedSource = {
    commit, gitExecutable: GIT, gitExecutableSha256: GIT_SHA,
    gitDir: path.join(repo, '.git'),
    trustedCommonDir: path.join(repo, '.git'),
  };
  const pins = [
    '--commit', commit, '--git-exe', GIT, '--git-sha256', GIT_SHA,
    '--git-dir', pinnedSource.gitDir, '--common-dir', pinnedSource.trustedCommonDir,
  ];
  return { repo, commit, pinnedSource, pins };
}
function call(f, selectors = [], options = []) {
  return spawnSync(process.execPath, [CLI, 'scan', 'pinned-next',
    ...f.pins, ...selectors, ...options], {
    encoding: 'utf8', timeout: 18000,
  });
}
function report(r, expectedCode = 0) {
  assert.equal(r.status, expectedCode, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.startsWith('{\n'));
  return JSON.parse(r.stdout);
}
const routes = result => result.endpoints.map(e =>
  e.project + ':' + e.method + ' ' + e.route).sort();

test('I01 opt-in pinned-next command schema is required and help lists flags', () => {
  assert.throws(() => parseCommand('scan pinned-next', []), /usage:/);
  const parsed = parseCommand('scan pinned-next', ['--help']);
  assert.equal(parsed.help, true);
  const help = spawnSync(process.execPath, [CLI, 'scan', 'pinned-next', '--help'],
    { encoding: 'utf8', timeout: 12000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--commit/);
  assert.match(help.stdout, /--all-projects/);
});
test('I02 standard scan CLI preserves its original non-pinned argument contract', () => {
  const standard = parseCommand('scan', []);
  assert.equal(standard['runtime-routes'], false);
  assert.equal(standard.feature, null);
  assert.ok(!Object.hasOwn(standard, 'commit'));
  assert.equal(ADAPTERS.some(a => a.id === 'typescript-nextjs'), false);
});
test('I03 exact committed project catalog lists two Next apps and no routes', t => {
  const f = fixture(t);
  const data = report(call(f, ['--list-projects'], ['--json']));
  assert.equal(data.status, 'project-list');
  assert.deepEqual(data.catalog.projects.map(p => p.id), ['apps/admin', 'apps/web']);
  assert.equal(data.inventory.endpointCount, 0);
  assert.equal(data.trust.sourceCommit, f.commit);
  assert.equal(data.trust.externallyAuthorized, false);
  assert.equal(data.support.operationRegistrationAllowed, false);
});
test('I04 multi-project implicit scan refuses arbitrary first-app selection', t => {
  const f = fixture(t);
  const data = report(call(f), 3);
  assert.equal(data.status, 'selection-required');
  assert.equal(data.projectSelection.selectionRequired, true);
  assert.deepEqual(data.endpoints, []);
});
test('I05 explicit all app routes keep Next project and basePath identity', t => {
  const f = fixture(t);
  const data = report(call(f, ['--all-projects'], ['--json']));
  assert.deepEqual(routes(data), [
    'apps/admin:DELETE /portal/users/{id}',
    'apps/web:GET /api',
    'apps/web:POST /api',
  ]);
  assert.equal(data.inventory.endpointCount, 3);
  assert.equal(data.inventory.virtualFdOperations.unclosed, 0);
  assert.equal(data.support.runtimeCertified, false);
});
test('I06 individual app selection leaves other app endpoints out', t => {
  const f = fixture(t);
  const data = report(call(f, ['--project', 'apps/web']));
  assert.deepEqual(routes(data), ['apps/web:GET /api', 'apps/web:POST /api']);
  assert.deepEqual(data.projectSelection.selectedProjectIds, ['apps/web']);
});
test('I07 bskel command stdout matches SDK source-selection output for same pinned revision', t => {
  const f = fixture(t);
  const cli = report(call(f, ['--all-projects']));
  const sdk = pinnedNextSourceAdapter.scanAll(f.pinnedSource);
  assert.deepEqual(cli, sdk);
  assert.equal(cli.resultSha256, sdk.resultSha256);
});
test('I08 dirty source checkout cannot change old pinned output', t => {
  const f = fixture(t);
  const before = report(call(f, ['--all-projects']));
  write(path.join(f.repo, 'apps/web/app/api/route.ts'), 'export async function PATCH() {}\n');
  write(path.join(f.repo, 'apps/admin/next.config.js'), "module.exports={basePath:'/evil'};\n");
  const after = report(call(f, ['--all-projects']));
  assert.deepEqual(after, before);
});
test('I09 changed Git commit is reflected only after explicit new pin', t => {
  const f = fixture(t);
  const initial = report(call(f, ['--all-projects']));
  write(path.join(f.repo, 'apps/web/app/api/route.ts'), 'export async function PATCH() {}\n');
  fixtureGit(f.repo, 'add', '-A');
  fixtureGit(f.repo, '-c', 'user.name=T13-integration',
    '-c', 'user.email=local@invalid.test', 'commit', '-qm', 'new version');
  const stillOld = report(call(f, ['--all-projects']));
  assert.deepEqual(stillOld, initial);
  f.pins[1] = fixtureGit(f.repo, 'rev-parse', 'HEAD');
  const newOne = report(call(f, ['--all-projects']));
  assert.ok(routes(newOne).includes('apps/web:PATCH /api'));
  assert.ok(!routes(newOne).includes('apps/web:GET /api'));
});
test('I10 invalid branch ref is denied, no implicit HEAD fallback', t => {
  const f = fixture(t);
  f.pins[1] = 'HEAD';
  const r = call(f, ['--all-projects'], ['--json']);
  assert.equal(r.status, 14);
  assert.match(r.stderr, /bskel pinned-next: EXACT_PIN_REQUIRED/);
  const diag = JSON.parse(r.stdout);
  assert.equal(diag.schema, 'sbf.cli-diagnostic/1');
  assert.equal(diag.reason, 'EXACT_PIN_REQUIRED');
});
test('I11 wrong trusted git executable digest denied and source not scanned', t => {
  const f = fixture(t);
  f.pins[5] = '0'.repeat(64);
  const r = call(f, ['--all-projects']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /GIT_EXECUTABLE_SHA256_MISMATCH/);
});
test('I12 no target app code executes; static output is explicit-only', t => {
  const f = fixture(t, { multi: false });
  write(path.join(f.repo, 'app/api/route.ts'),
    'throw new Error("if executed product is wrong");\nexport async function PATCH() {}\n');
  fixtureGit(f.repo, 'add', '-A');
  fixtureGit(f.repo, '-c', 'user.name=T13-integration',
    '-c', 'user.email=local@invalid.test', 'commit', '-qm', 'no dynamic application code');
  f.pins[1] = fixtureGit(f.repo, 'rev-parse', 'HEAD');
  const data = report(call(f));
  assert.deepEqual(routes(data), ['.:PATCH /api']);
  assert.equal(data.support.runtimeCertified, false);
});
test('I13 incomplete catalog returns machine status and nonzero whole-repo exit', t => {
  const f = fixture(t, { corrupted: true });
  const all = report(call(f, ['--all-projects']), 4);
  assert.equal(all.status, 'partial-scan');
  assert.equal(all.catalog.incomplete, true);
  assert.equal(all.inventory.endpointCount, 3);
  const web = report(call(f, ['--project', 'apps/web']));
  assert.equal(web.catalog.incomplete, true);
  assert.equal(web.inventory.endpointCount, 2);
});
test('I14 original product scanner registry/index hashes are preserved by this integration branch', () => {
  const a = sha256(fs.readFileSync(path.join(repoRoot, 'scanners/registry.mjs')));
  const b = sha256(fs.readFileSync(path.join(repoRoot, 'scanners/index.mjs')));
  assert.equal(a, 'f67968e4ef43cc138e4652c7d5b6e877d17e0cf79daa12a42ba83b5d8112ab8e');
  assert.equal(b, 'd6261c741e45df7f7b9b48b812158e575c3a0ef48a5c144d2e68f2733d13d63c');
});

test('I15 quiet plus explicit JSON still returns a machine-readable result', t => {
  const f = fixture(t);
  const result = report(call(f, ['--all-projects'], ['--quiet', '--json']));
  assert.equal(result.inventory.endpointCount, 3);
  const quietOnly = call(f, ['--all-projects'], ['--quiet']);
  assert.equal(quietOnly.status, 0);
  assert.equal(quietOnly.stdout, '');
  assert.equal(quietOnly.stderr, '');
});
test('I16 invalid Git executable hash with JSON flag follows native bskel diagnostic schema', t => {
  const f = fixture(t);
  f.pins[5] = '0'.repeat(64);
  const result = call(f, ['--all-projects'], ['--json']);
  assert.equal(result.status, 2);
  const diag = JSON.parse(result.stdout);
  assert.equal(diag.schema, 'sbf.cli-diagnostic/1');
  assert.equal(diag.command, 'scan pinned-next');
  assert.equal(diag.reason, 'GIT_EXECUTABLE_SHA256_MISMATCH');
  assert.match(result.stderr, /bskel pinned-next: GIT_EXECUTABLE_SHA256_MISMATCH/);
  assert.ok(!result.stdout.includes(f.repo));
});

test('I17 --name=value matches the existing public CLI argument contract', t => {
  const f = fixture(t);
  const equals = [];
  for (let i = 0; i < f.pins.length; i += 2) {
    equals.push(f.pins[i] + '=' + f.pins[i + 1]);
  }
  const r = spawnSync(process.execPath, [
    CLI, 'scan', 'pinned-next', ...equals, '--project=apps/web', '--json',
  ], { encoding: 'utf8', timeout: 18000 });
  const parsed = report(r, 0);
  const standard = report(call(f, ['--project', 'apps/web'], ['--json']), 0);
  assert.deepEqual(parsed, standard);
  assert.deepEqual(routes(parsed), ['apps/web:GET /api', 'apps/web:POST /api']);
});
test('I18 --flag=value retains invalid-argument and duplicate rejection', t => {
  const f = fixture(t);
  const cases = [
    [...f.pins, '--list-projects=true'],
    [...f.pins, '--project='],
    [...f.pins, '--project=apps/../escape'],
    [...f.pins, '--commit=abcdef0123456789'],
    [...f.pins, '--project=apps/web', '--project', 'apps/admin'],
  ];
  for (const flags of cases) {
    const p = spawnSync(process.execPath, [
      CLI, 'scan', 'pinned-next', ...flags, '--json',
    ], { encoding: 'utf8', timeout: 18000 });
    assert.equal(p.status, 14, flags.join(' ') + ' : ' + p.stderr);
    const error = JSON.parse(p.stdout);
    assert.equal(error.schema, 'sbf.cli-diagnostic/1');
    assert.equal(error.ok, false);
    assert.match(p.stderr, /./);
  }
});
