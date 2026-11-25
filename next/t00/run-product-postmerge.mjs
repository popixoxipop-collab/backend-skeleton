import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyTransitionPermit } from './transition-permit.mjs';
import { verifyDotTransitionIntent } from './dot-transition-intent.mjs';
import { encodeProductAttestation, PRODUCT_ATTESTATION_VALIDITY_SECONDS } from './promotion-authority.mjs';

const repository = 'popixoxipop-collab/backend-skeleton';
const repositoryId = 1334919554;
const publisherBotId = 361175685;
const workflowBotId = 41898282;
const intake = 389;
const origin = 'https://api.github.com';
const api = origin + '/repos/' + repository;
const transitionWorkflow = '.github/workflows/t00-product-transition.yml';
const replayWorkflow = '.github/workflows/t00-product-replay.yml';
const ciWorkflow = '.github/workflows/ci.yml';
const historicalArchive = '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a';
const reproducedArchive = 'caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742';
const productPublicDer = 'MCowBQYDK2VwAyEARSKqohZkpsVC29H4Sgo9gzvdwh5hzOLqpbT3DcOt/s8=';
const keyPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = /^[0-9a-f]{40}$/u;
const digest = /^[0-9a-f]{64}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const attestationSchema = 't00.met-product-attestation/1';
const caption = 'T00-MET-ATTESTATION-V1 ';
const replayPath = fileURLToPath(new URL('./product-t03-replay.py', import.meta.url));
const files = Object.freeze({
  envelope: 'attestation.json',
  independent: 'independent-manifest.json',
  adjudication: 'adjudication-manifest.json',
  replay: 'postmerge-replay.json',
});
const expectedPaths = [
  'test/capability-next/historical-installed-pair.test.mjs',
  'test/capability-next/historical-installed-probe.mjs',
];
const hash = value => createHash('sha256').update(value).digest('hex');
const sameRepository = value => value?.id === repositoryId && value.full_name === repository;
const validId = value => Number.isSafeInteger(value) && value > 0;
const isSha = value => typeof value === 'string' && sha.test(value);
const isDigest = value => typeof value === 'string' && digest.test(value);
const subjectKeys = ['repo', 'repositoryId', 'pr', 'task', 'scope', 'base', 'head', 'tree'];
const epoch = () => Math.floor(Date.now() / 1000);

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function exactKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function dateSeconds(value) {
  requireIt(typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value)),
    'HOLD_POSTMERGE_TIME');
  const millis = Date.parse(value);
  requireIt(new Date(millis).toISOString() === value.replace(/Z$/u, '.000Z'), 'HOLD_POSTMERGE_TIME');
  return millis / 1000;
}

export function verifyPostmergeTrigger({ env, event, permit, merged }) {
  const subject = permit?.subject;
  const run = event?.workflow_run;
  requireIt(env.GITHUB_REPOSITORY === repository && env.GITHUB_REPOSITORY_ID === String(repositoryId) &&
    env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === repository + '/' + transitionWorkflow + '@refs/heads/main' &&
    isSha(env.GITHUB_SHA) && env.GITHUB_SHA === subject?.base &&
    /^\d+$/u.test(env.GITHUB_RUN_ID ?? '') && validId(Number(env.GITHUB_RUN_ID)) &&
    /^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') && validId(Number(env.GITHUB_RUN_ATTEMPT)) &&
    event.action === 'completed' && sameRepository(event.repository) &&
    run?.id === permit.productRunId && run.run_attempt === permit.productAttempt && run.event === 'issue_comment' &&
    run.path?.split('@')[0] === replayWorkflow && run.head_branch === 'main' && run.head_sha === subject.base &&
    run.status === 'completed' && run.conclusion === 'success' && sameRepository(run.repository),
  'HOLD_POSTMERGE_WORKFLOW_IDENTITY');
  requireIt(subject.repo === repository && subject.repositoryId === repositoryId && validId(subject.pr) &&
    subject.task === 'T03-06' && subject.scope === 'historical-installed-package-replay' &&
    [subject.base, subject.head, subject.tree, permit.baseTree].every(isSha) && subject.base !== subject.head &&
    [permit.productEvidenceSha256, permit.receiptSha256, permit.dotIntentSha256,
      permit.independentReviewSha256].every(isDigest) && validId(permit.prCiRunId) && validId(permit.commentId) &&
    validId(permit.verifiedAt) && validId(permit.expiresAt) && permit.verifiedAt < permit.expiresAt &&
    exactKeys(merged, ['merge', 'pr', 'head', 'tree', 'base']) && isSha(merged.merge) &&
    merged.merge !== subject.base && merged.merge !== subject.head &&
    ['pr', 'head', 'tree', 'base'].every(key => merged[key] === subject[key]),
  'HOLD_POSTMERGE_PERMIT_BINDING');
  return Object.freeze({ task: subject.task, repository, repositoryId, scope: subject.scope, pr: subject.pr,
    head: subject.head, merge: merged.merge, tree: subject.tree });
}

