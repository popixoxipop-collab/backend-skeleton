import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKeypair,
  publicKeyIdFromPublic,
  signPayload,
} from '../../../lib/attest.mjs';
import {
  loadActivationLease,
  loadEvidenceAuthority,
  loadEvidenceStore,
  parseExpectedFencingToken,
  observedBlockers,
  releasePlanBlockers,
  verifyAll,
  verifyCompatibilityInventory,
  verifyReleasePlan,
} from '../release-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-plan.json'), 'utf8'));
const emptyStore = loadEvidenceStore(path.join(ROOT, 'evidence-manifest.json'));
const clone = (x) => structuredClone(x);
const heads = () => Object.fromEntries(inventory.repositories.map((repo) => [repo.role, repo.head_sha]));
const shaRef = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');

function makeAuthority(temp) {
  const keys = generateKeypair();
  const keyId = publicKeyIdFromPublic(keys.publicKeyPem);
  const authority = {
    schema: 'bskel.scale-release-evidence-authority/1',
    trusted_keys: [{ key_id: keyId, public_key_pem: keys.publicKeyPem }],
  };
  const bytes = JSON.stringify(authority, null, 2) + '\n';
  const file = path.join(temp, 'authority.json');
  fs.writeFileSync(file, bytes);
  const ref = shaRef(bytes);
  const loaded = loadEvidenceAuthority(file, ref);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  return { keys, keyId, file, ref, loaded };
}

function signedArtifact(payload, keys, keyId) {
  return {
    ...payload,
    attestation: {
      schema: 'bskel.scale-release-evidence-attestation/1',
      key_id: keyId,
      signature: signPayload(payload, keys.privateKeyPem),
    },
  };
}

