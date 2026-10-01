import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as policy from '../release-policy.mjs';
import {
  IDENTITY_PACK, IDENTITY_PACK_SHA256, MANIFEST_PATH, RELEASE_DIR, WAIVER,
  accept, clone, fileRef, inventory, plan, sha256Hex, tempRoot,
} from './policy-fixtures.mjs';

const verify = (inv, root) => policy.verifyCompatibilityInventory(inv, { repoRoot: root });
const blockersOf = (inv, root) => policy.observedBlockers(inv, { repoRoot: root });
const refCodes = (result, key) => result.errors.filter((e) => e.key === key && /^PROMOTION_EVIDENCE_(REF|WAIVER)_/.test(e.code)).map((e) => e.code);
const KEYS = [['t01_06', 'T01_06_NOT_ACCEPTED'], ['t19_03', 'INDEPENDENT_QA_NOT_READY'], ['t20_03', 'TRUST_POLICY_NOT_READY']];

function outsideDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-outside-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the committed inventory pins t01_06 with a file ref that verifies against the real repository', () => {
  const result = policy.verifyCompatibilityInventory(inventory);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(inventory.promotion_evidence.t01_06.evidence_ref, fileRef());
  assert.deepEqual(result.observed_blockers, ['INDEPENDENT_QA_NOT_READY', 'TRUST_POLICY_NOT_READY']);
  assert.deepEqual(result.waived_evidence, []);
  assert.deepEqual(policy.observedBlockers(inventory), result.observed_blockers);
});

test('a repo root that lacks the referenced file cannot accept t01_06', (t) => {
  const root = tempRoot(t, { withPack: false });
  const result = verify(inventory, root);
  assert.equal(result.ok, false);
  assert.deepEqual(refCodes(result, 't01_06'), ['PROMOTION_EVIDENCE_REF_FILE_UNREADABLE']);
  assert.ok(result.observed_blockers.includes('T01_06_NOT_ACCEPTED'));
});

test('forgery 2: an ACCEPTED entry without evidence_ref is an error and keeps its blocker', (t) => {
  const root = tempRoot(t);
  for (const [key, blocker] of KEYS) {
    const forged = accept(inventory, key, undefined);
    const result = verify(forged, root);
    assert.equal(result.ok, false, key);
    assert.deepEqual(refCodes(result, key), ['PROMOTION_EVIDENCE_REF_REQUIRED'], key);
    assert.ok(result.observed_blockers.includes(blocker), `${key} keeps ${blocker}`);
    assert.ok(blockersOf(forged, root).includes(blocker), `observedBlockers alone keeps ${blocker}`);
  }
});

