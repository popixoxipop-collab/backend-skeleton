import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBaseline } from './verify-baseline.mjs';

const LOCK = {
  repositories: [{
    repo: 'example/repo', default_branch: 'main', head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    required_artifacts: [{ path: 'package.json', git_blob_sha: 'blob-a' }],
  }],
};
const GOOD = {
  repositories: [{
    repo: 'example/repo', default_branch: 'main', head_sha: LOCK.repositories[0].head_sha, dirty: false,
    artifacts: [{ path: 'package.json', git_blob_sha: 'blob-a' }],
  }],
};

test('accepts exact locked observation', () => {
  assert.deepEqual(verifyBaseline(LOCK, GOOD), { ok: true, errors: [] });
});

test('rejects dirty checkout', () => {
  const x = structuredClone(GOOD); x.repositories[0].dirty = true;
  assert.equal(verifyBaseline(LOCK, x).errors[0].code, 'DIRTY_CHECKOUT');
});

test('rejects missing artifact', () => {
  const x = structuredClone(GOOD); x.repositories[0].artifacts = [];
  assert.equal(verifyBaseline(LOCK, x).errors[0].code, 'MISSING_ARTIFACT');
});

test('rejects remote default-branch mismatch', () => {
  const x = structuredClone(GOOD); x.repositories[0].default_branch = 'develop';
  assert.equal(verifyBaseline(LOCK, x).errors[0].code, 'DEFAULT_BRANCH_MISMATCH');
});

test('rejects unknown dirty state instead of assuming clean', () => {
  const x = structuredClone(GOOD); delete x.repositories[0].dirty;
  assert.equal(verifyBaseline(LOCK, x).errors[0].code, 'DIRTY_STATE_UNKNOWN');
});
