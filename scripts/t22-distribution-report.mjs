#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  T22_DISTRIBUTION_RECEIPT,
  canonicalJson,
  receiptBytes,
  sha256Bytes,
  verifyDistributionArtifacts,
} from './t22-distribution-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.env.T22_TEST_NPM || 'npm';
const TEST_FILES = [
  'test/t22-packed-consumer.test.mjs',
  'test/t22-sdk-util-hardening-integration.test.mjs',
];

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--output', '--expected-head'].includes(name) || index + 1 >= argv.length) {
      throw new Error(`usage: t22-distribution-report --output <absolute-dir> --expected-head <40-hex>`);
    }
    parsed[name.slice(2)] = argv[++index];
  }
  if (!path.isAbsolute(parsed.output ?? '')) throw new Error('--output must be an absolute path');
  if (!/^[0-9a-f]{40}$/.test(parsed['expected-head'] ?? '')) throw new Error('--expected-head must be a 40-hex commit');
  const relative = path.relative(ROOT, parsed.output);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('--output must be outside the source checkout');
  }
  return { output: parsed.output, expectedHead: parsed['expected-head'] };
}

function run(program, args, cwd = ROOT, options = {}) {
  return spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

function requireSuccess(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}: exit ${result.status}: ${(result.stderr || result.stdout || '').slice(-1000)}`);
  return result.stdout.trim();
}

function git(...args) {
  return requireSuccess(run('git', args), `git ${args.join(' ')}`);
}

function listFiles(directory, prefix = '') {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(absolute, relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}

function sourceInventory() {
  const relative = [
    '.github/workflows/ci.yml',
    'package.json',
    'package-lock.json',
    'scripts/t22-distribution-receipt.mjs',
    'scripts/t22-distribution-report.mjs',
    'test/t22-distribution-report.test.mjs',
    ...TEST_FILES,
    ...listFiles(path.join(ROOT, 'sdk', 'next'), 'sdk/next'),
  ];
  return [...new Set(relative)].sort().map((name) => {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    return { path: name, size_bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
  });
}

function parseTapSummary(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`TAP summary must contain exactly one ${key} count`);
    counts[key] = Number(matches[0][1]);
  }
  return counts;
}

function makeStage(output) {
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.staging-`));
}

function writeReceipt(stage, receipt) {
  const bytes = receiptBytes(receipt);
  const digest = sha256Bytes(bytes);
  fs.writeFileSync(path.join(stage, 'receipt.json'), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'receipt.sha256'), `${digest}\n`, { mode: 0o600 });
  return digest;
}

