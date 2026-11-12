import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvalTarget, parseDirectives, verifyApproval, verifyOnline } from '../next/t00/verify-path-exception-online.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function fixture(extraPath = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't00-path-online-'));
  run(root, 'init', '-q');
  run(root, 'config', 'user.name', 'T00 test');
  run(root, 'config', 'user.email', 't00@example.invalid');
  fs.mkdirSync(path.join(root, 'next/t15'), { recursive: true });
  fs.writeFileSync(path.join(root, 'next/t15/cli.mjs'), 'base\n');
  run(root, 'add', '.'); run(root, 'commit', '-qm', 'base');
  const base = run(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'next/t15/cli.mjs'), 'head\n');
  if (extraPath) fs.writeFileSync(path.join(root, extraPath), 'change\n');
  run(root, 'add', '.'); run(root, 'commit', '-qm', 'head');
  const head = run(root, 'rev-parse', 'HEAD');
  return { root, base, head };
}
function pull(base, head, body) {
  return { state: 'open', body, base: { sha: base, repo: { full_name: 'popixoxipop-collab/backend-decoder' } },
    head: { sha: head, repo: { full_name: 'popixoxipop-collab/backend-decoder' } } };
}
function receipt(base, head) {
  return { schema: 'bskel.t00-path-exception/2', repository: 'becoder', track: 'T15', base, head,
    approval: { login: 'popixoxipop-collab', url: 'https://github.com/popixoxipop-collab/backend-skeleton/issues/357#issuecomment-1234' },
    exceptions: [{ path: 'README.md', code: 'PATH_UNOWNED', reason: 'test exception' }] };
}
function commentFor(r) {
  const body = `Coordinator approval\nT00-Path-Exception: ${approvalTarget(r)}\n`;
  r.approval.body_sha256 = hash(body);
  return { id: 1234, body, user: { login: 'popixoxipop-collab' },
    issue_url: 'https://api.github.com/repos/popixoxipop-collab/backend-skeleton/issues/357' };
}
function writeReceipt(dir, r) {
  fs.mkdirSync(dir, { recursive: true });
  const bytes = `${JSON.stringify(r)}\n`;
  fs.writeFileSync(path.join(dir, 'test.json'), bytes);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'bskel.t00-receipt-index/1', receipts: [{ file: 'test.json', sha256: hash(bytes) }] }));
}

test('PR directives reject duplicate and malformed instructions', () => {
  assert.deepEqual(parseDirectives('T00-Track: T15\nT00-Receipt: test.json'), { track: 'T15', receipt: 'test.json' });
  assert.throws(() => parseDirectives('T00-Track: T15\nT00-Track: T16'), /duplicate/);
  assert.throws(() => parseDirectives('T00-Track: T15\nT00-Receipt: ..\/forged.json'), /invalid/);
});

test('comment authentication rejects forged actor, edited body, wrong issue and marker', () => {
  const r = receipt('a'.repeat(40), 'b'.repeat(40));
  const c = commentFor(r);
  assert.deepEqual(verifyApproval(r, c), []);
  for (const bad of [{ ...c, user: { login: 'forged' } }, { ...c, body: `${c.body}edited` },
    { ...c, issue_url: c.issue_url.replace('/357', '/358') }, { ...c, body: 'no marker' }]) {
    assert.equal(verifyApproval(r, bad)[0].code, 'APPROVAL_AUTH');
  }
});

test('online gate passes owned-only diff and rejects stale head or API failure', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const call = (p) => ({ repository: 'becoder', pullNumber: 99, expectedHead: f.head, repoDir: f.root,
    requestJson: async () => p });
  assert.deepEqual(await verifyOnline(call(pull(f.base, f.head, 'T00-Track: T15'))), []);
  assert.equal((await verifyOnline(call(pull(f.base, 'f'.repeat(40), 'T00-Track: T15'))))[0].code, 'PR_STALE');
  assert.equal((await verifyOnline({ ...call(), requestJson: async () => { throw Error('offline'); } }))[0].code, 'VERIFY_UNAVAILABLE');
});

test('online gate uses trusted index and exact Git diff, never a candidate receipt', async (t) => {
  const f = fixture('README.md'); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dir = path.join(f.root, 'trusted');
  const r = receipt(f.base, f.head);
  const c = commentFor(r);
  writeReceipt(dir, r);
  const options = { repository: 'becoder', pullNumber: 99, expectedHead: f.head, repoDir: f.root, receiptDir: dir,
    requestJson: async (url) => url.includes('/pulls/') ? pull(f.base, f.head, 'T00-Track: T15\nT00-Receipt: test.json') : c };
  assert.deepEqual(await verifyOnline(options), []);
  fs.writeFileSync(path.join(dir, 'test.json'), '{}');
  assert.equal((await verifyOnline(options))[0].code, 'RECEIPT_SHA256');
  writeReceipt(dir, { ...r, head: 'a'.repeat(40) });
  assert.equal((await verifyOnline(options))[0].code, 'RECEIPT_TARGET');
  writeReceipt(dir, r);
  const forged = { ...c, user: { login: 'other' } };
  assert.equal((await verifyOnline({ ...options, requestJson: async (url) => url.includes('/pulls/') ? pull(f.base, f.head, 'T00-Track: T15\nT00-Receipt: test.json') : forged }))[0].code, 'APPROVAL_AUTH');
});
