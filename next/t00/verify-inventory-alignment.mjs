#!/usr/bin/env node
// Optional T00-01 precondition: proposed T23 inventory pins equal a recorded baseline's heads.
// This is byte-bound alignment only, never freeze approval, authenticated CI or release authority.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { REQUIRED_REPOSITORIES, verifyBaseline, verifyLockRecord } from './verify-baseline-strict-v1.mjs';

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const INVENTORY_SCHEMA = 'bskel.scale-release-compatibility/3';
export const ALIGNMENT_SCHEMA = 'bskel.t00-inventory-alignment/1';
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const roles = REQUIRED_REPOSITORIES.map((r) => r.role).sort();
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameKeys = (obj, wanted) => plain(obj) && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify(wanted);
const validSha = (s) => typeof s === 'string' && SHA.test(s);
export const LIMITS = Object.freeze([
  'Alignment of these exact input bytes only; no current-main freshness or freeze decision is established.',
  'The supplied expected inventory SHA-256 binds bytes, not the identity or authority of its supplier.',
  'CI, signatures, independent attestation, branch protection, merge, MET and release authorization are not verified.',
  'The proposed inventory is separate from the historical inventory recorded inside the lock and may live in a later carrier commit.',
]);

// JSON.parse supplies syntax validation; this second walk rejects duplicate decoded member names
// (including escaped aliases). Last-key-wins input is ambiguous across other JSON consumers.
function parseUnambiguousJson(text) {
  const value = JSON.parse(text);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at += 1; };
  const string = () => {
    const start = at++;
    while (text[at] !== '"') { at += text[at] === '\\' ? 2 : 1; }
    at += 1;
    return JSON.parse(text.slice(start, at));
  };
  const visit = (depth) => {
    if (depth > 128) throw new Error('JSON nesting exceeds 128');
    ws();
    if (text[at] === '{') {
      at += 1; ws(); const keys = new Set();
      if (text[at] === '}') { at += 1; return; }
      for (;;) {
        ws(); const key = string();
        if (keys.has(key)) throw new Error('duplicate JSON object member');
        keys.add(key); ws(); at += 1; visit(depth + 1); ws();
        if (text[at++] === '}') return;
      }
    }
    if (text[at] === '[') {
      at += 1; ws();
      if (text[at] === ']') { at += 1; return; }
      for (;;) { visit(depth + 1); ws(); if (text[at++] === ']') return; }
    }
    if (text[at] === '"') { string(); return; }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at += 1;
  };
  visit(0);
  return value;
}

