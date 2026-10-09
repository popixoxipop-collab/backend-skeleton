import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied, createEnforcementGate, verifyAuditLog } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRealHost, freePort, makeScratch } from './enforcement-host.mjs';

// Real effects: real symbolic links, loopback sockets and child processes behind the gate. Nothing here
// leaves the machine: the host only connects to loopback addresses, and the "outside" directory is a
// scratch directory created for this file.

const posix = { skip: process.platform === 'win32' ? 'POSIX file system semantics are required' : false };
const scratch = makeScratch('bskel-gate-root-');
const outside = makeScratch('bskel-gate-outside-');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(() => {
  const root = scratch.root;
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(root, 'out', 'inner.txt'), 'inner');
  fs.writeFileSync(path.join(root, 'out', 'real.txt'), 'real');
  fs.writeFileSync(path.join(outside.root, 'secret.txt'), 'untouched');
  fs.symlinkSync(path.join(outside.root, 'secret.txt'), path.join(root, 'src', 'leak.txt'));
  fs.symlinkSync(outside.root, path.join(root, 'src', 'dirlink'));
  fs.symlinkSync('../out/inner.txt', path.join(root, 'src', 'to-out'));
  fs.symlinkSync('a.txt', path.join(root, 'src', 'inner-link'));
  fs.symlinkSync(path.join(outside.root, 'secret.txt'), path.join(root, 'out', 'link.txt'));
  fs.symlinkSync(path.join(outside.root, 'new-file.txt'), path.join(root, 'out', 'dangling'));
  fs.symlinkSync(outside.root, path.join(root, 'out', 'dirlink'));
  fs.symlinkSync('real.txt', path.join(root, 'out', 'alias'));
});
after(() => {
  scratch.cleanup();
  outside.cleanup();
});

function newGate({ manifestExtra = {}, dns = {}, mode = 'enforce' } = {}) {
  const host = createRealHost({ root: scratch.root, executables: { node: process.execPath, sh: '/bin/sh' }, dns });
  const manifest = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    read_roots: ['src'],
    write_roots: ['out'],
    process: { mode: 'argv-allowlist', executables: ['node'], max_children: 2 },
    ...manifestExtra,
  };
  return { gate: createEnforcementGate({ manifest, host, mode }), host };
}

async function denied(promise, reason, operation) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EnforcementDenied, `expected EnforcementDenied, got ${error?.name}: ${error?.message}`);
    assert.equal(error.reason, reason);
    if (operation) assert.equal(error.operation, operation);
    return true;
  });
}

// Settles a promise and closes any server it returns, so that a missing denial never leaves a socket open.
async function settle(promise) {
  try {
    const value = await promise;
    if (value && typeof value.close === 'function') await value.close();
    return { value };
  } catch (error) {
    return { error };
  }
}

const nodeEval = (code, ...args) => ['-e', code, ...args];