async function readResponse(response, limit = 2_000_000) {
  requireIt(response?.body, 'HOLD_POSTMERGE_GITHUB_RESPONSE');
  const reader = response.body.getReader();
  const buffers = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('HOLD_POSTMERGE_GITHUB_RESPONSE');
    }
    buffers.push(next.value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers, size)));
}

function github(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 't00-independent-postmerge',
    'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  async function request(path, body) {
    const writing = body !== undefined;
    requireIt(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') &&
      (!writing || (token && path === '/issues/' + intake + '/comments')), 'HOLD_POSTMERGE_GITHUB_ENDPOINT');
    const url = api + path;
    const response = await fetch(url, {
      method: writing ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: writing ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(writing && { body: JSON.stringify({ body }) }),
    });
    requireIt(response?.status === (writing ? 201 : 200) && response.url === url && !response.redirected,
      writing ? 'HOLD_POSTMERGE_COMMENT_WRITE' : 'HOLD_POSTMERGE_GITHUB_READ');
    return readResponse(response);
  }
  return { read: path => request(path), publish: body => request('/issues/' + intake + '/comments', body) };
}

function requiredChecks(branch) {
  const raw = branch?.protection?.required_status_checks?.checks;
  requireIt(branch?.name === 'main' && branch.protected === true && isSha(branch.commit?.sha) &&
    Array.isArray(raw) && raw.length > 0 && raw.length < 100 &&
    raw.every(gate => typeof gate?.context === 'string' && gate.context.length > 0 && validId(gate.app_id)) &&
    new Set(raw.map(gate => gate.context)).size === raw.length, 'HOLD_POSTMERGE_PROTECTED_MAIN');
  return raw.map(({ context, app_id }) => ({ context, appId: app_id }))
    .sort((left, right) => left.context.localeCompare(right.context));
}

export async function verifyPostmergeGitHub(read, target, permit, verifyIntent = verifyDotTransitionIntent) {
  const [pull, merge, base, branch, replay, originComment] = await Promise.all([
    read('/pulls/' + target.pr),
    read('/git/commits/' + target.merge),
    read('/git/commits/' + permit.subject.base),
    read('/branches/main'),
    read('/actions/runs/' + permit.productRunId + '/attempts/' + permit.productAttempt),
    read('/issues/comments/' + permit.commentId),
  ]);
  const mergedAt = dateSeconds(pull?.merged_at);
  requireIt(pull.number === target.pr && pull.state === 'closed' && pull.merged === true && pull.draft === false &&
    pull.merge_commit_sha === target.merge && pull.head?.sha === target.head &&
    pull.head.ref === 'dot/t00-publisher/' + target.head && pull.base?.ref === 'main' &&
    [pull.head.repo, pull.base.repo].every(sameRepository) &&
    [pull.user, pull.merged_by].every(person => person?.id === publisherBotId && person.type === 'Bot') &&
    permit.verifiedAt <= mergedAt && mergedAt < permit.expiresAt,
  'HOLD_POSTMERGE_EXACT_BOT_MERGE');
  requireIt(merge?.sha === target.merge && merge.tree?.sha === target.tree && merge.parents?.length === 2 &&
    merge.parents[0]?.sha === permit.subject.base && merge.parents[1]?.sha === target.head &&
    base?.sha === permit.subject.base && base.tree?.sha === permit.baseTree,
  'HOLD_POSTMERGE_EXACT_COMMIT');
  requireIt(replay?.id === permit.productRunId && replay.run_attempt === permit.productAttempt &&
    replay.event === 'issue_comment' && replay.path?.split('@')[0] === replayWorkflow &&
    replay.head_branch === 'main' && replay.head_sha === permit.subject.base && sameRepository(replay.repository) &&
    replay.status === 'completed' && replay.conclusion === 'success' && dateSeconds(replay.updated_at) <= mergedAt,
  'HOLD_POSTMERGE_PRIOR_PRODUCT_RUN');
  const original = verifyIntent({ repository, repositoryId, intake, comment: originComment, now: mergedAt });
  requireIt(original.commentId === permit.commentId && original.dotIntentSha256 === permit.dotIntentSha256 &&
    subjectKeys.every(key => original.subject[key] === permit.subject[key]), 'HOLD_POSTMERGE_DOT_ORIGIN');
  const required = requiredChecks(branch);
  const main = branch.commit.sha;
  if (main !== target.merge) {
    const ancestry = await read('/compare/' + target.merge + '...' + main + '?per_page=1');
    requireIt(ancestry?.status === 'ahead' && ancestry.merge_base_commit?.sha === target.merge,
      'HOLD_POSTMERGE_MERGE_NOT_IN_MAIN');
  }
  requireIt(Array.isArray(permit.policy?.requiredChecks) &&
    JSON.stringify(required) === JSON.stringify(permit.policy.requiredChecks.map(({ context, appId }) => ({ context, appId }))
      .sort((left, right) => left.context.localeCompare(right.context))), 'HOLD_POSTMERGE_REQUIRED_POLICY_CHANGED');
  return { mergedAt, main, required };
}

