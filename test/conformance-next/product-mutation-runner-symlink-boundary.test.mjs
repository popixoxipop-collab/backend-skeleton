import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runProductMutationCampaign, validateProductMutationCatalog} from './product-mutation-runner.mjs';

function fixture(t, {mutationSymlink = false, testSymlink = false, parentSymlink = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't19-scratch-symlink-boundary-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  const external = path.join(root, 'outside-mutation.mjs');
  const executedMarker = path.join(root, 'outside-test-ran');
  fs.mkdirSync(repo);
  fs.writeFileSync(external, 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 't19-symlink-boundary', version: '1.0.0', private: true, type: 'module',
  }) + '\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
    name: 't19-symlink-boundary', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {'': {name: 't19-symlink-boundary', version: '1.0.0'}},
  }, null, 2) + '\n');
  if (mutationSymlink) fs.symlinkSync(external, path.join(repo, 'subject.mjs'));
  else fs.writeFileSync(path.join(repo, 'subject.mjs'), 'export const value = 1;\n');

  const testParent = parentSymlink ? path.join(root, 'external-tests') : path.join(repo, 'test');
  fs.mkdirSync(testParent);
  if (parentSymlink) fs.symlinkSync(testParent, path.join(repo, 'test'), 'dir');

  if (testSymlink) {
    const externalTest = path.join(root, 'outside.test.mjs');
    fs.writeFileSync(externalTest, [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(executedMarker)},'ran');`,
      "test('out-of-checkout execution must be rejected',()=>{});",
    ].join('\n') + '\n');
    fs.symlinkSync(externalTest, path.join(testParent, 'subject.test.mjs'));
  } else {
    fs.writeFileSync(path.join(testParent, 'subject.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import {value} from '../subject.mjs';",
      "test('source assertion',()=>assert.equal(value,1));",
    ].join('\n') + '\n');
  }

  const git = (args) => {
    const child = spawnSync('git', args, {cwd: repo, encoding: 'utf8', timeout: 15000,
      env: {...process.env, GIT_AUTHOR_NAME: 'T19 fixture', GIT_AUTHOR_EMAIL: 't19@example.invalid',
        GIT_COMMITTER_NAME: 'T19 fixture', GIT_COMMITTER_EMAIL: 't19@example.invalid',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1'}});
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-qm', 'pinned symlink boundary fixture']);
  const head = git(['rev-parse', 'HEAD']);
  return {root, repo, head, external, executedMarker};
}

function catalog() {
  return {contract: 'sbf.qa-product-mutation-catalog/1', mutants: [{
    id: 'symlink-boundary-critical', vector_id: 'NEG-RUN-06', critical: true,
    file: 'subject.mjs', find: 'value = 1;', replace: 'value = 2;',
    test_files: ['test/subject.test.mjs'], timeout_ms: 20000,
    invariant: 'Mutation or its original oracle must not follow an untrusted linked file outside a disposable source checkout.',
  }]};
}

test('T19 source mutation refuses a Git-tracked symlink to outside the scratch checkout and never writes its target', {
  timeout: 90000,
}, t => {
  const {repo, head, external} = fixture(t, {mutationSymlink: true});
  const before = fs.readFileSync(external);
  const result = runProductMutationCampaign({repoRoot: repo, catalog: catalog(), sourceCommit: head});
  assert.equal(result.pass, false);
  const mutant = result.mutants[0];
  assert.equal(mutant.baseline.exit_code, null, 'unsafe source must be rejected before the original oracle');
  assert.equal(mutant.baseline.attempts, 0);
  assert.equal(mutant.baseline.error_code, 'UNSAFE_MUTATION_PATH');
  assert.equal(mutant.status, 'survived');
  assert.equal(mutant.classification, 'mutation-not-applied');
  assert.match(mutant.reason, /unsafe mutation target: source path contains a symbolic link/);
  assert.deepEqual(fs.readFileSync(external), before, 'mutation must not reach the symlink destination');
});

test('T19 linked original source cannot execute external code even during baseline', {
  timeout: 90000,
}, t => {
  const {repo, head, external, executedMarker} = fixture(t, {mutationSymlink: true});
  fs.writeFileSync(external, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(executedMarker)}, 'unsafe-baseline-executed');`,
    'export const value = 1;',
  ].join('\n') + '\n');
  const result = runProductMutationCampaign({repoRoot: repo, catalog: catalog(), sourceCommit: head});
  assert.equal(result.pass, false);
  assert.equal(result.mutants[0].status, 'survived');
  assert.equal(result.mutants[0].classification, 'mutation-not-applied');
  assert.equal(result.mutants[0].baseline.error_code, 'UNSAFE_MUTATION_PATH');
  assert.equal(result.mutants[0].baseline.attempts, 0);
  assert.equal(fs.existsSync(executedMarker), false,
    'original test must not import a tracked symlink source pointing outside the disposable checkout');
});

test('T19 selected test module symlink outside source is refused before execution', {
  timeout: 90000,
}, t => {
  const {repo, head, executedMarker} = fixture(t, {testSymlink: true});
  const result = runProductMutationCampaign({repoRoot: repo, catalog: catalog(), sourceCommit: head});
  assert.equal(result.pass, false);
  const mutant = result.mutants[0];
  assert.equal(mutant.status, 'survived');
  assert.equal(mutant.classification, 'baseline-failed');
  assert.equal(mutant.baseline.error_code, 'UNSAFE_TEST_PATH');
  assert.match(mutant.baseline.stderr_tail, /symbolic link/);
  assert.equal(fs.existsSync(executedMarker), false, 'out-of-checkout script must never execute');
});

test('T19 symlinked directory in the selected test path is refused before running', {
  timeout: 90000,
}, t => {
  const {repo, head} = fixture(t, {parentSymlink: true});
  const result = runProductMutationCampaign({repoRoot: repo, catalog: catalog(), sourceCommit: head});
  assert.equal(result.pass, false);
  assert.equal(result.mutants[0].classification, 'baseline-failed');
  assert.equal(result.mutants[0].baseline.error_code, 'UNSAFE_TEST_PATH');
  assert.match(result.mutants[0].baseline.stderr_tail, /symbolic link/);
});

test('T19 catalog refuses noncanonical, hidden Git, and dependency-directory paths without changing good paths', () => {
  assert.equal(validateProductMutationCatalog(catalog()).ok, true);
  for (const bad of ['./subject.mjs', 'x//subject.mjs', 'x/./subject.mjs',
    'x/.git/config', 'x/node_modules/internal.mjs', 'x/../subject.mjs']) {
    const row = catalog(); row.mutants[0].file = bad;
    assert.equal(validateProductMutationCatalog(row).ok, false, bad);
  }
});
