import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { createGitHubProductArtifactReader, PRODUCT_ARTIFACT_SOURCE_PATHS } from './t00-github-product-artifact.mjs';
import { DOT_TRANSITION_PREFIX, encodeDotTransitionIntent } from './dot-transition-intent.mjs';
import { getProductProfile } from './product-profiles.mjs';

const root = 'https://api.github.com/repos/popixoxipop-collab/backend-skeleton';
const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const storage = 'https://productionresultssa01.blob.core.windows.net/actions-results/receipt.zip?sig=test-download';
const token = 'ghs_example_actions_reader_only';
const workflowPath = '.github/workflows/t00-product-replay.yml';
const artifactPath = '/actions/artifacts/209';
const runPath = '/actions/runs/103';
const commentPath = '/issues/comments/892';
const listingPath = `${runPath}/artifacts?name=t00-product-premerge-103-1-892&per_page=10`;
const discoveryPath = `${runPath}/artifacts?per_page=50`;
const archivedPackage = 'caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742';
const originalPackage = '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a';
const clock = () => Date.parse('2026-11-25T16:13:00.000Z');
const issuedAt = Math.floor(Date.parse('2026-11-25T16:10:00.000Z') / 1000);
const identity = { id: repoId, full_name: repo };
const subject = { repo, repositoryId: repoId, pr: 395, task: 'T03-06', scope: 'historical-installed-package-replay',
  base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40) };
const t14 = { ...subject, pr: 398, task: 'T14-06', scope: 'historical-provider-preview-package-replay' };
const baseTree = 'd'.repeat(40);
const dot = generateKeyPairSync('ed25519');
const publicKeyDer = dot.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
function signedCandidate(candidate) {
  const intent = encodeDotTransitionIntent({ schema: 't00.dot-ready-merge/1', ...candidate, intake: 389,
    issuedAt, expiresAt: issuedAt + 350 }, issuedAt);
  return {
    body: `${DOT_TRANSITION_PREFIX} ${intent.toString('base64url')}.${sign(null, intent, dot.privateKey).toString('base64url')}`,
    request: { runId: 103, attempt: 1, commentId: 892, subject: candidate, dotIntentSha256: sha(intent) },
  };
}
const { request } = signedCandidate(subject);
const { dotIntentSha256 } = request;

function independentlyFormattedPythonResult(value) {
  // Replay strings and keys are all validated ASCII. Expand Python's default separators
  // after constructing a sorted compact digest input from the independent fixture.
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]))
    : value;
  return JSON.stringify(sort(value)).replaceAll(',', ', ').replaceAll(':', ': ') + '\n';
}

function zip(bytes, { name = 't00-product-premerge.json', descriptor = true, compressed = true,
  badChecksum = false, members = 1 } = {}) {
  const filename = Buffer.from(name);
  const payload = compressed ? deflateRawSync(bytes) : bytes;
  const flags = descriptor ? 8 : 0;
  const values = [crc32(bytes) ^ (badChecksum ? 1 : 0), payload.length, bytes.length];
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(compressed ? 8 : 0, 8);
  if (!descriptor) values.forEach((value, index) => local.writeUInt32LE(value >>> 0, 14 + index * 4));
  local.writeUInt16LE(filename.length, 26);
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50);
    values.forEach((value, index) => trailer.writeUInt32LE(value >>> 0, 4 + index * 4));
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(compressed ? 8 : 0, 10);
  values.forEach((value, index) => central.writeUInt32LE(value >>> 0, 16 + index * 4));
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members, 8);
  end.writeUInt16LE(members, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + payload.length + trailer.length, 16);
  return Buffer.concat([local, filename, payload, trailer, central, filename, end]);
}