test('real symbolic links and traversal cannot leave the grant, and the outside files stay untouched', posix, async () => {
  const { gate, host } = newGate();
  await denied(gate.read('src/leak.txt'), 'PATH_ESCAPES_ROOT', 'read');
  await denied(gate.read('src/dirlink/secret.txt'), 'PATH_ESCAPES_ROOT', 'read');
  await denied(gate.read('src/to-out'), 'PATH_ESCAPES_GRANT', 'read');
  await denied(gate.write('out/link.txt', 'pwned'), 'PATH_ESCAPES_ROOT', 'write');
  await denied(gate.write('out/dangling', 'pwned'), 'PATH_ESCAPES_ROOT', 'write');
  await denied(gate.write('out/dirlink/x.txt', 'pwned'), 'PATH_ESCAPES_ROOT', 'write');
  assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(outside.root, 'new-file.txt')), false);
  assert.equal(fs.existsSync(path.join(outside.root, 'x.txt')), false);
  assert.equal(host.count('readFile') + host.count('writeFile'), 0);
  assert.equal((await gate.read('src/inner-link')).toString(), 'alpha');
  await gate.write('out/alias', 'rewritten');
  assert.equal(fs.readFileSync(path.join(scratch.root, 'out', 'real.txt'), 'utf8'), 'rewritten');
  assert.deepEqual(host.calls.filter((c) => c.method === 'readFile' || c.method === 'writeFile').map((c) => [c.method, c.rel]), [['readFile', 'src/a.txt'], ['writeFile', 'out/real.txt']]);
  const before = host.calls.length;
  for (const lexical of ['src/../out/inner.txt', path.join(outside.root, 'secret.txt'), '../secret.txt']) await denied(gate.read(lexical), 'NOT_GRANTED', 'read');
  assert.equal(host.calls.length, before);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('the host opens files without following a final symbolic link, so a late swap is refused', posix, async () => {
  const host = createRealHost({ root: scratch.root });
  await assert.rejects(host.readFile('src/leak.txt'), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
  await assert.rejects(host.writeFile('out/link.txt', 'pwned'), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
  assert.equal(fs.readFileSync(path.join(outside.root, 'secret.txt'), 'utf8'), 'untouched');
  assert.equal((await host.readFile('src/a.txt')).toString(), 'alpha');
});

test('real loopback sockets: a granted connection works; ungranted ports, resolved loopback names and wide listeners never open', posix, async () => {
  const connections = { count: 0 };
  const canary = net.createServer((socket) => { connections.count += 1; socket.on('error', () => {}); socket.destroy(); });
  await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const canaryPort = canary.address().port;
  const granted = await freePort();
  const { gate, host } = newGate({
    manifestExtra: {
      network: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [granted] }, { host: 'granted.example.com', ports: [canaryPort] }] },
      listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [granted] }] },
    },
    dns: { 'granted.example.com': [['127.0.0.1']] },
  });
  try {
    const server = await gate.listen('127.0.0.1', granted);
    assert.equal(server.port, granted);
    assert.deepEqual(await gate.connect('127.0.0.1', granted), { connected: true, address: '127.0.0.1', port: granted });
    await server.close();
    await denied(gate.connect('127.0.0.1', canaryPort), 'NOT_GRANTED', 'connect');
    await denied(gate.connect('granted.example.com', canaryPort), 'RESOLVES_TO_NON_PUBLIC_ADDRESS', 'connect');
    assert.equal((await settle(gate.listen('0.0.0.0', granted))).error?.reason, 'NOT_GRANTED');
    assert.equal((await settle(gate.listen('127.0.0.1', canaryPort))).error?.reason, 'NOT_GRANTED');
    await sleep(100);
    assert.equal(connections.count, 0);
    assert.deepEqual(host.calls.filter((c) => c.method === 'connect').map((c) => c.port), [granted]);
  } finally {
    await new Promise((resolve) => canary.close(resolve));
  }
});

test('the real host survives many rapid connect and close rounds against a server that writes at once: no reset escapes', posix, async () => {
  const host = createRealHost({ root: scratch.root });
  const port = await freePort();
  const server = await host.listen({ host: '127.0.0.1', port });
  try {
    assert.equal(server.port, port);
    for (let round = 0; round < 100; round += 1) {
      assert.deepEqual(await host.connect({ host: '127.0.0.1', address: '127.0.0.1', port }), { connected: true, address: '127.0.0.1', port });
    }
  } finally {
    await server.close();
  }
  await assert.rejects(host.connect({ host: '127.0.0.1', address: '127.0.0.1', port }), (error) => error.code === 'ECONNREFUSED');
});

test('a child receives only the approved environment: an ambient NODE_OPTIONS preload does not run (with a positive control)', posix, async () => {
  const marker = path.join(scratch.root, 'out', 'preload-ran.txt');
  const preload = path.join(scratch.root, 'src', 'preload.cjs');
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const options = `--require ${preload}`;
  const control = spawnSync(process.execPath, nodeEval('0'), { env: { NODE_OPTIONS: options }, encoding: 'utf8' });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(fs.existsSync(marker), true, 'positive control: the preload must run when NODE_OPTIONS is inherited');
  fs.rmSync(marker);
  const { gate } = newGate({ manifestExtra: { environment: { allow: ['BSKEL_ALLOWED'] } } });
  const ambient = { BSKEL_ALLOWED: 'yes', BSKEL_SECRET: 'no', NODE_OPTIONS: options, PATH: '/tmp/ambient-bin', HOME: '/tmp/ambient-home' };
  const result = await gate.spawn('node', nodeEval('process.stdout.write(JSON.stringify(process.env))'), ambient);
  assert.equal(result.exit_code, 0, result.stderr.toString());
  const seen = JSON.parse(result.stdout.toString());
  assert.equal(seen.BSKEL_ALLOWED, 'yes');
  assert.equal('BSKEL_SECRET' in seen, false);
  assert.equal('NODE_OPTIONS' in seen, false);
  assert.notEqual(seen.PATH, '/tmp/ambient-bin');
  assert.notEqual(seen.HOME, '/tmp/ambient-home');
  assert.equal(fs.existsSync(marker), false);
  const audit = JSON.stringify(gate.audit());
  assert.equal(audit.includes('ambient-bin') || audit.includes(options), false);
});

