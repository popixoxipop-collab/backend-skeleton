#!/usr/bin/env node
// T00-03 lease gate. `ledger` verifies a lease ledger against the ownership policy; `result` verifies that a worker's result is
// in time, names the holder of the claim, carries the claim's fencing token and base, and changes only paths inside the claim.
// Exit 0 verified, 2 errors (printed as `FAIL <code> <subject> <detail>`), 3 a ledger of another schema version, 1 usage or
// unreadable input. The gate reads and prints; it never writes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatError } from './ownership.mjs';
import { DEFAULT_REPO_DIR, UnreadableInput, UsageError, failInput, inputErrors, loadSources, parseOptions, readMap, verifyMap } from './build-ownership-map.mjs';
import { gitDiffPaths } from './check-ownership.mjs';
import { SHA, checkLedger, checkResult, leaseCounts, leasePolicy, parseInstant } from './lease-ledger.mjs';

export const CHECKS_RUN = 'ownership map derived from its inputs, ledger version and members, claim fields, track and repository, scopes inside the track, fencing order and counters, lease currency, scope conflicts, digest chain and head';
const RESULT_FLAGS = ['--claim', '--worker', '--worktree', '--token', '--base', '--head'];
const DIGEST = /^[0-9a-f]{64}$/;

const USAGE = `usage: node next/t00/check-lease.mjs [--repo-dir <dir>] ledger --ledger <file> --at <instant> [--head-digest <sha256>]
       node next/t00/check-lease.mjs [--repo-dir <dir>] result --ledger <file> --at <instant> --claim <id> --worker <name> --worktree <name> --token <n> --base <sha> --head <sha> [--head-digest <sha256>] [<path>...]
ledger  verifies the ledger against the ownership map of <dir> (default: this checkout), judged at <instant> (UTC, 2026-10-09T00:00:00Z)
result  verifies the ledger, then the result of one claim; without paths, the paths that differ between --base and --head in <dir>
--head-digest  the head_digest of the ledger as recorded outside the ledger file; a ledger with another head fails
exit codes: 0 verified, 2 errors, 3 ledger of another schema version, 1 usage or unreadable input`;

function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UnreadableInput(`cannot read the lease ledger ${file}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UnreadableInput(`the lease ledger ${file} is not valid JSON: ${e.message}`);
  }
}

export async function runCli(argv) {
  let command;
  let options;
  let operands;
  let sources;
  let map;
  let ledger;
  let repoDir;
  try {
    ({ options, rest: operands } = parseOptions(argv, { single: ['--repo-dir', '--ledger', '--at', '--head-digest', ...RESULT_FLAGS] }));
    command = operands.shift();
    if (command !== 'ledger' && command !== 'result') throw new UsageError(`expected the command ledger or result, got ${JSON.stringify(command)}`);
    for (const key of ['--ledger', '--at']) if (!Object.hasOwn(options, key)) throw new UsageError(`${command} needs ${key}`);
    if (Number.isNaN(parseInstant(options['--at']))) throw new UsageError(`--at must be a UTC instant like 2026-10-09T00:00:00Z, got ${JSON.stringify(options['--at'])}`);
    if (Object.hasOwn(options, '--head-digest') && !DIGEST.test(options['--head-digest'])) {
      throw new UsageError(`--head-digest must be 64 lowercase hex digits, got ${JSON.stringify(options['--head-digest'])}`);
    }
    if (command === 'ledger' && (RESULT_FLAGS.some((k) => Object.hasOwn(options, k)) || operands.length)) {
      throw new UsageError('ledger takes no paths and none of --claim, --worker, --worktree, --token, --base or --head');
    }
    if (command === 'result') {
      for (const key of RESULT_FLAGS) if (!Object.hasOwn(options, key)) throw new UsageError(`result needs ${key}`);
      if (!/^\d+$/.test(options['--token'])) throw new UsageError(`--token must be a whole number, got ${JSON.stringify(options['--token'])}`);
    }
    repoDir = path.resolve(options['--repo-dir'] ?? DEFAULT_REPO_DIR);
    sources = await loadSources(repoDir);
    map = readMap(repoDir);
    ledger = readLedger(path.resolve(options['--ledger']));
  } catch (e) {
    return failInput(e, USAGE);
  }

  const show = (errors) => errors.forEach((e) => console.log(formatError(e)));
  const at = options['--at'];
  const pin = options['--head-digest'];
  if (sources.problems.length) {
    show(inputErrors(sources.problems));
    return 2;
  }
  const mapErrors = verifyMap(map, sources);
  if (mapErrors.length) {
    show(mapErrors);
    return 2;
  }
  const ledgerErrors = checkLedger(ledger, leasePolicy(map), at, { currency: command === 'ledger', pin });
  if (ledgerErrors.length) {
    show(ledgerErrors);
    return ledgerErrors.some((e) => e.code === 'LEDGER_VERSION_UNSUPPORTED') ? 3 : 2;
  }
  if (command === 'ledger') {
    const { claims, active } = leaseCounts(ledger);
    const head = pin === undefined ? 'is not pinned (a ledger rewritten and sealed anew would pass too)' : 'equals the pin';
    console.log(`OK lease ledger verified at ${at}: ${claims} claims, ${active} active (checks: ${CHECKS_RUN}); head ${ledger.head_digest} ${head}`);
    return 0;
  }

  const packet = {
    claim_id: options['--claim'], worker: options['--worker'], worktree: options['--worktree'], fencing_token: Number(options['--token']),
    base_sha: options['--base'], head_sha: options['--head'], paths: operands,
  };
  if (operands.length === 0 && SHA.test(packet.base_sha) && SHA.test(packet.head_sha)) {
    try {
      packet.paths = gitDiffPaths(repoDir, packet.base_sha, packet.head_sha);
      if (packet.paths.length === 0) throw new UnreadableInput(`the diff between ${packet.base_sha} and ${packet.head_sha} is empty, so there is nothing to check`);
    } catch (e) {
      return failInput(e, USAGE);
    }
  }
  const errors = checkResult(ledger, packet, at);
  show(errors);
  if (errors.length) return 2;
  console.log(`OK the result of claim ${packet.claim_id} (token ${packet.fencing_token}, ${packet.paths.length} paths) stays inside its lease`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
