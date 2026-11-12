#!/usr/bin/env node
// An exact-head T00 coordinator exception, not an override of the ownership map.
// The caller must source and SHA-pin the receipt independently (for example from protected T00 main).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitDiffPaths } from './check-ownership.mjs';
import { DEFAULT_REPO_DIR, loadSources, readMap, verifyMap } from './build-ownership-map.mjs';
import { checkPaths, normalizePath } from './ownership.mjs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EXCEPTION_CODES = new Set(['PATH_RESERVED_HOT', 'PATH_UNOWNED']);
const RECEIPT_SCHEMA = 'bskel.t00-path-exception/1';
const REPO_ROLES = new Set(['bskel', 'becoder', 'beval']);
const fail = (code, detail) => ({ code, detail });

export function judgePathException(map, receipt, { repository, track, base, head, paths }) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schema !== RECEIPT_SCHEMA) return [fail('RECEIPT_SCHEMA', 'unsupported receipt schema')];
  if (!REPO_ROLES.has(repository) || receipt.repository !== repository || receipt.track !== track || receipt.base !== base || receipt.head !== head || !SHA.test(base) || !SHA.test(head)) {
    errors.push(fail('RECEIPT_TARGET', 'repository, track or exact base/head do not match'));
  }
  if (typeof receipt.approval?.actor !== 'string' || !receipt.approval.actor ||
      !/^https:\/\/github\.com\/popixoxipop-collab\/backend-skeleton\/(issues|pull)\/\d+#issuecomment-\d+$/.test(receipt.approval.url ?? '')) {
    errors.push(fail('RECEIPT_APPROVAL', 'a T00 GitHub issue/PR comment URL and actor are required; authenticity is not checked offline'));
  }
  if (!Array.isArray(receipt.exceptions) || receipt.exceptions.length === 0) return [...errors, fail('RECEIPT_SCHEMA', 'exceptions must be a nonempty array')];
  const allowed = new Map();
  for (const entry of receipt.exceptions) {
    let valid = entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof entry.path === 'string' && typeof entry.reason === 'string' && entry.reason.trim() && EXCEPTION_CODES.has(entry.code);
    if (valid) {
      try { valid = normalizePath(entry.path, { backslash: 'reject' }) === entry.path; } catch { valid = false; }
    }
    if (!valid) { errors.push(fail('RECEIPT_ENTRY', 'invalid path, reason or exception code')); continue; }
    if (allowed.has(entry.path)) errors.push(fail('RECEIPT_DUPLICATE', entry.path));
    allowed.set(entry.path, entry.code);
  }
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) return [...errors, fail('DIFF_PATHS', 'nonempty unique git diff paths required')];
  const seen = new Set();
  for (const p of paths) {
    const findings = checkPaths(map, { repository, track, paths: [p], backslash: 'reject' });
    if (findings.length === 0) {
      if (allowed.has(p)) errors.push(fail('EXCEPTION_NOT_NEEDED', p));
      continue;
    }
    for (const finding of findings) {
      if (!EXCEPTION_CODES.has(finding.code)) errors.push(fail('EXCEPTION_FORBIDDEN', `${p} ${finding.code}`));
      else if (allowed.get(p) !== finding.code) errors.push(fail('EXCEPTION_MISSING', `${p} ${finding.code}`));
      else seen.add(p);
    }
  }
  for (const p of allowed.keys()) if (!seen.has(p) && !errors.some((e) => e.code === 'EXCEPTION_NOT_NEEDED' && e.detail === p)) errors.push(fail('EXCEPTION_UNUSED', p));
  return errors;
}

export async function runCli(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || values.has(argv[i])) return { status: 1, lines: ['ERROR: expected unique --repo-dir --repository --track --base --head --receipt --receipt-sha256 pairs'] };
    values.set(argv[i], argv[i + 1]);
  }
  const required = ['--repo-dir', '--repository', '--track', '--base', '--head', '--receipt', '--receipt-sha256'];
  if (values.size !== required.length || required.some((k) => !values.has(k)) || !DIGEST.test(values.get('--receipt-sha256'))) return { status: 1, lines: ['ERROR: missing option or invalid receipt SHA-256'] };
  const repoDir = path.resolve(values.get('--repo-dir'));
  const receiptPath = path.resolve(values.get('--receipt'));
  try {
    const bytes = fs.readFileSync(receiptPath);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== values.get('--receipt-sha256')) return { status: 2, lines: [`FAIL RECEIPT_SHA256 expected ${values.get('--receipt-sha256')} actual ${actualHash}`] };
    const receipt = JSON.parse(bytes.toString('utf8'));
    const sources = await loadSources(DEFAULT_REPO_DIR);
    if (sources.problems.length) return { status: 2, lines: sources.problems.map((p) => `FAIL MAP_INPUT ${String(p)}`) };
    const map = readMap(DEFAULT_REPO_DIR);
    const mapErrors = verifyMap(map, sources);
    if (mapErrors.length) return { status: 2, lines: mapErrors.map((e) => `FAIL MAP ${e.code} ${e.subject}`) };
    const paths = gitDiffPaths(repoDir, values.get('--base'), values.get('--head'));
    const errors = judgePathException(map, receipt, {
      repository: values.get('--repository'), track: values.get('--track'), base: values.get('--base'), head: values.get('--head'), paths,
    });
    if (errors.length) return { status: 2, lines: errors.map((e) => `FAIL ${e.code} ${e.detail}`) };
    return { status: 0, lines: [`OK ${paths.length} paths checked; ${receipt.exceptions.length} exact T00 exceptions; receipt sha256 ${actualHash}`] };
  } catch (e) {
    return { status: 1, lines: [`ERROR: ${e.message}`] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const result = await runCli(process.argv.slice(2));
  for (const line of result.lines) console.log(line);
  process.exitCode = result.status;
}
