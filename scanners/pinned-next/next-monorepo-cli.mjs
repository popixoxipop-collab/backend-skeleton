#!/usr/bin/env node
/**
 * Product candidate CLI for monorepo Next.js Git-object static analysis.
 *
 * Mutually exclusive selection:
 *   --list-projects                  list all Next manifests + route counts
 *   --project apps/web               inspect exactly one verified project
 *   --all-projects                   inspect every detected Next project
 *   [none]                           auto only if unambiguous
 *
 * Required Git source pin flags in every mode:
 * --commit HEX40 --git-exe ABSOLUTE --git-sha256 HEX64
 * --git-dir ABSOLUTE --common-dir ABSOLUTE
 *
 * No production registry, T19 approval, run-time certification, application
 * module execution, npm invocations or mutable checkout source access.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions as parsePinnedOptions } from './next-pinned-cli.mjs';
import { validProjectId, NextMonorepoError } from './next-monorepo.mjs';
import { inspectPinnedNextSource } from './next-product-sdk.mjs';

const myPath = fileURLToPath(import.meta.url);
const OPTIONS_WITH_VALUES = new Set([
  'commit', 'git-exe', 'git-sha256', 'git-dir', 'common-dir', 'project',
]);
const MODE_FLAGS = new Set(['list-projects', 'all-projects']);

export function parseMonorepoOptions(argv) {
  if (!Array.isArray(argv)) {
    throw new NextMonorepoError('INVALID_ARGUMENTS');
  }
  if (argv.length === 1 && argv[0] === '--help') {
    return Object.freeze({ help: true });
  }
  const pinArgv = [];
  let selectedProject = null;
  let mode = 'auto';
  let chosenMode = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = typeof flag === 'string' && flag.startsWith('--')
      ? flag.slice(2) : '';
    if (!OPTIONS_WITH_VALUES.has(key) && !MODE_FLAGS.has(key)) {
      throw new NextMonorepoError('INVALID_ARGUMENTS');
    }
    if (seen.has(key)) {
      throw new NextMonorepoError('DUPLICATE_ARGUMENT');
    }
    seen.add(key);
    if (MODE_FLAGS.has(key)) {
      if (chosenMode) throw new NextMonorepoError('CONFLICTING_SCAN_MODES');
      mode = key === 'list-projects' ? 'list' : 'all';
      chosenMode = true;
      continue;
    }
    const value = argv[++i];
    if (typeof value !== 'string' || value.length === 0 ||
        value.startsWith('--')) {
      throw new NextMonorepoError('INVALID_ARGUMENTS');
    }
    if (key === 'project') {
      if (chosenMode) throw new NextMonorepoError('CONFLICTING_SCAN_MODES');
      if (!validProjectId(value)) {
        throw new NextMonorepoError('INVALID_PROJECT_ID');
      }
      selectedProject = value;
      mode = 'single';
      chosenMode = true;
    } else {
      pinArgv.push(flag, value);
    }
  }
  const pins = parsePinnedOptions(pinArgv);
  if (pins.help) throw new NextMonorepoError('EXACT_PIN_REQUIRED');
  return Object.freeze({ mode, projectId: selectedProject, pins });
}

export function scanMonorepoProduct(options) {
  if (!options || options.help || !options.pins) {
    throw new NextMonorepoError('INVALID_ARGUMENTS');
  }
  const { pins } = options;
  return inspectPinnedNextSource({
    source: {
      commit: pins.commit,
      gitExecutable: pins['git-exe'],
      gitExecutableSha256: pins['git-sha256'],
      gitDir: pins['git-dir'],
      trustedCommonDir: pins['common-dir'],
    },
    mode: options.mode,
    projectId: options.projectId,
  });
}

function safeErrorCode(error) {
  if (error instanceof NextMonorepoError && /^[A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  const text = typeof error?.message === 'string'
    ? error.message.split(':')[0] : '';
  return /^[A-Z][A-Z0-9_]{2,65}$/.test(text)
    ? text : 'PINNED_MONOREPO_SCAN_UNAVAILABLE';
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseMonorepoOptions(argv);
    if (opts.help) {
      process.stdout.write(
        'Next.js pinned-source monorepo scanner (experimental, read-only)\n' +
        'Required: --commit <40hex> --git-exe <absolute> ' +
        '--git-sha256 <64hex> --git-dir <absolute> --common-dir <absolute>\n' +
        'Option: --list-projects | --project <relative-project-id> ' +
        '| --all-projects\n' +
        'No option scans automatically only if one Next.js project exists.\n' +
        'Exit 3 means select a project when there are multiple apps.\n');
      return 0;
    }
    const data = scanMonorepoProduct(opts);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    if (data.projectSelection.selectionRequired) return 3;
    // Never return a quiet success for an incomplete automatic/whole-repo
    // inventory. Listing and explicitly selected projects remain inspectable.
    if (data.catalog.incomplete && ['auto', 'all'].includes(opts.mode)) return 4;
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false, errorCode: safeErrorCode(error),
    }) + '\n');
    return 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === myPath) {
  process.exitCode = main();
}
