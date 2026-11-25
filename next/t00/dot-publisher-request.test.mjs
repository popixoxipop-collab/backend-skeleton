import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { parseSignedRequest } from './dot-publisher-request.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
const now = 1_970_000_000;
const request = {
  schema: 't00.dot-publish/1',
  repositoryId: 1334919554,
  intake: 389,
  base: '1'.repeat(40),
  head: '2'.repeat(40),
  tree: '3'.repeat(40),
  track: 'T03',
  issuedAt: now - 30,
  expiresAt: now + 600,
};

function envelope(value = request, key = privateKey) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return 'T00-DOT-PUBLISH-V1 ' + bytes.toString('base64url') + '.' + sign(null, bytes, key).toString('base64url');
}

function read(body, options = {}) {
  return parseSignedRequest({ body, publicKeyDer: publicKeyDer.toString('base64'), now, ...options });
}

test('authenticates the canonical, exact repository, intake, base, head, tree, track and time binding', () => {
  assert.deepEqual(read(envelope()), request);
  assert.deepEqual(read(envelope(), { publicKeyDer, intakeNumber: 389 }), request);
  assert.deepEqual(read(envelope({ ...request, issuedAt: now, expiresAt: now + 900 })).issuedAt, now);
});

test('rejects any alteration of the signed Git object or replacement signing key', () => {
  for (const changes of [
    { base: '8'.repeat(40) }, { head: '8'.repeat(40) }, { tree: '8'.repeat(40) }, { track: 'T04' },
  ]) {
    const payload = Buffer.from(JSON.stringify({ ...request, ...changes })).toString('base64url');
    const signature = envelope().split('.')[1];
    assert.throws(() => read('T00-DOT-PUBLISH-V1 ' + payload + '.' + signature), { code: 'REQUEST_SIGNATURE' });
  }
  const rogue = generateKeyPairSync('ed25519');
  assert.throws(() => read(envelope(request, rogue.privateKey)), { code: 'REQUEST_SIGNATURE' });
  assert.throws(() => read(envelope(), { publicKeyDer: Buffer.alloc(44) }), { code: 'REQUEST_KEY' });
  assert.throws(() => read(envelope(), { publicKeyDer: publicKeyDer.toString('base64') + '\n' }), { code: 'REQUEST_KEY' });
});

test('requires the exact repository, intake, schema and candidate shape even for a valid signature', () => {
  for (const value of [
    { ...request, repositoryId: request.repositoryId + 1 },
    { ...request, intake: 390 },
    { ...request, schema: 't00.dot-publish/2' },
  ]) {
    assert.throws(() => read(envelope(value)), { code: 'REQUEST_SCOPE' });
  }
  assert.throws(() => read(envelope({ ...request, intake: 390 }), { intakeNumber: 390 }),
    { code: 'REQUEST_SCOPE' });
  for (const value of [
    { ...request, head: request.base }, { ...request, tree: 'X'.repeat(40) },
    { ...request, tree: request.tree + '\n' }, { ...request, track: ['T03'] },
    { ...request, track: 'T03\n' },
  ]) {
    assert.throws(() => read(envelope(value)), { code: 'REQUEST_PAYLOAD' });
  }
});

test('rejects expired, not yet valid, unsafe or overlong requests', () => {
  for (const times of [
    { expiresAt: now }, { expiresAt: request.issuedAt + 901 },
    { issuedAt: now + 1 }, { issuedAt: now - 0.5 }, { issuedAt: 0 },
  ]) {
    assert.throws(() => read(envelope({ ...request, ...times })), { code: 'REQUEST_TIME' });
  }
  assert.throws(() => read(envelope(), { now: '1970000000' }), { code: 'REQUEST_TIME' });
});

test('rejects ambiguous, non-canonical and non-JSON representations', () => {
  const canonical = JSON.stringify(request);
  for (const raw of [
    ' ' + canonical, canonical.replace('{', '{"schema":"duplicate",'),
    canonical.replace('{', '{"unexpected":0,'), canonical.replace('"track":"T03"', '"track":"\\u005403"'),
    JSON.stringify(Object.fromEntries(Object.entries(request).reverse())),
    'null', '[]',
  ]) {
    assert.throws(() => read(envelope(Buffer.from(raw))), { code: 'REQUEST_PAYLOAD' });
  }
  assert.throws(() => read(envelope(Buffer.concat([Buffer.from([0xff]), Buffer.from(canonical)]))),
    { code: 'REQUEST_PAYLOAD' });
  const signed = envelope();
  for (const body of [signed + '\n', signed + '=', 'extra ' + signed, signed.repeat(2), 'T00-DOT-PUBLISH-V1 ...']) {
    assert.throws(() => read(body), { code: 'REQUEST_FORMAT' });
  }
});
