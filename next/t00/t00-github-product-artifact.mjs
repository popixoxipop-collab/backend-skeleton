import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { verifyDotTransitionIntent } from './dot-transition-intent.mjs';

const REPO = 'popixoxipop-collab/backend-skeleton';
const REPO_ID = 1334919554;
const INTAKE = 389;
const ACTOR_ID = 261965176;
const API = `https://api.github.com/repos/${REPO}`;
const WORKFLOW = '.github/workflows/t00-product-replay.yml';
const RECEIPT_SCHEMA = 't00.t03-github-independent-premerge/1';
const ENTRY_NAME = Buffer.from('t00-product-premerge.json');
const MAX_JSON = 256 * 1024;
const MAX_ZIP = 32 * 1024;
const MAX_RECEIPT = 16 * 1024;
const OID = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HISTORICAL_SHA = '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a';
const REPRODUCED_SHA = 'caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742';
const SUBJECT_FIELDS = ['repo', 'repositoryId', 'pr', 'task', 'scope', 'base', 'head', 'tree'];
const PINNED_FILES = [
  [WORKFLOW, 'workflowSha256'], ['next/t00/run-product-replay.mjs', 'runScriptSha256'],
  ['next/t00/product-t03-replay.py', 'verifierSha256'], ['next/t00/dot-transition-intent.mjs', 'intentVerifierSha256'],
];
const REPLAY_PATHS = ['test/capability-next/historical-installed-pair.test.mjs',
  'test/capability-next/historical-installed-probe.mjs'];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameSubject = (observed, expected) => exactKeys(observed, SUBJECT_FIELDS) &&
  SUBJECT_FIELDS.every(key => observed[key] === expected[key]);
const repoIdentity = value => value?.id === REPO_ID && value.full_name === REPO;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function timestamp(value) {
  requireIt(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
    'HOLD_PRODUCT_ARTIFACT_TIME');
  const millis = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  requireIt(Number.isFinite(millis) && new Date(millis).toISOString() === canonical, 'HOLD_PRODUCT_ARTIFACT_TIME');
  return millis;
}

async function readBytes(response, maxBytes) {
  requireIt(response.body, 'HOLD_PRODUCT_ARTIFACT_RESPONSE');
  const reader = response.body.getReader();
  const buffers = [];
  let total = 0;
  while (true) {
    let next;
    try { next = await reader.read(); } catch { throw new Error('HOLD_PRODUCT_ARTIFACT_TRANSPORT'); }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('HOLD_PRODUCT_ARTIFACT_SIZE');
    }
    buffers.push(next.value);
  }
  return Buffer.concat(buffers, total);
}

function parseObject(bytes, error) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(error); }
}