export function runDistributionReport(argv = process.argv.slice(2)) {
  const { output, expectedHead } = parseArgs(argv);
  const stage = makeStage(output);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t22-distribution-'));
  const failures = [];
  let head = null, tree = null, dirty = true, relevantFiles = [];
  let packageEvidence = null, testEvidence = null, cacheEvidence = null;
  let nodeVersion = process.version, npmVersion = null;

  try {
    head = git('rev-parse', 'HEAD');
    tree = git('rev-parse', 'HEAD^{tree}');
    dirty = git('status', '--porcelain', '--untracked-files=all') !== '';
    if (head !== expectedHead) failures.push(`SOURCE_HEAD_MISMATCH expected=${expectedHead} actual=${head}`);
    if (dirty) failures.push('SOURCE_TREE_DIRTY');
    relevantFiles = sourceInventory();
    npmVersion = requireSuccess(run(NPM, ['--version']), 'npm --version');

    if (failures.length === 0) {
      const pack = run(NPM, [
        'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch,
      ], ROOT, { timeout: 60000 });
      const packJson = JSON.parse(requireSuccess(pack, 'npm pack'));
      if (!Array.isArray(packJson) || packJson.length !== 1) throw new Error('npm pack returned an unexpected result count');
      const metadata = packJson[0];
      const scratchTarball = path.join(scratch, metadata.filename);
      const tarballBytes = fs.readFileSync(scratchTarball);
      const tarballSha256 = sha256Bytes(tarballBytes);
      fs.copyFileSync(scratchTarball, path.join(stage, metadata.filename));
      const metadataPath = path.join(scratch, 'pack-metadata.json');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      const members = metadata.files.map(({ path: memberPath, size, mode }) => ({
        path: memberPath, size_bytes: size, mode,
      }));

      const emptyCache = path.join(scratch, 'empty-cache');
      const emptyConsumer = path.join(scratch, 'empty-cache-consumer');
      fs.mkdirSync(emptyCache);
      fs.mkdirSync(emptyConsumer);
      const emptyProbe = run(NPM, [
        'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save',
        '--cache', emptyCache, '--prefix', emptyConsumer, scratchTarball,
      ], scratch, { timeout: 60000 });
      if (emptyProbe.error) throw emptyProbe.error;
      if (emptyProbe.status === 0) failures.push('EMPTY_CACHE_OFFLINE_INSTALL_UNEXPECTEDLY_SUCCEEDED');

      const testCommand = [process.execPath, '--test', '--test-reporter=tap', ...TEST_FILES];
      const testRun = run(testCommand[0], testCommand.slice(1), ROOT, {
        timeout: 180000,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          T22_DISTRIBUTION_TARBALL: scratchTarball,
          T22_DISTRIBUTION_METADATA_PATH: metadataPath,
          T22_DISTRIBUTION_TARBALL_SHA256: tarballSha256,
        },
      });
      if (testRun.error) throw testRun.error;
      const transcript = Buffer.from(testRun.stdout ?? '', 'utf8');
      fs.writeFileSync(path.join(stage, 'test.tap'), transcript, { mode: 0o600 });
      fs.writeFileSync(path.join(stage, 'test.stderr'), testRun.stderr ?? '', { mode: 0o600 });
      let counts = null;
      try { counts = parseTapSummary(testRun.stdout ?? ''); }
      catch (error) { failures.push(error.message); }
      if (testRun.status !== 0) failures.push(`TEST_EXIT_${testRun.status}`);
      if (counts && (counts.fail !== 0 || counts.cancelled !== 0)) failures.push('TEST_SUMMARY_NOT_GREEN');

      packageEvidence = {
        name: metadata.name,
        version: metadata.version,
        tarball_file: metadata.filename,
        tarball_sha256: tarballSha256,
        tarball_size_bytes: tarballBytes.byteLength,
        member_count: members.length,
        member_inventory_sha256: sha256Bytes(Buffer.from(canonicalJson(members))),
        members,
      };
      testEvidence = {
        command: testCommand,
        exit_code: testRun.status,
        signal: testRun.signal,
        counts,
        transcript_file: 'test.tap',
        transcript_sha256: sha256Bytes(transcript),
        stderr_file: 'test.stderr',
        stderr_sha256: sha256Bytes(Buffer.from(testRun.stderr ?? '', 'utf8')),
        tarball_sha256: tarballSha256,
      };
      cacheEvidence = {
        mode: 'network-disabled-prewarmed-npm-cache',
        lockfile_sha256: sha256Bytes(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
        empty_cache_probe_expected: 'nonzero-exit',
        empty_cache_probe_exit_code: emptyProbe.status,
        empty_cache_probe_stderr_sha256: sha256Bytes(Buffer.from(emptyProbe.stderr ?? '', 'utf8')),
      };
    }
  } catch (error) {
    failures.push(`HARNESS_ERROR ${error.message}`);
  }

  const receipt = {
    schema: T22_DISTRIBUTION_RECEIPT,
    status: failures.length === 0 ? 'pass' : 'fail',
    generated_at: new Date().toISOString(),
    source: { head, tree, expected_head: expectedHead, dirty, relevant_files: relevantFiles },
    package: packageEvidence,
    test: testEvidence,
    cache: cacheEvidence ?? {
      mode: 'network-disabled-prewarmed-npm-cache',
      lockfile_sha256: fs.existsSync(path.join(ROOT, 'package-lock.json'))
        ? sha256Bytes(fs.readFileSync(path.join(ROOT, 'package-lock.json'))) : null,
      empty_cache_probe_expected: 'nonzero-exit',
      empty_cache_probe_exit_code: null,
      empty_cache_probe_stderr_sha256: null,
    },
    environment: { node: nodeVersion, npm: npmVersion, platform: process.platform, arch: process.arch },
    durability: {
      atomic_directory_publish: true,
      scratch_deleted_after_publish: true,
      failure_receipt_preserved: true,
      detached_receipt_sha256_file: 'receipt.sha256',
    },
    failures,
    limitations: [
      'No npm publication, main merge, adapter auto-import, runtime execution authority, or official MET promotion.',
      'Offline acceptance requires the exact lockfile dependencies in npm\'s configured cache.',
    ],
  };
  let receiptSha256 = writeReceipt(stage, receipt);
  let verified = verifyDistributionArtifacts(stage, { expectedHead, expectedTree: tree });
  if (receipt.status === 'pass' && verified.problems.length > 0) {
    receipt.status = 'fail';
    receipt.failures.push(...verified.problems.map((problem) => `SELF_VERIFY ${problem}`));
    receiptSha256 = writeReceipt(stage, receipt);
    verified = verifyDistributionArtifacts(stage, { expectedHead, expectedTree: tree });
  }
  fs.renameSync(stage, output);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({
    status: receipt.status,
    output,
    source_head: head,
    tarball_sha256: packageEvidence?.tarball_sha256 ?? null,
    test_transcript_sha256: testEvidence?.transcript_sha256 ?? null,
    receipt_sha256: receiptSha256,
    verification_problems: verified.problems,
  })}\n`);
  return receipt.status === 'pass' && verified.problems.length === 0 ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runDistributionReport();
}
