import { fileURLToPath } from 'node:url';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => Array.isArray(left) && left.length === right.length &&
  right.every((item, index) => left[index] === item);
const exact = (value, fields, extras = []) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === Object.keys(fields).length + extras.length &&
  Object.entries(fields).every(([name, expected]) => Object.hasOwn(value, name) && value[name] === expected) &&
  extras.every(name => Object.hasOwn(value, name));

const t03 = Object.freeze({ task: 'T03-06', scope: 'historical-installed-package-replay',
  replayFile: 'next/t00/product-t03-replay.py', probeFile: null, receiptSchema: 't00.t03-github-independent-premerge/1',
  scopePaths: Object.freeze(['test/capability-next/historical-installed-pair.test.mjs',
    'test/capability-next/historical-installed-probe.mjs']) });
const t14 = Object.freeze({ task: 'T14-06', scope: 'historical-provider-preview-package-replay',
  replayFile: 'next/t00/t14-historical-product-replay.py', probeFile: 'next/t00/t14-installed-preview-probe.mjs',
  receiptSchema: 't00.t14-github-independent-premerge/1',
  scopePaths: Object.freeze(['next/t14/HISTORICAL_PACKAGE_REPLAY.json', 'next/t14/HISTORICAL_PACKAGE_REPLAY.md']) });
export const productProfiles = Object.freeze([t03, t14]);

const t03OriginalArchive = '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a';
const t03ArchiveEncodings = Object.freeze([t03OriginalArchive, 'caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742']);
const t14Previous = Object.freeze({ commit: '271d5d747d7ef99fb7ce990a95db32fbdf4e46bd',
  tree: 'c5f1da277f3858cc93cefa8b6c3c0d5956b23e07', kind: 'reproduced-from-pinned-git-tree', package_members: 217,
  archive_platform: 'linux', archive_sha256: '72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b',
  darwin_reference_archive_sha256: '9f2c2b705ddf6f7e9bd4ed03a7d4d6fb8ce002fbd46709f948ea99aa4e783ac8',
  archive_inventory_sha256: 'e32a0d3d34c46534f3a423fb1623e61e78965247bbd43f1c4c625d0922239e31' });
const t14Introduced = Object.freeze({ commit: 'bb18182c54a3a8f682ed2d1a6bac26749fcf267e',
  tree: '3330ac643682236547425436179a8d09cb33bbec', kind: 'reproduced-from-pinned-git-tree', package_members: 363,
  archive_platform: 'linux', archive_sha256: '1c3c550b2cb76881af9a6b5be786f77f63ba92c76d48589cf32a052513414b44',
  darwin_reference_archive_sha256: '055e93ed6cde2c58f7fe7b1cfecedbf1375eda3be44ac3e9fa78168c43802a85',
  archive_inventory_sha256: 'cfe99556d4531269d87a213f3320a584d7d23653de33a6bb36f2d7d4aee588fb' });
const t14Writes = ['specs/001-t14-replay/handles/migration.sql', 'src/handles/codec.ts',
  'src/handles/handleEntities.ts', 'src/handles/handleService.ts', 'src/handles/recordSnapshotWrapper.ts',
  'src/handles/registry.ts', 'src/handles/resolvers/account.ts', 'src/handles/resolvers/accountPolicy.ts',
  'src/handles/resolvers/resolvers_index.ts', 'src/handles/router.ts'];

export function getProductProfile({ task, scope } = {}) {
  const profile = productProfiles.find(value => value.task === task && value.scope === scope);
  if (!profile) throw new Error('HOLD_PRODUCT_PROFILE_SCOPE');
  return profile;
}

export function productSourcePath(file) {
  if (typeof file !== 'string' || !productProfiles.some(profile => file === profile.replayFile || file === profile.probeFile)) {
    throw new Error('HOLD_PRODUCT_PROFILE_SOURCE');
  }
  return fileURLToPath(new URL(`../../${file}`, import.meta.url));
}

export function productReplayArguments(profile, { phase, subject, baseTree, testedCommit }) {
  if (getProductProfile(subject) !== profile || !['premerge', 'postmerge'].includes(phase)) {
    throw new Error('HOLD_PRODUCT_PROFILE_SCOPE');
  }
  const args = [productSourcePath(profile.replayFile)];
  args.push(...(profile === t03 ? [String(subject.pr), phase] : [phase, '--pr', String(subject.pr)]),
    '--base', subject.base, '--base-tree', baseTree, '--head', subject.head, '--head-tree', subject.tree);
  if (profile === t03) args.push('--reproduce-historical-archive');
  if (profile === t14 && phase === 'postmerge') args.push('--merge', testedCommit);
  return args;
}