test('PATH hijack: the pinned executable runs even when the ambient PATH starts with a look-alike', posix, async () => {
  const hijackDir = path.join(scratch.root, 'src', 'hijack');
  const marker = path.join(scratch.root, 'out', 'hijacked.txt');
  fs.mkdirSync(hijackDir, { recursive: true });
  fs.writeFileSync(path.join(hijackDir, 'node'), `#!/bin/sh\necho hijacked > ${marker}\n`, { mode: 0o755 });
  for (const grantPath of [false, true]) {
    const { gate } = newGate({ manifestExtra: { environment: { allow: grantPath ? ['PATH'] : [] } } });
    const result = await gate.spawn('node', nodeEval('process.stdout.write(process.execPath)'), { PATH: `${hijackDir}:/usr/bin:/bin` });
    assert.equal(result.exit_code, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), process.execPath);
    assert.equal(fs.existsSync(marker), false, `hijack ran (PATH granted: ${grantPath})`);
  }
});

test('argv reaches the child without a shell, and unlisted executables never start', posix, async () => {
  const { gate } = newGate();
  const args = ['a b', ';touch pwned', '$(touch pwned)', '`touch pwned`', '*', '--', '-x'];
  const result = await gate.spawn('node', nodeEval('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args), {});
  assert.equal(result.exit_code, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), args);
  const marker = path.join(scratch.root, 'pwned');
  for (const name of ['sh', '/bin/sh', 'node;touch pwned', '../node']) await denied(gate.spawn(name, ['-c', 'touch pwned'], {}), 'NOT_GRANTED', 'spawn');
  assert.equal(fs.existsSync(marker), false);
});

test('the wall limit kills a real child that outlives it and nothing is left running', posix, async () => {
  const { gate } = newGate({ manifestExtra: { limits: { wall_ms: 400 } } });
  const started = Date.now();
  const result = await gate.spawn('node', nodeEval('setTimeout(() => {}, 6000)'), {});
  assert.equal(result.timed_out, true);
  assert.equal(result.killed_for, 'wall_ms');
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 5500, 'the child must not run to its natural end');
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  assert.equal(gate.audit().at(-1).timed_out, true);
});

test('the stdout cap cuts a real flood, flags it and stops the child', posix, async () => {
  const { gate } = newGate({ manifestExtra: { limits: { stdout_bytes: 2048 } } });
  const result = await gate.spawn('node', nodeEval("process.stdout.write('x'.repeat(300000))"), {});
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stdout.length, 2048);
  assert.equal(result.killed_for, 'stdout_bytes');
  assert.equal(result.stderr_truncated, false);
});

test('max_children holds for real concurrent children and capacity returns when one exits', posix, async () => {
  const { gate } = newGate({ manifestExtra: { process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 } } });
  const first = gate.spawn('node', nodeEval('setTimeout(() => {}, 1500)'), {});
  const second = await settle(gate.spawn('node', nodeEval('0'), {}));
  assert.equal(second.error?.reason, 'PROCESS_CAPACITY_EXCEEDED');
  assert.equal((await first).exit_code, 0);
  assert.equal((await gate.spawn('node', nodeEval('process.exit(3)'), {})).exit_code, 3);
});

test('the audit of a real run round-trips through JSON, verifies, and the report claims no attestation', posix, async () => {
  const { gate } = newGate({ manifestExtra: { environment: { allow: ['LANG'] } } });
  await gate.read('src/a.txt');
  await denied(gate.read('src/leak.txt'), 'PATH_ESCAPES_ROOT', 'read');
  await gate.spawn('node', nodeEval('0'), { LANG: 'C', TOKEN: 'ambient-token-value' });
  const report = gate.report();
  const copy = JSON.parse(JSON.stringify(gate.audit()));
  assert.deepEqual(verifyAuditLog(copy, { manifestDigest: gate.permissionDigest, expectedEntries: copy.length, expectedHeadSha256: report.audit.head_sha256 }), { ok: true, errors: [] });
  assert.equal(JSON.stringify(copy).includes('ambient-token-value'), false);
  assert.equal(report.attestation.present, false);
  assert.equal(report.os_sandbox, false);
  assert.equal(report.audit.entries, copy.length);
});