function t14Replay(candidate, verifierSha256, probeSha256) {
  const archive = (commit, tree, archive_sha256, archive_inventory_sha256, package_members) => ({
    commit, tree, archive_sha256, archive_inventory_sha256, package_members, kind: 'reproduced-from-pinned-git-tree',
  });
  const current = archive(candidate.base, baseTree, '3'.repeat(64), '4'.repeat(64), 424);
  const baseline = '569c8f16aa6287a0abf403bb3456274271d424f65167604678cbfb55a0d58c4f';
  return {
    schema: 't00.t14-exact-installed-preview-replay/1', phase: 'premerge', track: 'T14', task: candidate.task,
    pull_request: candidate.pr, base: candidate.base, base_tree: baseTree, source_head: candidate.head,
    tested_commit: candidate.head, tested_tree: candidate.tree, published_candidate_validated: true,
    scope_paths: ['next/t14/HISTORICAL_PACKAGE_REPLAY.json', 'next/t14/HISTORICAL_PACKAGE_REPLAY.md'],
    historical_pr: 147,
    historical_previous: { ...archive('271d5d747d7ef99fb7ce990a95db32fbdf4e46bd', 'c5f1da277f3858cc93cefa8b6c3c0d5956b23e07',
      '72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b', 'e32a0d3d34c46534f3a423fb1623e61e78965247bbd43f1c4c625d0922239e31', 217),
    archive_platform: 'linux', darwin_reference_archive_sha256: '9f2c2b705ddf6f7e9bd4ed03a7d4d6fb8ce002fbd46709f948ea99aa4e783ac8' },
    historical_introduced: { ...archive('bb18182c54a3a8f682ed2d1a6bac26749fcf267e', '3330ac643682236547425436179a8d09cb33bbec',
      '1c3c550b2cb76881af9a6b5be786f77f63ba92c76d48589cf32a052513414b44', 'cfe99556d4531269d87a213f3320a584d7d23653de33a6bb36f2d7d4aee588fb', 363),
    archive_platform: 'linux', darwin_reference_archive_sha256: '055e93ed6cde2c58f7fe7b1cfecedbf1375eda3be44ac3e9fa78168c43802a85' },
    protected_base: current, tested_package: { ...current, commit: candidate.head, tree: candidate.tree },
    installed_probe: { baseline_installed_sha256: baseline, baseline_version: 'bskel 1.9.0',
      completed_install_commands: 5, fixture_before_after_sha256: '80e9319a8e5c309ee79a4b19efde0d97e0d585e95fee60c7802ec96310f4a230',
      install_exit_code: 0, normal_restore: true, normal_restored_sha256: baseline, preview_exit_code: 0,
      preview_version: 'bskel 1.9.0', sigterm_probe_exit_code: -15, sigterm_probe_restore: true,
      sigterm_restored_sha256: baseline, preview_installed_sha256: '9'.repeat(64),
      result: { applyAllowed: false, behavior: 'behavior-handoff-not-integrated', behaviorCertified: false,
        combination: 'typescript-express+typeorm+uuid', emitCalls: 1, previewReady: true,
        unsupported: 'unsupported-combination', requiredManualCompletions: ['authorization', 'patch'],
        plannedWrites: ['specs/001-t14-replay/handles/migration.sql', 'src/handles/codec.ts',
          'src/handles/handleEntities.ts', 'src/handles/handleService.ts', 'src/handles/recordSnapshotWrapper.ts',
          'src/handles/registry.ts', 'src/handles/resolvers/account.ts', 'src/handles/resolvers/accountPolicy.ts',
          'src/handles/resolvers/resolvers_index.ts', 'src/handles/router.ts'],
      },
    },
    node: 'v26.7.0', npm: '11.19.0', candidate_tests_executed: false,
    verifier_sha256: verifierSha256, probe_sha256: probeSha256,
    runtime_certified: false, release_authorized: false, requires_separate_github_ci_and_authority: true,
  };
}

