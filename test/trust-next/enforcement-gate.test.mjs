import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied, classifyAddress, createEnforcementGate } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// Policy-level tests of the enforcement gate against an in-memory recording host. Real file, socket and
// process effects are in enforcement-gate-real.test.mjs; limits, secrets and the audit chain are in
// enforcement-gate-limits.test.mjs.

const minimal = () => ({ schema: PERMISSION_MANIFEST_SCHEMA });
const manifest = (extra = {}) => ({
  schema: PERMISSION_MANIFEST_SCHEMA,
  read_roots: ['src'],
  write_roots: ['out'],
  network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443] }] },
  listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [18080] }] },
  process: { mode: 'argv-allowlist', executables: ['node'], max_children: 2 },
  environment: { allow: ['LANG'] },
  secret_refs: ['provider-token'],
  devices: { mode: 'allowlist', allow: ['gpu'] },
  ...extra,
});
const net = (...allow) => ({ network: { mode: 'allowlist', allow } });

async function denied(promise, reason, operation) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EnforcementDenied, `expected EnforcementDenied, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, 'PERMISSION_DENIED');
    assert.equal(error.reason, reason);
    if (operation) assert.equal(error.operation, operation);
    return true;
  });
}

test('a default manifest denies every operation and the host is never called', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: minimal(), host });
  assert.equal(gate.mode, 'enforce');
  await denied(gate.read('src/a.txt'), 'NOT_GRANTED', 'read');
  await denied(gate.write('out/r.json', 'x'), 'NOT_GRANTED', 'write');
  await denied(gate.connect('api.example.com', 443), 'NOT_GRANTED', 'connect');
  await denied(gate.listen('127.0.0.1', 18080), 'NOT_GRANTED', 'listen');
  await denied(gate.spawn('node', ['-v'], {}), 'NOT_GRANTED', 'spawn');
  await denied(gate.readEnv('LANG', { LANG: 'C' }), 'NOT_GRANTED', 'env');
  await denied(gate.useSecret('provider-token', () => 1), 'NOT_GRANTED', 'secret');
  await denied(gate.useDevice('gpu'), 'NOT_GRANTED', 'device');
  assert.deepEqual(host.calls, []);
  const audit = gate.audit();
  assert.equal(audit.length, 8);
  assert.ok(audit.every((entry) => entry.phase === 'decision' && entry.decision === 'deny' && entry.enforced === true && entry.mode === 'enforce'));
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('granted file operations reach the host and are audited as a decision plus an outcome', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  assert.equal((await gate.read('src/a.txt')).toString(), 'alpha');
  await gate.write('out/r.json', '{"ok":true}');
  assert.equal(host.files['out/r.json'], '{"ok":true}');
  assert.deepEqual(host.calls.map((call) => call.method), ['realpath', 'readFile', 'realpath', 'writeFile']);
  const audit = gate.audit();
  assert.deepEqual(audit.map((e) => `${e.phase}:${e.operation}:${e.decision ?? (e.ok ? 'ok' : 'failed')}`), ['decision:read:allow', 'outcome:read:ok', 'decision:write:allow', 'outcome:write:ok']);
  assert.equal(audit[1].decision_seq, 0);
  assert.equal(audit[1].bytes, 5);
  assert.equal(audit[0].target.canonical, 'src/a.txt');
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('the canonical path decides: a link out of the grant is refused and a link inside is used as canonical', async () => {
  const host = createRecordingHost({
    files: { 'src/a.txt': 'alpha', 'secret/key': 'K' },
    canonical: { 'src/link': 'secret/key', 'src/up': null, 'src/inner': 'src/a.txt', 'out/link': 'out/real.json', 'out/escape': 'secret/key' },
  });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await denied(gate.read('src/link'), 'PATH_ESCAPES_GRANT', 'read');
  await denied(gate.read('src/up'), 'PATH_ESCAPES_ROOT', 'read');
  await denied(gate.write('out/escape', 'x'), 'PATH_ESCAPES_GRANT', 'write');
  assert.equal(host.count('readFile') + host.count('writeFile'), 0);
  assert.equal((await gate.read('src/inner')).toString(), 'alpha');
  await gate.write('out/link', 'x');
  assert.deepEqual(host.calls.filter((c) => c.method === 'readFile' || c.method === 'writeFile').map((c) => [c.method, c.rel]), [['readFile', 'src/a.txt'], ['writeFile', 'out/real.json']]);
  assert.equal(host.calls.find((c) => c.method === 'realpath' && c.rel === 'out/link').forWrite, true);
  for (const answer of [() => { throw new Error('boom'); }, () => 42, () => '', () => 'a\0b']) {
    host.realpath = async () => answer();
    await denied(gate.read('src/a.txt'), 'PATH_UNRESOLVABLE', 'read');
  }
  assert.equal(host.count('readFile'), 1);
});

test('lexical traversal, sibling prefixes, absolute paths and malformed paths never reach the host', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  for (const path of ['src/../secret', '/etc/passwd', '../src/a.txt', 'src2/a.txt', 'secret/x', 'out/r.json']) await denied(gate.read(path), 'NOT_GRANTED', 'read');
  for (const path of ['src/../out/r.json', '/tmp/x', 'src/a.txt']) await denied(gate.write(path, 'x'), 'NOT_GRANTED', 'write');
  for (const path of ['', 'src/\0x', 5, null, undefined, 'a'.repeat(5000)]) await denied(gate.read(path), 'INVALID_ARGUMENT', 'read');
  await denied(gate.write('out/r.json', 5), 'INVALID_ARGUMENT', 'write');
  await denied(gate.invoke('read', 'src/a.txt'), 'INVALID_ARGUMENT', 'read');
  assert.deepEqual(host.calls, []);
});

test('network access is an exact host and port allowlist and names are lowercased', async () => {
  const host = createRecordingHost({ dns: { 'api.example.com': [['93.184.216.34']] } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await denied(gate.connect('api.example.com', 80), 'NOT_GRANTED', 'connect');
  await denied(gate.connect('evil-api.example.com', 443), 'NOT_GRANTED', 'connect');
  await denied(gate.connect('example.com', 443), 'NOT_GRANTED', 'connect');
  assert.equal(host.count('resolve') + host.count('connect'), 0);
  await gate.connect('API.Example.COM', 443);
  assert.deepEqual(host.calls.filter((c) => c.method === 'connect'), [{ method: 'connect', host: 'api.example.com', address: '93.184.216.34', port: 443 }]);
  for (const [name, port] of [[5, 443], ['', 443], ['api.example.com', '443'], ['api.example.com', 0], ['api.example.com', 70000], ['api.example.com', 4.5]]) {
    await denied(gate.connect(name, port), 'INVALID_ARGUMENT', 'connect');
  }
});

test('DNS rebinding: the name is resolved once and the checked address is the address that is connected', async () => {
  const host = createRecordingHost({ dns: { 'api.example.com': [['93.184.216.34'], ['127.0.0.1']] } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await gate.connect('api.example.com', 443);
  assert.equal(host.count('resolve'), 1);
  assert.equal(host.calls.find((c) => c.method === 'connect').address, '93.184.216.34');
  const audit = gate.audit();
  assert.equal(audit[0].target.address, '93.184.216.34');
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('a granted name that resolves to a non-public address is refused unless that address is itself granted', async () => {
  const answers = [['127.0.0.1'], ['10.0.0.5'], ['172.16.9.9'], ['192.168.0.10'], ['169.254.169.254'], ['0.0.0.0'], ['::1'], ['::ffff:127.0.0.1'], ['fe80::1'], ['fd00::1'], ['93.184.216.34', '10.0.0.5']];
  const dns = {};
  const allow = answers.map((answer, index) => {
    dns[`case${index}.example.com`] = [answer];
    return { host: `case${index}.example.com`, ports: [443] };
  });
  const host = createRecordingHost({ dns });
  const gate = createEnforcementGate({ manifest: manifest(net(...allow)), host });
  for (let index = 0; index < answers.length; index += 1) await denied(gate.connect(`case${index}.example.com`, 443), 'RESOLVES_TO_NON_PUBLIC_ADDRESS', 'connect');
  assert.equal(host.count('resolve'), answers.length);
  assert.equal(host.count('connect'), 0);
  assert.equal(gate.audit().at(-1).target.address_classes.includes('private'), true);
  const grantedHost = createRecordingHost({ dns: { 'internal.example.com': [['127.0.0.1']] } });
  const granted = createEnforcementGate({ manifest: manifest(net({ host: 'internal.example.com', ports: [443] }, { host: '127.0.0.1', ports: [443] })), host: grantedHost });
  await granted.connect('internal.example.com', 443);
  assert.equal(grantedHost.calls.find((c) => c.method === 'connect').address, '127.0.0.1');
});

test('resolution failures and malformed answers are denials, and literal addresses are not resolved', async () => {
  const host = createRecordingHost({ dns: { 'empty.example.com': [[]], 'bad.example.com': [[5]] } });
  const allow = ['empty', 'bad', 'missing'].map((name) => ({ host: `${name}.example.com`, ports: [443] }));
  const gate = createEnforcementGate({ manifest: manifest(net(...allow, { host: '203.0.113.9', ports: [443] }, { host: '1.2.3.999', ports: [443] })), host });
  for (const name of ['empty', 'bad', 'missing']) await denied(gate.connect(`${name}.example.com`, 443), 'RESOLVE_FAILED', 'connect');
  await denied(gate.connect('1.2.3.999', 443), 'INVALID_ADDRESS_LITERAL', 'connect');
  const before = host.count('resolve');
  await gate.connect('203.0.113.9', 443);
  assert.equal(host.count('resolve'), before);
  assert.equal(host.calls.at(-1).address, '203.0.113.9');
  const noResolver = createRecordingHost({ dns: {} });
  delete noResolver.resolve;
  await denied(createEnforcementGate({ manifest: manifest(), host: noResolver }).connect('api.example.com', 443), 'HOST_CAPABILITY_MISSING', 'connect');
});

test('address classification covers IPv4, IPv6, mapped, translated and malformed forms', () => {
  const table = [
    ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['192.168.1.1', 'private'], ['100.64.0.1', 'private'], ['169.254.169.254', 'link-local'],
    ['0.0.0.0', 'unspecified'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'], ['192.0.2.1', 'reserved'],
    ['::1', 'loopback'], ['::', 'unspecified'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'public'],
    ['fe80::1', 'link-local'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['ff02::1', 'multicast'], ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'], ['64:ff9b::7f00:1', 'loopback'], ['2002:7f00:1::', 'loopback'],
    ['010.0.0.1', 'invalid'], ['256.1.1.1', 'invalid'], ['1.2.3', 'invalid'], ['not-an-ip', 'invalid'], ['1::2::3', 'invalid'], [42, 'invalid'], [undefined, 'invalid'],
  ];
  for (const [address, expected] of table) assert.equal(classifyAddress(address), expected, String(address));
});

test('listening is limited to the granted loopback host and port', async () => {
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await gate.listen('127.0.0.1', 18080);
  assert.deepEqual(host.calls, [{ method: 'listen', host: '127.0.0.1', port: 18080 }]);
  for (const [name, port] of [['127.0.0.1', 18081], ['0.0.0.0', 18080], ['localhost', 18080], ['::1', 18080]]) await denied(gate.listen(name, port), 'NOT_GRANTED', 'listen');
  await denied(gate.listen('127.0.0.1', -1), 'INVALID_ARGUMENT', 'listen');
  assert.equal(host.count('listen'), 1);
});

test('spawn passes argv without a shell, the pinned executable path and only the approved environment', async () => {
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest(), host });
  const hostile = { LANG: 'C', SECRET_TOKEN: 's3cr3t-token', NODE_OPTIONS: '--require /tmp/evil.js', PATH: '/tmp/evil' };
  const result = await gate.spawn('node', ['-e', '1; rm -rf /'], hostile);
  assert.equal(result.exit_code, 0);
  const call = host.calls.find((c) => c.method === 'spawn');
  assert.equal(call.file, '/pinned/bin/node');
  assert.equal(call.executable, 'node');
  assert.deepEqual(call.args, ['-e', '1; rm -rf /']);
  assert.deepEqual(call.env, { LANG: 'C' });
  assert.deepEqual(gate.audit()[0].target.env_names, ['LANG']);
  assert.equal(JSON.stringify(gate.audit()).includes('s3cr3t-token'), false);
  assert.equal(JSON.stringify(gate.audit()).includes('/tmp/evil'), false);
});

test('only allowlisted executable basenames spawn; shells, paths and shell fragments are refused', async () => {
  const host = createRecordingHost({ executables: { node: '/pinned/bin/node', sh: '/bin/sh', python3: '/pinned/bin/python3' } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  for (const name of ['sh', '/bin/sh', 'node;curl', '../node', './node', 'node -e 1', 'python3']) await denied(gate.spawn(name, [], {}), 'NOT_GRANTED', 'spawn');
  for (const name of ['', 5, 'a\0b']) await denied(gate.spawn(name, [], {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', 'ls', {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', [1], {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', ['a\0b'], {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', [], 'LANG=C'), 'INVALID_ARGUMENT', 'spawn');
  assert.equal(host.count('spawn') + host.count('resolveExecutable'), 0);
});

test('an executable the host cannot pin is refused instead of being looked up on the ambient PATH', async () => {
  const host = createRecordingHost({ executables: {} });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await denied(gate.spawn('node', [], { PATH: '/tmp/evil' }), 'EXECUTABLE_NOT_RESOLVED', 'spawn');
  assert.equal(host.count('spawn'), 0);
});

test('shadow mode records would-deny and passes file, network and process requests through, but never env, secret, device or unknown requests', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: minimal(), host, mode: 'shadow' });
  assert.equal((await gate.read('src/a.txt')).toString(), 'alpha');
  await gate.write('out/r.json', 'x');
  await gate.connect('api.example.com', 443);
  await gate.listen('127.0.0.1', 18080);
  assert.equal((await gate.spawn('node', ['-v'], {})).exit_code, 0);
  await denied(gate.readEnv('LANG', { LANG: 'C' }), 'NOT_GRANTED', 'env');
  await denied(gate.useSecret('provider-token', () => 1), 'NOT_GRANTED', 'secret');
  await denied(gate.useDevice('gpu'), 'NOT_GRANTED', 'device');
  await denied(gate.invoke('exec', {}), 'UNKNOWN_OPERATION');
  const wouldDeny = gate.audit().filter((entry) => entry.decision === 'would-deny');
  assert.deepEqual(wouldDeny.map((entry) => entry.operation), ['read', 'write', 'connect', 'listen', 'spawn']);
  assert.ok(wouldDeny.every((entry) => entry.enforced === false && entry.mode === 'shadow' && entry.reason === 'NOT_GRANTED'));
  assert.ok(gate.audit().filter((entry) => entry.decision === 'deny').every((entry) => entry.enforced === true));
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  const report = gate.report();
  assert.equal(report.enforcing, false);
  assert.equal(report.dimensions.fs_read, 'observed');
  assert.equal(report.dimensions.environment, 'mediated');
});

test('unknown operations are refused in both modes and never forwarded', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const host = createRecordingHost();
    const gate = createEnforcementGate({ manifest: manifest(), host, mode });
    for (const operation of ['exec', 'chmod', '__proto__', 'constructor', 'read ', 'READ', '', 5, undefined]) await denied(gate.invoke(operation, { path: 'src/a.txt' }), 'UNKNOWN_OPERATION');
    assert.deepEqual(host.calls, []);
  }
});

test('a host that lacks a capability makes that operation fail closed', async () => {
  const gate = createEnforcementGate({ manifest: manifest(), host: {} });
  await denied(gate.read('src/a.txt'), 'HOST_CAPABILITY_MISSING', 'read');
  await denied(gate.write('out/r.json', 'x'), 'HOST_CAPABILITY_MISSING', 'write');
  await denied(gate.connect('api.example.com', 443), 'HOST_CAPABILITY_MISSING', 'connect');
  await denied(gate.spawn('node', [], {}), 'HOST_CAPABILITY_MISSING', 'spawn');
  await denied(gate.useSecret('provider-token', () => 1), 'HOST_CAPABILITY_MISSING', 'secret');
  await denied(gate.useDevice('gpu'), 'HOST_CAPABILITY_MISSING', 'device');
  assert.equal(gate.report().dimensions.fs_read, 'unavailable');
});
