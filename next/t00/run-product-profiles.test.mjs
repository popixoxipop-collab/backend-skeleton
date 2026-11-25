import assert from 'node:assert/strict';
import test from 'node:test';
import { getProductProfile, productReplayArguments, productSourcePath, validateProductReplay } from './product-profiles.mjs';

const s = char => char.repeat(40);
const d = char => char.repeat(64);
const t14 = { task: 'T14-06', scope: 'historical-provider-preview-package-replay', pr: 530,
  base: s('a'), head: s('b'), tree: s('c') };
const t03 = { ...t14, task: 'T03-06', scope: 'historical-installed-package-replay' };
const t14Profile = getProductProfile(t14);
const baseTree = s('d');
const verifierSha256 = d('e');
const probeSha256 = d('f');
const baseline = '569c8f16aa6287a0abf403bb3456274271d424f65167604678cbfb55a0d58c4f';
const kind = 'reproduced-from-pinned-git-tree';
const source = { phase: 'premerge', subject: t14, baseTree, testedCommit: t14.head, verifierSha256, probeSha256 };
const protectedPackage = { commit: t14.base, tree: baseTree, kind, archive_sha256: d('7'),
  archive_inventory_sha256: d('8'), package_members: 424 };
const replay = { schema: 't00.t14-exact-installed-preview-replay/1', phase: 'premerge', track: 'T14', task: t14.task,
  pull_request: t14.pr, base: t14.base, base_tree: baseTree, source_head: t14.head, tested_commit: t14.head,
  tested_tree: t14.tree, scope_paths: t14Profile.scopePaths, published_candidate_validated: true, historical_pr: 147,
  historical_previous: { kind, commit: '271d5d747d7ef99fb7ce990a95db32fbdf4e46bd',
    tree: 'c5f1da277f3858cc93cefa8b6c3c0d5956b23e07', package_members: 217,
    archive_sha256: '9f2c2b705ddf6f7e9bd4ed03a7d4d6fb8ce002fbd46709f948ea99aa4e783ac8',
    archive_inventory_sha256: 'e32a0d3d34c46534f3a423fb1623e61e78965247bbd43f1c4c625d0922239e31' },
  historical_introduced: { kind, commit: 'bb18182c54a3a8f682ed2d1a6bac26749fcf267e',
    tree: '3330ac643682236547425436179a8d09cb33bbec', package_members: 363,
    archive_sha256: '055e93ed6cde2c58f7fe7b1cfecedbf1375eda3be44ac3e9fa78168c43802a85',
    archive_inventory_sha256: 'cfe99556d4531269d87a213f3320a584d7d23653de33a6bb36f2d7d4aee588fb' },
  protected_base: protectedPackage, tested_package: { ...protectedPackage, commit: t14.head, tree: t14.tree },
  installed_probe: { baseline_installed_sha256: baseline, baseline_version: 'bskel 1.9.0', completed_install_commands: 5,
    fixture_before_after_sha256: '80e9319a8e5c309ee79a4b19efde0d97e0d585e95fee60c7802ec96310f4a230',
    install_exit_code: 0, normal_restore: true, normal_restored_sha256: baseline, preview_exit_code: 0,
    preview_installed_sha256: d('9'), preview_version: 'bskel 1.9.0', sigterm_probe_exit_code: -15,
    sigterm_probe_restore: true, sigterm_restored_sha256: baseline, result: { applyAllowed: false,
      behavior: 'behavior-handoff-not-integrated', behaviorCertified: false, combination: 'typescript-express+typeorm+uuid',
      emitCalls: 1, previewReady: true, unsupported: 'unsupported-combination', requiredManualCompletions: ['authorization', 'patch'],
      plannedWrites: ['specs/001-t14-replay/handles/migration.sql', 'src/handles/codec.ts', 'src/handles/handleEntities.ts',
        'src/handles/handleService.ts', 'src/handles/recordSnapshotWrapper.ts', 'src/handles/registry.ts',
        'src/handles/resolvers/account.ts', 'src/handles/resolvers/accountPolicy.ts', 'src/handles/resolvers/resolvers_index.ts',
        'src/handles/router.ts'] } },
  node: 'v26.7.0', npm: '11.19.0', candidate_tests_executed: false, verifier_sha256: verifierSha256,
  probe_sha256: probeSha256, runtime_certified: false, release_authorized: false, requires_separate_github_ci_and_authority: true };

test('each product task has an independently fixed scope, program and invocation', () => {
  const t03Profile = getProductProfile(t03);
  assert.match(t03Profile.receiptSchema, /^t00\.t03-/u);
  assert.throws(() => getProductProfile({ ...t14, scope: t03.scope }), /HOLD_PRODUCT_PROFILE_SCOPE/u);
  assert.throws(() => productSourcePath('package.json'), /HOLD_PRODUCT_PROFILE_SOURCE/u);
  assert.deepEqual(productReplayArguments(t03Profile, { ...source, subject: t03 }).slice(1, 3), ['530', 'premerge']);
  assert.deepEqual(productReplayArguments(t14Profile, source).slice(1, 4), ['premerge', '--pr', '530']);
  assert.deepEqual(productReplayArguments(t14Profile, { ...source, phase: 'postmerge', testedCommit: s('9') }).slice(-2),
    ['--merge', s('9')]);
});

test('T14 requires exact packaged bytes, trusted sources, both restores and the canonical preview bounds', () => {
  assert.equal(validateProductReplay(t14Profile, replay, source), replay);
  const merged = { ...replay, phase: 'postmerge', tested_commit: s('9'), tested_package: { ...replay.tested_package, commit: s('9') } };
  assert.equal(validateProductReplay(t14Profile, merged, { ...source, phase: 'postmerge', testedCommit: s('9') }), merged);
  for (const update of [{ phase: 'reference', published_candidate_validated: false }, { probe_sha256: d('0') },
    { tested_package: { ...replay.tested_package, archive_sha256: d('0') } },
    { installed_probe: { ...replay.installed_probe, normal_restored_sha256: d('0') } },
    { installed_probe: { ...replay.installed_probe, sigterm_probe_exit_code: 0 } },
    { installed_probe: { ...replay.installed_probe, result: { ...replay.installed_probe.result, applyAllowed: true } } }]) {
    assert.throws(() => validateProductReplay(t14Profile, { ...replay, ...update }, source), /HOLD_PRODUCT_REPLAY_RECEIPT/u);
  }
  assert.throws(() => validateProductReplay(getProductProfile(t03), replay, { ...source, subject: t03 }),
    /HOLD_PRODUCT_REPLAY_RECEIPT/u);
});
