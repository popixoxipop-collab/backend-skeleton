import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_SPARSE = new Set(['ruby-rails', 'python-fastapi']);

function git(repoRoot, args, { optional = false } = {}) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (optional) return null;
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error('git ' + args.join(' ') + ' failed: ' + detail);
  }
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function excludedPython(rel) {
  return rel.split('/').some((part) =>
    part === '.venv' || part === 'site-packages' || part === 'node_modules' || part === '__pycache__',
  );
}

function excludedRails(rel) {
  return rel === '.bundle' || rel.startsWith('.bundle/') ||
    rel === 'vendor/bundle' || rel.startsWith('vendor/bundle/') ||
    rel === 'tmp' || rel.startsWith('tmp/') ||
    rel === 'log' || rel.startsWith('log/') ||
    rel === 'node_modules' || rel.startsWith('node_modules/');
}

function expectedSparseReadSet(adapterId, trackedRelativePaths) {
  if (adapterId === 'python-fastapi') {
    return trackedRelativePaths.filter((rel) => rel.endsWith('.py') && !excludedPython(rel));
  }
  if (adapterId === 'ruby-rails') {
    return trackedRelativePaths.filter((rel) => {
      if (excludedRails(rel)) return false;
      if (rel === 'Gemfile' || rel === 'Gemfile.lock') return true;
      if (!rel.endsWith('.rb')) return false;
      return rel === 'config/routes.rb' || rel.startsWith('config/') ||
        rel.startsWith('app/controllers/') || rel.startsWith('app/models/') ||
        rel.startsWith('lib/');
    });
  }
  return null;
}

export function inspectLegacyCorpusCheckout({ repoRoot, adapterId, maxMissing = 50 } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot is required');
  if (typeof adapterId !== 'string' || adapterId.length === 0) throw new TypeError('adapterId is required');
  if (!Number.isInteger(maxMissing) || maxMissing < 1 || maxMissing > 1000) {
    throw new RangeError('maxMissing must be an integer from 1 through 1000');
  }

  const root = fs.realpathSync(path.resolve(repoRoot));
  const gitTop = fs.realpathSync(path.resolve(git(root, ['rev-parse', '--show-toplevel'])));
  const relProject = posix(path.relative(gitTop, root));
  if (relProject.startsWith('../') || path.isAbsolute(relProject)) {
    throw new Error('repoRoot escapes its git toplevel');
  }

  const head = git(root, ['rev-parse', 'HEAD']);
  const sparse = git(root, ['config', '--bool', 'core.sparseCheckout'], { optional: true }) === 'true';
  if (!sparse) {
    return Object.freeze({
      complete: true,
      mode: 'full-working-tree',
      git_head: head,
      project_root: relProject || '.',
      adapter_id: adapterId,
      expected_tracked_read_files: null,
      materialized_read_files: null,
      missing_count: 0,
      missing_paths: Object.freeze([]),
    });
  }

  if (!SUPPORTED_SPARSE.has(adapterId)) {
    return Object.freeze({
      complete: false,
      mode: 'sparse-unsupported-adapter',
      git_head: head,
      project_root: relProject || '.',
      adapter_id: adapterId,
      expected_tracked_read_files: null,
      materialized_read_files: null,
      missing_count: null,
      missing_paths: Object.freeze([]),
      reason: 'T11 cannot prove sparse checkout completeness for this adapter',
    });
  }

  const treeArgs = ['ls-tree', '-r', '--name-only', 'HEAD'];
  if (relProject) treeArgs.push('--', relProject);
  const raw = git(gitTop, treeArgs);
  const tracked = raw ? raw.split('\n').filter(Boolean) : [];
  const prefix = relProject ? relProject.replace(/\/$/, '') + '/' : '';
  const relative = tracked
    .filter((entry) => !prefix || entry === relProject || entry.startsWith(prefix))
    .map((entry) => prefix ? entry.slice(prefix.length) : entry)
    .filter(Boolean);

  const expected = expectedSparseReadSet(adapterId, relative);
  const missing = [];
  let materialized = 0;
  for (const rel of expected) {
    if (fs.existsSync(path.join(root, rel))) materialized += 1;
    else if (missing.length < maxMissing) missing.push(rel);
  }
  const missingCount = expected.length - materialized;

  return Object.freeze({
    complete: missingCount === 0,
    mode: 'sparse-readset-verified',
    git_head: head,
    project_root: relProject || '.',
    adapter_id: adapterId,
    expected_tracked_read_files: expected.length,
    materialized_read_files: materialized,
    missing_count: missingCount,
    missing_paths: Object.freeze(missing),
    ...(missingCount > missing.length ? { missing_paths_truncated: true } : {}),
  });
}

export function assertLegacyCorpusCheckoutComplete(options) {
  const result = inspectLegacyCorpusCheckout(options);
  if (!result.complete) {
    const detail = result.missing_count == null
      ? result.reason
      : result.missing_count + ' tracked scanner read-set file(s) are absent from the working tree';
    const err = new Error('corpus checkout is incomplete: ' + detail);
    err.code = 'T11_CORPUS_CHECKOUT_INCOMPLETE';
    err.checkout = result;
    throw err;
  }
  return result;
}
