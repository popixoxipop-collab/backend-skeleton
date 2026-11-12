import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyCrossRepositoryCi, runCli, ROLES, LIMITS } from './verify-cross-repo-ci.mjs';
import { MAX_INPUT_BYTES } from './verify-inventory-alignment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const bytes = (x) => Buffer.from(JSON.stringify(x));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const lockBytes = fs.readFileSync(path.join(HERE, 'baseline.lock.json'));
const observationBytes = fs.readFileSync(path.join(HERE, 'fixtures/observation.json'));
const actualInventoryBytes = fs.readFileSync(path.join(ROOT, 'release/next/compatibility-inventory.json'));
const lock = JSON.parse(lockBytes);
function fixture() {
  const inv = JSON.parse(actualInventoryBytes);
  for (const r of lock.repositories) {
    inv.coordination_baseline.repositories[r.role] = r.head_sha;
    const row = inv.repositories.find((x) => x.role === r.role);
    row.head_sha = row.coordination_sha = row.verification.ci_head_sha = r.head_sha;
  }
  return inv;
}
function inputs(inv = fixture()) {
  const inventoryBytes = Buffer.isBuffer(inv) ? inv : bytes(inv);
  return { lockBytes, observationBytes, inventoryBytes, expectedInventorySha256: sha(inventoryBytes) };
}
function goodRun(inv, role) {
  const r = inv.repositories.find((x) => x.role === role);
  return { id: r.verification.ci_run, repository: { full_name: r.repo }, event: 'push', head_branch: 'main',
    head_sha: r.verification.ci_head_sha, status: 'completed', conclusion: 'success' };
}
function transport(inv = fixture(), change = (_role, reply) => reply) {
  const calls = [];
  const fetchRun = async (request) => {
    calls.push(request);
    const role = inv.repositories.find((r) => r.repo === request.repo)?.role;
    return change(role, { status: 200, body: goodRun(inv, role) });
  };
  return { calls, fetchRun };
}
const codes = (r) => r.errors.map((e) => e.code);

test('strict cross-repository control checks all three exact heads without awarding MET', async () => {
  const inv = fixture(), i = inputs(inv), t = transport(inv), before = sha(i.inventoryBytes);
  const r = await verifyCrossRepositoryCi(i, t);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.online.checked_roles, ROLES);
  assert.deepEqual(r.online.not_checked_roles, []);
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.calls, ROLES.map((role) => {
    const row = inv.repositories.find((x) => x.role === role);
    return { repo: row.repo, runId: row.verification.ci_run };
  }));
  assert.equal(r.met_awarded, false); assert.equal(r.release_authorized, false);
  assert.deepEqual(r.limits, [...LIMITS]); assert.equal(sha(i.inventoryBytes), before);
});

test('a caller cannot select only bskel through an extra options field', async () => {
  const t = transport();
  const r = await verifyCrossRepositoryCi(inputs(), { ...t, roles: ['bskel'] });
  assert.equal(r.ok, true); assert.equal(t.calls.length, 3);
  assert.deepEqual(r.online.checked_roles, ROLES);
});

test('bskel-only success and private-repository 404s cannot become full success', async () => {
  const t = transport(fixture(), (role, reply) => role === 'bskel' ? reply : { status: 404, body: null });
  const r = await verifyCrossRepositoryCi(inputs(), t);
  assert.equal(r.ok, false); assert.equal(t.calls.length, 3);
  assert.equal(codes(r).filter((c) => c === 'ONLINE_RUN_NOT_FOUND').length, 2);
  assert.ok(codes(r).includes('CI_ALL_REPOSITORIES_NOT_VERIFIED'));
  assert.ok(r.errors.filter((e) => e.code === 'ONLINE_RUN_NOT_FOUND').every((e) => /private/i.test(e.hint)));
});

