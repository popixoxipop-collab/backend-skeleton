import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deriveLock, verifyBaseline, verifyLockRecord } from './verify-baseline-strict-v1.mjs';
import { verifyInventoryAlignment, MAX_INPUT_BYTES, LIMITS } from './verify-inventory-alignment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CLI = path.join(HERE, 'verify-inventory-alignment.mjs');
const bytes = (value) => Buffer.from(JSON.stringify(value));
const digest = (b) => createHash('sha256').update(b).digest('hex');
const lockBytes = fs.readFileSync(path.join(HERE, 'baseline.lock.json'));
const observationBytes = fs.readFileSync(path.join(HERE, 'fixtures/observation.json'));
const originalInventory = fs.readFileSync(path.join(ROOT, 'release/next/compatibility-inventory.json'));
const lock = JSON.parse(lockBytes);
const observation = JSON.parse(observationBytes);
const inventory = () => {
  const proposed = JSON.parse(originalInventory);
  for (const r of lock.repositories) {
    proposed.coordination_baseline.repositories[r.role] = r.head_sha;
    const row = proposed.repositories.find((x) => x.role === r.role);
    row.head_sha = row.coordination_sha = r.head_sha;
  }
  return proposed;
};
const check = (proposed = inventory(), overrides = {}) => {
  const inventoryBytes = Buffer.isBuffer(proposed) ? proposed : bytes(proposed);
  return verifyInventoryAlignment({ lockBytes, observationBytes, inventoryBytes,
    expectedInventorySha256: digest(inventoryBytes), ...overrides });
};
const has = (report, code) => report.errors.some((e) => e.code === code);
const rejects = (report, code) => {
  assert.equal(report.ok, false);
  assert.deepEqual(report.aligned_repositories, []);
  assert.equal(has(report, code), true, JSON.stringify(report.errors));
};

test('historical lock/observation remain valid while actual inventory is rejected for every role', () => {
  assert.equal(verifyBaseline(lock, observation, { remote: true }).ok, true);
  assert.equal(verifyLockRecord(lock, observation).ok, true);
  const report = check(originalInventory);
  rejects(report, 'INVENTORY_HEAD_MISMATCH');
  assert.deepEqual([...new Set(report.errors.map((e) => e.role))].sort(), ['becoder', 'beval', 'bskel']);
  assert.equal(report.errors.length, 9);
});

test('aligned fixture succeeds without modifying historical evidence or requiring successful CI', () => {
  const l = digest(lockBytes), o = digest(observationBytes), i = digest(originalInventory);
  assert.ok(lock.repositories.some((r) => r.ci_on_exact_head.all_success === false));
  const report = check();
  assert.equal(report.ok, true);
  assert.equal(report.aligned_repositories.length, 3);
  assert.equal(report.inputs.lock.sha256, l);
  assert.equal(report.inputs.observation.sha256, o);
  assert.deepEqual(report.limits, [...LIMITS]);
  assert.deepEqual([digest(lockBytes), digest(observationBytes), digest(originalInventory)], [l, o, i]);
});

test('later inventory carrier is permitted without binding it to the old inventory source blob', () => {
  const proposed = inventory();
  assert.notEqual(digest(bytes(proposed)), digest(originalInventory));
  assert.equal(check(proposed).ok, true);
  assert.notEqual(proposed.coordination_baseline.repositories.bskel,
    lock.inventory_pins.pins.find((p) => p.role === 'bskel').pinned_sha);
});

test('expected inventory pin is mandatory, exact lowercase hex and not derived from an input field', () => {
  for (const pin of [undefined, null, '', 1, '0'.repeat(63), 'A'.repeat(64), {}, ['0'.repeat(64)]]) {
    rejects(check(inventory(), { expectedInventorySha256: pin }), 'INVENTORY_PIN_INVALID');
  }
  rejects(check(inventory(), { expectedInventorySha256: '0'.repeat(64) }), 'INVENTORY_HASH_MISMATCH');
});

test('byte pin rejects whitespace-only edits, not merely changed JSON values', () => {
  const b = bytes(inventory());
  rejects(check(Buffer.concat([b, Buffer.from('\n')]), { expectedInventorySha256: digest(b) }), 'INVENTORY_HASH_MISMATCH');
});

for (const role of ['bskel', 'becoder', 'beval']) {
  for (const field of ['coordination_pin', 'head_sha', 'coordination_sha']) {
    test(`${role} ${field} mismatch is refused independently`, () => {
      const proposed = inventory();
      if (field === 'coordination_pin') proposed.coordination_baseline.repositories[role] = '0'.repeat(40);
      else proposed.repositories.find((r) => r.role === role)[field] = '0'.repeat(40);
      rejects(check(proposed), 'INVENTORY_HEAD_MISMATCH');
    });
  }
}