function fixture({ change = (rows, receipt) => {}, archiveOptions, raw, candidate = subject } = {}) {
  const { body, request } = signedCandidate(candidate);
  const profile = getProductProfile(candidate);
  const policy = { workflowId: 31, fileSha256s: {} };
  const branch = { name: 'main', protected: true, commit: { sha: candidate.base, commit: { tree: { sha: baseTree } } } };
  const run = { id: 103, run_attempt: 1, workflow_id: 31, path: workflowPath, head_branch: 'main', head_sha: candidate.base,
    event: 'issue_comment', repository: identity, head_repository: identity, actor: { id: 261965176 },
    triggering_actor: { id: 261965176 }, status: 'completed', conclusion: 'success',
    run_started_at: '2026-11-25T16:10:20Z', updated_at: '2026-11-25T16:12:32Z' };
  const rows = {
    [`${runPath}/attempts/1`]: run, [runPath]: structuredClone(run), '/branches/main': branch,
    '/actions/workflows/31': { id: 31, path: workflowPath, state: 'active' },
    [commentPath]: { id: 892, body, url: `${root}${commentPath}`, issue_url: `${root}/issues/389`,
      user: { id: 261965176 }, created_at: '2026-11-25T16:10:05Z', updated_at: '2026-11-25T16:10:05Z' },
    [listingPath]: { total_count: 1, artifacts: [{ id: 209, name: 't00-product-premerge-103-1-892',
      url: `${root}${artifactPath}`, archive_download_url: `${root}${artifactPath}/zip`, expired: false,
      created_at: '2026-11-25T16:12:20Z', expires_at: '2026-11-30T16:12:20Z',
      workflow_run: { id: 103, repository_id: repoId, head_repository_id: repoId, head_branch: 'main', head_sha: candidate.base } }] },
  };
  rows[discoveryPath] = structuredClone(rows[listingPath]);
  for (const path of PRODUCT_ARTIFACT_SOURCE_PATHS) {
    const source = Buffer.from(`pinned fixture for ${path}\n`);
    rows[`/contents/${path}?ref=${candidate.base}`] = { path, type: 'file', encoding: 'base64', size: source.length,
      content: source.toString('base64') };
    policy.fileSha256s[path] = sha(source);
  }
  const verifierSha256 = policy.fileSha256s[profile.replayFile];
  const replay = profile.task === 'T14-06' ? t14Replay(candidate, verifierSha256, policy.fileSha256s[profile.probeFile]) : {
    schema: 't00.t03-exact-pr-replay/3', phase: 'premerge', pull_request: candidate.pr, base: candidate.base,
    base_tree: baseTree, source_head: candidate.head, tested_commit: candidate.head, tested_tree: candidate.tree,
    historical_archive_sha256: originalPackage, replayed_historical_archive_sha256: archivedPackage,
    historical_archive_kind: 'reproduced-from-pinned-historical-tree', base_archive_sha256: archivedPackage,
    candidate_archive_sha256: archivedPackage, package_file_bytes_match_official_baseline: true,
    package_members: 424, candidate_tests_executed: false, requires_separate_github_ci_and_authority: true,
    normal_restore: true, sigterm_probe_restore: true, node: 'v26.7.0', npm: '11.19.0', release_authorized: false,
    runtime_certified: false, previous_installed_inventory_sha256: 'e'.repeat(64),
    scope_paths: ['test/capability-next/historical-installed-pair.test.mjs', 'test/capability-next/historical-installed-probe.mjs'],
    outcome: { legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected' },
  };
  const receipt = { schema: profile.receiptSchema, workflow: workflowPath, commit: candidate.base,
    runId: 103, attempt: 1, commentId: 892, dotIntentSha256: request.dotIntentSha256, verifierSha256,
    stdoutSha256: sha(independentlyFormattedPythonResult(replay)), completedAt: '2026-11-25T16:12:18.251Z',
    subject: candidate, replay };
  const settings = { redirect: storage };
  change(rows, receipt, settings);
  const receiptBytes = raw ? raw(receipt) : Buffer.from(`${JSON.stringify(receipt)}\n`);
  const archive = zip(receiptBytes, archiveOptions);
  for (const artifact of rows[listingPath].artifacts) {
    artifact.size_in_bytes ??= archive.length;
    artifact.digest ??= `sha256:${sha(archive)}`;
  }
  const records = [];
  const fetchImpl = async (url, options) => {
    records.push({ url, options });
    assert.equal(options.method, 'GET');
    let response;
    if (url === storage) response = new Response(archive);
    else {
      const path = url.slice(root.length);
      assert.ok(url.startsWith(root));
      if (path === `${artifactPath}/zip`) response = new Response(undefined, { status: 302, headers: { Location: settings.redirect } });
      else if (Object.hasOwn(rows, path)) response = Response.json(rows[path]);
      else throw new Error('unexpected API route');
    }
    return Object.defineProperty(response, 'url', { value: url });
  };
  const read = createGitHubProductArtifactReader({ actionsReadToken: token, policy, publicKeyDer, fetchImpl, clock });
  return { read, records, receiptBytes, archive, request };
}

test('authenticates the workflow, archives, receipt bytes, and current signed comment without leaking the Actions token', async () => {
  for (const archiveOptions of [undefined, { compressed: false, descriptor: false }]) {
    const { read, records, archive, receiptBytes } = fixture({ archiveOptions });
    const proof = await read(request);
    assert.equal(proof.artifactId, 209);
    assert.equal(proof.archiveSha256, sha(archive));
    assert.equal(proof.receiptSha256, sha(receiptBytes));
    assert.deepEqual(proof.receiptBytes, receiptBytes);
    assert.equal(proof.receipt.replay.package_members, 424);
    assert.match(proof.productEvidenceSha256, /^[0-9a-f]{64}$/u);
    const exact = records.find(record => record.url === `${root}${artifactPath}/zip`);
    assert.equal(exact.options.redirect, 'manual');
    assert.equal(exact.options.headers.Authorization, `Bearer ${token}`);
    const redirected = records.find(record => record.url === storage);
    assert.equal(redirected.options.redirect, 'error');
    assert.deepEqual(redirected.options.headers, { Accept: 'application/zip' });
  }
});

test('rejects wrong workflow, attempt, actor, branch pin and signed intent without any artifact download', async () => {
  const cases = [
    [rows => { rows[`${runPath}/attempts/1`].event = 'pull_request'; }, /HOLD_PRODUCT_ARTIFACT_RUN/],
    [rows => { rows[`${runPath}/attempts/1`].run_attempt = 2; }, /HOLD_PRODUCT_ARTIFACT_RUN/],
    [rows => { rows[`${runPath}/attempts/1`].triggering_actor.id = 10; }, /HOLD_PRODUCT_ARTIFACT_RUN/],
    [rows => { rows['/branches/main'].protected = false; }, /HOLD_PRODUCT_ARTIFACT_MAIN/],
    [rows => { rows[commentPath].body += '\n'; }, /HOLD_DOT_TRANSITION_FORMAT/],
    [rows => { rows[`/contents/${workflowPath}?ref=${subject.base}`].content = 'YQ=='; }, /HOLD_PRODUCT_ARTIFACT_WORKFLOW_PIN/],
  ];
  for (const [change, error] of cases) {
    const { read, records } = fixture({ change });
    await assert.rejects(read(request), error);
    assert.equal(records.some(record => record.url.endsWith('/zip')), false);
  }
  await assert.rejects(fixture().read({ ...request, dotIntentSha256: '0'.repeat(64) }), /HOLD_PRODUCT_ARTIFACT_INTENT/);
});

test('rejects ambiguous artifact listings, foreign provenance, mismatched ZIP digest, and unsafe redirects', async () => {
  const cases = [
    [rows => { rows[listingPath].total_count = 2; }, /HOLD_PRODUCT_ARTIFACT_LIST/],
    [rows => { rows[listingPath].artifacts[0].workflow_run.head_repository_id = 1; }, /HOLD_PRODUCT_ARTIFACT_METADATA/],
    [rows => { rows[listingPath].artifacts[0].digest = `sha256:${'0'.repeat(64)}`; }, /HOLD_PRODUCT_ARTIFACT_ARCHIVE_DIGEST/],
    [(_rows, _receipt, settings) => { settings.redirect = 'https://example.invalid/receipt.zip'; }, /HOLD_PRODUCT_ARTIFACT_REDIRECT/],
    [(_rows, _receipt, settings) => { settings.redirect = storage.replace('https:', 'http:'); }, /HOLD_PRODUCT_ARTIFACT_REDIRECT/],
  ];
  for (const [change, error] of cases) await assert.rejects(fixture({ change }).read(request), error);
});

test('rejects malformed/surplus ZIP members, a noncanonical receipt and incomplete replay evidence', async () => {
  for (const archiveOptions of [{ name: '../t00-product-premerge.json' }, { badChecksum: true }, { members: 2 }]) {
    await assert.rejects(fixture({ archiveOptions }).read(request), /HOLD_PRODUCT_ARTIFACT_ZIP/);
  }
  await assert.rejects(fixture({ raw: value => Buffer.from(JSON.stringify(value, null, 2)) }).read(request),
    /HOLD_PRODUCT_ARTIFACT_RECEIPT/);
  await assert.rejects(fixture({ change: (_rows, receipt) => { receipt.replay.candidate_archive_sha256 = '1'.repeat(64); } }).read(request),
    /HOLD_PRODUCT_ARTIFACT_REPLAY/);
  await assert.rejects(fixture({ change: (_rows, receipt) => { receipt.stdoutSha256 = '9'.repeat(64); } }).read(request),
    /HOLD_PRODUCT_ARTIFACT_REPLAY/);
});

test('holds an attempt superseded while reading the artifact', async () => {
  await assert.rejects(fixture({ change: rows => { rows[runPath].run_attempt = 2; } }).read(request),
    /HOLD_PRODUCT_ARTIFACT_CHANGED/);
});

test('discovers the single upstream evidence handle and independently verifies its original comment', async () => {
  const { intent, proof } = await fixture().read.discover({ runId: 103, attempt: 1 });
  assert.equal(intent.commentId, 892);
  assert.equal(intent.dotIntentSha256, dotIntentSha256);
  assert.equal(proof.artifactId, 209);
  await assert.rejects(fixture({ change: rows => { rows[discoveryPath].artifacts[0].name += '-extra'; } })
    .read.discover({ runId: 103, attempt: 1 }), /HOLD_PRODUCT_ARTIFACT_DISCOVERY/);
  await assert.rejects(fixture({ change: rows => { rows[discoveryPath].artifacts[0].id = 210; } })
    .read.discover({ runId: 103, attempt: 1 }), /HOLD_PRODUCT_ARTIFACT_DISCOVERY_CHANGED/);
  await assert.rejects(fixture({ change: rows => { rows[commentPath].body += '\n'; } })
    .read.discover({ runId: 103, attempt: 1 }), /HOLD_DOT_TRANSITION_FORMAT/);
});

test('selects only the T14 replay and probe pinned to the signed task and its scope', async () => {
  const { read, request, records } = fixture({ candidate: t14 });
  const proof = await read(request);
  assert.equal(proof.receipt.schema, 't00.t14-github-independent-premerge/1');
  assert.equal(proof.receipt.replay.installed_probe.result.applyAllowed, false);
  for (const path of ['next/t00/product-profiles.mjs', 'next/t00/setup-product-npm.sh',
    'next/t00/t14-historical-product-replay.py', 'next/t00/t14-installed-preview-probe.mjs']) {
    assert.ok(records.some(record => record.url === `${root}/contents/${path}?ref=${t14.base}`), path);
  }
  assert.ok(!records.some(record => record.url.includes('/contents/next/t00/product-t03-replay.py')));
  const scopeSwap = fixture({ candidate: t14 });
  await assert.rejects(scopeSwap.read({ ...scopeSwap.request, subject: { ...t14, scope: subject.scope } }),
    /HOLD_PRODUCT_ARTIFACT_SUBJECT/);
  assert.equal(scopeSwap.records.length, 0);
});

test('holds before artifact download when a required T14 source or shared toolchain hash differs', async () => {
  for (const path of ['next/t00/product-profiles.mjs', 'next/t00/setup-product-npm.sh',
    'next/t00/t14-historical-product-replay.py', 'next/t00/t14-installed-preview-probe.mjs']) {
    const modified = fixture({ candidate: t14, change(rows) {
      const pin = rows[`/contents/${path}?ref=${t14.base}`];
      const replacement = Buffer.alloc(pin.size, 0x61);
      pin.content = replacement.toString('base64');
    } });
    await assert.rejects(modified.read(modified.request), /HOLD_PRODUCT_ARTIFACT_WORKFLOW_PIN/);
    assert.ok(!modified.records.some(record => record.url.endsWith('/zip')));
  }
});

test('refuses a cross-profile receipt, reference phase, or wrong probe identity independently of stdout hash', async () => {
  const schemaSwap = fixture({ candidate: t14, change(_rows, receipt) {
    receipt.schema = 't00.t03-github-independent-premerge/1';
  } });
  await assert.rejects(schemaSwap.read(schemaSwap.request), /HOLD_PRODUCT_ARTIFACT_RECEIPT/);
  for (const change of [replay => { replay.schema = 't00.t03-exact-pr-replay/3'; },
    replay => { replay.phase = 'reference'; replay.published_candidate_validated = false; },
    replay => { replay.probe_sha256 = '0'.repeat(64); }]) {
    const modified = fixture({ candidate: t14, change(_rows, receipt) {
      change(receipt.replay);
      receipt.stdoutSha256 = sha(independentlyFormattedPythonResult(receipt.replay));
    } });
    await assert.rejects(modified.read(modified.request), /HOLD_PRODUCT_ARTIFACT_REPLAY/);
  }
  const crossReplay = fixture({ change(_rows, receipt) {
    receipt.replay = t14Replay(t14, receipt.verifierSha256, '5'.repeat(64));
    receipt.stdoutSha256 = sha(independentlyFormattedPythonResult(receipt.replay));
  } });
  await assert.rejects(crossReplay.read(crossReplay.request), /HOLD_PRODUCT_ARTIFACT_REPLAY/);
});
