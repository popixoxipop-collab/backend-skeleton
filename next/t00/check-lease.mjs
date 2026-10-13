#!/usr/bin/env node
// T00-03 lease gate. `ledger` verifies a lease ledger against the ownership policy; `result` verifies that a worker's result is
// in time, carries the claim's fencing token and base, and changes only paths inside the claim. Exit 0 verified, 2 errors
// (printed as `FAIL <code> <subject> <detail>`), 1 usage or unreadable input. The gate reads and prints; it never writes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatError } from './ownership.mjs';
import { DEFAULT_REPO_DIR, UnreadableInput, UsageError, failInput, inputErrors, loadSources, parseOptions, readMap, verifyMap } from './build-ownership-map.mjs';
import { gitDiffPaths } from './check-ownership.mjs';
import { SHA, checkLedger, checkResult, leaseCounts, leasePolicy, parseInstant } from './lease-ledger.mjs';

export const CHECKS_RUN = 'ownership map derived from its inputs, ledger shape, claim fields, track and repository, scopes inside the track, fencing order and counters, lease currency, scope conflicts';
const RESULT_FLAGS = ['--claim', '--token', '--base', '--head'];

const USAGE = `usage: node next/t00/check-lease.mjs [--repo-dir <dir>] ledger --ledger <file> --at <instant>
       node next/t00/check-lease.mjs [--repo-dir <dir>] result --ledger <file> --at <instant> --claim <id> --token <n> --base <sha> --head <sha> [<path>...]
ledger  verifies the ledger against the ownership map of <dir> (default: this checkout), judged at <instant> (UTC, 2026-10-09T00:00:00Z)
result  verifies the ledger, then the result of one claim; without paths, the paths that differ between --base and --head in <dir>
exit codes: 0 verified, 2 errors, 1 usage or unreadable input`;

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
    ({ options, rest: operands } = parseOptions(argv, { single: ['--repo-dir', '--ledger', '--at', ...RESULT_FLAGS] }));
    command = operands.shift();
    if (command !== 'ledger' && command !== 'result') throw new UsageError(`expected the command ledger or result, got ${JSON.stringify(command)}`);
    for (const key of ['--ledger', '--at']) if (!Object.hasOwn(options, key)) throw new UsageError(`${command} needs ${key}`);
    if (Number.isNaN(parseInstant(options['--at']))) throw new UsageError(`--at must be a UTC instant like 2026-10-09T00:00:00Z, got ${JSON.stringify(options['--at'])}`);
    if (command === 'ledger' && (RESULT_FLAGS.some((k) => Object.hasOwn(options, k)) || operands.length)) {
      throw new UsageError('ledger takes no paths and no --claim, --token, --base or --head');
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
  if (sources.problems.length) {
    show(inputErrors(sources.problems));
    return 2;
  }
  const mapErrors = verifyMap(map, sources);
  if (mapErrors.length) {
    show(mapErrors);
    return 2;
  }
  const ledgerErrors = checkLedger(ledger, leasePolicy(map), at, { currency: command === 'ledger' });
  if (ledgerErrors.length) {
    show(ledgerErrors);
    return 2;
  }
  if (command === 'ledger') {
    const { claims, active } = leaseCounts(ledger);
    console.log(`OK lease ledger verified at ${at}: ${claims} claims, ${active} active (checks: ${CHECKS_RUN})`);
    return 0;
  }

  const packet = { claim_id: options['--claim'], fencing_token: Number(options['--token']), base_sha: options['--base'], head_sha: options['--head'], paths: operands };
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
