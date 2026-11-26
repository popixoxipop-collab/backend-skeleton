// T00-03 opt-in rehearsal: lease rotation against exact Git results and an externally supplied snapshot pin.
// No production ledger, network, clock, or permissions are modified.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEDGER_SCHEMA, sealLedger } from './lease-ledger.mjs';
import { baseModel, twoCommits, writeScaffold } from './make-ownership-report.mjs';

const cli = fileURLToPath(new URL('./check-lease.mjs', import.meta.url));
const at = '2026-10-09T01:00:00Z';

test('the pinned lease snapshot fences a completed Git result after holder rotation', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't00-lease-rotation-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  writeScaffold(repo, baseModel());
  const env = { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: repo };
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t00', '-c', 'user.email=t00@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`, ...args], { env, encoding: 'utf8' }).trim();
  twoCommits(repo, { after: (write) => write('next/t00/first.mjs', 'export const first = true;\n') });
  const oldBase = git('rev-parse', 'HEAD^');
  const firstHead = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'next/t00/second.mjs'), 'export const second = true;\n');
  git('add', 'next/t00/second.mjs');
  git('commit', '-qm', 'second leased result');
  const secondHead = git('rev-parse', 'HEAD');
  const old = {
    claim_id: 'rotation-1', track: 'T00', repository: 'bskel', worker: 'worker-one', worktree: 'agents/one',
    base_sha: oldBase, path_scopes: ['next/t00/**'], issued_at: '2026-10-09T00:00:00Z',
    expires_at: '2026-10-09T02:00:00Z', fencing_token: 1, state: 'ACTIVE',
  };
  const next = {
    ...old, claim_id: 'rotation-2', worker: 'worker-two', worktree: 'agents/two', base_sha: firstHead,
    issued_at: '2026-10-09T00:45:00Z', fencing_token: 2,
  };
  function snapshot(name, counter, claims) {
    const sealed = sealLedger({ schema: LEDGER_SCHEMA, counters: { T00: counter }, claims });
    assert.equal(sealed.problem, undefined, sealed.problem);
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify(sealed.ledger));
    return { file, pin: sealed.ledger.head_digest };
  }
  const prior = snapshot('prior.json', 1, [old]);
  const active = snapshot('active.json', 2, [{ ...old, state: 'RELEASED' }, next]);
  assert.notEqual(prior.pin, active.pin);

  function check({ ledger, pin, claim, head, base = claim.base_sha, exit, codes }) {
    const r = spawnSync(process.execPath, [cli, '--repo-dir', repo, 'result', '--ledger', ledger.file,
      '--at', at, '--head-digest', pin, '--claim', claim.claim_id, '--worker', claim.worker,
      '--worktree', claim.worktree, '--token', String(claim.fencing_token), '--base', base, '--head', head],
    { env, encoding: 'utf8', timeout: 8000 });
    assert.ifError(r.error);
    assert.equal(r.signal, null);
    assert.equal(r.status, exit, r.stdout + r.stderr);
    assert.equal(r.stderr, '');
    if (exit === 0) assert.match(r.stdout, /stays inside its lease/);
    else assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.split(' ')[1]).sort(), [...codes].sort());
  }

  await t.test('previous holder was accepted against the then-current pin', () =>
    check({ ledger: prior, pin: prior.pin, claim: old, head: firstHead, exit: 0 }));
  await t.test('the unchanged previous result is fenced against the successor snapshot', () =>
    check({ ledger: active, pin: active.pin, claim: old, head: firstHead, exit: 2,
      codes: ['RESULT_CLAIM_NOT_ACTIVE', 'RESULT_STALE_FENCING_TOKEN'] }));
  await t.test('the previous snapshot is refused against the new independent pin', () =>
    check({ ledger: prior, pin: active.pin, claim: old, head: firstHead, exit: 2, codes: ['LEDGER_HEAD_PIN_MISMATCH'] }));
  await t.test('the new holder cannot reuse the first result base', () =>
    check({ ledger: active, pin: active.pin, claim: next, base: oldBase, head: firstHead, exit: 2,
      codes: ['RESULT_BASE_SHA_MISMATCH'] }));
  await t.test('the new holder can submit the next exact Git result', () =>
    check({ ledger: active, pin: active.pin, claim: next, head: secondHead, exit: 0 }));
});
