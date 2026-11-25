import { execFileSync } from 'node:child_process';
import { loadSources, readMap, verifyMap } from './build-ownership-map.mjs';
import { checkPaths } from './ownership.mjs';
import { parseDirectives } from './verify-path-exception-online.mjs';

const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const SHARED_ACCOUNT_ID = 261965176;
const SHA = /^[0-9a-f]{40}$/;
const DOT_BRANCH = /^dot\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const DIRECTIVE = /^\s*T00-(?:Track|Receipt)\s*:/im;
const MAX_PATHS = 256;
const GIT_LIMIT = 512 * 1024;
const STRICT_PATH = /^[A-Za-z0-9_.@+/-]{1,512}$/;
const CONTROL_PATH = /^(?:\.github(?:\/|$)|next\/t00\/(?:independent-approval|run-independent-approval|pr-path-gate|ownership|(?:build|check)-ownership|baseline\.lock\.json$|check-lease|check-path-exception|verify-path-exception|verify-baseline|snapshot-plan|path_exception_protocol|fixtures\/(?:ownership-rules|plan-write-scopes)\.json$|receipts(?:\/|$))|scripts\/run-next-nested-tests\.mjs$|package(?:-lock)?\.json$)/i;

function requirePolicy(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function git(repoDir, ...args) {
  // The checkout is trusted main. Read the candidate only as Git objects and disable
  // inherited configuration, hooks, refs replacements, and locking side effects.
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  };
  try {
    const output = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repoDir, ...args], {
      env, timeout: 15_000, maxBuffer: GIT_LIMIT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    requirePolicy(false, 'GIT_OBJECT_UNAVAILABLE');
  }
}

function readCandidateObjects(repoDir, base, head) {
  const header = git(repoDir, 'cat-file', 'commit', head).split('\n\n', 1)[0].split('\n');
  const trees = header.filter((line) => line.startsWith('tree '));
  const parents = header.filter((line) => line.startsWith('parent '));
  const tree = trees[0]?.slice(5);
  requirePolicy(trees.length === 1 && SHA.test(tree), 'GIT_TREE');
  requirePolicy(parents.length === 1 && parents[0] === 'parent ' + base, 'GIT_DIRECT_PARENT');

  const raw = git(repoDir, 'diff-tree', '-r', '--raw', '--no-abbrev', '--no-commit-id',
    '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-renames', '-z', base, head, '--');
  const fields = raw.split('\0');
  requirePolicy(fields.pop() === '' && fields.length > 0 && fields.length % 2 === 0 &&
    fields.length <= MAX_PATHS * 2, 'GIT_DIFF_FORMAT');
  const paths = new Set();
  for (let i = 0; i < fields.length; i += 2) {
    const entry = /^:(000000|100644|100755) (100644|100755) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AM])$/.exec(fields[i]);
    const file = fields[i + 1];
    requirePolicy(entry && (entry[5] === 'A' ? entry[1] === '000000' : entry[1] === entry[2]), 'GIT_STATUS_OR_MODE');
    requirePolicy(STRICT_PATH.test(file) &&
      !file.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('-')) &&
      !paths.has(file), 'GIT_PATH');
    requirePolicy(!CONTROL_PATH.test(file) && !/(?:^|\/)\.git(?:attributes|modules|ignore)?$/i.test(file), 'PROTECTED_PATH');
    paths.add(file);
  }
  return { tree, paths: [...paths].sort() };
}

function isRepository(repository) {
  return repository?.id === REPOSITORY_ID && repository?.full_name === REPOSITORY;
}

export async function bindCandidate({ pull, mainSha, repoDir, publisherId }) {
  requirePolicy(Number.isSafeInteger(publisherId) && publisherId > 0 && publisherId !== SHARED_ACCOUNT_ID,
    'PUBLISHER_NOT_ENROLLED');
  // A GitHub App's registration ID is not the actor's Bot account ID. Insist on
  // the actual REST PR author, even if a human acted using an unrelated App.
  requirePolicy(pull?.user?.type === 'Bot' && pull.user.id === publisherId, 'PUBLISHER_IDENTITY');
  const branch = pull.head?.ref;
  const head = pull.head?.sha;
  requirePolicy(Number.isSafeInteger(pull.number) && pull.number > 0 && pull.state === 'open' && pull.draft === true &&
    !pull.merged_at && pull.base?.ref === 'main' && SHA.test(mainSha) && mainSha === pull.base.sha &&
    SHA.test(head) && head !== mainSha && isRepository(pull.base?.repo) && isRepository(pull.head?.repo) &&
    typeof branch === 'string' && branch.length <= 180 && DOT_BRANCH.test(branch) &&
    !branch.includes('..') && !branch.endsWith('.') && !branch.split('/').some((part) => part.endsWith('.lock')),
  'STALE_OR_UNVERIFIED_PR');

  const body = pull.body;
  requirePolicy(typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= 32_768, 'DIRECTIVE_REQUIRED');
  const markers = body.split(/\r?\n/).filter((line) => DIRECTIVE.test(line));
  requirePolicy(markers.length === 1, 'DIRECTIVE_REQUIRED');
  let selected;
  try {
    selected = parseDirectives(body);
  } catch {
    requirePolicy(false, 'DIRECTIVE_MALFORMED');
  }
  const { track, receipt } = selected;
  requirePolicy(!receipt, 'DIRECTIVE_MALFORMED');

  requirePolicy(typeof repoDir === 'string' && repoDir.length > 0 &&
    git(repoDir, 'rev-parse', 'HEAD').trim() === mainSha, 'POLICY_NOT_EXACT_BASE');
  requirePolicy(!git(repoDir, 'status', '--porcelain=v1', '--untracked-files=all',
    '--ignored=matching', '--ignore-submodules=none'), 'POLICY_DIRTY');
  const { tree, paths } = readCandidateObjects(repoDir, mainSha, head);
  const sources = await loadSources(repoDir);
  requirePolicy(!sources.problems.length, 'POLICY_INPUT_INVALID');
  const map = readMap(repoDir);
  requirePolicy(!verifyMap(map, sources).length, 'POLICY_MAP_INVALID');
  const failures = checkPaths(map, { repository: 'bskel', track, paths, backslash: 'reject' });
  requirePolicy(!failures.length, failures[0]?.code);
  return { number: pull.number, base: mainSha, head, tree, track, paths, publisherId };
}
