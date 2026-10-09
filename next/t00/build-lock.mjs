#!/usr/bin/env node
// Derives baseline.lock.json from a captured observation. The limits are human statements, so they are carried over
// from an existing lock and reviewed by hand whenever the observed facts change. The derivation is deriveLock() in
// verify-baseline.mjs: the verifier runs the same function to check a lock, so builder and checker cannot drift apart.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deriveLock } from './verify-baseline.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [observationPath, limitsFromLock, out] = process.argv.slice(2);
  if (!observationPath || !limitsFromLock || !out) {
    console.error('usage: node next/t00/build-lock.mjs <observation.json> <lock-to-take-limits-from.json> <out-lock.json>');
    process.exitCode = 1;
  } else {
    const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
    const { limits } = JSON.parse(fs.readFileSync(limitsFromLock, 'utf8'));
    fs.writeFileSync(out, `${JSON.stringify(deriveLock(observation, limits), null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}
