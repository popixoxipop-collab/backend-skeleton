import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertLegacyCorpusCheckoutComplete,
  inspectLegacyCorpusCheckout,
} from '../../adapters/http-legacy-next/checkout-completeness.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-sparse-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't11@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T11 Fixture']);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

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