// Read a single bounded member into memory. Never extract paths or execute archived content.
function unzipReceipt(bytes) {
  const end = bytes.length - 22;
  const badZip = 'HOLD_PRODUCT_ARTIFACT_ZIP';
  requireIt(end >= 76 && bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt32LE(end + 4) === 0 &&
    bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1 && bytes.readUInt16LE(end + 20) === 0,
  badZip);
  const central = bytes.readUInt32LE(end + 16);
  const centralSize = bytes.readUInt32LE(end + 12);
  requireIt(central >= 30 && central + 46 <= end && central + centralSize === end &&
    bytes.readUInt32LE(central) === 0x02014b50 && bytes.readUInt32LE(central + 42) === 0, badZip);
  const flags = bytes.readUInt16LE(central + 8);
  const method = bytes.readUInt16LE(central + 10);
  const checksum = bytes.readUInt32LE(central + 16);
  const compressed = bytes.readUInt32LE(central + 20);
  const size = bytes.readUInt32LE(central + 24);
  const mode = bytes.readUInt32LE(central + 38) >>> 16 & 0o170000;
  requireIt((flags & ~0x080e) === 0 && (method === 0 || method === 8) && (mode === 0 || mode === 0o100000) &&
    size > 0 && size <= MAX_RECEIPT && compressed > 0 && (method !== 0 || compressed === size) &&
    bytes.readUInt16LE(central + 28) === ENTRY_NAME.length && bytes.readUInt16LE(central + 32) === 0 &&
    bytes.readUInt16LE(central + 34) === 0 && 46 + ENTRY_NAME.length + bytes.readUInt16LE(central + 30) === centralSize &&
    bytes.subarray(central + 46, central + 46 + ENTRY_NAME.length).equals(ENTRY_NAME), badZip);
  requireIt(bytes.readUInt32LE(0) === 0x04034b50 && bytes.readUInt16LE(6) === flags &&
    bytes.readUInt16LE(8) === method && bytes.readUInt16LE(26) === ENTRY_NAME.length &&
    bytes.subarray(30, 30 + ENTRY_NAME.length).equals(ENTRY_NAME), badZip);
  const start = 30 + ENTRY_NAME.length + bytes.readUInt16LE(28);
  const finish = start + compressed;
  const localValues = [bytes.readUInt32LE(14), bytes.readUInt32LE(18), bytes.readUInt32LE(22)];
  const values = [checksum, compressed, size];
  requireIt(finish <= central, badZip);
  if (flags & 8) {
    const descriptorStart = finish + (central - finish === 16 && bytes.readUInt32LE(finish) === 0x08074b50 ? 4 : 0);
    requireIt(descriptorStart + 12 === central && values.every((value, index) =>
      (localValues[index] === 0 || localValues[index] === value) &&
      bytes.readUInt32LE(descriptorStart + index * 4) === value), badZip);
  } else {
    requireIt(finish === central && values.every((value, index) => localValues[index] === value), badZip);
  }
  let receipt;
  try {
    const member = bytes.subarray(start, finish);
    receipt = method === 0 ? member : inflateRawSync(member, { maxOutputLength: MAX_RECEIPT });
  } catch { throw new Error(badZip); }
  requireIt(receipt.length === size && crc32(receipt) === checksum, badZip);
  return receipt;
}

function pythonCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${pythonCanonicalJson(value[key])}`);
    return `{${fields.join(', ')}}`;
  }
  return JSON.stringify(value);
}

function verifyReplay(value, subject, baseTree, stdoutSha256) {
  const expected = {
    schema: 't00.t03-exact-pr-replay/3', phase: 'premerge', pull_request: subject.pr, base: subject.base,
    base_tree: baseTree, source_head: subject.head, tested_commit: subject.head, tested_tree: subject.tree,
    historical_archive_sha256: HISTORICAL_SHA, replayed_historical_archive_sha256: REPRODUCED_SHA,
    historical_archive_kind: 'reproduced-from-pinned-historical-tree', base_archive_sha256: REPRODUCED_SHA,
    candidate_archive_sha256: REPRODUCED_SHA, package_file_bytes_match_official_baseline: true,
    package_members: 424, candidate_tests_executed: false, requires_separate_github_ci_and_authority: true,
    normal_restore: true, sigterm_probe_restore: true, node: 'v26.7.0', npm: '11.19.0',
    release_authorized: false, runtime_certified: false,
  };
  const outcome = { legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected' };
  requireIt(exactKeys(value, [...Object.keys(expected), 'previous_installed_inventory_sha256', 'scope_paths', 'outcome']) &&
    Object.entries(expected).every(([key, item]) => value[key] === item) &&
    matches(SHA256, value.previous_installed_inventory_sha256) && Array.isArray(value.scope_paths) &&
    value.scope_paths.length === REPLAY_PATHS.length && REPLAY_PATHS.every((path, index) => path === value.scope_paths[index]) &&
    exactKeys(value.outcome, Object.keys(outcome)) && Object.entries(outcome).every(([key, item]) => value.outcome[key] === item) &&
    sha256(`${pythonCanonicalJson(value)}\n`) === stdoutSha256, 'HOLD_PRODUCT_ARTIFACT_REPLAY');
}

function safeArchiveRedirect(location) {
  let url;
  try { url = new URL(location); } catch { throw new Error('HOLD_PRODUCT_ARTIFACT_REDIRECT'); }
  const trustedHost = /^(?:productionresultssa[0-9]+\.blob\.core\.windows\.net|[a-z0-9-]+\.actions\.githubusercontent\.com)$/u;
  requireIt(url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' &&
    url.hash === '' && matches(trustedHost, url.hostname) && url.pathname !== '/', 'HOLD_PRODUCT_ARTIFACT_REDIRECT');
  return url.href;
}

export function createGitHubProductArtifactReader({ actionsReadToken, policy, publicKeyDer,
  fetchImpl = fetch, clock = Date.now }) {
  requireIt(matches(/^[A-Za-z0-9_.-]{20,256}$/u, actionsReadToken) && positiveId(policy?.workflowId) &&
    PINNED_FILES.every(([, key]) => matches(SHA256, policy[key])) &&
    typeof fetchImpl === 'function' && typeof clock === 'function', 'HOLD_PRODUCT_ARTIFACT_CONFIGURATION');
  const pins = Object.freeze({ ...policy });

  async function request(url, { api = true, redirect = 'error', signal } = {}) {
    const headers = api ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${actionsReadToken}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 't00-product-artifact' } : { Accept: 'application/zip' };
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers, redirect, signal, cache: 'no-store' }); }
    catch { throw new Error('HOLD_PRODUCT_ARTIFACT_TRANSPORT'); }
    requireIt(response && !response.redirected && response.url === url, 'HOLD_PRODUCT_ARTIFACT_TRANSPORT');
    return response;
  }

  async function getJson(path, signal) {
    const response = await request(`${API}${path}`, { signal });
    requireIt(response.status === 200, `HOLD_PRODUCT_ARTIFACT_GITHUB_${response.status}`);
    return parseObject(await readBytes(response, MAX_JSON), 'HOLD_PRODUCT_ARTIFACT_JSON');
  }

  async function pinnedFiles(base, signal) {
    await Promise.all(PINNED_FILES.map(async ([path, key]) => {
      const file = await getJson(`/contents/${path}?ref=${base}`, signal);
      requireIt(file?.type === 'file' && file.path === path && file.encoding === 'base64' && typeof file.content === 'string',
        'HOLD_PRODUCT_ARTIFACT_WORKFLOW_PIN');
      const encoded = file.content.replace(/\r?\n/gu, '');
      const bytes = Buffer.from(encoded, 'base64');
      requireIt(bytes.length > 0 && bytes.length === file.size && bytes.toString('base64') === encoded &&
        sha256(bytes) === pins[key], 'HOLD_PRODUCT_ARTIFACT_WORKFLOW_PIN');
    }));
  }

  async function readProductPremergeReceipt({ runId, attempt, commentId, subject, dotIntentSha256 }) {
    requireIt([runId, attempt, commentId].every(positiveId) && exactKeys(subject, SUBJECT_FIELDS) &&
      subject.repo === REPO && subject.repositoryId === REPO_ID && positiveId(subject.pr) && subject.pr !== INTAKE &&
      subject.task === 'T03-06' && subject.scope === 'historical-installed-package-replay' && subject.base !== subject.head &&
      [subject.base, subject.head, subject.tree].every(value => matches(OID, value)) && matches(SHA256, dotIntentSha256),
    'HOLD_PRODUCT_ARTIFACT_SUBJECT');
    const signal = AbortSignal.timeout(45_000);
    const runPath = `/actions/runs/${runId}`;
    const commentPath = `/issues/comments/${commentId}`;
    const [run, workflow, branch, comment] = await Promise.all([
      getJson(`${runPath}/attempts/${attempt}`, signal), getJson(`/actions/workflows/${pins.workflowId}`, signal),
      getJson('/branches/main', signal), getJson(commentPath, signal),
    ]);
    requireIt(workflow?.id === pins.workflowId && workflow.path === WORKFLOW && workflow.state === 'active' &&
      run?.id === runId && run.run_attempt === attempt && run.workflow_id === pins.workflowId && run.path === WORKFLOW &&
      run.head_branch === 'main' && run.head_sha === subject.base && run.event === 'issue_comment' &&
      repoIdentity(run.repository) && repoIdentity(run.head_repository) && run.actor?.id === ACTOR_ID &&
      run.triggering_actor?.id === ACTOR_ID && run.status === 'completed' && run.conclusion === 'success',
    'HOLD_PRODUCT_ARTIFACT_RUN');
    const baseTree = branch?.commit?.commit?.tree?.sha;
    requireIt(branch?.name === 'main' && branch.protected === true && branch.commit?.sha === subject.base && matches(OID, baseTree),
      'HOLD_PRODUCT_ARTIFACT_MAIN');
    const start = timestamp(run.run_started_at);
    const updated = timestamp(run.updated_at);
    const now = clock();
    requireIt(Number.isSafeInteger(now) && start <= updated && updated <= now && comment?.id === commentId &&
      comment.url === `${API}${commentPath}` && timestamp(comment.created_at) <= start, 'HOLD_PRODUCT_ARTIFACT_TIME');
    const intent = verifyDotTransitionIntent({ repository: REPO, repositoryId: REPO_ID, intake: INTAKE,
      comment, now: Math.floor(now / 1000), publicKeyDer });
    requireIt(sameSubject(intent.subject, subject) && intent.dotIntentSha256 === dotIntentSha256,
      'HOLD_PRODUCT_ARTIFACT_INTENT');
    await pinnedFiles(subject.base, signal);

    const name = `t00-product-premerge-${runId}-${attempt}-${commentId}`;
    const listing = await getJson(`${runPath}/artifacts?name=${name}&per_page=10`, signal);
    requireIt(listing?.total_count === 1 && Array.isArray(listing.artifacts) && listing.artifacts.length === 1,
      'HOLD_PRODUCT_ARTIFACT_LIST');
    const [artifact] = listing.artifacts;
    const artifactPath = `/actions/artifacts/${artifact?.id}`;
    requireIt(positiveId(artifact?.id) && artifact.name === name && artifact.expired === false &&
      artifact.url === `${API}${artifactPath}` && artifact.archive_download_url === `${API}${artifactPath}/zip` &&
      artifact.workflow_run?.id === runId && artifact.workflow_run?.repository_id === REPO_ID &&
      artifact.workflow_run?.head_repository_id === REPO_ID && artifact.workflow_run.head_branch === 'main' &&
      artifact.workflow_run.head_sha === subject.base && positiveId(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= MAX_ZIP && matches(/^sha256:[0-9a-f]{64}$/u, artifact.digest),
    'HOLD_PRODUCT_ARTIFACT_METADATA');
    const artifactCreated = timestamp(artifact.created_at);
    requireIt(artifactCreated >= start && artifactCreated <= updated && timestamp(artifact.expires_at) > now,
      'HOLD_PRODUCT_ARTIFACT_TIME');

    const redirect = await request(`${API}${artifactPath}/zip`, { redirect: 'manual', signal });
    requireIt(redirect.status === 302, `HOLD_PRODUCT_ARTIFACT_GITHUB_${redirect.status}`);
    const archiveUrl = safeArchiveRedirect(redirect.headers.get('location'));
    const download = await request(archiveUrl, { api: false, signal });
    requireIt(download.status === 200, 'HOLD_PRODUCT_ARTIFACT_DOWNLOAD');
    const archive = await readBytes(download, artifact.size_in_bytes);
    const archiveSha256 = sha256(archive);
    requireIt(archive.length === artifact.size_in_bytes && `sha256:${archiveSha256}` === artifact.digest,
      'HOLD_PRODUCT_ARTIFACT_ARCHIVE_DIGEST');
    const receiptBytes = unzipReceipt(archive);
    const receipt = parseObject(receiptBytes, 'HOLD_PRODUCT_ARTIFACT_RECEIPT');
    requireIt(exactKeys(receipt, ['schema', 'workflow', 'commit', 'runId', 'attempt', 'commentId', 'dotIntentSha256',
      'verifierSha256', 'stdoutSha256', 'completedAt', 'subject', 'replay']) &&
      Buffer.from(`${JSON.stringify(receipt)}\n`).equals(receiptBytes) && receipt.schema === RECEIPT_SCHEMA &&
      receipt.workflow === WORKFLOW && receipt.commit === subject.base && receipt.runId === runId &&
      receipt.attempt === attempt && receipt.commentId === commentId && receipt.dotIntentSha256 === dotIntentSha256 &&
      receipt.verifierSha256 === pins.verifierSha256 && matches(SHA256, receipt.stdoutSha256) && sameSubject(receipt.subject, subject),
    'HOLD_PRODUCT_ARTIFACT_RECEIPT');
    const completed = timestamp(receipt.completedAt);
    requireIt(completed >= start && completed <= artifactCreated + 999 && completed <= now,
      'HOLD_PRODUCT_ARTIFACT_TIME');
    verifyReplay(receipt.replay, subject, baseTree, receipt.stdoutSha256);

    const [latest, currentMain, currentComment] = await Promise.all([
      getJson(runPath, signal), getJson('/branches/main', signal), getJson(commentPath, signal),
    ]);
    requireIt(latest?.id === runId && latest.run_attempt === attempt && latest.head_sha === subject.base &&
      latest.status === 'completed' && latest.conclusion === 'success' && latest.updated_at === run.updated_at &&
      currentMain?.name === 'main' && currentMain.protected === true && currentMain.commit?.sha === subject.base &&
      currentMain.commit?.commit?.tree?.sha === baseTree && currentComment?.id === commentId &&
      currentComment.body === comment.body && currentComment.updated_at === comment.updated_at &&
      Math.floor(clock() / 1000) < intent.expiresAt, 'HOLD_PRODUCT_ARTIFACT_CHANGED');

    const receiptSha256 = sha256(receiptBytes);
    const evidence = { schema: 't00.github-product-artifact-evidence/1', runId, attempt, artifactId: artifact.id,
      commentId, dotIntentSha256, receiptSha256, archiveSha256 };
    return { ...evidence, receipt, receiptBytes, productEvidenceSha256: sha256(`${JSON.stringify(evidence)}\n`) };
  }

  // A workflow_run event carries the completed upstream run, not the originating issue comment.
  // Resolve that comment from one artifact name returned by GitHub, then verify the comment and
  // the complete evidence independently. Neither the name nor the event is an authorization.
  readProductPremergeReceipt.discover = async ({ runId, attempt }) => {
    requireIt([runId, attempt].every(positiveId), 'HOLD_PRODUCT_ARTIFACT_DISCOVERY');
    const signal = AbortSignal.timeout(45_000);
    const path = `/actions/runs/${runId}/artifacts?per_page=50`;
    const listing = await getJson(path, signal);
    requireIt(Array.isArray(listing?.artifacts) && listing.total_count === listing.artifacts.length &&
      listing.artifacts.length <= 50, 'HOLD_PRODUCT_ARTIFACT_DISCOVERY');
    const prefix = `t00-product-premerge-${runId}-${attempt}-`;
    const possible = listing.artifacts.filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix));
    requireIt(possible.length === 1 && positiveId(possible[0].id) && possible[0].expired === false,
      'HOLD_PRODUCT_ARTIFACT_DISCOVERY');
    const id = possible[0].name.slice(prefix.length);
    const commentId = Number(id);
    requireIt(/^[1-9][0-9]{0,15}$/u.test(id) && positiveId(commentId) && String(commentId) === id,
      'HOLD_PRODUCT_ARTIFACT_DISCOVERY');
    const comment = await getJson(`/issues/comments/${commentId}`, signal);
    requireIt(comment?.id === commentId && comment.url === `${API}/issues/comments/${commentId}`,
      'HOLD_PRODUCT_ARTIFACT_DISCOVERY');
    const intent = verifyDotTransitionIntent({ repository: REPO, repositoryId: REPO_ID, intake: INTAKE,
      comment, now: Math.floor(clock() / 1000), publicKeyDer });
    const proof = await readProductPremergeReceipt({ runId, attempt, commentId, subject: intent.subject,
      dotIntentSha256: intent.dotIntentSha256 });
    requireIt(proof.artifactId === possible[0].id, 'HOLD_PRODUCT_ARTIFACT_DISCOVERY_CHANGED');
    return { intent, proof };
  };
  return Object.freeze(readProductPremergeReceipt);
}