test('forgery 2 end to end: verifyAll stays not ok even when the release plan stops declaring the blockers', (t) => {
  const root = tempRoot(t);
  const forged = accept(accept(inventory, 't19_03', undefined), 't20_03', undefined);
  const forgedPlan = clone(plan);
  forgedPlan.blockers = forgedPlan.blockers.filter((b) => b !== 'INDEPENDENT_QA_NOT_READY' && b !== 'TRUST_POLICY_NOT_READY');
  const store = policy.loadEvidenceStore(MANIFEST_PATH);
  const all = policy.verifyAll(forged, forgedPlan, store, null, { repoRoot: root });
  assert.equal(all.ok, false);
  assert.deepEqual(refCodes(all.inventory, 't19_03'), ['PROMOTION_EVIDENCE_REF_REQUIRED']);
  assert.deepEqual(refCodes(all.inventory, 't20_03'), ['PROMOTION_EVIDENCE_REF_REQUIRED']);
  const undeclared = all.release_plan.errors.filter((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED').map((e) => e.blocker).sort();
  assert.deepEqual(undeclared, ['INDEPENDENT_QA_NOT_READY', 'TRUST_POLICY_NOT_READY']);
});

test('forgery 3: a sha256 that does not match the referenced bytes is an error and keeps the blocker', (t) => {
  const root = tempRoot(t);
  const wrong = 'a'.repeat(64);
  const result = verify(accept(inventory, 't19_03', fileRef(IDENTITY_PACK, wrong)), root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.filter((e) => e.key === 't19_03').map(({ code, path: p, expected, actual }) => ({ code, path: p, expected, actual })), [
    { code: 'PROMOTION_EVIDENCE_REF_SHA256_MISMATCH', path: IDENTITY_PACK, expected: wrong, actual: IDENTITY_PACK_SHA256 },
  ]);
  assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'));

  fs.appendFileSync(path.join(root, IDENTITY_PACK), '\n');
  const edited = verify(inventory, root);
  assert.deepEqual(refCodes(edited, 't01_06'), ['PROMOTION_EVIDENCE_REF_SHA256_MISMATCH'], 'editing the pinned artifact breaks the pin');
  assert.ok(edited.observed_blockers.includes('T01_06_NOT_ACCEPTED'));
});

test('sha256 must be 64 lowercase hex characters, bare', (t) => {
  const root = tempRoot(t);
  const hex = IDENTITY_PACK_SHA256;
  const cases = [
    [hex.toUpperCase(), 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'], ['sha256:' + hex, 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'],
    [hex.slice(1), 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'], [hex + '0', 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'],
    ['', 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'], ['g'.repeat(64), 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT'],
    [null, 'PROMOTION_EVIDENCE_REF_MALFORMED'], [12345, 'PROMOTION_EVIDENCE_REF_MALFORMED'],
  ];
  for (const [sha, code] of cases) {
    const result = verify(accept(inventory, 't19_03', fileRef(IDENTITY_PACK, sha)), root);
    assert.deepEqual(refCodes(result, 't19_03'), [code], String(sha));
    assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'));
  }
});

test('repo-relative paths only: absolute, parent, backslash, NUL and non-canonical paths are rejected without reading', (t) => {
  const root = tempRoot(t);
  const parent = path.dirname(root);
  const sibling = path.join(parent, 'outside-' + path.basename(root) + '.json');
  fs.writeFileSync(sibling, 'sibling bytes\n');
  t.after(() => fs.rmSync(sibling, { force: true }));
  const siblingSha = sha256Hex('sibling bytes\n');
  const unsafe = [
    ['../' + path.basename(sibling), siblingSha], [path.join(root, IDENTITY_PACK), IDENTITY_PACK_SHA256], [sibling, siblingSha],
    ['schemas/../../' + path.basename(sibling), siblingSha], ['schemas/next/../../../' + path.basename(sibling), siblingSha],
    ['schemas\\next\\identity-conformance.json', IDENTITY_PACK_SHA256], ['./' + IDENTITY_PACK, IDENTITY_PACK_SHA256],
    ['schemas//next/identity-conformance.json', IDENTITY_PACK_SHA256], ['schemas/./next/identity-conformance.json', IDENTITY_PACK_SHA256],
    [IDENTITY_PACK + '/', IDENTITY_PACK_SHA256], ['..', IDENTITY_PACK_SHA256], ['.', IDENTITY_PACK_SHA256],
    ['a' + String.fromCharCode(0) + 'b', IDENTITY_PACK_SHA256],
  ];
  for (const [p, sha] of unsafe) {
    const result = verify(accept(inventory, 't19_03', fileRef(p, sha)), root);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_REF_PATH_UNSAFE'], JSON.stringify(p));
    assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'), JSON.stringify(p));
  }
});

test('a missing file or a directory is not evidence', (t) => {
  const root = tempRoot(t);
  for (const p of ['schemas/next/missing.json', 'schemas/next', 'schemas']) {
    const result = verify(accept(inventory, 't19_03', fileRef(p, IDENTITY_PACK_SHA256)), root);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_REF_FILE_UNREADABLE'], p);
  }
  fs.symlinkSync('does-not-exist.json', path.join(root, 'dangling.json'));
  assert.deepEqual(refCodes(verify(accept(inventory, 't19_03', fileRef('dangling.json')), root), 't19_03'), ['PROMOTION_EVIDENCE_REF_FILE_UNREADABLE']);
});

test('a FIFO is rejected as not a regular file without blocking the verifier', (t) => {
  const root = tempRoot(t);
  const made = spawnSync('mkfifo', [path.join(root, 'pipe.json')]);
  if (made.status !== 0) { t.skip('mkfifo is not available'); return; }
  const child = `
    const fs = await import('node:fs');
    const [policyUrl, inventoryPath, root] = process.argv.slice(1);
    const policy = await import(policyUrl);
    const inv = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    inv.promotion_evidence.t19_03.observed_state = 'ACCEPTED';
    inv.promotion_evidence.t19_03.evidence_ref = { kind: 'file', path: 'pipe.json', sha256: '0'.repeat(64) };
    const result = policy.verifyCompatibilityInventory(inv, { repoRoot: root });
    process.stdout.write(JSON.stringify(result.errors.filter((e) => e.key === 't19_03').map((e) => e.code)));
  `;
  const policyUrl = pathToFileURL(path.join(RELEASE_DIR, 'release-policy.mjs')).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child, policyUrl, path.join(RELEASE_DIR, 'compatibility-inventory.json'), root], { timeout: 20000, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.error, undefined, 'the verifier must not block on a FIFO');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['PROMOTION_EVIDENCE_REF_FILE_UNREADABLE']);
});

