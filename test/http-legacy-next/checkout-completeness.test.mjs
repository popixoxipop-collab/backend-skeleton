import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../../scanners/index.mjs';
import {
  assertLegacyCorpusCheckoutComplete,
  inspectLegacyCorpusCheckout,
} from '../../adapters/http-legacy-next/checkout-completeness.mjs';

// The guard shells out to git, so the whole test process, not only the fixture setup, must ignore the
// developer's or runner's git configuration (a global commit.gpgsign or core.quotePath changes the
// outcome) and any variable that redirects git to another repository.
const HERMETIC_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T11 Fixture',
  GIT_AUTHOR_EMAIL: 't11@example.invalid',
  GIT_COMMITTER_NAME: 'T11 Fixture',
  GIT_COMMITTER_EMAIL: 't11@example.invalid',
});
const REPOSITORY_SELECTING_GIT_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);
let savedEnv = {};

before(() => {
  const names = [...Object.keys(HERMETIC_GIT_ENV), ...REPOSITORY_SELECTING_GIT_ENV];
  savedEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of REPOSITORY_SELECTING_GIT_ENV) delete process.env[name];
  Object.assign(process.env, HERMETIC_GIT_ENV);
});

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const PYPROJECT = '[project]\ndependencies=["fastapi"]\n';
const FASTAPI_APP = 'from fastapi import FastAPI\napp = FastAPI()\n';
const RAILS_APPLICATION = 'class App < Rails::Application; end\n';
const RAILS_ROUTES = 'Rails.application.routes.draw { resources :users }\n';
const RAILS_CONTROLLER = 'class UsersController < ApplicationController; end\n';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepoAt(root, files) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