test('malformed or coerced head values never equal a commit', () => {
  for (const value of [null, 42, {}, [], [lock.repositories[0].head_sha], 'A'.repeat(40), '0'.repeat(39)]) {
    const proposed = inventory();
    proposed.coordination_baseline.repositories.bskel = value;
    rejects(check(proposed), 'INVENTORY_HEAD_INVALID');
  }
});

test('missing, added or substituted coordination role keys are refused', () => {
  for (const mutate of [
    (p) => { delete p.bskel; }, (p) => { p.extra = p.bskel; },
    (p) => { p.BSKEL = p.bskel; delete p.bskel; },
    (p) => { Object.defineProperty(p, '__proto__', { value: p.bskel, enumerable: true }); },
  ]) {
    const proposed = inventory(); mutate(proposed.coordination_baseline.repositories);
    rejects(check(proposed), 'INVENTORY_REPOSITORY_SET_MISMATCH');
  }
});

test('missing, added, duplicate, null or primitive repository rows are refused', () => {
  for (const mutate of [
    (rows) => rows.pop(), (rows) => rows.push(rows[0]), (rows) => { rows[1] = rows[0]; },
    (rows) => { rows[0] = null; }, (rows) => { rows[0] = 'bskel'; },
    (rows) => { rows[0].role = { toString: null, valueOf: null }; },
  ]) {
    const proposed = inventory(); mutate(proposed.repositories);
    rejects(check(proposed), 'INVENTORY_REPOSITORY_SET_MISMATCH');
  }
});

test('duplicate decoded JSON keys are rejected in every input, including escaped aliases', () => {
  const proposed = inventory();
  const raw = JSON.stringify(proposed).replace('"bskel":', '"bskel":"' + '0'.repeat(40) + '","bskel":');
  rejects(check(Buffer.from(raw)), 'INPUT_INVALID');
  const escaped = JSON.stringify(proposed).replace('"bskel":', '"bskel":"' + '0'.repeat(40) + '","\\u0062skel":');
  rejects(check(Buffer.from(escaped)), 'INPUT_INVALID');
  for (const name of ['lockBytes', 'observationBytes']) {
    const original = name === 'lockBytes' ? lockBytes : observationBytes;
    const raw = original.toString().replace('"schema":', '"schema":"ignored","schema":');
    rejects(check(proposed, { [name]: Buffer.from(raw) }), 'INPUT_INVALID');
  }
});

test('unambiguous parser handles escaped strings, empty objects, arrays and bounds nesting', () => {
  const proposed = inventory();
  proposed.extra = { escaped: '\\"\n\u0000', empty: {}, array: [[], null, true, false, 12, -1.5e7] };
  assert.equal(check(proposed).ok, true);
  let deep = {};
  for (let i = 0; i < 130; i += 1) deep = { nested: deep };
  proposed.extra = deep;
  rejects(check(proposed), 'INPUT_INVALID');
});

test('repository identity and branch cannot be redirected', () => {
  for (const [field, value] of [['repo', 'other/repo'], ['default_branch', 'other'], ['repo', null]]) {
    const proposed = inventory(); proposed.repositories[0][field] = value;
    rejects(check(proposed), 'INVENTORY_REPOSITORY_IDENTITY_MISMATCH');
  }
});

test('unsupported inventory schema is rejected without interpreting its fields', () => {
  for (const value of [null, [], {}, { ...inventory(), schema: 'bskel.scale-release-compatibility/99' }]) {
    rejects(check(value), 'INVENTORY_SCHEMA_INVALID');
  }
});

test('missing or unknown coordination acceptance states are rejected', () => {
  for (const value of [undefined, null, false, 'true', 1]) {
    const proposed = inventory(); proposed.coordination_baseline.accepted = value;
    rejects(check(proposed), 'INVENTORY_BASELINE_STATE_INVALID');
  }
  for (const value of [undefined, null, 'UNKNOWN', 'ERROR', 'accepted']) {
    const proposed = inventory(); proposed.coordination_baseline.state = value;
    rejects(check(proposed), 'INVENTORY_BASELINE_STATE_INVALID');
  }
});

test('coherent-looking inventory cannot hide an invalid historical lock or observation', () => {
  const l = structuredClone(lock); l.capture.observation_sha256 = '0'.repeat(64);
  rejects(check(inventory(), { lockBytes: bytes(l) }), 'OBSERVATION_HASH_MISMATCH');
  const o = structuredClone(observation); o.repositories[0].head_sha = '0'.repeat(40);
  rejects(check(inventory(), { observationBytes: bytes(o) }), 'HEAD_SHA_MISMATCH');
});

test('malformed baseline JSON values fail closed without throwing', () => {
  for (const value of [null, [], {}, { repositories: [null] }, { repositories: [{}] }]) {
    const result = check(inventory(), { lockBytes: bytes(value) });
    assert.equal(result.ok, false); assert.deepEqual(result.aligned_repositories, []);
  }
});