test('a symlink that resolves outside the repo root is rejected even when its hash matches', (t) => {
  const root = tempRoot(t);
  const outside = outsideDir(t);
  fs.writeFileSync(path.join(outside, 'real.json'), 'outside bytes\n');
  fs.symlinkSync(path.join(outside, 'real.json'), path.join(root, 'link.json'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  const sha = sha256Hex('outside bytes\n');
  for (const p of ['link.json', 'linkdir/real.json']) {
    const result = verify(accept(inventory, 't19_03', fileRef(p, sha)), root);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_REF_OUTSIDE_ROOT'], p);
    assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'), p);
  }
});

test('symlinks that stay inside the repo root, and a symlinked repo root, are accepted', (t) => {
  const root = tempRoot(t);
  fs.symlinkSync(path.join(root, IDENTITY_PACK), path.join(root, 'inside-link.json'));
  const result = verify(accept(inventory, 't19_03', fileRef('inside-link.json')), root);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.observed_blockers, ['TRUST_POLICY_NOT_READY']);
  const wrongViaLink = verify(accept(inventory, 't19_03', fileRef('inside-link.json', 'a'.repeat(64))), root);
  assert.deepEqual(refCodes(wrongViaLink, 't19_03'), ['PROMOTION_EVIDENCE_REF_SHA256_MISMATCH'], 'the link target is really hashed');

  const holder = outsideDir(t);
  const linkedRoot = path.join(holder, 'root-link');
  fs.symlinkSync(root, linkedRoot);
  const viaLink = verify(inventory, linkedRoot);
  assert.equal(viaLink.ok, true, JSON.stringify(viaLink.errors));
  const wrong = clone(inventory);
  wrong.promotion_evidence.t01_06.evidence_ref.sha256 = 'a'.repeat(64);
  assert.deepEqual(refCodes(verify(wrong, linkedRoot), 't01_06'), ['PROMOTION_EVIDENCE_REF_SHA256_MISMATCH'], 'the symlinked root is really read');
});

const GOOD = { path: IDENTITY_PACK, sha256: IDENTITY_PACK_SHA256 };
const SHAPES = [
  ['null', null], ['string', 'x'], ['array', []], ['number', 7], ['empty object', {}],
  ['unknown kind', { kind: 'url', ...GOOD }], ['kind in the wrong case', { kind: 'FILE', ...GOOD }], ['no kind', { ...GOOD }],
  ['file without path', { kind: 'file', sha256: GOOD.sha256 }], ['file without sha256', { kind: 'file', path: GOOD.path }],
  ['file with an extra key', { kind: 'file', ...GOOD, extra: 1 }], ['file with a waiver key', { kind: 'file', ...GOOD, waiver: WAIVER }],
  ['waiver with a path key', { kind: 'waiver', waiver: WAIVER, path: GOOD.path }], ['waiver kind without waiver', { kind: 'waiver' }],
  ['path that is not a string', { kind: 'file', path: 5, sha256: GOOD.sha256 }], ['empty path', { kind: 'file', path: '', sha256: GOOD.sha256 }],
];

test('a malformed evidence_ref is an error on an ACCEPTED entry and on an unaccepted one, and never clears a blocker', (t) => {
  const root = tempRoot(t);
  for (const [label, ref] of SHAPES) {
    const accepted = verify(accept(inventory, 't19_03', ref), root);
    assert.deepEqual(refCodes(accepted, 't19_03'), ['PROMOTION_EVIDENCE_REF_MALFORMED'], label);
    assert.ok(accepted.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'), label);

    const unaccepted = clone(inventory);
    unaccepted.promotion_evidence.t19_03.evidence_ref = ref;
    const result = verify(unaccepted, root);
    assert.equal(result.ok, false, `${label} on a NOT_ACCEPTED entry`);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_REF_MALFORMED'], label);
  }
});

test('a valid file ref clears exactly its own blocker; on an unaccepted entry it is allowed and changes nothing', (t) => {
  const root = tempRoot(t);
  const result = verify(accept(inventory, 't19_03', fileRef()), root);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.observed_blockers, ['TRUST_POLICY_NOT_READY']);
  assert.deepEqual(result.waived_evidence, []);

  const borrowed = accept(accept(inventory, 't19_03', fileRef()), 't20_03', undefined);
  assert.deepEqual(refCodes(verify(borrowed, root), 't20_03'), ['PROMOTION_EVIDENCE_REF_REQUIRED'], 'no entry borrows another entry\'s ref');

  const unaccepted = clone(inventory);
  unaccepted.promotion_evidence.t20_03.evidence_ref = fileRef();
  const same = verify(unaccepted, root);
  assert.equal(same.ok, true, JSON.stringify(same.errors));
  assert.deepEqual(same.observed_blockers, ['INDEPENDENT_QA_NOT_READY', 'TRUST_POLICY_NOT_READY']);
});

test('observedBlockers verifies the reference itself rather than trusting verifyCompatibilityInventory', (t) => {
  const root = tempRoot(t);
  assert.ok(blockersOf(accept(inventory, 't19_03', fileRef(IDENTITY_PACK, 'b'.repeat(64))), root).includes('INDEPENDENT_QA_NOT_READY'));
  assert.ok(blockersOf(accept(inventory, 't19_03', undefined), root).includes('INDEPENDENT_QA_NOT_READY'));
  assert.ok(!blockersOf(accept(inventory, 't19_03', fileRef()), root).includes('INDEPENDENT_QA_NOT_READY'));
  assert.ok(blockersOf(inventory, tempRoot(t, { withPack: false })).includes('T01_06_NOT_ACCEPTED'));
});