// JSON bytes, not caller-supplied objects: no coercion/getter/prototype-based lookup of input values.
export function verifyInventoryAlignment({ lockBytes, observationBytes, inventoryBytes, expectedInventorySha256 } = {}) {
  const errors = [];
  const inputs = {};
  const add = (code, role, detail) => errors.push({ code, role, detail });
  const parse = (name, value) => {
    if (!(typeof value === 'string' || Buffer.isBuffer(value))) {
      add('INPUT_INVALID', '-', `${name} must be UTF-8 string or Buffer bytes`);
      return null;
    }
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    if (bytes.length > MAX_INPUT_BYTES) {
      add('INPUT_INVALID', '-', `${name} exceeds ${MAX_INPUT_BYTES} bytes`);
      return null;
    }
    inputs[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    try { return parseUnambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { add('INPUT_INVALID', '-', `${name} must be valid UTF-8 JSON without duplicate members or nesting beyond 128`); return null; }
  };
  const lock = parse('lock', lockBytes);
  const observation = parse('observation', observationBytes);
  const inventory = parse('inventory', inventoryBytes);
  const validPin = typeof expectedInventorySha256 === 'string' && SHA256.test(expectedInventorySha256);
  if (!validPin) add('INVENTORY_PIN_INVALID', '-', 'an independently supplied lowercase SHA-256 is required');
  else if (inputs.inventory && inputs.inventory.sha256 !== expectedInventorySha256) {
    add('INVENTORY_HASH_MISMATCH', '-', 'supplied inventory bytes differ from the expected SHA-256');
  }
  const result = (aligned = []) => ({
    schema: ALIGNMENT_SCHEMA, ok: errors.length === 0, inputs,
    expected_inventory_sha256: validPin ? expectedInventorySha256 : null,
    aligned_repositories: errors.length === 0 ? aligned : [], errors, limits: [...LIMITS],
  });
  if (errors.length) return result();
  try {
    errors.push(...verifyBaseline(lock, observation, { remote: true }).errors,
      ...verifyLockRecord(lock, observation).errors);
  } catch {
    add('BASELINE_INPUT_INVALID', '-', 'the baseline verifier could not validate malformed input');
  }
  if (errors.length) return result();

  for (const row of observation.repositories) {
    if (![null, false, true].includes(row.dirty)) {
      add('BASELINE_STATE_INVALID', row.role, 'recorded dirty state must be a boolean or null, not an error/unknown string');
    }
  }
  const historicalSource = lock.inventory_pins.source;
  const bskel = lock.repositories.find((r) => r.role === 'bskel');
  if (historicalSource.repo !== bskel.repo || historicalSource.ref !== bskel.head_sha ||
      historicalSource.path !== 'release/next/compatibility-inventory.json' ||
      historicalSource.pin_field !== 'coordination_baseline.repositories.<role>') {
    add('BASELINE_SOURCE_INVALID', 'bskel', 'historical inventory source must identify the canonical path and locked bskel revision');
  }
  if (errors.length) return result();

  // Do not bind the new inventory to lock.inventory_pins.source: that is a historical blob.
  // Such a requirement would force the bskel commit to contain its own SHA.
  if (!plain(inventory) || inventory.schema !== INVENTORY_SCHEMA) {
    add('INVENTORY_SCHEMA_INVALID', '-', `expected ${INVENTORY_SCHEMA}`);
    return result();
  }
  if (!plain(inventory.coordination_baseline) || inventory.coordination_baseline.state !== 'ACCEPTED' ||
      inventory.coordination_baseline.accepted !== true) {
    add('INVENTORY_BASELINE_STATE_INVALID', '-', 'coordination baseline must explicitly record state ACCEPTED and accepted true');
  }
  const pins = inventory.coordination_baseline?.repositories;
  if (!sameKeys(pins, roles)) add('INVENTORY_REPOSITORY_SET_MISMATCH', '-', 'coordination pins must name exactly bskel, becoder and beval');
  const rows = inventory.repositories;
  if (!Array.isArray(rows) || rows.length !== roles.length || rows.some((r) => !plain(r) || typeof r.role !== 'string') ||
      JSON.stringify(rows.map((r) => r.role).sort()) !== JSON.stringify(roles)) {
    add('INVENTORY_REPOSITORY_SET_MISMATCH', '-', 'repository rows must contain each required role exactly once');
  }
  if (errors.length) return result();
  const aligned = [];
  for (const want of REQUIRED_REPOSITORIES) {
    const locked = lock.repositories.find((r) => r.role === want.role);
    const row = rows.find((r) => r.role === want.role);
    if (row.repo !== want.repo || row.default_branch !== locked.default_branch) {
      add('INVENTORY_REPOSITORY_IDENTITY_MISMATCH', want.role, 'repository name or default branch differs from the validated lock');
    }
    for (const [field, value] of [
      ['coordination_baseline.repositories', pins[want.role]],
      ['repositories.head_sha', row.head_sha],
      ['repositories.coordination_sha', row.coordination_sha],
    ]) {
      if (!validSha(value)) add('INVENTORY_HEAD_INVALID', want.role, `${field} is not a lowercase 40-hex commit`);
      else if (value !== locked.head_sha) add('INVENTORY_HEAD_MISMATCH', want.role, `${field}: expected ${locked.head_sha}, found ${value}`);
    }
    aligned.push({ role: want.role, repo: want.repo, default_branch: locked.default_branch, head_sha: locked.head_sha });
  }
  return result(aligned);
}

// No network, subprocess, file writes, or implicit default paths. Bound reads and reject special files.
export function readInput(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) throw new Error('input must be a bounded regular file');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let count = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
      if (count > MAX_INPUT_BYTES) throw new Error('input grew beyond the byte limit');
    }
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

export function runCli(argv) {
  if (argv.length !== 5 || argv[0] !== '--inventory-sha256' || !SHA256.test(argv[1] ?? '') ||
      argv.slice(2).some((v) => !v || v.startsWith('--'))) {
    console.error('usage: node next/t00/verify-inventory-alignment.mjs --inventory-sha256 <64-lowercase-hex> <lock.json> <observation.json> <proposed-inventory.json>');
    return 1;
  }
  try {
    const report = verifyInventoryAlignment({ expectedInventorySha256: argv[1],
      lockBytes: readInput(argv[2]), observationBytes: readInput(argv[3]), inventoryBytes: readInput(argv[4]) });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 2;
  } catch (error) {
    console.error(`cannot read input: ${error.code ?? error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