function verifyRun(run, head, event) {
  requireIt(validId(run?.id) && validId(run.run_attempt) && run.head_sha === head &&
    run.path?.split('@')[0] === ciWorkflow && run.event === event &&
    (event !== 'push' || run.head_branch === 'main') && sameRepository(run.repository),
  'HOLD_POSTMERGE_EXACT_CI');
}

function completeChecks(observed, required, head, runId) {
  const checks = observed?.check_runs;
  const prefix = 'https://github.com/' + repository + '/actions/runs/' + runId + '/job/';
  requireIt(Array.isArray(checks) && checks.length < 100 && observed.total_count === checks.length,
    'HOLD_POSTMERGE_CI_CHECK_PAGE');
  return required.every(gate => checks.some(check => check.name === gate.context && check.app?.id === gate.appId &&
    check.head_sha === head && check.status === 'completed' && check.conclusion === 'success' &&
    typeof check.details_url === 'string' && check.details_url.startsWith(prefix) &&
    /^[1-9][0-9]*$/u.test(check.details_url.slice(prefix.length))));
}

export async function waitForPostmergeCI(read, target, permit, required, { attempts = 30, wait = sleep } = {}) {
  const pr = await read('/actions/runs/' + permit.prCiRunId);
  verifyRun(pr, target.head, 'pull_request');
  requireIt(pr.id === permit.prCiRunId && pr.status === 'completed' && pr.conclusion === 'success' &&
    completeChecks(await read('/commits/' + target.head + '/check-runs?filter=latest&per_page=100'),
      required, target.head, pr.id), 'HOLD_POSTMERGE_PR_REQUIRED_CI');
  const search = '?event=push&branch=main&head_sha=' + target.merge + '&per_page=10';
  for (let index = 0; index < attempts; index++) {
    const runs = await read('/actions/workflows/ci.yml/runs' + search);
    requireIt(Array.isArray(runs?.workflow_runs) && runs.total_count === runs.workflow_runs.length &&
      runs.workflow_runs.length <= 1, 'HOLD_POSTMERGE_MAIN_CI_AMBIGUOUS');
    const main = runs.workflow_runs[0];
    if (main) {
      verifyRun(main, target.merge, 'push');
      if (main.status === 'completed') {
        requireIt(main.conclusion === 'success', 'HOLD_POSTMERGE_MAIN_CI_FAILED');
        if (completeChecks(await read('/commits/' + target.merge + '/check-runs?filter=latest&per_page=100'),
          required, target.merge, main.id)) return { pr, main };
      }
    }
    if (index + 1 < attempts) await wait(30_000);
  }
  throw new Error('HOLD_POSTMERGE_MAIN_CI_PENDING');
}

