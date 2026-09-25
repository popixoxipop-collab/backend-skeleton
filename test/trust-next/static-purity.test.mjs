import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUST_ROOT = path.resolve(HERE, '../../lib/trust-next');

test('trust permission layer stays declarative: no process/network/database execution imports', () => {
  const files = fs.readdirSync(TRUST_ROOT).filter((name) => name.endsWith('.mjs')).sort();
  assert.ok(files.length > 0);
  const forbidden = [
    'node:child_process',
    'node:http',
    'node:https',
    'node:net',
    'node:dgram',
    'node:tls',
    "from 'pg'",
    'from "pg"',
    'import(',
  ];
  for (const name of files) {
    const source = fs.readFileSync(path.join(TRUST_ROOT, name), 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${name} must not acquire execution/network/database capability via ${token}`);
    }
  }
});

test('trust permission layer has no direct environment-variable reads', () => {
  const files = fs.readdirSync(TRUST_ROOT).filter((name) => name.endsWith('.mjs')).sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(TRUST_ROOT, name), 'utf8');
    assert.equal(/process\.env(?:\.|\[)/.test(source), false, `${name} must receive approved values explicitly instead of ambient environment access`);
  }
});