function writeEvidenceStore(temp, artifact, filename = 'evidence.json') {
  const artifactDir = path.join(temp, 'evidence-artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const bytes = JSON.stringify(artifact, null, 2) + '\n';
  const ref = shaRef(bytes);
  fs.writeFileSync(path.join(artifactDir, filename), bytes);
  const manifest = {
    schema: 'bskel.scale-release-evidence-manifest/1',
    entries: [{ ref, path: 'evidence-artifacts/' + filename }],
  };
  const manifestPath = path.join(temp, 'evidence-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { ref, manifestPath };
}

function bskelPackPayload() {
  return {
    schema: 'bskel.scale-release-evidence/1',
    check_id: 'bskel npm run test:pack',
    outcome: 'PASS',
    observed_at: '2026-09-27T00:00:00Z',
    release_heads: heads(),
    verifier: {
      kind: 'github-actions',
      repository: 'popixoxipop-collab/backend-skeleton',
      head_sha: heads().bskel,
      run_id: 12345,
      conclusion: 'success',
      command: 'npm run test:pack',
      exit_code: 0,
    },
  };
}

function signedActivationLease(keys, keyId, overrides = {}) {
  const payload = {
    schema: 'bskel.scale-default-activation-lease/1',
    claim_id: 'T00-DEFAULT-ACTIVATION-test-r1',
    track: 'T00-DEFAULT-ACTIVATION',
    state: 'ACTIVE',
    scope: 'default-activation',
    repo: 'popixoxipop-collab/backend-skeleton',
    release_heads: heads(),
    fencing_token: 1,
    issued_at: '2026-09-27T00:00:00Z',
    expires_at: '2099-09-27T00:00:00Z',
    ...overrides,
  };
  return {
    ...payload,
    attestation: {
      schema: 'bskel.scale-default-activation-lease-attestation/1',
      key_id: keyId,
      signature: signPayload(payload, keys.privateKeyPem),
    },
  };
}

test('current integrated-main inventory is structurally valid but release remains blocked', () => {
  const result = verifyAll(inventory, plan, emptyStore, null);
  assert.equal(emptyStore.ok, true, JSON.stringify(emptyStore.errors));
  assert.equal(result.ok, true);
  assert.deepEqual(result.inventory.errors, []);
  assert.deepEqual(result.release_plan.errors, []);
  assert.deepEqual(result.inventory.observed_blockers, [
    'FINAL_MAIN_PUSH_CI_NOT_DIRECT',
    'INDEPENDENT_QA_NOT_READY',
    'TRUST_POLICY_NOT_READY',
  ]);
  assert.deepEqual(releasePlanBlockers(plan, inventory, emptyStore, null), [
    'FINAL_RELEASE_REHEARSAL_NOT_RUN',
    'RELEASE_CHECKS_NOT_COMPLETE',
  ]);
  assert.equal(plan.release_allowed, false);
  assert.equal(plan.default_activation_allowed, false);
});

test('role identity is pinned to exact repository and package names', () => {
  const wrongRepo = clone(inventory);
  wrongRepo.repositories[0].repo = 'popixoxipop-collab/not-bskel';
  assert.ok(verifyCompatibilityInventory(wrongRepo).errors.some((e) => e.code === 'REPOSITORY_IDENTITY_MISMATCH'));

  const wrongPackage = clone(inventory);
  wrongPackage.repositories[2].package.name = 'backend-skeleton';
  assert.ok(verifyCompatibilityInventory(wrongPackage).errors.some((e) => e.code === 'PACKAGE_IDENTITY_MISMATCH'));
});

test('zero-delta equivalence is exact and does not count as direct main CI', () => {
  const x = clone(inventory);
  x.repositories[0].verification.file_delta_count = 1;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'TREE_EQUIVALENCE'));
  assert.ok(observedBlockers(inventory).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('direct main CI cannot reuse an older or merely tree-equivalent CI head', () => {
  const x = clone(inventory);
  x.repositories[0].verification.direct_main_ci = true;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'DIRECT_CI_HEAD_MISMATCH'));
  assert.ok(observedBlockers(x).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('promotion evidence is mandatory and required state is fixed to ACCEPTED', () => {
  const missing = clone(inventory);
  delete missing.promotion_evidence.t19_03;
  assert.ok(verifyCompatibilityInventory(missing).errors.some((e) => e.code === 'PROMOTION_EVIDENCE_MISSING'));
  assert.ok(observedBlockers(missing).includes('INDEPENDENT_QA_NOT_READY'));

  const weakened = clone(inventory);
  weakened.promotion_evidence.t20_03.required_state = 'NOT_ACCEPTED';
  weakened.promotion_evidence.t20_03.observed_state = 'NOT_ACCEPTED';
  assert.ok(verifyCompatibilityInventory(weakened).errors.some((e) => e.code === 'PROMOTION_REQUIRED_STATE'));
  assert.ok(observedBlockers(weakened).includes('TRUST_POLICY_NOT_READY'));
});

test('release cannot hide an observed blocker', () => {
  const x = clone(plan);
  x.blockers = x.blockers.filter((v) => v !== 'TRUST_POLICY_NOT_READY');
  assert.ok(verifyReleasePlan(x, inventory, emptyStore, null).errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED'));
});

test('every mandatory prerequisite remains present with pinned required state', () => {
  const missing = clone(plan);
  missing.prerequisites = missing.prerequisites.filter((x) => x.id !== 'T00-04A');
  assert.ok(verifyReleasePlan(missing, inventory, emptyStore, null).errors.some((e) => e.code === 'PREREQUISITE_MISSING'));

  const weakened = clone(plan);
  weakened.prerequisites.find((x) => x.id === 'T00-05').required_state = 'PLANNED';
  assert.ok(verifyReleasePlan(weakened, inventory, emptyStore, null).errors.some((e) => e.code === 'PREREQUISITE_REQUIRED_STATE'));
});

test('migration stage IDs and safety semantics are immutable', () => {
  const reordered = clone(plan);
  [reordered.migration_stages[1], reordered.migration_stages[2]] = [reordered.migration_stages[2], reordered.migration_stages[1]];
  assert.ok(verifyReleasePlan(reordered, inventory, emptyStore, null).errors.some((e) => e.code === 'MIGRATION_ORDER'));

  const widened = clone(plan);
  widened.migration_stages[0].writer_mode = 'next-global';
  widened.migration_stages[0].promotion = true;
  assert.ok(verifyReleasePlan(widened, inventory, emptyStore, null).errors.some((e) => e.code === 'MIGRATION_STAGE_SEMANTICS'));
});

test('release rehearsal remains a real gate', () => {
  const hidden = clone(plan);
  hidden.blockers = hidden.blockers.filter((v) => v !== 'FINAL_RELEASE_REHEARSAL_NOT_RUN');
  assert.ok(verifyReleasePlan(hidden, inventory, emptyStore, null).errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED'));
});

test('destructive rollback, old-writer overwrite, and stale cache reuse remain forbidden', () => {
  const x = clone(plan);
  x.rollback_policy.destructive_down_migration_allowed = true;
  x.rollback_policy.old_writer_may_overwrite_next_artifacts = true;
  x.rollback_policy.cache_namespace_or_revision_must_change_on_semantic_revision = false;
  const codes = verifyReleasePlan(x, inventory, emptyStore, null).errors.map((e) => e.code);
  assert.ok(codes.includes('DESTRUCTIVE_DOWN_MIGRATION'));
  assert.ok(codes.includes('OLD_WRITER_OVERWRITE'));
  assert.ok(codes.includes('CACHE_REVISION_ISOLATION'));
});

test('all documented release checks remain mandatory', () => {
  for (const check of ['historical contract/run replay', 'support matrix generated only from admitted evidence-backed profiles']) {
    const x = clone(plan);
    x.required_release_checks = x.required_release_checks.filter((item) => item !== check);
    assert.ok(verifyReleasePlan(x, inventory, emptyStore, null).errors.some((e) => e.code === 'REQUIRED_RELEASE_CHECK_MISSING'), check);
  }
});

test('syntactically valid fake digest cannot satisfy a release check', () => {
  const x = clone(plan);
  const item = x.release_check_results.find((entry) => entry.id === 'bskel npm run test:pack');
  item.observed_state = 'PASS';
  item.evidence_refs = ['sha256:' + '0'.repeat(64)];
  assert.ok(verifyReleasePlan(x, inventory, emptyStore, null).errors.some((e) => e.code === 'RELEASE_CHECK_EVIDENCE_NOT_FOUND'));
});

test('unsigned evidence is rejected even when bytes and context are correct', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-unsigned-'));
  try {
    const authority = makeAuthority(temp);
    const artifact = bskelPackPayload();
    const { manifestPath } = writeEvidenceStore(temp, artifact);
    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, false);
    assert.ok(store.errors.some((e) => e.code === 'EVIDENCE_ATTESTATION_SCHEMA'));
    assert.equal(store.entries.size, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('self-authored authority cannot replace the externally pinned authority ref', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-authority-'));
  try {
    const authority = makeAuthority(temp);
    const bad = loadEvidenceAuthority(authority.file, 'sha256:' + '0'.repeat(64));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'EVIDENCE_AUTHORITY_REF_MISMATCH'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('authenticated evidence requires check-specific verifier fields', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-verifier-'));
  try {
    const authority = makeAuthority(temp);
    const badPayload = bskelPackPayload();
    badPayload.verifier.command = 'echo PASS';
    const artifact = signedArtifact(badPayload, authority.keys, authority.keyId);
    const { manifestPath } = writeEvidenceStore(temp, artifact);
    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, false);
    assert.ok(store.errors.some((e) => e.code === 'EVIDENCE_PACK_VERIFIER_MISMATCH'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('trusted signed pack evidence resolves only for the exact release heads', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-signed-'));
  try {
    const authority = makeAuthority(temp);
    const payload = bskelPackPayload();
    const artifact = signedArtifact(payload, authority.keys, authority.keyId);
    const { ref, manifestPath } = writeEvidenceStore(temp, artifact);
    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, true, JSON.stringify(store.errors));
    assert.equal(store.entries.has(ref), true);

    const x = clone(plan);
    const item = x.release_check_results.find((entry) => entry.id === payload.check_id);
    item.observed_state = 'PASS';
    item.evidence_refs = [ref];
    const errors = verifyReleasePlan(x, inventory, store, null).errors;
    assert.equal(errors.some((e) => e.code.startsWith('RELEASE_CHECK_EVIDENCE_')), false, JSON.stringify(errors));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('release=true cannot retain a blocked or arbitrary status', () => {
  const x = clone(plan);
  x.release_allowed = true;
  x.status = 'REBASELINED_BLOCKED';
  assert.ok(verifyReleasePlan(x, inventory, emptyStore, null).errors.some((e) => e.code === 'RELEASE_STATUS_CONTRADICTION'));
});

test('default activation requires a separately signed active lease', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-default-lease-'));
  try {
    const authority = makeAuthority(temp);

    const noLeasePlan = clone(plan);
    noLeasePlan.release_allowed = true;
    noLeasePlan.default_activation_allowed = true;
    noLeasePlan.status = 'READY_FOR_DEFAULT_ACTIVATION';
    const missingErrors = verifyReleasePlan(noLeasePlan, inventory, emptyStore, null).errors;
    assert.ok(missingErrors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_REQUIRED'));

    const lease = signedActivationLease(authority.keys, authority.keyId);
    const leasePath = path.join(temp, 'activation-lease.json');
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\n');
    const loaded = loadActivationLease(
      leasePath,
      authority.loaded,
      inventory,
      Date.parse('2026-09-27T01:00:00Z'),
      1,
      'T00-DEFAULT-ACTIVATION-test-r1',
    );
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));

    const errors = verifyReleasePlan(noLeasePlan, inventory, emptyStore, loaded).errors;
    assert.equal(errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_REQUIRED'), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('activation lease is bound to exact release heads and trusted signer', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-default-lease-heads-'));
  try {
    const authority = makeAuthority(temp);
    const wrongHeads = { ...heads(), beval: '0'.repeat(40) };
    const lease = signedActivationLease(authority.keys, authority.keyId, { release_heads: wrongHeads });
    const leasePath = path.join(temp, 'activation-lease.json');
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\n');
    const loaded = loadActivationLease(
      leasePath,
      authority.loaded,
      inventory,
      Date.parse('2026-09-27T01:00:00Z'),
      1,
      'T00-DEFAULT-ACTIVATION-test-r1',
    );
    assert.equal(loaded.ok, false);
    assert.ok(loaded.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_HEADS'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('authority rejects non-Ed25519 public keys', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-rsa-authority-'));
  try {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const keyId = publicKeyIdFromPublic(publicKeyPem);
    const authority = {
      schema: 'bskel.scale-release-evidence-authority/1',
      trusted_keys: [{ key_id: keyId, public_key_pem: publicKeyPem }],
    };
    const bytes = JSON.stringify(authority, null, 2) + '\n';
    const file = path.join(temp, 'authority.json');
    fs.writeFileSync(file, bytes);
    const loaded = loadEvidenceAuthority(file, shaRef(bytes));
    assert.equal(loaded.ok, false);
    assert.ok(loaded.errors.some((e) => e.code === 'EVIDENCE_AUTHORITY_KEY_TYPE'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('malformed non-object evidence is rejected without crashing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-null-artifact-'));
  try {
    const authority = makeAuthority(temp);
    const artifactDir = path.join(temp, 'evidence-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const bytes = 'null\n';
    const ref = shaRef(bytes);
    fs.writeFileSync(path.join(artifactDir, 'null.json'), bytes);
    const manifestPath = path.join(temp, 'evidence-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'bskel.scale-release-evidence-manifest/1',
      entries: [{ ref, path: 'evidence-artifacts/null.json' }],
    }, null, 2) + '\n');
    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, false);
    assert.ok(store.errors.some((e) => e.code === 'EVIDENCE_ARTIFACT_OBJECT_REQUIRED'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('activation lease cannot become valid before issued_at', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-default-lease-future-'));
  try {
    const authority = makeAuthority(temp);
    const lease = signedActivationLease(authority.keys, authority.keyId, {
      issued_at: '2026-09-27T05:00:00Z',
      expires_at: '2026-09-27T06:00:00Z',
    });
    const leasePath = path.join(temp, 'activation-lease.json');
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\n');
    const loaded = loadActivationLease(
      leasePath,
      authority.loaded,
      inventory,
      Date.parse('2026-09-27T04:00:00Z'),
      1,
      'T00-DEFAULT-ACTIVATION-test-r1',
    );
    assert.equal(loaded.ok, false);
    assert.ok(loaded.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_NOT_YET_VALID'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('activation lease must match externally pinned fencing token and claim id', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-default-lease-fence-'));
  try {
    const authority = makeAuthority(temp);
    const lease = signedActivationLease(authority.keys, authority.keyId);
    const leasePath = path.join(temp, 'activation-lease.json');
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\n');

    const stale = loadActivationLease(
      leasePath,
      authority.loaded,
      inventory,
      Date.parse('2026-09-27T01:00:00Z'),
      2,
      'T00-DEFAULT-ACTIVATION-test-r2',
    );
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_FENCE_MISMATCH'));
    assert.ok(stale.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_CLAIM_MISMATCH'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('support-matrix source evidence refs must resolve to admitted signed PASS artifacts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-support-matrix-sources-'));
  try {
    const authority = makeAuthority(temp);
    const payload = {
      schema: 'bskel.scale-release-evidence/1',
      check_id: 'support matrix generated only from admitted evidence-backed profiles',
      outcome: 'PASS',
      observed_at: '2026-09-27T00:00:00Z',
      release_heads: heads(),
      verifier: {
        kind: 't23-support-matrix',
        admitted_profiles: 1,
        unsupported_profiles: 0,
        source_evidence_refs: ['sha256:' + '0'.repeat(64)],
      },
    };
    const artifact = signedArtifact(payload, authority.keys, authority.keyId);
    const { manifestPath } = writeEvidenceStore(temp, artifact, 'support-matrix.json');
    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, false);
    assert.ok(store.errors.some((e) => e.code === 'EVIDENCE_SUPPORT_MATRIX_SOURCE_NOT_FOUND'));
    assert.equal(store.entries.size, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('support-matrix evidence cannot recursively cite another support matrix', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-support-matrix-recursive-'));
  try {
    const authority = makeAuthority(temp);
    const artifactDir = path.join(temp, 'evidence-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });

    const pack = signedArtifact(bskelPackPayload(), authority.keys, authority.keyId);
    const packBytes = JSON.stringify(pack, null, 2) + '\n';
    const packRef = shaRef(packBytes);
    fs.writeFileSync(path.join(artifactDir, 'pack.json'), packBytes);

    const childPayload = {
      schema: 'bskel.scale-release-evidence/1',
      check_id: 'support matrix generated only from admitted evidence-backed profiles',
      outcome: 'PASS',
      observed_at: '2026-09-27T00:00:00Z',
      release_heads: heads(),
      verifier: {
        kind: 't23-support-matrix',
        admitted_profiles: 1,
        unsupported_profiles: 0,
        source_evidence_refs: [packRef],
      },
    };
    const child = signedArtifact(childPayload, authority.keys, authority.keyId);
    const childBytes = JSON.stringify(child, null, 2) + '\n';
    const childRef = shaRef(childBytes);
    fs.writeFileSync(path.join(artifactDir, 'child-support.json'), childBytes);

    const parentPayload = {
      ...childPayload,
      verifier: {
        ...childPayload.verifier,
        source_evidence_refs: [childRef],
      },
    };
    const parent = signedArtifact(parentPayload, authority.keys, authority.keyId);
    const parentBytes = JSON.stringify(parent, null, 2) + '\n';
    const parentRef = shaRef(parentBytes);
    fs.writeFileSync(path.join(artifactDir, 'parent-support.json'), parentBytes);

    const manifestPath = path.join(temp, 'evidence-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'bskel.scale-release-evidence-manifest/1',
      entries: [
        { ref: packRef, path: 'evidence-artifacts/pack.json' },
        { ref: childRef, path: 'evidence-artifacts/child-support.json' },
        { ref: parentRef, path: 'evidence-artifacts/parent-support.json' },
      ],
    }, null, 2) + '\n');

    const store = loadEvidenceStore(manifestPath, authority.loaded);
    assert.equal(store.ok, false);
    assert.ok(store.errors.some((e) => e.code === 'EVIDENCE_SUPPORT_MATRIX_SOURCE_RECURSIVE'));
    assert.equal(store.entries.has(parentRef), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('activation fencing tokens outside safe-integer range are rejected', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-default-lease-unsafe-fence-'));
  try {
    const authority = makeAuthority(temp);
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const lease = signedActivationLease(authority.keys, authority.keyId, { fencing_token: unsafe });
    const leasePath = path.join(temp, 'activation-lease.json');
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\n');
    const loaded = loadActivationLease(
      leasePath,
      authority.loaded,
      inventory,
      Date.parse('2026-09-27T01:00:00Z'),
      unsafe,
      'T00-DEFAULT-ACTIVATION-test-r1',
    );
    assert.equal(loaded.ok, false);
    assert.ok(loaded.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_LEASE_FENCE'));
    assert.ok(loaded.errors.some((e) => e.code === 'DEFAULT_ACTIVATION_EXPECTED_FENCE_REQUIRED'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('raw activation fencing token is canonical decimal and lossless before conversion', () => {
  assert.equal(parseExpectedFencingToken('1'), 1);
  assert.equal(parseExpectedFencingToken(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const raw of [
    '0',
    '01',
    '+1',
    '-1',
    '1.0',
    '9007199254740991.1',
    '9007199254740992',
    '1e3',
    ' 1',
    '1 ',
  ]) {
    assert.equal(parseExpectedFencingToken(raw), null, raw);
  }
});

test('legacy HTTP identity stays authoritative during additive T01 shipping', () => {
  const x = clone(inventory);
  x.invariants.legacy_http_identity_authoritative = false;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'LEGACY_IDENTITY_AUTHORITY'));
});
