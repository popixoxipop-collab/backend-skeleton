#!/usr/bin/env node
// Run only from a trusted backend-skeleton main checkout, never from candidate PR code.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitDiffPaths } from './check-ownership.mjs';
import { DEFAULT_REPO_DIR, loadSources, readMap, verifyMap } from './build-ownership-map.mjs';
import { checkPaths } from './ownership.mjs';
import { judgePathException } from './check-path-exception.mjs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOS = { becoder: 'backend-decoder', beval: 'Backend-evaluation' };
const OWNER = 'popixoxipop-collab';
const RECEIPTS = path.join(DEFAULT_REPO_DIR, 'next/t00/receipts');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const failure = (code, detail) => ({ code, detail });

export function approvalTarget(receipt) {
  return hash(JSON.stringify({ repository: receipt.repository, track: receipt.track, base: receipt.base,
    head: receipt.head, exceptions: receipt.exceptions.map(({ path, code }) => ({ path, code })) }));
}

export function parseDirectives(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const match = /^T00-(Track|Receipt):\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    if (values.has(match[1])) throw new Error(`duplicate T00-${match[1]} directive`);
    values.set(match[1], match[2]);
  }
  const track = values.get('Track');
  const receipt = values.get('Receipt');
  if (!/^T\d{2}$/.test(track ?? '')) throw new Error('PR body needs exactly one T00-Track: Tnn line');
  if (receipt && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(receipt)) throw new Error('invalid T00-Receipt filename');
  return { track, receipt };
}

export function verifyApproval(receipt, comment) {
  const approval = receipt.approval;
  const match = /^https:\/\/github\.com\/popixoxipop-collab\/backend-skeleton\/issues\/(\d+)#issuecomment-(\d+)$/.exec(approval?.url ?? '');
  if (!match || approval.login !== OWNER || comment?.id !== Number(match[2]) ||
      comment?.issue_url !== `https://api.github.com/repos/${OWNER}/backend-skeleton/issues/${match[1]}` ||
      comment?.user?.login !== approval.login || !DIGEST.test(approval.body_sha256 ?? '') ||
      hash(comment.body ?? '') !== approval.body_sha256 ||
      !String(comment.body ?? '').split(/\r?\n/).includes(`T00-Path-Exception: ${approvalTarget(receipt)}`)) {
    return [failure('APPROVAL_AUTH', 'comment actor, immutable body pin, issue target or exact approval marker mismatch')];
  }
  return [];
}

export async function verifyOnline({ repository, pullNumber, expectedHead, repoDir, requestJson = githubJson, receiptDir = RECEIPTS }) {
  if (!REPOS[repository] || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !SHA.test(expectedHead)) return [failure('USAGE', 'invalid repository, pull number or event head')];
  try {
    const pull = await requestJson(`/repos/${OWNER}/${REPOS[repository]}/pulls/${pullNumber}`, true);
    if (pull?.state !== 'open' || pull?.head?.sha !== expectedHead || !SHA.test(pull?.base?.sha ?? '') ||
        pull?.base?.repo?.full_name !== `${OWNER}/${REPOS[repository]}` ||
        pull?.head?.repo?.full_name !== `${OWNER}/${REPOS[repository]}`) {
      return [failure('PR_STALE', 'PR is closed, changed head, wrong base or not a same-repository PR')];
    }
    const { track, receipt: receiptName } = parseDirectives(pull.body);
    const sources = await loadSources(DEFAULT_REPO_DIR);
    if (sources.problems.length) return [failure('MAP_INPUT', String(sources.problems[0]))];
    const map = readMap(DEFAULT_REPO_DIR);
    const mapErrors = verifyMap(map, sources);
    if (mapErrors.length) return [failure('MAP', `${mapErrors[0].code} ${mapErrors[0].subject}`)];
    const base = execFileSync('git', ['-C', repoDir, 'merge-base', pull.base.sha, pull.head.sha], { encoding: 'utf8' }).trim();
    if (!SHA.test(base)) return [failure('MERGE_BASE', 'invalid computed merge base')];
    const paths = gitDiffPaths(repoDir, base, pull.head.sha);
    if (!paths.length) return [failure('DIFF_EMPTY', 'empty base/head diff')];
    const findings = checkPaths(map, { repository, track, paths, backslash: 'reject' });
    if (!findings.length) return receiptName ? [failure('EXCEPTION_NOT_NEEDED', receiptName)] : [];
    if (!receiptName) return [failure('RECEIPT_MISSING', `ownership findings: ${findings.map((e) => e.code).join(', ')}`)];
    const indexBytes = fs.readFileSync(path.join(receiptDir, 'index.json'));
    const index = JSON.parse(indexBytes);
    if (index.schema !== 'bskel.t00-receipt-index/1' || !Array.isArray(index.receipts)) return [failure('INDEX_SCHEMA', 'invalid trusted receipt index')];
    const entry = index.receipts.find((e) => e.file === receiptName);
    if (!entry || !DIGEST.test(entry.sha256 ?? '')) return [failure('RECEIPT_UNPINNED', receiptName)];
    const receiptBytes = fs.readFileSync(path.join(receiptDir, receiptName));
    if (hash(receiptBytes) !== entry.sha256) return [failure('RECEIPT_SHA256', receiptName)];
    const receipt = JSON.parse(receiptBytes);
    if (receipt.schema !== 'bskel.t00-path-exception/2') return [failure('RECEIPT_SCHEMA', 'online gate accepts only authenticated v2 receipts')];
    // The offline path judge implements exact base/head/path-set matching. It accepts v1 schema only;
    // translate the already authenticated v2 envelope for this strictly mechanical sub-check.
    const errors = judgePathException(map, { ...receipt, schema: 'bskel.t00-path-exception/1', approval: {
      actor: receipt.approval?.login, url: receipt.approval?.url,
    } }, { repository, track, base, head: pull.head.sha, paths });
    if (errors.length) return errors;
    const commentId = /^https:\/\/github\.com\/popixoxipop-collab\/backend-skeleton\/issues\/\d+#issuecomment-(\d+)$/.exec(receipt.approval?.url ?? '')?.[1];
    if (!commentId) return [failure('APPROVAL_AUTH', 'invalid approval URL')];
    const comment = await requestJson(`/repos/${OWNER}/backend-skeleton/issues/comments/${commentId}`, false);
    return verifyApproval(receipt, comment);
  } catch (error) {
    return [failure('VERIFY_UNAVAILABLE', String(error.message ?? error))];
  }
}

async function githubJson(apiPath, privateRepo) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (privateRepo) {
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to read the private PR');
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com${apiPath}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${apiPath}`);
  return response.json();
}

export async function runCli(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || values.has(argv[i])) return { status: 1, lines: ['ERROR: expected unique option pairs'] };
    values.set(argv[i], argv[i + 1]);
  }
  const required = ['--repository', '--pull-number', '--expected-head', '--repo-dir'];
  if (values.size !== required.length || required.some((k) => !values.has(k))) return { status: 1, lines: ['ERROR: missing option'] };
  const errors = await verifyOnline({ repository: values.get('--repository'), pullNumber: Number(values.get('--pull-number')),
    expectedHead: values.get('--expected-head'), repoDir: path.resolve(values.get('--repo-dir')) });
  return errors.length ? { status: 2, lines: errors.map((e) => `FAIL ${e.code} ${e.detail}`) } : { status: 0, lines: ['OK exact-head T00 path authorization verified'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const result = await runCli(process.argv.slice(2));
  for (const line of result.lines) console.log(line);
  process.exitCode = result.status;
}