function makeRepo(files) {
  return makeRepoAt(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-sparse-')), files);
}

function sparse(root, ...cone) {
  git(root, 'sparse-checkout', 'init', '--cone');
  git(root, 'sparse-checkout', 'set', ...cone);
}

// Names compare equal across the NFC/NFD forms a file system may report for the same text.
const names = (paths) => paths.map((entry) => entry.normalize('NFC')).sort();

test('T11 corpus completeness accepts a normal full checkout', () => {
  const root = makeRepo({
    'pyproject.toml': '[project]\ndependencies=["fastapi"]\n',
    'app/main.py': 'from fastapi import FastAPI\n',
  });
  try {
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, true);
    assert.equal(result.mode, 'full-working-tree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness rejects sparse FastAPI checkout missing tracked Python files', () => {
  const root = makeRepo({
    'pyproject.toml': '[project]\ndependencies=["fastapi"]\n',
    'app/main.py': 'from fastapi import FastAPI\n',
    'tests/test_api.py': 'def test_x(): pass\n',
  });
  try {
    git(root, 'sparse-checkout', 'init', '--cone');
    git(root, 'sparse-checkout', 'set', 'app');
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, false);
    assert.equal(result.mode, 'sparse-readset-verified');
    assert.equal(result.missing_count, 1);
    assert.deepEqual(result.missing_paths, ['tests/test_api.py']);
    assert.throws(
      () => assertLegacyCorpusCheckoutComplete({ repoRoot: root, adapterId: 'python-fastapi' }),
      (err) => err?.code === 'T11_CORPUS_CHECKOUT_INCOMPLETE',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness accepts sparse Rails checkout only when scanner read-set scopes are materialized', () => {
  const root = makeRepo({
    'Gemfile': 'gem "rails"\n',
    'config/application.rb': 'class App < Rails::Application; end\n',
    'config/routes.rb': 'Rails.application.routes.draw { resources :users }\n',
    'app/controllers/users_controller.rb': 'class UsersController < ApplicationController; end\n',
    'app/models/user.rb': 'class User < ApplicationRecord; end\n',
    'lib/feature.rb': 'module Feature; end\n',
    'spec/user_spec.rb': 'RSpec.describe User do; end\n',
  });
  try {
    git(root, 'sparse-checkout', 'init', '--cone');
    git(root, 'sparse-checkout', 'set', 'config', 'app/controllers', 'app/models');
    let result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'ruby-rails' });
    assert.equal(result.complete, false);
    assert.ok(result.missing_paths.includes('lib/feature.rb'));

    git(root, 'sparse-checkout', 'set', 'config', 'app/controllers', 'app/models', 'lib');
    result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'ruby-rails' });
    assert.equal(result.complete, true);
    assert.equal(result.expected_tracked_read_files, 6);
    assert.equal(result.materialized_read_files, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness fails closed for sparse adapters without an audited tracked-path rule', () => {
  const root = makeRepo({
    'package.json': '{"dependencies":{"express":"1.0.0"}}\n',
    'src/app.js': 'require("express")\n',
  });
  try {
    git(root, 'sparse-checkout', 'init', '--cone');
    git(root, 'sparse-checkout', 'set', 'src');
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'javascript-express' });
    assert.equal(result.complete, false);
    assert.equal(result.mode, 'sparse-unsupported-adapter');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness rejects a sparse checkout whose project root has a non-ASCII name', () => {
  const root = makeRepo({
    'README.md': 'docs\n',
    '서버/pyproject.toml': PYPROJECT,
    '서버/app/main.py': FASTAPI_APP,
    '서버/app/api.py': 'x = 1\n',
  });
  try {
    sparse(root, 'docs-only');
    const project = path.join(root, '서버');
    fs.mkdirSync(project, { recursive: true });
    assert.deepEqual(fs.readdirSync(project), []);
    const result = inspectLegacyCorpusCheckout({ repoRoot: project, adapterId: 'python-fastapi' });
    assert.equal(result.project_root.normalize('NFC'), '서버');
    assert.equal(result.complete, false);
    assert.equal(result.expected_tracked_read_files, 2);
    assert.equal(result.materialized_read_files, 0);
    assert.deepEqual(names(result.missing_paths), ['app/api.py', 'app/main.py']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness reports tracked Python files with non-ASCII names outside the sparse cone', () => {
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
    'modèles/café.py': 'x = 1\n',
  });
  try {
    sparse(root, 'app');
    assert.equal(fs.existsSync(path.join(root, 'modèles', 'café.py')), false);
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, false);
    assert.equal(result.expected_tracked_read_files, 2);
    assert.deepEqual(names(result.missing_paths), ['modèles/café.py']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness reports tracked Python files whose names git always quotes', () => {
  const awkward = ['gen/a"b.py', 'gen/back\\slash.py', 'gen/tab\there.py', 'gen/new\nline.py'];
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
    ...Object.fromEntries(awkward.map((rel) => [rel, 'x = 1\n'])),
  });
  try {
    sparse(root, 'app');
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, false);
    assert.equal(result.expected_tracked_read_files, 5);
    assert.deepEqual(names(result.missing_paths), names(awkward));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness keeps leading whitespace in tracked path names', () => {
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    ' lead.py': 'x = 1\n',
    'app/main.py': FASTAPI_APP,
    'tests/test_api.py': 'def test_x(): pass\n',
  });
  try {
    sparse(root, 'app', 'tests');
    assert.equal(fs.existsSync(path.join(root, ' lead.py')), true);
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, true);
    assert.equal(result.expected_tracked_read_files, 3);
    assert.equal(result.materialized_read_files, 3);
    assert.deepEqual(result.missing_paths, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness requires every tracked Rails Gemfile and Gemfile.lock, also below the trees the scanner may exclude', () => {
  const root = makeRepo({
    'Gemfile': 'gem "rails"\n',
    'Gemfile.lock': '    rails (7.1.0)\n',
    'config/application.rb': RAILS_APPLICATION,
    'config/routes.rb': RAILS_ROUTES,
    'app/controllers/users_controller.rb': RAILS_CONTROLLER,
    'engines/billing/Gemfile': 'gem "rails"\n',
    'engines/billing/Gemfile.lock': '    rails (7.1.0)\n',
    'vendor/bundle/ruby/3.3.0/gems/dep/Gemfile': 'gem "dep"\n',
    'node_modules/dep/Gemfile': 'gem "dep"\n',
    'tmp/cache/Gemfile': 'gem "dep"\n',
    'log/Gemfile': 'gem "dep"\n',
  });
  try {
    sparse(root, 'config', 'app/controllers');
    let result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'ruby-rails' });
    assert.equal(result.complete, false);
    assert.equal(result.expected_tracked_read_files, 11);
    assert.equal(result.materialized_read_files, 5);
    assert.deepEqual(names(result.missing_paths), [
      'engines/billing/Gemfile',
      'engines/billing/Gemfile.lock',
      'log/Gemfile',
      'node_modules/dep/Gemfile',
      'tmp/cache/Gemfile',
      'vendor/bundle/ruby/3.3.0/gems/dep/Gemfile',
    ]);

    sparse(root, 'config', 'app/controllers', 'engines', 'vendor', 'node_modules', 'tmp', 'log');
    result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'ruby-rails' });
    assert.equal(result.complete, true);
    assert.equal(result.expected_tracked_read_files, 11);
    assert.equal(result.materialized_read_files, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness expects exactly the files the FastAPI scanner reads', () => {
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
    ' lead.py': 'x = 1\n',
    'modèles/café.py': 'x = 1\n',
    'gen/a"b.py': 'x = 1\n',
    'tests/test_api.py': 'def test_x(): pass\n',
    '.venv/lib/hidden.py': 'x = 1\n',
    'pkg/site-packages/vendored.py': 'x = 1\n',
    'pkg/__pycache__/cached.py': 'x = 1\n',
    'node_modules/dep/mod.py': 'x = 1\n',
    'notes.txt': 'not python\n',
  });
  try {
    sparse(root, 'app', 'modèles', 'gen', 'tests', '.venv', 'pkg', 'node_modules');
    const scanned = runScan({ repoRoot: root, terms: [] });
    assert.equal(scanned.adapter, 'python-fastapi');
    const result = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(result.complete, true);
    assert.equal(result.expected_tracked_read_files, scanned.files_read.length);
    assert.equal(result.expected_tracked_read_files, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness expects every file the Rails scanner reads, whichever directory the scan runs from', () => {
  const root = makeRepo({
    'Gemfile': 'gem "rails"\n',
    'Gemfile.lock': '    rails (7.1.0)\n',
    'config/application.rb': RAILS_APPLICATION,
    'config/routes.rb': RAILS_ROUTES,
    'config/initializers/cors.rb': 'x = 1\n',
    'app/controllers/users_controller.rb': RAILS_CONTROLLER,
    'app/models/user.rb': 'class User < ApplicationRecord; end\n',
    'app/models/concerns/auditable.rb': 'module Auditable; end\n',
    'app/jobs/cleanup_job.rb': 'class CleanupJob; end\n',
    'lib/tasks/seed.rb': 'x = 1\n',
    'spec/user_spec.rb': 'RSpec.describe User do; end\n',
    'engines/billing/Gemfile': 'gem "rails"\n',
    'engines/billing/Gemfile.lock': '    rails (7.1.0)\n',
    'engines/billing/app/models/invoice.rb': 'class Invoice; end\n',
    'vendor/bundle/ruby/3.3.0/gems/dep/Gemfile': 'gem "dep"\n',
    'node_modules/dep/Gemfile': 'gem "dep"\n',
    'tmp/cache/Gemfile': 'gem "dep"\n',
    'log/Gemfile': 'gem "dep"\n',
    'log/development.rb': 'x = 1\n',
  });
  const startDir = process.cwd();
  try {
    sparse(root, 'config', 'app', 'lib', 'spec', 'engines', 'vendor', 'node_modules', 'tmp', 'log');
    const projectDir = fs.realpathSync(root);
    const result = inspectLegacyCorpusCheckout({ repoRoot: projectDir, adapterId: 'ruby-rails' });
    assert.equal(result.complete, true);

    // ripgrep anchors the scanner's `!tmp/**`-style excludes at its working directory: from any other
    // directory the Gemfiles below those trees are read as well.
    const fromElsewhere = runScan({ repoRoot: projectDir, terms: [] });
    assert.equal(fromElsewhere.adapter, 'ruby-rails');
    assert.equal(fromElsewhere.files_read.length, 15);
    assert.equal(result.expected_tracked_read_files, fromElsewhere.files_read.length);

    process.chdir(projectDir);
    const fromInside = runScan({ repoRoot: projectDir, terms: [] });
    assert.equal(fromInside.files_read.length, 11);
    assert.deepEqual(fromInside.files_read.filter((file) => !fromElsewhere.files_read.includes(file)), []);
    assert.ok(result.expected_tracked_read_files >= fromInside.files_read.length);
  } finally {
    process.chdir(startDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness re-bases a subdirectory project root and ignores sibling projects', () => {
  const root = makeRepo({
    'README.md': 'monorepo\n',
    'other/Gemfile': 'gem "sinatra"\n',
    'other/lib/sibling.rb': 'module Sibling; end\n',
    'server/Gemfile': 'gem "rails"\n',
    'server/config/application.rb': RAILS_APPLICATION,
    'server/config/routes.rb': RAILS_ROUTES,
    'server/app/controllers/users_controller.rb': RAILS_CONTROLLER,
    'server/lib/feature.rb': 'module Feature; end\n',
  });
  try {
    sparse(root, 'server/config', 'server/app/controllers');
    const project = path.join(root, 'server');
    let result = inspectLegacyCorpusCheckout({ repoRoot: project, adapterId: 'ruby-rails' });
    assert.equal(result.project_root, 'server');
    assert.equal(result.complete, false);
    assert.equal(result.expected_tracked_read_files, 5);
    assert.deepEqual(result.missing_paths, ['lib/feature.rb']);

    sparse(root, 'server/config', 'server/app/controllers', 'server/lib');
    result = inspectLegacyCorpusCheckout({ repoRoot: project, adapterId: 'ruby-rails' });
    assert.equal(result.complete, true);
    assert.equal(result.expected_tracked_read_files, 5);
    assert.equal(result.materialized_read_files, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness fails closed when the project directory is not tracked in HEAD', () => {
  const root = makeRepo({
    'Gemfile': 'gem "rails"\n',
    'config/application.rb': RAILS_APPLICATION,
  });
  try {
    sparse(root, 'config');
    const untracked = path.join(root, 'untracked');
    fs.mkdirSync(untracked);
    assert.throws(
      () => inspectLegacyCorpusCheckout({ repoRoot: untracked, adapterId: 'ruby-rails' }),
      /git ls-tree .* failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness assert helper rejects unsupported sparse adapters and returns complete results', () => {
  const unsupported = makeRepo({
    'package.json': '{"dependencies":{"express":"1.0.0"}}\n',
    'src/app.js': 'require("express")\n',
  });
  const supported = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
  });
  try {
    sparse(unsupported, 'src');
    assert.throws(
      () => assertLegacyCorpusCheckoutComplete({ repoRoot: unsupported, adapterId: 'javascript-express' }),
      (err) => err?.code === 'T11_CORPUS_CHECKOUT_INCOMPLETE' &&
        err.checkout.mode === 'sparse-unsupported-adapter' &&
        /cannot prove sparse checkout completeness/.test(err.message),
    );

    sparse(supported, 'app');
    const result = assertLegacyCorpusCheckoutComplete({ repoRoot: supported, adapterId: 'python-fastapi' });
    assert.equal(result.complete, true);
    assert.equal(result.mode, 'sparse-readset-verified');
  } finally {
    fs.rmSync(unsupported, { recursive: true, force: true });
    fs.rmSync(supported, { recursive: true, force: true });
  }
});

test('T11 corpus completeness reports the checked head, bounds missing paths and returns frozen results', () => {
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
    'extra/one.py': 'x = 1\n',
    'extra/two.py': 'x = 1\n',
  });
  try {
    const head = git(root, 'rev-parse', 'HEAD');
    assert.equal(inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' }).git_head, head);

    sparse(root, 'app');
    const full = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(full.git_head, head);
    assert.equal(full.missing_count, 2);
    assert.equal('missing_paths_truncated' in full, false);
    assert.equal(Object.isFrozen(full), true);
    assert.equal(Object.isFrozen(full.missing_paths), true);

    const bounded = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi', maxMissing: 1 });
    assert.equal(bounded.missing_count, 2);
    assert.deepEqual(bounded.missing_paths, ['extra/one.py']);
    assert.equal(bounded.missing_paths_truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness validates its arguments', () => {
  const root = makeRepo({
    'pyproject.toml': PYPROJECT,
    'app/main.py': FASTAPI_APP,
  });
  try {
    assert.throws(() => inspectLegacyCorpusCheckout(), TypeError);
    assert.throws(() => inspectLegacyCorpusCheckout({ adapterId: 'python-fastapi' }), TypeError);
    assert.throws(() => inspectLegacyCorpusCheckout({ repoRoot: '', adapterId: 'python-fastapi' }), TypeError);
    assert.throws(() => inspectLegacyCorpusCheckout({ repoRoot: root }), TypeError);
    for (const maxMissing of [0, 1001, 1.5, '5', Number.NaN]) {
      assert.throws(
        () => inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi', maxMissing }),
        RangeError,
        String(maxMissing),
      );
    }
    for (const maxMissing of [1, 1000]) {
      assert.equal(inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi', maxMissing }).complete, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T11 corpus completeness refuses a checkout whose git working tree is configured elsewhere', () => {
  const root = makeRepo({ 'pyproject.toml': PYPROJECT, 'app/main.py': FASTAPI_APP });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-elsewhere-'));
  try {
    // `git config` cannot write the setting through the repository it would break, so edit the file.
    execFileSync('git', ['config', '--file', path.join(root, '.git', 'config'), 'core.worktree', elsewhere]);
    assert.equal(fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')), fs.realpathSync(elsewhere));

    assert.throws(
      () => inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' }),
      /repoRoot escapes its git toplevel/,
    );
    assert.throws(
      () => assertLegacyCorpusCheckoutComplete({ repoRoot: root, adapterId: 'ruby-rails' }),
      /repoRoot escapes its git toplevel/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('T11 corpus completeness keeps whitespace at both ends of the checkout directory name', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-spaced-'));
  try {
    const root = makeRepoAt(path.join(parent, ' spaced checkout '), {
      'pyproject.toml': PYPROJECT,
      'app/main.py': FASTAPI_APP,
      'tests/test_api.py': 'def test_x(): pass\n',
    });

    const full = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(full.complete, true);
    assert.equal(full.mode, 'full-working-tree');
    assert.equal(full.project_root, '.');

    sparse(root, 'app');
    const partial = inspectLegacyCorpusCheckout({ repoRoot: root, adapterId: 'python-fastapi' });
    assert.equal(partial.mode, 'sparse-readset-verified');
    assert.deepEqual(partial.missing_paths, ['tests/test_api.py']);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