for (const role of ROLES) {
  test(`${role}: CI pinned to another head fails before any request`, async () => {
    const inv = fixture(); inv.repositories.find((x) => x.role === role).verification.ci_head_sha = 'f'.repeat(40);
    const t = transport(inv), r = await verifyCrossRepositoryCi(inputs(inv), t);
    assert.equal(r.ok, false); assert.ok(codes(r).includes('CI_BASELINE_HEAD_MISMATCH'));
    assert.equal(t.calls.length, 0); assert.equal(r.online, null);
  });
  test(`${role}: run identity, origin, state or head mismatch cannot pass`, async () => {
    for (const [field, value] of [['id', 1], ['event', 'pull_request'], ['head_branch', 'feature'],
      ['head_sha', '0'.repeat(40)], ['status', 'in_progress'], ['conclusion', 'failure'], ['repository', { full_name: 'untrusted/fork' }]]) {
      const t = transport(fixture(), (which, reply) => {
        if (which === role) reply.body[field] = value;
        return reply;
      });
      const r = await verifyCrossRepositoryCi(inputs(), t);
      assert.equal(r.ok, false, `${role} ${field}`);
      assert.ok(codes(r).includes('ONLINE_RUN_MISMATCH'), field); assert.equal(t.calls.length, 3);
    }
  });
  test(`${role}: unavailable, unauthorized and malformed responses fail closed`, async () => {
    for (const response of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 429 },
      { status: 500 }, { status: 302 }, { status: 200, body: null }, { status: 200, body: {} }]) {
      const t = transport(fixture(), (which, reply) => which === role ? response : reply);
      const r = await verifyCrossRepositoryCi(inputs(), t);
      assert.equal(r.ok, false, JSON.stringify(response)); assert.equal(t.calls.length, 3);
    }
  });
}

test('all-role pin preflight refuses missing/invalid run IDs without partial requests', async () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', null, {}, []]) {
    const inv = fixture(); inv.repositories.find((x) => x.role === 'beval').verification.ci_run = bad;
    const t = transport(inv), r = await verifyCrossRepositoryCi(inputs(inv), t);
    assert.equal(r.ok, false); assert.ok(codes(r).includes('CI_PIN_INVALID')); assert.equal(t.calls.length, 0);
  }
  const inv = fixture(); delete inv.repositories[0].verification;
  const t = transport(inv), r = await verifyCrossRepositoryCi(inputs(inv), t);
  assert.equal(r.ok, false); assert.equal(t.calls.length, 0);
});

test('alignment failure and wrong byte pin refuse every request', async () => {
  for (const i of [inputs(actualInventoryBytes), { ...inputs(), expectedInventorySha256: '0'.repeat(64) },
    { ...inputs(), expectedInventorySha256: undefined }, { ...inputs(), observationBytes: Buffer.from([0xff]) }]) {
    const t = transport(), r = await verifyCrossRepositoryCi(i, t);
    assert.equal(r.ok, false); assert.equal(t.calls.length, 0); assert.equal(r.online, null);
  }
});

test('duplicate JSON members cannot be normalized into an accepted inventory', async () => {
  const raw = bytes(fixture()).toString().replace('"schema":', '"schema":"ignored","schema":');
  const t = transport(), r = await verifyCrossRepositoryCi(inputs(Buffer.from(raw)), t);
  assert.equal(r.ok, false); assert.ok(codes(r).includes('INPUT_INVALID')); assert.equal(t.calls.length, 0);
});

test('accepted UTF-8 BOM bytes are decoded consistently after alignment', async () => {
  for (const asString of [false, true]) {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(fixture())]);
    const i = inputs(raw); if (asString) i.inventoryBytes = raw.toString('utf8');
    const t = transport(), r = await verifyCrossRepositoryCi(i, t);
    assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(t.calls.length, 3);
    assert.equal(r.alignment.inputs.inventory.sha256, sha(raw));
  }
});

test('oversized Buffer is rejected without allocating a second oversized copy', async () => {
  const i = inputs(); i.inventoryBytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
  const originalFrom = Buffer.from, t = transport();
  Buffer.from = function (value, ...rest) {
    assert.ok(!(Buffer.isBuffer(value) && value.length > MAX_INPUT_BYTES), 'oversized copy attempted');
    return originalFrom(value, ...rest);
  };
  try {
    const r = await verifyCrossRepositoryCi(i, t);
    assert.equal(r.ok, false); assert.ok(codes(r).includes('INPUT_INVALID')); assert.equal(t.calls.length, 0);
  } finally { Buffer.from = originalFrom; }
});

test('missing transport is an error, never an offline success', async () => {
  const r = await verifyCrossRepositoryCi(inputs());
  assert.equal(r.ok, false); assert.ok(codes(r).includes('CI_TRANSPORT_REQUIRED')); assert.equal(r.online, null);
});

test('transport exceptions remain failures and cannot echo a raw credential', async () => {
  const r = await verifyCrossRepositoryCi(inputs(), { fetchRun: async () => { throw new Error('Bearer secret-test-token'); } });
  assert.equal(r.ok, false); assert.equal(r.online.runs.length, 3);
  assert.ok(!JSON.stringify(r).includes('secret-test-token'));
});

