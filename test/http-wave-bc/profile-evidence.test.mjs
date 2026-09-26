import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const waveRoot = path.join(repoRoot, 'adapters', 'http-wave-bc');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function implementedLeaves() {
  return fs.readdirSync(waveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(waveRoot, entry.name, 'adapter.mjs')))
    .map((entry) => entry.name)
    .sort();
}

test('T13 profile evidence enumerates every implemented leaf exactly once', () => {
  const evidence = readJson(path.join(waveRoot, 'profile-evidence.json'));
  const profileIds = evidence.profiles.map((profile) => profile.id).sort();

  assert.deepEqual(profileIds, implementedLeaves());
  assert.equal(new Set(profileIds).size, profileIds.length);
  assert.equal(evidence.promotion_state, 'HOLD_T19_T23');
  assert.equal(evidence.new_framework_fanout, 'DEFER_UNTIL_PROFILE_REVIEW');
});

test('T13 evidence never upgrades static leaves to runtime or production claims', async () => {
  const evidence = readJson(path.join(waveRoot, 'profile-evidence.json'));

  for (const profile of evidence.profiles) {
    assert.equal(profile.state, 'STATIC_EVIDENCE_GREEN');
    assert.equal(profile.verificationBasis, 'synthetic-only');
    assert.ok(profile.explicitly_unclaimed.includes('api.operations'));
    assert.ok(profile.explicitly_unclaimed.includes('persistence'));
    assert.ok(profile.explicitly_unclaimed.includes('codegen'));

    const moduleUrl = pathToFileURL(path.join(waveRoot, profile.id, 'adapter.mjs')).href;
    const mod = await import(moduleUrl);
    assert.equal(mod.adapter.verificationBasis, profile.verificationBasis);
    assert.equal(mod.adapter.capabilities['api.operations'], false);
    assert.equal(mod.adapter.capabilities['resource.fetch'], false);
    assert.equal(mod.adapter.capabilities['codegen.handles'], false);
  }
});

test('T13 evidence keeps exact implementation CI refs and explicit integration blockers', () => {
  const evidence = readJson(path.join(waveRoot, 'profile-evidence.json'));

  assert.match(evidence.exact_head, /^[0-9a-f]{40}$/);
  assert.equal(evidence.ci.conclusion, 'success');
  assert.equal(evidence.ci.focused_tests_observed, true);
  assert.deepEqual(
    evidence.ci.node_jobs.map((job) => [job.node, job.conclusion]).sort(),
    [['22.x', 'success'], ['24.x', 'success']]
  );
  assert.ok(evidence.promotion_blockers.some((x) => x.includes('T19 independent')));
  assert.ok(evidence.promotion_blockers.some((x) => x.includes('T23')));
  assert.ok(evidence.promotion_blockers.some((x) => x.includes('T16/beval')));
});
