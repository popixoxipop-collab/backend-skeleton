#!/usr/bin/env node
import fs from 'node:fs';

export function verifyBaseline(lock, observation) {
  const errors = [];
  const byRepo = new Map((observation.repositories ?? []).map((r) => [r.repo, r]));

  for (const expected of lock.repositories ?? []) {
    const actual = byRepo.get(expected.repo);
    if (!actual) {
      errors.push({ code: 'MISSING_REPOSITORY_OBSERVATION', repo: expected.repo });
      continue;
    }
    if (actual.dirty !== false) {
      errors.push({ code: actual.dirty === true ? 'DIRTY_CHECKOUT' : 'DIRTY_STATE_UNKNOWN', repo: expected.repo });
    }
    if (actual.default_branch !== expected.default_branch) {
      errors.push({ code: 'DEFAULT_BRANCH_MISMATCH', repo: expected.repo, expected: expected.default_branch, actual: actual.default_branch ?? null });
    }
    if (actual.head_sha !== expected.head_sha) {
      errors.push({ code: 'HEAD_SHA_MISMATCH', repo: expected.repo, expected: expected.head_sha, actual: actual.head_sha ?? null });
    }
    const actualArtifacts = new Map((actual.artifacts ?? []).map((a) => [a.path, a]));
    for (const artifact of expected.required_artifacts ?? []) {
      const found = actualArtifacts.get(artifact.path);
      if (!found) {
        errors.push({ code: 'MISSING_ARTIFACT', repo: expected.repo, path: artifact.path });
      } else if (found.git_blob_sha !== artifact.git_blob_sha) {
        errors.push({ code: 'ARTIFACT_BLOB_MISMATCH', repo: expected.repo, path: artifact.path, expected: artifact.git_blob_sha, actual: found.git_blob_sha ?? null });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const [lockPath, observationPath] = process.argv.slice(2);
  if (!lockPath || !observationPath) {
    console.error('usage: node verify-baseline.mjs <baseline.lock> <observation.json>');
    process.exit(1);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
  const result = verifyBaseline(lock, observation);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
