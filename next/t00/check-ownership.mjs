#!/usr/bin/env node
// T00-02 ownership gate for the tracks. `map` verifies the committed ownership map: its shape, scope collisions between
// tracks, reserved hot paths, the plan's write scopes, the nested-runner suites, and that it equals the map derived from its
// inputs. `paths` verifies the map first and then that every given path, or every path a git diff changed, belongs to one
// track only. Exit 0 verified, 2 errors (printed as `FAIL <code> <subject> <detail>`), 1 usage or unreadable input.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAP_CODES, PATH_CODES, TRACK_ID, checkPaths, formatError, matches } from './ownership.mjs';
import {
  BUILD_CODES, DEFAULT_REPO_DIR, LOCAL_ROLE, UnreadableInput, UsageError, failInput, inputErrors, loadSources, mapCounts, parseOptions, readMap, verifyMap,
} from './build-ownership-map.mjs';
import { cleanGitEnv } from './verify-baseline.mjs';

export const OWNERSHIP_CODES = [...MAP_CODES, ...BUILD_CODES, ...PATH_CODES];
export const CHECKS_RUN = 'map shape, track ids, scope grammar, scope collisions, reserved paths exist and are unclaimed, plan scopes, nested suites, derivation from the inputs';
const REVISION = /^[0-9A-Za-z][0-9A-Za-z._/~^@{}-]*$/;

// Paths changed between two revisions, renames listed as a delete and an add. Taken from git, so a backslash is part of
// a file name and is refused by the path check instead of being read as a separator.
export function gitDiffPaths(repoDir, base, head) {
  for (const rev of [base, head]) {
    if (!REVISION.test(rev) || rev.includes('..')) throw new UsageError(`${JSON.stringify(rev)} is not a plain revision name`);
  }
  let out;
  try {
    out = execFileSync('git', ['-C', repoDir, 'diff', '--name-only', '--no-renames', '-z', base, head, '--'], {
      encoding: 'utf8',
      env: { ...cleanGitEnv(), GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new UnreadableInput(`git diff ${base} ${head} failed in ${repoDir}: ${String(e.stderr ?? e.message).trim()}`);
  }
  return out.split('\0').filter(Boolean);
}

const USAGE = `usage: node next/t00/check-ownership.mjs [--repo-dir <dir>] map
       node next/t00/check-ownership.mjs [--repo-dir <dir>] paths --track Tnn [--repository <role>] (<path>... | --git-diff <base> <head>)
map    verifies the committed ownership map of <dir> (default: this checkout) against its inputs
paths  verifies the map, then that every path belongs to the track only; --git-diff checks the paths that differ between
       two revisions (pass the merge base as <base> to check only a branch's own changes)
exit codes: 0 verified, 2 errors, 1 usage or unreadable input`;

export async function runCli(argv) {
  let command;
  let operands;
  let options;
  let sources;
  let map;
  let repoDir;
  try {
    ({ options, rest: operands } = parseOptions(argv, { single: ['--repo-dir', '--track', '--repository'], pairs: ['--git-diff'] }));
    command = operands.shift();
    if (command !== 'map' && command !== 'paths') throw new UsageError(`expected the command map or paths, got ${JSON.stringify(command)}`);
    const forPaths = ['--track', '--repository', '--git-diff'].filter((k) => Object.hasOwn(options, k));
    if (command === 'map' && (forPaths.length || operands.length)) throw new UsageError('map takes no paths and no --track, --repository or --git-diff');
    if (command === 'paths') {
      if (!matches(TRACK_ID, options['--track'])) throw new UsageError('paths needs --track Tnn');
      if (options['--git-diff'] && operands.length) throw new UsageError('give paths or --git-diff, not both');
      if (!options['--git-diff'] && operands.length === 0) throw new UsageError('paths needs at least one path or --git-diff <base> <head>');
    }
    repoDir = path.resolve(options['--repo-dir'] ?? DEFAULT_REPO_DIR);
    sources = await loadSources(repoDir);
    map = readMap(repoDir);
  } catch (e) {
    return failInput(e, USAGE);
  }

  const show = (errors) => errors.forEach((e) => console.log(formatError(e)));
  if (sources.problems.length) {
    show(inputErrors(sources.problems));
    return 2;
  }
  const mapErrors = verifyMap(map, sources);
  if (mapErrors.length) {
    show(mapErrors);
    return 2;
  }
  if (command === 'map') {
    const { tracks, scopes, reserved } = mapCounts(map);
    console.log(`OK ownership map verified: ${tracks} tracks, ${scopes} scopes, ${reserved} reserved paths (checks: ${CHECKS_RUN})`);
    return 0;
  }

  const track = options['--track'];
  let paths = operands;
  if (options['--git-diff']) {
    try {
      paths = gitDiffPaths(repoDir, ...options['--git-diff']);
      if (paths.length === 0) throw new UnreadableInput(`the diff between ${options['--git-diff'].join(' and ')} is empty, so there is nothing to check`);
    } catch (e) {
      return failInput(e, USAGE);
    }
  }
  const repository = options['--repository'] ?? map.tracks.find((t) => t.track === track)?.repository ?? LOCAL_ROLE;
  const errors = checkPaths(map, { repository, track, paths, backslash: options['--git-diff'] ? 'reject' : 'convert' });
  show(errors);
  if (errors.length) return 2;
  console.log(`OK ${paths.length} paths belong to ${track} only`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