export function verifyPostmergeReplay(stdout, target, permit) {
  requireIt(typeof stdout === 'string' && Buffer.byteLength(stdout) <= 16_384 && /^[^\n]+\n$/u.test(stdout),
    'HOLD_POSTMERGE_PRODUCT_REPLAY');
  const replay = JSON.parse(stdout);
  const fields = {
    schema: 't00.t03-exact-pr-replay/3', phase: 'postmerge', pull_request: target.pr,
    base: permit.subject.base, base_tree: permit.baseTree, source_head: target.head,
    tested_commit: target.merge, tested_tree: target.tree,
    historical_archive_sha256: historicalArchive, replayed_historical_archive_sha256: reproducedArchive,
    historical_archive_kind: 'reproduced-from-pinned-historical-tree',
    base_archive_sha256: reproducedArchive, candidate_archive_sha256: reproducedArchive,
    package_file_bytes_match_official_baseline: true, package_members: 424,
    candidate_tests_executed: false, requires_separate_github_ci_and_authority: true,
    normal_restore: true, sigterm_probe_restore: true, node: 'v26.7.0', npm: '11.19.0',
    release_authorized: false, runtime_certified: false,
  };
  const outcome = { legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected' };
  requireIt(exactKeys(replay, [...Object.keys(fields), 'scope_paths', 'previous_installed_inventory_sha256', 'outcome']) &&
    Object.entries(fields).every(([key, value]) => replay[key] === value) &&
    Array.isArray(replay.scope_paths) && replay.scope_paths.length === expectedPaths.length &&
    expectedPaths.every((value, index) => replay.scope_paths[index] === value) &&
    isDigest(replay.previous_installed_inventory_sha256) && exactKeys(replay.outcome, Object.keys(outcome)) &&
    Object.entries(outcome).every(([key, value]) => replay.outcome[key] === value), 'HOLD_POSTMERGE_PRODUCT_REPLAY');
  return replay;
}

function replayInProcess(target, permit, path) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', replayPath, String(target.pr), 'postmerge',
    '--base', permit.subject.base, '--base-tree', permit.baseTree, '--head', target.head, '--head-tree', target.tree,
    '--reproduce-historical-archive'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 16_384,
    env: { PATH: path ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  requireIt(result.status === 0 && result.stderr === '', 'HOLD_POSTMERGE_PRODUCT_EXECUTION');
  verifyPostmergeReplay(result.stdout, target, permit);
  return result.stdout;
}

function signProduct(bytes, encodedKey, expectedProductPublicDer) {
  requireIt(typeof encodedKey === 'string' && /^[A-Za-z0-9+/]{64}$/u.test(encodedKey), 'HOLD_POSTMERGE_SIGNING_KEY');
  const der = Buffer.from(encodedKey, 'base64');
  try {
    requireIt(der.length === 48 && der.toString('base64') === encodedKey &&
      der.subarray(0, keyPrefix.length).equals(keyPrefix), 'HOLD_POSTMERGE_SIGNING_KEY');
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    requireIt(key.asymmetricKeyType === 'ed25519' &&
      createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') === expectedProductPublicDer,
    'HOLD_POSTMERGE_SIGNING_KEY');
    return sign(null, bytes, key).toString('base64url');
  } finally { der.fill(0); }
}

export function buildPostmergeAttestation({ target, permit, ci, required, mergedAt, main, replayStdout, verifierSha256,
  issuedAt, encodedKey, expectedProductPublicDer = productPublicDer }) {
  const replay = verifyPostmergeReplay(replayStdout, target, permit);
  requireIt(isDigest(verifierSha256) && isSha(main) && validId(issuedAt) && validId(mergedAt) && issuedAt >= mergedAt &&
    Array.isArray(required) && required.length > 0 && ci.pr?.id === permit.prCiRunId && validId(ci.main?.id),
  'HOLD_POSTMERGE_SIGNING_EVIDENCE');
  const premerge = { phase: 'premerge', base: permit.subject.base, testedCommit: target.head,
    workflow: replayWorkflow, githubRunId: permit.productRunId, githubRunAttempt: permit.productAttempt,
    manifestSha256: permit.receiptSha256, evidenceSha256: permit.productEvidenceSha256,
    dotIntentSha256: permit.dotIntentSha256 };
  const postmerge = { phase: 'postmerge', base: permit.subject.base, testedCommit: target.merge,
    verifierSha256, manifestSha256: hash(replayStdout), testedTree: replay.tested_tree };
  const independent = Buffer.from(JSON.stringify({ schema: 't00.met-independent-replay-manifest/1',
    target, premerge, postmerge }));
  const independentManifestSha256 = hash(independent);
  const reviewEvidenceSha256 = permit.independentReviewSha256;
  const prCiRun = ci.pr.id;
  const mainCiRun = ci.main.id;
  const adjudication = Buffer.from(JSON.stringify({ schema: 't00.met-adjudication-manifest/1',
    target, base: permit.subject.base, protectedMain: main, prCiRun, mainCiRun, reviewEvidenceSha256,
    checked: required.length, formalGitHubReview: false, independentManifestSha256,
    requiredChecks: required, mergedAt, prCiAttempt: ci.pr.run_attempt, mainCiAttempt: ci.main.run_attempt }));
  const adjudicationManifestSha256 = hash(adjudication);
  const bytes = encodeProductAttestation({ schema: attestationSchema, ...target, prCiRun, mainCiRun,
    reviewEvidenceSha256, independentManifestSha256, adjudicationManifestSha256,
    issuedAt, expiresAt: issuedAt + PRODUCT_ATTESTATION_VALIDITY_SECONDS }, issuedAt);
  const envelope = { attestation: { body: bytes.toString('base64url'),
    signature: signProduct(bytes, encodedKey, expectedProductPublicDer) }, attestationSha256: hash(bytes),
    independentManifestSha256, adjudicationManifestSha256 };
  return { envelope, independent, adjudication };
}

function readFile(file, maxBytes) {
  const stat = lstatSync(file);
  requireIt(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes &&
    (stat.mode & 0o022) === 0, 'HOLD_POSTMERGE_ARTIFACT_FILE');
  return readFileSync(file);
}

function decodeAttestation(attestation) {
  requireIt(exactKeys(attestation, ['body', 'signature']) && /^[A-Za-z0-9_-]{1,4096}$/u.test(attestation.body) &&
    /^[A-Za-z0-9_-]{86}$/u.test(attestation.signature), 'HOLD_POSTMERGE_ATTESTATION');
  const bytes = Buffer.from(attestation.body, 'base64url');
  const signature = Buffer.from(attestation.signature, 'base64url');
  const key = createPublicKey({ key: Buffer.from(productPublicDer, 'base64'), format: 'der', type: 'spki' });
  requireIt(bytes.toString('base64url') === attestation.body && signature.toString('base64url') === attestation.signature &&
    signature.length === 64 && verify(null, bytes, key, signature), 'HOLD_POSTMERGE_ATTESTATION');
  const value = JSON.parse(bytes.toString('utf8'));
  requireIt(value.schema === attestationSchema && bytes.equals(encodeProductAttestation(value, value.issuedAt)),
    'HOLD_POSTMERGE_ATTESTATION');
  return value;
}

function matchingPublishedAttestation(comment, expected) {
  if (comment?.user?.id !== workflowBotId || comment.user.type !== 'Bot' || !validId(comment.id) ||
      comment.issue_url !== api + '/issues/' + intake || comment.created_at !== comment.updated_at ||
      typeof comment.body !== 'string' || !comment.body.startsWith(caption)) return false;
  const fields = comment.body.slice(caption.length).split('.');
  if (fields.length !== 2) return false;
  try {
    const value = decodeAttestation({ body: fields[0], signature: fields[1] });
    return Object.keys(expected).filter(key => !['issuedAt', 'expiresAt', 'adjudicationManifestSha256'].includes(key))
      .every(key => value[key] === expected[key]);
  } catch { return false; }
}

async function publishAttestation({ target, permit, client, dir, mergedAt, runId, attempt, now }) {
  const wrapped = JSON.parse(readFile(join(dir, files.envelope), 6_000));
  const value = decodeAttestation(wrapped.attestation);
  const independent = readFile(join(dir, files.independent), 32_768);
  const adjudication = readFile(join(dir, files.adjudication), 32_768);
  const replay = readFile(join(dir, files.replay), 16_384);
  requireIt(Object.keys(target).every(key => value[key] === target[key]) && value.prCiRun === permit.prCiRunId &&
    value.issuedAt <= now && now < value.expiresAt && value.issuedAt >= mergedAt &&
    value.independentManifestSha256 === hash(independent) && value.adjudicationManifestSha256 === hash(adjudication) &&
    JSON.parse(independent).premerge.evidenceSha256 === permit.productEvidenceSha256 &&
    JSON.parse(independent).postmerge.manifestSha256 === hash(replay) &&
    wrapped.attestationSha256 === hash(Buffer.from(wrapped.attestation.body, 'base64url')),
  'HOLD_POSTMERGE_PUBLICATION_EVIDENCE');
  verifyPostmergeReplay(replay.toString('utf8'), target, permit);
  const artifactName = 't00-product-postmerge-' + runId + '-' + attempt;
  const artifacts = await client.read('/actions/runs/' + runId + '/artifacts?per_page=100');
  const matching = artifacts?.artifacts?.filter(artifact => artifact.name === artifactName && artifact.expired === false);
  requireIt(Array.isArray(artifacts?.artifacts) && artifacts.artifacts.length < 100 &&
    artifacts.total_count === artifacts.artifacts.length && matching.length === 1 && validId(matching[0].id) &&
    typeof matching[0].digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(matching[0].digest) &&
    matching[0].workflow_run?.id === runId, 'HOLD_POSTMERGE_ARTIFACT_NOT_UPLOADED');
  const since = new Date((mergedAt - 1) * 1000).toISOString();
  let exhausted = false;
  for (let page = 1; page <= 5; page++) {
    const comments = await client.read('/issues/' + intake + '/comments?per_page=100&since=' +
      encodeURIComponent(since) + '&page=' + page);
    requireIt(Array.isArray(comments) && comments.length <= 100, 'HOLD_POSTMERGE_INTAKE_READ');
    const known = comments.find(comment => matchingPublishedAttestation(comment, value));
    if (known) return { commentId: known.id, reused: true };
    if (comments.length < 100) { exhausted = true; break; }
  }
  requireIt(exhausted, 'HOLD_POSTMERGE_INTAKE_PAGE');
  const message = caption + wrapped.attestation.body + '.' + wrapped.attestation.signature;
  const comment = await client.publish(message);
  requireIt(comment?.body === message && matchingPublishedAttestation(comment, value), 'HOLD_POSTMERGE_COMMENT_ACK');
  return { commentId: comment.id, reused: false };
}

async function execute(argv = process.argv.slice(2), env = process.env) {
  const publishing = argv.length === 1 && argv[0] === '--publish';
  // Avoid giving either secret to a verifier subprocess. The write token is injected only after artifact upload.
  const encodedKey = env.T00_PRODUCT_ED25519_PRIVATE_DER_BASE64;
  const token = env.GITHUB_TOKEN;
  delete env.T00_PRODUCT_ED25519_PRIVATE_DER_BASE64;
  delete env.T00_POLICY_READER_APP_PRIVATE_KEY;
  delete env.GITHUB_TOKEN;
  requireIt((publishing || argv.length === 0) && isAbsolute(env.GITHUB_EVENT_PATH ?? '') &&
    isAbsolute(env.RUNNER_TEMP ?? '') && typeof env.T00_POSTMERGE_PROOF_JSON === 'string' &&
    Buffer.byteLength(env.T00_POSTMERGE_PROOF_JSON) <= 16_384 && (!publishing || typeof token === 'string'),
  'HOLD_POSTMERGE_INPUT');
  const input = JSON.parse(env.T00_POSTMERGE_PROOF_JSON);
  requireIt(exactKeys(input, ['permit', 'merged']), 'HOLD_POSTMERGE_INPUT');
  const permit = verifyTransitionPermit(input.permit, { allowExpired: true, now: epoch() });
  const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH, 512_000));
  const target = verifyPostmergeTrigger({ env, event, permit, merged: input.merged });
  const at = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000,
    env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  requireIt(at.status === 0 && at.stdout.trim() === env.GITHUB_SHA, 'HOLD_POSTMERGE_PROTECTED_CHECKOUT');
  const client = github(token);
  const read = client.read;
  const start = await verifyPostmergeGitHub(read, target, permit);
  const dir = join(env.RUNNER_TEMP, 't00-product-postmerge');
  if (publishing) {
    const sent = await publishAttestation({ target, permit, client, dir, mergedAt: start.mergedAt,
      runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), now: epoch() });
    console.log('T03-06 attestation comment ' + sent.commentId + (sent.reused ? ' reused' : ' published'));
    return;
  }
  const replayStdout = replayInProcess(target, permit, env.PATH);
  const ci = await waitForPostmergeCI(read, target, permit, start.required);
  const refreshed = await verifyPostmergeGitHub(read, target, permit);
  requireIt(refreshed.mergedAt === start.mergedAt &&
    JSON.stringify(refreshed.required) === JSON.stringify(start.required), 'HOLD_POSTMERGE_POLICY_CHANGED');
  const signed = buildPostmergeAttestation({ target, permit, ci, required: start.required, mergedAt: start.mergedAt,
    main: refreshed.main,
    replayStdout, verifierSha256: hash(readFileSync(replayPath)), issuedAt: epoch(), encodedKey });
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, files.replay), replayStdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, files.independent), signed.independent, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, files.adjudication), signed.adjudication, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, files.envelope), JSON.stringify(signed.envelope) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('T03-06 postmerge attestation SHA-256 ' + signed.envelope.attestationSha256);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  execute().catch(error => {
    const code = /^HOLD_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_POSTMERGE_UNEXPECTED';
    console.error(code);
    process.exitCode = 1;
  });
}
