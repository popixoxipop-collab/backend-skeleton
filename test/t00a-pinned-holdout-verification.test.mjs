import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTypeScriptExpressRoot, scanTypeScriptExpress } from '../scanners/adapters/typescript-express.mjs';

const HOLDOUT_REPO = 'https://github.com/syedammar/rest-api-nodejs-typescript.git';
const HOLDOUT_SHA = '798546fc0e89365ac601be15c857c589916205d4';

test('T00-A exact pinned T19 TypeScript Express holdout remains 7/7 on merged main', { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t00a-t19-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', HOLDOUT_REPO]);
    execFileSync('git', ['-C', root, 'fetch', '-q', '--depth', '1', 'origin', HOLDOUT_SHA]);
    execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', 'FETCH_HEAD']);
    const actualSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(actualSha, HOLDOUT_SHA, 'holdout commit must be exact');

    const projectRoot = detectTypeScriptExpressRoot(root);
    assert.ok(projectRoot, 'exact holdout must detect as typescript-express');

    const result = scanTypeScriptExpress(root, projectRoot);
    const routes = result.modules
      .flatMap((m) => m.controllers)
      .flatMap((c) => c.endpoints)
      .map((e) => `${e.verb} ${e.path}`)
      .sort();

    assert.deepEqual(routes, [
      'DELETE /api/users/:id',
      'GET /api/users/:id',
      'GET /api/users/protected',
      'GET /main/healthcheck',
      'POST /api/auth/login',
      'POST /api/auth/register',
      'PUT /api/users/:id',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
