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

test('address classification covers IPv4, IPv6, mapped, translated and malformed forms (a wrapped public IPv4 address is reserved)', () => {
  const table = [
    ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['192.168.1.1', 'private'], ['100.64.0.1', 'private'], ['169.254.169.254', 'link-local'],
    ['0.0.0.0', 'unspecified'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'], ['192.0.2.1', 'reserved'],
    ['192.88.99.1', 'reserved'], ['192.88.98.255', 'public'], ['192.88.100.0', 'public'], ['192.175.48.1', 'public'],
    ['::1', 'loopback'], ['::', 'unspecified'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'reserved'],
    ['fe80::1', 'link-local'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['ff02::1', 'multicast'], ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'], ['64:ff9b::7f00:1', 'loopback'], ['2002:7f00:1::', 'loopback'],
    ['010.0.0.1', 'invalid'], ['256.1.1.1', 'invalid'], ['1.2.3', 'invalid'], ['not-an-ip', 'invalid'], ['1::2::3', 'invalid'], [42, 'invalid'], [undefined, 'invalid'],
  ];
  for (const [address, expected] of table) assert.equal(classifyAddress(address), expected, String(address));
});

// One address per block that is not global unicast, with the class the gate reports for it. Every block is a row of the IANA
// IPv6 Special-Purpose Address Registry except ff00::/8, which is the multicast block of the IPv6 Address Space registry.
const IPV6_NOT_PUBLIC = [
  ['::/128 unspecified address', '::', 'unspecified'],
  ['::1/128 loopback address', '::1', 'loopback'],
  ['::ffff:0:0/96 IPv4-mapped with a private IPv4 inside: the wrapped address names the class', '::ffff:10.0.0.1', 'private'],
  ['::ffff:0:0/96 IPv4-mapped with a public IPv4 inside: still not global unicast', '::ffff:8.8.8.8', 'reserved'],
  ['64:ff9b::/96 NAT64 with a private IPv4 inside: the wrapped address names the class', '64:ff9b::a00:1', 'private'],
  ['64:ff9b::/96 NAT64 with a public IPv4 inside: still not global unicast', '64:ff9b::808:808', 'reserved'],
  ['64:ff9b:1::/48 local-use NAT64', '64:ff9b:1::1', 'reserved'],
  ['100::/64 discard-only', '100::1', 'reserved'],
  ['2001::/23 IETF protocol assignments, first address', '2001::1', 'reserved'],
  ['2001::/23 benchmarking 2001:2::/48', '2001:2::1', 'reserved'],
  ['2001::/23 last address', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:db8::/32 documentation', '2001:db8::1', 'reserved'],
  ['2002::/16 6to4 with a public IPv4 inside: still not global by itself', '2002:808:808::', 'reserved'],
  ['2002::/16 6to4 with a private IPv4 inside', '2002:a00:1::', 'private'],
  ['3fff::/20 documentation, first address', '3fff::1', 'reserved'],
  ['3fff::/20 last address', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['3ffe::/16 IANA reserved (the returned 6bone block)', '3ffe::1', 'reserved'],
  ['3f00::/9 IANA reserved', '3f00::1', 'reserved'],
  ['2d00::/8 IANA reserved, the first block after the last allocation', '2d00::1', 'reserved'],
  ['2000::/16 below the first allocation', '2000::1', 'reserved'],
  ['2001:6000::/19 gap between 2001:5000::/20 and 2001:8000::/19', '2001:6000::1', 'reserved'],
  ['2a20::/12 unallocated, between 2a10::/12 and 2c00::/12', '2a20::1', 'reserved'],
  ['::/8 IPv4-compatible form is not an allocation', '::808:808', 'reserved'],
  ['4000::/2 outside 2000::/3', '4000::1', 'reserved'],
  ['5f00::/16 segment routing SIDs', '5f00::1', 'reserved'],
  ['fc00::/7 unique local', 'fc00::1', 'private'],
  ['fe80::/10 link-local', 'fe80::1', 'link-local'],
  ['ff00::/8 multicast', 'ff02::1', 'multicast'],
];
// Global unicast in blocks IANA has ALLOCATED to a registry: published resolver addresses, the first address after each
// special-purpose block that sits inside the allocated space, and the last address of the last allocation.
const IPV6_PUBLIC = [
  ['Cloudflare public DNS', '2606:4700:4700::1111'],
  ['Google public DNS', '2001:4860:4860::8888'],
  ['Quad9', '2620:fe::fe'],
  ['first address after 2001::/23 (APNIC)', '2001:200::1'],
  ['next /32 after 2001:db8::/32 (inside APNIC 2001:c00::/23)', '2001:db9::1'],
  ['last address of 2001:5000::/20', '2001:5fff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['first address of 2001:8000::/19, after the gap', '2001:8000::1'],
  ['AS112 direct delegation 2620:4f:8000::/48, a globally reachable special-purpose row inside ARIN space', '2620:4f:8000::1'],
  ['last address of the last allocation 2c00::/12 (AFRINIC)', '2c0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
];

test('IPv6 is public only inside an allocated unicast block and outside every special-purpose block: one address per block', () => {
  for (const [block, address, expected] of IPV6_NOT_PUBLIC) assert.equal(classifyAddress(address), expected, `${block}: ${address}`);
  for (const [name, address] of IPV6_PUBLIC) assert.equal(classifyAddress(address), 'public', `${name}: ${address}`);
});

test('6to4, IPv4-mapped and NAT64 addresses are never public, whatever IPv4 address they wrap; a non-public wrapped address names the class', () => {
  for (const [inner, expected] of [['808:808', 'reserved'], ['a00:1', 'private'], ['7f00:1', 'loopback'], ['c0a8:1', 'private'], ['a9fe:a9fe', 'link-local'], ['c058:6301', 'reserved']]) {
    assert.equal(classifyAddress(`2002:${inner}::`), expected, `2002:${inner}::`);
    assert.equal(classifyAddress(`::ffff:${inner}`), expected, `::ffff:${inner}`);
    assert.equal(classifyAddress(`64:ff9b::${inner}`), expected, `64:ff9b::${inner}`);
  }
});

test('a granted name that resolves to a special-purpose, reserved or unallocated address is refused, and granting that exact literal allows it', async () => {
  const cases = ['2001::1', '2001:2::1', '2001:db8::1', '2002:808:808::', '3fff::1', '5f00::1', '100::1', '64:ff9b:1::1',
    '3f00::1', '3ffe::1', '2d00::1', '2001:6000::1', '::808:808', '192.88.99.1'];
  const dns = {};
  const allow = cases.map((address, index) => {
    dns[`v6-${index}.example.com`] = [[address]];
    return { host: `v6-${index}.example.com`, ports: [443] };
  });
  const host = createRecordingHost({ dns });
  const gate = createEnforcementGate({ manifest: manifest(net(...allow)), host });
  for (let index = 0; index < cases.length; index += 1) await denied(gate.connect(`v6-${index}.example.com`, 443), 'RESOLVES_TO_NON_PUBLIC_ADDRESS', 'connect');
  assert.equal(host.count('resolve'), cases.length);
  assert.equal(host.count('connect'), 0);
  assert.deepEqual(gate.audit().map((entry) => entry.target.address_classes), cases.map(() => ['reserved']));
  const grantedHost = createRecordingHost({ dns: { 'bench.example.com': [['2001:2::1']] } });
  const granted = createEnforcementGate({ manifest: manifest(net({ host: 'bench.example.com', ports: [443] }, { host: '[2001:2::1]', ports: [443] })), host: grantedHost });
  await granted.connect('bench.example.com', 443);
  assert.equal(grantedHost.calls.find((call) => call.method === 'connect').address, '2001:2::1');
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

test('an IPv6 listener host reaches the host as the bare literal while the grant and the audit target keep the bracketed spelling', async () => {
  const host = createRecordingHost();
  const listen = { mode: 'allowlist', allow: [{ host: '[::1]', ports: [18080] }, { host: 'localhost', ports: [18081] }] };
  const gate = createEnforcementGate({ manifest: manifest({ listen }), host });
  await gate.listen('[::1]', 18080);
  await gate.listen('localhost', 18081);
  assert.deepEqual(host.calls, [{ method: 'listen', host: '::1', port: 18080 }, { method: 'listen', host: 'localhost', port: 18081 }]);
  assert.deepEqual(gate.audit()[0].target, { host: '[::1]', port: 18080 });
  // The bare literal is not the granted spelling, and no other spelling or port widens the grant.
  for (const [name, port] of [['::1', 18080], ['[::1]', 18081], ['[::2]', 18080], ['[0:0:0:0:0:0:0:1]', 18080]]) await denied(gate.listen(name, port), 'NOT_GRANTED', 'listen');
  assert.equal(host.count('listen'), 2);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  // Shadow mode forwards an ungranted request as well, with the same spelling rule; bracketed text that is not an IPv6 literal is left alone.
  const shadowHost = createRecordingHost();
  const shadow = createEnforcementGate({ manifest: minimal(), host: shadowHost, mode: 'shadow' });
  await shadow.listen('[::1]', 18080);
  await shadow.listen('[not-a-literal]', 18080);
  assert.deepEqual(shadowHost.calls, [{ method: 'listen', host: '::1', port: 18080 }, { method: 'listen', host: '[not-a-literal]', port: 18080 }]);
  assert.deepEqual(shadow.audit().filter((entry) => entry.phase === 'decision').map((entry) => [entry.decision, entry.target.host]), [['would-deny', '[::1]'], ['would-deny', '[not-a-literal]']]);
  assert.deepEqual(shadow.verifyAudit(), { ok: true, errors: [] });
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
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' }, dns: { 'api.example.com': [['93.184.216.34']] } });
  const gate = createEnforcementGate({ manifest: minimal(), host, mode: 'shadow' });
  assert.equal((await gate.read('src/a.txt')).toString(), 'alpha');
  await gate.write('out/r.json', 'x');
  await gate.connect('api.example.com', 443);
  assert.deepEqual(host.calls.find((call) => call.method === 'connect'), { method: 'connect', host: 'api.example.com', address: '93.184.216.34', port: 443 });
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

const layout = (gate) => gate.audit().map((entry) => `${entry.phase}:${entry.operation}:${entry.decision ?? (entry.ok ? 'ok' : 'failed')}`);

test('shadow connect to a name the manifest does not grant resolves it once and connects to that pinned address', async () => {
  const host = createRecordingHost({ dns: { 'api.example.com': [['93.184.216.34'], ['127.0.0.1']] } });
  const gate = createEnforcementGate({ manifest: minimal(), host, mode: 'shadow' });
  assert.deepEqual(await gate.connect('API.example.com', 443), { connected: true });
  assert.equal(host.count('resolve'), 1);
  assert.deepEqual(host.calls.filter((call) => call.method === 'connect'), [{ method: 'connect', host: 'api.example.com', address: '93.184.216.34', port: 443 }]);
  assert.deepEqual(layout(gate), ['decision:connect:would-deny', 'outcome:connect:ok']);
  assert.equal(gate.audit()[1].address, '93.184.216.34');
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('shadow connect with no address to pass through is recorded as not executed: the host is not called and the outcome is a failure', async () => {
  const cases = [
    { label: 'an unresolvable ungranted name', name: 'gone.example.com', reason: 'RESOLVE_FAILED' },
    { label: 'an empty answer', name: 'empty.example.com', reason: 'RESOLVE_FAILED', dns: { 'empty.example.com': [[]] } },
    { label: 'a malformed answer', name: 'bad.example.com', reason: 'RESOLVE_FAILED', dns: { 'bad.example.com': [[5]] } },
    { label: 'a malformed address literal', name: '1.2.3.999', reason: 'INVALID_ADDRESS_LITERAL' },
    { label: 'a host without a resolver', name: 'api.example.com', reason: 'HOST_CAPABILITY_MISSING', edit: (host) => { delete host.resolve; } },
    { label: 'a granted name that does not resolve', name: 'api.example.com', reason: 'RESOLVE_FAILED', granted: true },
  ];
  for (const { label, name, reason, dns = {}, edit, granted = false } of cases) {
    const host = createRecordingHost({ dns });
    edit?.(host);
    const gate = createEnforcementGate({ manifest: granted ? manifest() : minimal(), host, mode: 'shadow' });
    await assert.rejects(gate.connect(name, 443), (error) => {
      assert.ok(error instanceof EnforcementDenied, label);
      assert.equal(error.reason, reason, label);
      assert.equal(error.operation, 'connect', label);
      return true;
    });
    assert.equal(host.count('connect'), 0, label);
    const audit = gate.audit();
    assert.deepEqual(layout(gate), ['decision:connect:would-deny', 'outcome:connect:failed'], label);
    assert.equal(audit[1].decision_seq, 0, label);
    assert.equal(audit[1].error_code, reason, label);
    assert.equal(audit[1].ok, false, label);
    assert.equal(audit.filter((entry) => entry.phase === 'outcome' && entry.ok === true).length, 0, label);
    assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, label);
  }
});

test('shadow connect to a granted name that resolves to a non-public address records would-deny and still connects to the pinned address', async () => {
  const host = createRecordingHost({ dns: { 'api.example.com': [['10.0.0.5']] } });
  const gate = createEnforcementGate({ manifest: manifest(), host, mode: 'shadow' });
  assert.deepEqual(await gate.connect('api.example.com', 443), { connected: true });
  assert.deepEqual(host.calls.filter((call) => call.method === 'connect'), [{ method: 'connect', host: 'api.example.com', address: '10.0.0.5', port: 443 }]);
  assert.deepEqual(layout(gate), ['decision:connect:would-deny', 'outcome:connect:ok']);
  assert.equal(gate.audit()[0].reason, 'RESOLVES_TO_NON_PUBLIC_ADDRESS');
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('a host that does not report the connection as made is a failed connect in enforce and shadow mode, never a successful outcome', async () => {
  const answers = [{ connected: false }, {}, null, undefined, 'connected', 1, { connected: 'true' }, { connected: 1 }];
  for (const mode of ['enforce', 'shadow']) {
    for (const answer of answers) {
      const host = createRecordingHost({ dns: { 'api.example.com': [['93.184.216.34']] } });
      host.connect = async () => answer;
      const gate = createEnforcementGate({ manifest: mode === 'enforce' ? manifest() : minimal(), host, mode });
      const label = `${mode}: ${JSON.stringify(answer) ?? 'undefined'}`;
      await assert.rejects(gate.connect('api.example.com', 443), (error) => {
        assert.equal(error.code, 'NOT_CONNECTED', label);
        assert.equal(error instanceof EnforcementDenied, false, label);
        return true;
      });
      const outcome = gate.audit().at(-1);
      assert.equal(outcome.phase, 'outcome', label);
      assert.equal(outcome.ok, false, label);
      assert.equal(outcome.error_code, 'NOT_CONNECTED', label);
      assert.equal(gate.audit().filter((entry) => entry.phase === 'outcome' && entry.ok === true).length, 0, label);
      assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, label);
    }
  }
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
