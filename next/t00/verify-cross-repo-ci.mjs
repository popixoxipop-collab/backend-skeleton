#!/usr/bin/env node
// Strict optional T00 precondition. No role-selection or offline-success mode.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { REQUIRED_REPOSITORIES } from './verify-baseline.mjs';
import { MAX_INPUT_BYTES, readInput, verifyInventoryAlignment } from './verify-inventory-alignment.mjs';
import { verifyOnline } from '../../release/next/release-policy.mjs';
import { createGithubFetchRun, redactSecrets, secretsFromEnv } from '../../release/next/release-policy-github.mjs';

export const ROLES = Object.freeze(REQUIRED_REPOSITORIES.map((r) => r.role));
export const SCHEMA = 'bskel.t00-cross-repository-ci/1';
export const LIMITS = Object.freeze([
  'Checks the supplied byte-pinned baseline/inventory and all three exact-head CI runs; it does not freeze current branches.',
  'CI replies are evidence only from the supplied transport. Mocked or replayed replies are not independent live attestations.',
  'Does not verify every job, required-check enforcement, path approvals, signatures, review, merge, MET or release authorization.',
  'No existing release workflow is changed or made mandatory by this optional command.',
]);
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const copy = (value) => Buffer.isBuffer(value) && value.length <= MAX_INPUT_BYTES ? Buffer.from(value) : value;

export async function verifyCrossRepositoryCi(inputs = {}, { fetchRun } = {}) {
  // Capture every byte input before the first await. The caller cannot change a
  // Buffer while a request is in flight and make the next role use another pin.
  const captured = {
    lockBytes: copy(inputs.lockBytes), observationBytes: copy(inputs.observationBytes),
    inventoryBytes: copy(inputs.inventoryBytes), expectedInventorySha256: inputs.expectedInventorySha256,
  };
  const alignment = verifyInventoryAlignment(captured);
  const errors = [...alignment.errors];
  const result = (online = null) => ({
    schema: SCHEMA, ok: errors.length === 0 && online?.ok === true,
    expected_roles: [...ROLES], alignment, online, errors, limits: [...LIMITS],
    met_awarded: false, release_authorized: false,
  });
  if (!alignment.ok) return result();
  // The alignment verifier already bounded and unambiguously parsed these bytes.
  const inventory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    typeof captured.inventoryBytes === 'string' ? Buffer.from(captured.inventoryBytes, 'utf8') : captured.inventoryBytes));
  for (const wanted of alignment.aligned_repositories) {
    const row = inventory.repositories.find((r) => r.role === wanted.role);
    const verification = row.verification;
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
      errors.push({ code: 'CI_PIN_INVALID', role: wanted.role, field: 'verification' });
      continue;
    }
    if (!Number.isSafeInteger(verification.ci_run) || verification.ci_run <= 0) {
      errors.push({ code: 'CI_PIN_INVALID', role: wanted.role, field: 'ci_run' });
    }
    if (typeof verification.ci_head_sha !== 'string' || !SHA.test(verification.ci_head_sha) ||
        verification.ci_head_sha !== wanted.head_sha) {
      errors.push({ code: 'CI_BASELINE_HEAD_MISMATCH', role: wanted.role, field: 'ci_head_sha' });
    }
    if (wanted.default_branch !== 'main') {
      errors.push({ code: 'CI_BRANCH_UNSUPPORTED', role: wanted.role, field: 'default_branch' });
    }
  }
  if (typeof fetchRun !== 'function') errors.push({ code: 'CI_TRANSPORT_REQUIRED', role: '-' });
  // Check every role's pins before asking the transport about any role.
  if (errors.length) return result();
  const safeFetchRun = async (request) => {
    try { return await fetchRun(request); }
    catch { throw new Error('GitHub run read failed'); }
  };
  const online = await verifyOnline(inventory, { roles: [...ROLES], fetchRun: safeFetchRun });
  errors.push(...online.errors);
  if (JSON.stringify(online.checked_roles) !== JSON.stringify(ROLES) || online.not_checked_roles.length !== 0 ||
      online.runs.length !== ROLES.length || online.runs.some((r, i) => r.role !== ROLES[i] || r.ok !== true)) {
    errors.push({ code: 'CI_ALL_REPOSITORIES_NOT_VERIFIED', role: '-' });
  }
  return result(online);
}

export async function runCli(argv, { env = process.env, fetchImpl = globalThis.fetch, sleep,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 5 || argv[0] !== '--inventory-sha256' || !SHA256.test(argv[1] ?? '') ||
      argv.slice(2).some((v) => !v || v.startsWith('--'))) {
    stderr.write('usage: node next/t00/verify-cross-repo-ci.mjs --inventory-sha256 <64-lowercase-hex> <lock.json> <observation.json> <inventory.json>\n');
    return 1;
  }
  try {
    const inputs = { expectedInventorySha256: argv[1], lockBytes: readInput(argv[2]),
      observationBytes: readInput(argv[3]), inventoryBytes: readInput(argv[4]) };
    const report = await verifyCrossRepositoryCi(inputs,
      { fetchRun: createGithubFetchRun({ env, fetchImpl, sleep }) });
    stdout.write(`${redactSecrets(JSON.stringify(report, null, 2), secretsFromEnv(env))}\n`);
    return report.ok ? 0 : 2;
  } catch (error) {
    // Do not echo arbitrary transport or input content into logs.
    const code = ['EACCES', 'ENOENT', 'ELOOP', 'EISDIR'].includes(error?.code) ? error.code : 'INPUT_OR_TRANSPORT_ERROR';
    stderr.write(`cannot verify inputs: ${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
