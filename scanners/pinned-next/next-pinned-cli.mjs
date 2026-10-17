#!/usr/bin/env node
/**
 * Product candidate: one-shot static Next.js Route Handler scan from a pinned
 * Git commit, without reading mutable application worktree paths.
 *
 * NO production registry registration, runtime endpoint certification,
 * trust-root attestation, or approval of the caller's Git object store.
 * The caller MUST select a trusted Git executable/store and an exact commit.
 *
 * Usage:
 * node next-pinned-cli.mjs --commit <40hex> --git-exe /usr/bin/git \
 *   --git-sha256 <64hex> --git-dir /absolute/git-admin-dir \
 *   --common-dir /absolute/git-common-dir
 *
 * All source inputs are read through the bounded static P3 Git-object loader.
 * Never loads target application code, runs npm, or uses a scanner filesystem
 * path from an attacker-controlled working tree.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitAuthority } from './git-authority.mjs';
import { loadPinnedSnapshot } from './git-snapshot.mjs';
import { scanPinnedNext } from './scan-pinned.mjs';

const cliEntrypoint = fileURLToPath(import.meta.url);
const EXPECTED = new Set(['commit', 'git-exe', 'git-sha256', 'git-dir', 'common-dir']);
const EXACT_COMMIT = /^[a-f0-9]{40}$/;
const EXACT_SHA256 = /^[a-f0-9]{64}$/;

export class PinnedNextScanError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PinnedNextScanError';
    this.code = code;
  }
}

export function parseOptions(argv) {
  if (!Array.isArray(argv)) throw new PinnedNextScanError('INVALID_ARGUMENTS');
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') ||
        !EXPECTED.has(flag.slice(2)) || typeof val !== 'string' ||
        !val || val.startsWith('--') || Object.hasOwn(options, flag.slice(2))) {
      throw new PinnedNextScanError('INVALID_ARGUMENTS');
    }
    options[flag.slice(2)] = val;
  }
  if (Object.keys(options).length !== EXPECTED.size ||
      !EXACT_COMMIT.test(options.commit) ||
      !EXACT_SHA256.test(options['git-sha256'])) {
    throw new PinnedNextScanError('EXACT_PIN_REQUIRED');
  }
  for (const key of ['git-exe', 'git-dir', 'common-dir']) {
    const val = options[key];
    if (!path.isAbsolute(val) || val.includes('\0') ||
        path.normalize(val) !== val) {
      throw new PinnedNextScanError('TRUSTED_ABSOLUTE_PATH_REQUIRED');
    }
  }
  return Object.freeze(options);
}

export function scanNextPinnedProduct(options) {
  if (!options || options.help) throw new PinnedNextScanError('INVALID_ARGUMENTS');
  const trust = makeGitAuthority({
    gitExecutable: options['git-exe'],
    gitExecutableSha256: options['git-sha256'],
    gitDir: options['git-dir'],
    trustedCommonDir: options['common-dir'],
  });
  const snapshot = loadPinnedSnapshot({
    gitAuthority: trust,
    commit: options.commit,
  });
  const output = scanPinnedNext({ snapshot });
  if (output.virtual_io.unclosed !== 0) {
    throw new PinnedNextScanError('SOURCE_DESCRIPTOR_LEAK');
  }
  const endpoints = output.report.modules.flatMap(m =>
    m.controllers.flatMap(c => c.endpoints.map(e => ({
      method: e.verb,
      route: e.path,
      source: path.posix.normalize(path.posix.relative(
        snapshot.virtualRoot, c.file)),
      line: e.line,
      params: e.params,
    }))));
  return Object.freeze({
    schema: 'backend-skeleton.next-pinned-static-scan/1',
    status: output.detection ? 'detected' : 'no-next-project-detected',
    profile: 'typescript-nextjs',
    support: Object.freeze({
      stage: 'experimental',
      verificationBasis: 'synthetic-only',
      runtimeCertified: false,
      operationRegistrationAllowed: false,
      methodInference: 'explicit-export-only',
    }),
    trust: Object.freeze({
      type: 'caller-selected-pinned-Git-object-store',
      externallyAuthorized: false,
      gitExecutableSha256: trust.gitExecutableSha256,
      sourceCommit: snapshot.git_commit,
      sourceTree: snapshot.git_tree,
      snapshotSha256: output.source_snapshot_sha256,
      scannerSourceSha256: output.trusted_scanner_sha256,
      reportSha256: output.report_sha256,
      resultSha256: output.result_sha256,
    }),
    inventory: Object.freeze({
      totalTrackedFiles: snapshot.file_count,
      hydratedSourceFiles: snapshot.hydrated_file_count,
      hydratedSourceBytes: snapshot.hydrated_bytes,
      virtualFdOperations: output.virtual_io,
      endpointCount: endpoints.length,
    }),
    endpoints,
    report: output.report,
  });
}

function safeErrorCode(err) {
  if (err instanceof PinnedNextScanError) return err.code;
  // Only bounded machine-readable error names, never source path, stderr,
  // caller Git configuration or application contents in stderr.
  const code = typeof err?.message === 'string'
    ? err.message.split(':')[0]
    : '';
  return /^[A-Z][A-Z0-9_]{2,65}$/.test(code)
    ? code
    : 'PINNED_SCAN_UNAVAILABLE';
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseOptions(argv);
    if (opts.help) {
      process.stdout.write(
        'Required: --commit <40 lowercase hex> --git-exe <absolute> ' +
        '--git-sha256 <64 lowercase hex> --git-dir <absolute> ' +
        '--common-dir <absolute>\n' +
        'Read-only experimental Next.js Git-object scanner. ' +
        'Caller must supply trusted source authority; NOT production-certified.\n');
      return 0;
    }
    process.stdout.write(JSON.stringify(scanNextPinnedProduct(opts), null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(JSON.stringify({
      ok: false, errorCode: safeErrorCode(err),
    }) + '\n');
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === cliEntrypoint) {
  process.exitCode = main();
}