test('mutation of caller Buffers during first request cannot change later role pins', async () => {
  const i = inputs(), inv = fixture(); i.lockBytes = Buffer.from(i.lockBytes); i.observationBytes = Buffer.from(i.observationBytes);
  const t = transport(inv, (_role, reply) => {
    i.inventoryBytes.fill(0); i.lockBytes.fill(0); i.observationBytes.fill(0); return reply;
  });
  const r = await verifyCrossRepositoryCi(i, t);
  assert.equal(r.ok, true); assert.equal(t.calls.length, 3);
  assert.equal(r.alignment.inputs.inventory.sha256, sha(bytes(inv)));
});

const capture = () => {
  let out = '', err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    out: () => out, err: () => err };
};
async function withFiles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00 CI 한글 '));
  const inv = fixture(), i = inputs(inv), paths = ['lock.json', 'observation.json', 'inventory.json'].map((n) => path.join(dir, n));
  [i.lockBytes, i.observationBytes, i.inventoryBytes].forEach((b, n) => fs.writeFileSync(paths[n], b));
  const args = ['--inventory-sha256', i.expectedInventorySha256, ...paths];
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(new URL(url).origin, 'https://api.github.com');
    const row = inv.repositories.find((r) => url === `https://api.github.com/repos/${r.repo}/actions/runs/${r.verification.ci_run}`);
    assert.ok(row, url);
    return new Response(JSON.stringify(goodRun(inv, row.role)), { status: 200 });
  };
  try { await fn({ dir, inv, i, paths, args, fetchImpl, calls: () => calls }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('CLI runs all three GETs using explicit paths with spaces and does not write inputs', async () => withFiles(async (f) => {
  const c = capture(), before = f.paths.map((p) => sha(fs.readFileSync(p)));
  const status = await runCli(f.args, { ...c, env: {}, fetchImpl: f.fetchImpl });
  assert.equal(status, 0, c.err()); assert.equal(f.calls(), 3); assert.equal(c.err(), '');
  assert.equal(JSON.parse(c.out()).online.checked_roles.length, 3);
  assert.deepEqual(f.paths.map((p) => sha(fs.readFileSync(p))), before);
}));

test('CLI refuses role selection, offline/override flags and missing arguments before transport', async () => withFiles(async (f) => {
  for (const args of [[], f.args.slice(1), [...f.args, '--online-roles', 'bskel'], [...f.args, '--offline'], [...f.args, '--allow-drift']]) {
    const c = capture(); assert.equal(await runCli(args, { ...c, env: {}, fetchImpl: f.fetchImpl }), 1);
    assert.equal(c.out(), ''); assert.equal(f.calls(), 0);
  }
}));

test('CLI rejects directories, missing paths and symlinks before transport', async () => withFiles(async (f) => {
  const targets = [f.dir, path.join(f.dir, 'missing')];
  if (fs.constants.O_NOFOLLOW !== undefined) {
    const link = path.join(f.dir, 'link'); fs.symlinkSync(f.paths[2], link); targets.push(link);
  }
  for (const target of targets) {
    const c = capture(); assert.equal(await runCli([...f.args.slice(0, 4), target], { ...c, env: {}, fetchImpl: f.fetchImpl }), 1);
    assert.equal(c.out(), ''); assert.equal(f.calls(), 0);
  }
}));

test('CLI preserves an actual mode-000 EACCES rather than inventing a mock permission proof', async (t) => withFiles(async (f) => {
  fs.chmodSync(f.paths[2], 0o000);
  try {
    try { fs.readFileSync(f.paths[2]); t.skip('runtime bypasses mode-000 permissions'); return; }
    catch (e) { assert.equal(e.code, 'EACCES'); }
    const c = capture(); assert.equal(await runCli(f.args, { ...c, env: {}, fetchImpl: f.fetchImpl }), 1);
    assert.match(c.err(), /EACCES/); assert.equal(c.out(), ''); assert.equal(f.calls(), 0);
  } finally { fs.chmodSync(f.paths[2], 0o600); }
}));

test('CLI redacts configured token when a malformed reply reflects it', async () => withFiles(async (f) => {
  const secret = 't00-mocked-token-not-a-real-secret', c = capture();
  const status = await runCli(f.args, { ...c, env: { GH_TOKEN: secret }, fetchImpl: async () =>
    new Response(JSON.stringify({ ...goodRun(f.inv, 'bskel'), head_sha: secret }), { status: 200 }) });
  assert.equal(status, 2); assert.ok(!c.out().includes(secret)); assert.ok(c.out().includes('[redacted]'));
}));
