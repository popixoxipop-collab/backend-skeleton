import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_SPARSE = new Set(['ruby-rails', 'python-fastapi']);

// The variables git itself treats as local to one repository (GIT_DIR, GIT_CONFIG_COUNT, ...). A caller
// inside a git hook or an outer git command inherits some of them, and they would send every call below
// to another repository or configuration than the one under repoRoot, so each call runs without them.
let localEnvNames;
function gitEnvironment() {
  localEnvNames ??= execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(Boolean);
  const env = { ...process.env };
  for (const name of localEnvNames) delete env[name];
  return env;
}

// Returns raw stdout. Tracked paths may begin or end with whitespace, so path data is never trimmed.
function git(repoRoot, args, { optional = false } = {}) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    if (optional) return null;
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error('git ' + args.join(' ') + ' failed: ' + detail);
  }
}

function gitLine(repoRoot, args, options) {
  const out = git(repoRoot, args, options);
  return out === null ? null : out.replace(/\n$/, '');
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function excludedPython(rel) {
  return rel.split('/').some((part) =>
    part === '.venv' || part === 'site-packages' || part === 'node_modules' || part === '__pycache__',
  );
}

// The Rails scanner lists markers with `rg --files -g Gemfile -g Gemfile.lock` and adds root-anchored
// excludes (`!tmp/**`, `!log/**`, `!vendor/bundle/**`, `!.bundle/**`, `!node_modules/**`). ripgrep
// anchors those globs at its own working directory, so they only take effect when the scan runs from
// inside the project directory; from any other directory a Gemfile below one of those trees is read
// too. The guard cannot know the scan's working directory, so it requires every tracked Gemfile and
// Gemfile.lock at any depth (it may over-require, never under-require).
function isRailsMarker(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return name === 'Gemfile' || name === 'Gemfile.lock';
}

function expectedSparseReadSet(adapterId, trackedRelativePaths) {
  if (adapterId === 'python-fastapi') {
    return trackedRelativePaths.filter((rel) => rel.endsWith('.py') && !excludedPython(rel));
  }
  if (adapterId === 'ruby-rails') {
    return trackedRelativePaths.filter((rel) => {
      if (isRailsMarker(rel)) return true;
      if (!rel.endsWith('.rb')) return false;
      return rel === 'config/routes.rb' || rel.startsWith('config/') ||
        rel.startsWith('app/controllers/') || rel.startsWith('app/models/') ||
        rel.startsWith('lib/');
    });
  }
  return null;
}

// `core.sparseCheckout` can be switched off for one worktree (`git config --worktree`) while the files stay
// missing and `git status` stays clean; the skip-worktree bit (tag `S`) that sparse checkout sets on every
// entry it left out is then the only record of it. `-z` keeps the entries NUL-separated like the paths.
function hasSkipWorktreeEntry(root) {
  return git(root, ['ls-files', '-t', '-z']).split('\0').some((entry) => entry.startsWith('S '));
}

export function inspectLegacyCorpusCheckout({ repoRoot, adapterId, maxMissing = 50 } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot is required');
  if (typeof adapterId !== 'string' || adapterId.length === 0) throw new TypeError('adapterId is required');
  if (!Number.isInteger(maxMissing) || maxMissing < 1 || maxMissing > 1000) {
    throw new RangeError('maxMissing must be an integer from 1 through 1000');
  }

  const root = fs.realpathSync(path.resolve(repoRoot));
  const gitTop = fs.realpathSync(path.resolve(gitLine(root, ['rev-parse', '--show-toplevel'])));
  const relProject = posix(path.relative(gitTop, root));
  if (relProject.startsWith('../') || path.isAbsolute(relProject)) {
    throw new Error('repoRoot escapes its git toplevel');
  }

  const head = gitLine(root, ['rev-parse', 'HEAD']);
  const sparse = gitLine(root, ['config', '--bool', 'core.sparseCheckout'], { optional: true }) === 'true';
  if (!sparse && !hasSkipWorktreeEntry(root)) {
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

  // `-z` prints raw NUL-separated names; without it git C-quotes non-ASCII names (core.quotePath) and
  // names containing a double quote, backslash or control character, and a quoted entry would never
  // match a `.py`/`.rb` rule. `HEAD:<dir>` lists the project subtree with names already relative to it
  // and, unlike a pathspec, treats the directory name literally.
  const raw = git(gitTop, ['ls-tree', '-r', '-z', '--name-only', relProject ? 'HEAD:' + relProject : 'HEAD']);
  const relative = raw.split('\0').filter(Boolean);

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