test('coherently rederived unknown dirty state is rejected instead of treated as a remote observation', () => {
  const o = structuredClone(observation); o.repositories[0].dirty = 'ERROR';
  const l = deriveLock(o, lock.limits);
  const report = check(inventory(), { lockBytes: bytes(l), observationBytes: bytes(o) });
  assert.equal(report.ok, false);
  assert.deepEqual(report.aligned_repositories, []);
  assert.ok(report.errors.some((e) => ['BASELINE_STATE_INVALID', 'DIRTY_STATE_UNKNOWN', 'MALFORMED_RECORD'].includes(e.code)));
});

test('historical source metadata is checked separately from the later inventory carrier', () => {
  for (const [key, value] of [['repo', 'other/repo'], ['path', 'other.json'], ['ref', '0'.repeat(40)], ['pin_field', 'other']]) {
    const o = structuredClone(observation); o.inventory.source[key] = value;
    const l = deriveLock(o, lock.limits);
    const report = check(inventory(), { lockBytes: bytes(l), observationBytes: bytes(o) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.aligned_repositories, []);
    assert.ok(report.errors.some((e) => ['BASELINE_SOURCE_INVALID', 'MALFORMED_RECORD'].includes(e.code)));
  }
});

test('non-JSON, invalid UTF-8, oversized bytes and nonbyte inputs fail closed', () => {
  for (const value of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(MAX_INPUT_BYTES + 1), {}, null]) {
    rejects(check(inventory(), { observationBytes: value }), 'INPUT_INVALID');
  }
});

function withFiles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00 alignment 한글 '));
  const files = ['lock.json', 'observation.json', 'inventory.json'].map((n) => path.join(dir, n));
  const proposed = bytes(inventory());
  [lockBytes, observationBytes, proposed].forEach((b, i) => fs.writeFileSync(files[i], b));
  const invoke = (args = [], paths = files) => spawnSync(process.execPath,
    [CLI, '--inventory-sha256', digest(proposed), ...paths, ...args], { encoding: 'utf8', timeout: 10000 });
  try { fn({ dir, files, proposed, invoke }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('actual CLI succeeds in paths with spaces/non-ASCII and emits byte-bound JSON only', () => withFiles(({ invoke, files }) => {
  const before = files.map((p) => digest(fs.readFileSync(p)));
  const r = invoke(); assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout); assert.equal(report.ok, true); assert.equal(report.aligned_repositories.length, 3);
  assert.deepEqual(files.map((p) => digest(fs.readFileSync(p))), before);
}));

test('actual CLI mismatch exits 2, no implicit re-pin or success', () => withFiles(({ invoke, files }) => {
  fs.writeFileSync(files[2], originalInventory);
  const r = invoke(); assert.equal(r.status, 2); rejects(JSON.parse(r.stdout), 'INVENTORY_HASH_MISMATCH');
}));

test('actual CLI rejects unknown flags, missing pin, unreadable inputs and directories with exit 1', () => withFiles(({ invoke, files, dir }) => {
  for (const r of [invoke(['--allow-drift']), invoke([], [files[0], files[1], path.join(dir, 'absent')]),
    invoke([], [files[0], files[1], dir]), spawnSync(process.execPath, [CLI, ...files], { encoding: 'utf8' })]) {
    assert.equal(r.status, 1); assert.equal(r.stdout, '');
  }
}));

test('actual CLI refuses symlinks and oversized files', () => withFiles(({ invoke, files, dir }) => {
  if (fs.constants.O_NOFOLLOW !== undefined) {
    const alias = path.join(dir, 'alias.json'); fs.symlinkSync(files[2], alias);
    assert.equal(invoke([], [files[0], files[1], alias]).status, 1);
  }
  fs.writeFileSync(files[2], Buffer.alloc(MAX_INPUT_BYTES + 1));
  assert.equal(invoke().status, 1);
}));

test('actual CLI rejects a FIFO with no writer without blocking', { skip: process.platform === 'win32' }, () => withFiles(({ files, dir, proposed }) => {
  const fifo = path.join(dir, 'no-writer.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 2000 });
  assert.equal(made.status, 0, made.stderr);
  const r = spawnSync(process.execPath, [CLI, '--inventory-sha256', digest(proposed), files[0], files[1], fifo],
    { encoding: 'utf8', timeout: 2000 });
  assert.equal(r.error, undefined); assert.equal(r.signal, null);
  assert.equal(r.status, 1); assert.equal(r.stdout, '');
}));

test('actual non-root unreadable input exits 1 with EACCES',
  { skip: process.platform === 'win32' || !process.getuid || process.getuid() === 0 }, () => withFiles(({ files, invoke }) => {
    fs.chmodSync(files[2], 0);
    try {
      const r = invoke(); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /EACCES/);
    } finally { fs.chmodSync(files[2], 0o600); }
  }));