function validT14Package(record, commit, tree) {
  return exact(record, { commit, tree, kind: 'reproduced-from-pinned-git-tree' },
    ['archive_sha256', 'archive_inventory_sha256', 'package_members']) && digest(record.archive_sha256) &&
    digest(record.archive_inventory_sha256) && positiveId(record.package_members);
}

function validT14Installed(probe) {
  const baseline = '569c8f16aa6287a0abf403bb3456274271d424f65167604678cbfb55a0d58c4f';
  return exact(probe, { baseline_installed_sha256: baseline, baseline_version: 'bskel 1.9.0',
    completed_install_commands: 5, fixture_before_after_sha256: '80e9319a8e5c309ee79a4b19efde0d97e0d585e95fee60c7802ec96310f4a230',
    install_exit_code: 0, normal_restore: true, normal_restored_sha256: baseline, preview_exit_code: 0,
    preview_version: 'bskel 1.9.0', sigterm_probe_exit_code: -15, sigterm_probe_restore: true,
    sigterm_restored_sha256: baseline }, ['preview_installed_sha256', 'result']) &&
    digest(probe.preview_installed_sha256) && exact(probe.result, { applyAllowed: false,
      behavior: 'behavior-handoff-not-integrated', behaviorCertified: false,
      combination: 'typescript-express+typeorm+uuid', emitCalls: 1, previewReady: true,
      unsupported: 'unsupported-combination' }, ['plannedWrites', 'requiredManualCompletions']) &&
    same(probe.result.plannedWrites, t14Writes) && same(probe.result.requiredManualCompletions, ['authorization', 'patch']);
}

// Both hosts run only the trusted profile program. A reference replay lacks the exact PR and cannot satisfy this gate.
export function validateProductReplay(profile, replay, { phase, subject, baseTree, testedCommit, verifierSha256, probeSha256 }) {
  if (getProductProfile(subject) !== profile || !['premerge', 'postmerge'].includes(phase)) {
    throw new Error('HOLD_PRODUCT_PROFILE_SCOPE');
  }
  const bound = { phase, pull_request: subject.pr, base: subject.base, base_tree: baseTree,
    source_head: subject.head, tested_commit: testedCommit, tested_tree: subject.tree, candidate_tests_executed: false,
    requires_separate_github_ci_and_authority: true, node: 'v26.7.0', npm: '11.19.0',
    release_authorized: false, runtime_certified: false };
  let ok;
  if (profile === t03) {
    const t03Archive = replay?.replayed_historical_archive_sha256;
    ok = t03ArchiveEncodings.includes(t03Archive) && exact(replay, { ...bound, schema: 't00.t03-exact-pr-replay/3',
      historical_archive_sha256: t03OriginalArchive,
      replayed_historical_archive_sha256: t03Archive, historical_archive_kind: 'reproduced-from-pinned-historical-tree',
      base_archive_sha256: t03Archive, candidate_archive_sha256: t03Archive, package_file_bytes_match_official_baseline: true,
      package_members: 424, normal_restore: true, sigterm_probe_restore: true },
    ['previous_installed_inventory_sha256', 'scope_paths', 'outcome']) &&
      digest(replay.previous_installed_inventory_sha256) && exact(replay.outcome, {
        legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected',
      });
  } else {
    ok = digest(verifierSha256) && digest(probeSha256) && exact(replay, { ...bound,
      schema: 't00.t14-exact-installed-preview-replay/1', track: 'T14', task: profile.task,
      published_candidate_validated: true, historical_pr: 147, verifier_sha256: verifierSha256, probe_sha256: probeSha256 },
    ['scope_paths', 'historical_previous', 'historical_introduced', 'protected_base', 'tested_package', 'installed_probe']) &&
      exact(replay.historical_previous, t14Previous) && exact(replay.historical_introduced, t14Introduced) &&
      validT14Package(replay.protected_base, subject.base, baseTree) && validT14Package(replay.tested_package, testedCommit, subject.tree) &&
      ['archive_sha256', 'archive_inventory_sha256', 'package_members'].every(key => replay.tested_package[key] === replay.protected_base[key]) &&
      validT14Installed(replay.installed_probe);
  }
  if (!ok || !same(replay.scope_paths, profile.scopePaths)) throw new Error('HOLD_PRODUCT_REPLAY_RECEIPT');
  return replay;
}
