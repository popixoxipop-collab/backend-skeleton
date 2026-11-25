import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindCandidate, bindGitCandidate } from './independent-approval-policy.mjs';

const baseRepo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't00-approval-policy-'));
const repoDir = path.join(scratch, 'main');
const index = path.join(scratch, 'candidate.index');
const publisherId = 42424242;
const repository = { id: 1334919554, full_name: 'popixoxipop-collab/backend-skeleton' };
const own = 'next/t03/t00-approval-fixture.mjs';
const content = 'throw new Error("candidate code must never run");\n';

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function git(dir, args, { input, candidate = false } = {}) {
  const env = { ...process.env, ...(candidate && { GIT_INDEX_FILE: index }) };
  return execFileSync('git', ['-C', dir, '-c', 'user.name=T00 Test',
    '-c', 'user.email=t00@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
  { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const base = git(baseRepo, ['rev-parse', 'HEAD']);
git(scratch, ['clone', '--quiet', '--shared', '--no-checkout', baseRepo, repoDir]);
git(repoDir, ['checkout', '--quiet', '--detach', base]);

function commit(changes, parent = base) {
  const opts = { candidate: true };
  git(repoDir, ['read-tree', parent], opts);
  for (const [file, body, mode = '100644'] of changes) {
    if (body === null) git(repoDir, ['update-index', '--force-remove', '--', file], opts);
    else {
      const blob = git(repoDir, ['hash-object', '-w', '--stdin'], { input: body });
      git(repoDir, ['update-index', '--add', '--cacheinfo', mode + ',' + blob + ',' + file], opts);
    }
  }
  const tree = git(repoDir, ['write-tree'], opts);
  const head = git(repoDir, ['commit-tree', tree, '-p', parent, '-m', 'Local T00 candidate fixture']);
  return { tree, head };
}

const owned = commit([[own, content]]);
const modified = commit([['next/t00/README.md', 'Changed regular T00-owned fixture\n']]);

function candidate({ head = owned.head, track = 'T03' } = {}) {
  return {
    mainSha: base, repoDir, publisherId,
    pull: {
      number: 10, state: 'open', draft: true, body: 'T00-Track: ' + track,
      user: { type: 'Bot', id: publisherId },
      base: { ref: 'main', sha: base, repo: repository },
      head: { ref: 'dot/t00-approval-fixture', sha: head, repo: repository },
    },
  };
}

test('binds a Bot-authored owned addition to the exact current protected base and tree', async () => {
  assert.deepEqual(await bindCandidate(candidate()), {
    number: 10, base, head: owned.head, tree: owned.tree, track: 'T03', paths: [own], publisherId,
  });
  assert.equal(fs.existsSync(path.join(repoDir, own)), false);
});

test('broker can bind exact Git objects before a PR exists without asserting a publisher identity', async () => {
  assert.deepEqual(await bindGitCandidate({ repoDir, mainSha: base, head: owned.head, track: 'T03' }), {
    base, head: owned.head, tree: owned.tree, track: 'T03', paths: [own],
  });
  assert.equal(fs.existsSync(path.join(repoDir, own)), false);
});

test('allows modifying an existing owned regular file without changing its mode', async () => {
  assert.deepEqual((await bindCandidate(candidate({ head: modified.head, track: 'T00' }))).paths,
    ['next/t00/README.md']);
});

test('rejects shared, mismatched, and App-proxied human identities', async () => {
  const input = candidate();
  input.publisherId = 261965176;
  input.pull.user.id = 261965176;
  await assert.rejects(bindCandidate(input), { code: 'PUBLISHER_NOT_ENROLLED' });

  const proxied = candidate();
  proxied.pull.user.type = 'User';
  proxied.pull.performed_via_github_app = { id: publisherId };
  await assert.rejects(bindCandidate(proxied), { code: 'PUBLISHER_IDENTITY' });

  const unmapped = candidate();
  unmapped.pull.user.id += 1;
  await assert.rejects(bindCandidate(unmapped), { code: 'PUBLISHER_IDENTITY' });
});

test('rejects stale bases, forks, non-Drafts and invalid branches', async () => {
  for (const mutate of [
    (pull) => { pull.base.sha = 'e'.repeat(40); },
    (pull) => { pull.head.repo = { ...repository, id: repository.id + 1 }; },
    (pull) => { pull.draft = false; },
    (pull) => { pull.state = 'closed'; },
    (pull) => { pull.head.ref = 'codex/not-dot'; },
    (pull) => { pull.head.ref = 'dot/invalid/../ref'; },
  ]) {
    const input = candidate();
    mutate(input.pull);
    await assert.rejects(bindCandidate(input), { code: 'STALE_OR_UNVERIFIED_PR' });
  }
});

test('rejects duplicate, malformed and exception-bearing directives', async () => {
  for (const [body, code] of [
    ['body without track', 'DIRECTIVE_REQUIRED'],
    ['T00-Track: T03\nT00-Track: T03', 'DIRECTIVE_REQUIRED'],
    ['T00-Track: T03\nT00-Receipt: allowed.json', 'DIRECTIVE_REQUIRED'],
    ['T00-Track: T3', 'DIRECTIVE_MALFORMED'],
  ]) {
    const input = candidate();
    input.pull.body = body;
    await assert.rejects(bindCandidate(input), { code });
  }
});

test('rejects a commit whose direct parent is not exact main', async () => {
  const { head } = commit([['next/t03/second-fixture.mjs', content]], owned.head);
  await assert.rejects(bindCandidate(candidate({ head })), { code: 'GIT_DIRECT_PARENT' });
});

test('rejects deletes, symlinks, and modifications changing file mode', async () => {
  for (const changes of [
    [['next/t00/README.md', null]],
    [['next/t00/fixture-link.mjs', 'README.md', '120000']],
    [['next/t00/README.md', content, '100755']],
  ]) {
    const { head } = commit(changes);
    await assert.rejects(bindCandidate(candidate({ head, track: 'T00' })), { code: 'GIT_STATUS_OR_MODE' });
  }
});

test('rejects owned authorization files, hidden Git controls and cross-track edits', async () => {
  for (const file of [
    '.github/workflows/fixture.yml',
    'next/t00/independent-approval-policy.mjs',
    'next/t00/run-independent-approval.mjs',
    'next/t00/dot-publisher-request.mjs',
    'next/t00/run-dot-publisher.mjs',
    'next/t00/verify-baseline.mjs',
    'scripts/run-next-nested-tests.mjs',
    'next/t00/baseline.lock.json',
    'next/t00/ownership.mjs',
    'next/t00/fixtures/plan-write-scopes.json',
    'next/t00/receipts/fixture.json',
    'next/t00/.gitattributes',
  ]) {
    const { head } = commit([[file, content]]);
    await assert.rejects(bindCandidate(candidate({ head, track: 'T00' })), { code: 'PROTECTED_PATH' });
  }
  const mixed = commit([[own, content], ['next/t04/mixed-track-fixture.mjs', content]]);
  await assert.rejects(bindCandidate(candidate({ head: mixed.head })), { code: 'PATH_OWNED_BY_OTHER_TRACK' });
});

test('rejects a dirty local policy checkout before reading its code or rules', async () => {
  const shadowed = path.join(repoDir, 'test/t00-untracked.test.mjs');
  fs.writeFileSync(shadowed, content);
  try {
    await assert.rejects(bindCandidate(candidate()), { code: 'POLICY_DIRTY' });
  } finally {
    fs.unlinkSync(shadowed);
  }
});
