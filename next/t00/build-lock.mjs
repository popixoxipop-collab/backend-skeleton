#!/usr/bin/env node
// Derives baseline.lock.json from a captured observation. The limits are human statements, so they are carried over
// from an existing lock and reviewed by hand whenever the observed facts change.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalSha256, deriveLockRepository } from './verify-baseline.mjs';

export const OBSERVATION_FILE = 'next/t00/fixtures/observation.json';

export function buildLock(observation, limits) {
  return {
    schema: 'bskel.t00-baseline-lock/1',
    task_id: 'T00-01',
    repositories: observation.repositories.map(deriveLockRepository),
    inventory_pins: observation.inventory,
    capture: {
      observed_at: observation.observed_at,
      observation_file: OBSERVATION_FILE,
      observation_sha256: canonicalSha256(observation),
      observation_sha256_method: 'sha256 of canonical JSON (object keys sorted, no whitespace), so line endings do not change it',
      commands: [`node next/t00/capture-observation.mjs ${OBSERVATION_FILE}`],
    },
    limits,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [observationPath, limitsFromLock, out] = process.argv.slice(2);
  if (!observationPath || !limitsFromLock || !out) {
    console.error('usage: node next/t00/build-lock.mjs <observation.json> <lock-to-take-limits-from.json> <out-lock.json>');
    process.exitCode = 1;
  } else {
    const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
    const { limits } = JSON.parse(fs.readFileSync(limitsFromLock, 'utf8'));
    fs.writeFileSync(out, `${JSON.stringify(buildLock(observation, limits), null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}
