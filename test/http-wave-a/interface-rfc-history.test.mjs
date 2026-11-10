import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const oldPath = 'next/t12/INTERFACE_RFC_EVIDENCE.json';
const currentPath = 'next/t12/INTERFACE_RFC_EVIDENCE_2026-11-11.json';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root });

test('T12 source evolution retains the original immutable RFC receipt as historical proof', () => {
  const oldBytes = fs.readFileSync(path.join(root, oldPath));
  assert.equal(sha(oldBytes), 'a86ce0734f8a5b9f3e52b8ee5988163e46f08d8c67ce874294a33c9082389f5d');
  const old = JSON.parse(oldBytes);
  const current = JSON.parse(fs.readFileSync(path.join(root, currentPath)));
  assert.equal(old.schema, 'bskel.t12-interface-rfc-evidence/1');
  assert.equal(current.schema, old.schema);
  assert.notEqual(current.verified_source_commit, old.verified_source_commit);
  assert.equal(old.assertions.official_MET_delta, 0);
  assert.equal(old.assertions.signed_independent_attestation, false);
  const originalReceipt = spawnSync('git', ['cat-file', '-e', `${old.verified_source_commit}:${oldPath}`], { cwd: root });
  assert.notEqual(originalReceipt.status, 0, 'historical receipt must not self-attest');
  for (const [file, digest] of Object.entries(old.source_files)) {
    assert.equal(sha(git('show', `${old.verified_source_commit}:${file}`)), digest, file);
  }
});
