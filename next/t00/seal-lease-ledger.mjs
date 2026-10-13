#!/usr/bin/env node
// T00-03 seal tool. Prints a lease ledger with the digests computed: prev_digest and entry_digest on every claim, in ledger order,
// and head_digest. It reads the file and prints to stdout; it never writes, so the lead redirects the output to a new file, runs
// `check-lease.mjs ledger` on it and only then replaces the ledger. Sealing signs whatever it is given and judges nothing.
// Exit 0 sealed, 1 usage, unreadable input or a ledger that cannot be sealed.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sealLedger } from './lease-ledger.mjs';

const USAGE = `usage: node next/t00/seal-lease-ledger.mjs <ledger.json>
prints the ledger with prev_digest, entry_digest and head_digest computed; the head_digest is the value to keep outside the file (--head-digest of check-lease.mjs)
exit codes: 0 sealed, 1 usage, unreadable input or a ledger that cannot be sealed`;

export function runCli(argv) {
  if (argv.length !== 1 || argv[0].startsWith('--')) {
    console.error(USAGE);
    return 1;
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  } catch (e) {
    console.error(`cannot read the lease ledger ${argv[0]}: ${e.code ?? e.message}\n${USAGE}`);
    return 1;
  }
  const sealed = sealLedger(ledger);
  if (sealed.problem !== undefined) {
    console.error(`cannot seal the lease ledger ${argv[0]}: ${sealed.problem}\n${USAGE}`);
    return 1;
  }
  console.log(JSON.stringify(sealed.ledger, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
