import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const T22_DISTRIBUTION_RECEIPT = 'bskel.t22-distribution-receipt/1';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
// Shared with the producer; a generic green test is not distribution evidence.
export const T22_DISTRIBUTION_TEST_ARGS = Object.freeze([
  '--test', '--test-reporter=tap',
  'test/t22-packed-consumer.test.mjs',
  'test/t22-sdk-util-hardening-integration.test.mjs',
]);
function isRequiredDistributionCommand(command, expectedNodeExecutable) {
  if (!Array.isArray(command) || command.length !== T22_DISTRIBUTION_TEST_ARGS.length + 1 ||
      command.some((part) => typeof part !== 'string')) return false;
  const executable = command[0];
  const nativeNode = path.isAbsolute(executable) && path.basename(executable) === 'node';
  const windowsNode = path.win32.isAbsolute(executable) && path.win32.basename(executable).toLowerCase() === 'node.exe';
  return (nativeNode || windowsNode) && executable === expectedNodeExecutable && T22_DISTRIBUTION_TEST_ARGS.every((part, index) => command[index + 1] === part);
}


export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function regularFile(directory, name, problems) {
  if (typeof name !== 'string' || name === '' || path.basename(name) !== name) {
    problems.push(`unsafe artifact filename: ${JSON.stringify(name)}`);
    return null;
  }
  const target = path.join(directory, name);
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error('not a regular file');
    return target;
  } catch (error) {
    problems.push(`artifact ${name} is unavailable: ${error.message}`);
    return null;
  }
}

function safeJson(bytes, label, problems) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    problems.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function normalizeSourceInventory(files) {
 if (!Array.isArray(files) || files.length === 0) throw new Error('source inventory must be a nonempty array');
 const seen = new Set();
 return files.map((file) => {
  if (!file || typeof file !== 'object' || typeof file.path !== 'string' ||
      file.path === '' || file.path.startsWith('/') || file.path.includes('\\') ||
      /[\x00-\x1f]/.test(file.path) || file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || !SHA256.test(file.sha256 ?? '') || seen.has(file.path)) {
   throw new Error('source inventory contains an invalid or duplicate record');
  }
  seen.add(file.path); return {path:file.path,size_bytes:file.size_bytes,sha256:file.sha256};
 }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function verifyDistributionArtifacts(directory, {
  expectedHead,
  expectedTree,
  expectedNodeExecutable,
  expectedSourceInventory,
  expectedTarballSha256,
} = {}) {
  const problems = [];
  const receiptPath = path.join(directory, 'receipt.json');
  const digestPath = path.join(directory, 'receipt.sha256');
  let bytes;
  try {
    bytes = fs.readFileSync(receiptPath);
  } catch (error) {
    return { problems: [`receipt.json is unavailable: ${error.message}`], receipt: null, receiptSha256: null };
  }
  const receiptSha256 = sha256Bytes(bytes);
  let detached = '';
  try {
    detached = fs.readFileSync(digestPath, 'utf8');
  } catch (error) {
    problems.push(`receipt.sha256 is unavailable: ${error.message}`);
  }
  if (detached !== `${receiptSha256}\n`) problems.push('detached receipt SHA-256 does not match receipt.json bytes');

  const receipt = safeJson(bytes, 'receipt.json', problems);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    problems.push('receipt.json must contain a receipt object');
    return { problems, receipt: null, receiptSha256 };
  }
  if (!Array.isArray(receipt.failures) || receipt.failures.some((value) => typeof value !== 'string')) {
    problems.push('receipt.failures must be an array of failure messages');
  } else if (receipt.status === 'pass' && receipt.failures.length !== 0) {
    problems.push('passing receipt contains recorded failures');
  }
  if (receipt.schema !== T22_DISTRIBUTION_RECEIPT) problems.push(`unsupported receipt schema: ${receipt.schema}`);
  if (!['pass', 'fail'].includes(receipt.status)) problems.push(`invalid receipt status: ${receipt.status}`);
  if (!COMMIT.test(receipt.source?.head ?? '')) problems.push('source.head must be a 40-hex commit');
  if (!COMMIT.test(receipt.source?.tree ?? '')) problems.push('source.tree must be a 40-hex tree');
  if (expectedHead !== undefined && receipt.source?.head !== expectedHead) {
    problems.push(`source HEAD mismatch: expected ${expectedHead}, received ${receipt.source?.head}`);
  }
  if (receipt.cache?.mode !== 'network-disabled-prewarmed-npm-cache') {
    problems.push('cache.mode must state the pre-warmed offline precondition');
  }
  if (!SHA256.test(receipt.cache?.lockfile_sha256 ?? '')) problems.push('cache.lockfile_sha256 is invalid');
  if (receipt.status === 'pass' && receipt.source?.dirty !== false) problems.push('a passing receipt must bind a clean checkout');

  const passing = receipt.status === 'pass';
  if (passing || receipt.package != null || receipt.test != null) {
    // The caller must obtain both pins from Git, not from this receipt.
    if (!COMMIT.test(expectedHead ?? '')) problems.push('passing receipt requires an independently supplied expectedHead');
    if (!COMMIT.test(expectedTree ?? '')) problems.push('passing receipt requires an independently supplied expectedTree');
    if (expectedTree !== undefined && receipt.source?.tree !== expectedTree) {
      problems.push(`source tree mismatch: expected ${expectedTree}, received ${receipt.source?.tree}`);
    }
    if (receipt.source?.expected_head !== receipt.source?.head) {
      problems.push('source.expected_head does not match passing source.head');
    }
    if (typeof expectedNodeExecutable !== 'string' ||
        !(path.isAbsolute(expectedNodeExecutable) || path.win32.isAbsolute(expectedNodeExecutable))) {
      problems.push('recorded execution requires independently supplied expectedNodeExecutable');
    }
    try {
      const actual = normalizeSourceInventory(receipt.source?.relevant_files);
      const expected = normalizeSourceInventory(expectedSourceInventory);
      if (canonicalJson(actual) !== canonicalJson(expected)) problems.push('source inventory does not match expectedSourceInventory');
    } catch (error) { problems.push(`source inventory: ${error.message}`); }
    const tarball = regularFile(directory, receipt.package?.tarball_file, problems);
    if (!SHA256.test(receipt.package?.tarball_sha256 ?? '')) problems.push('package.tarball_sha256 is invalid');
    if (tarball) {
      const tarballBytes = fs.readFileSync(tarball);
      const actual = sha256Bytes(tarballBytes);
      if (actual !== receipt.package.tarball_sha256) problems.push('preserved tarball SHA-256 does not match receipt');
      if (tarballBytes.byteLength !== receipt.package.tarball_size_bytes) problems.push('preserved tarball size does not match receipt');
    }
    if (expectedTarballSha256 !== undefined && receipt.package?.tarball_sha256 !== expectedTarballSha256) {
      problems.push(`tarball SHA-256 mismatch: expected ${expectedTarballSha256}, received ${receipt.package?.tarball_sha256}`);
    }
    if (!Array.isArray(receipt.package?.members) || receipt.package.members.length === 0) {
      problems.push('package member inventory is empty');
    } else {
      const inventorySha = sha256Bytes(Buffer.from(canonicalJson(receipt.package.members)));
      if (inventorySha !== receipt.package.member_inventory_sha256) problems.push('package member inventory SHA-256 does not match');
      if (receipt.package.member_count !== receipt.package.members.length) problems.push('package member count does not match inventory');
    }

    const transcript = regularFile(directory, receipt.test?.transcript_file, problems);
    let transcriptCounts = null;
    if (transcript) {
      const transcriptBytes = fs.readFileSync(transcript);
      if (sha256Bytes(transcriptBytes) !== receipt.test?.transcript_sha256) {
        problems.push('test transcript SHA-256 does not match receipt');
      }
      // A matching file digest binds bytes, not the claimed test outcome.
      // Re-read the actual retained counts instead of trusting receipt metadata.
      const text = transcriptBytes.toString('utf8');
      transcriptCounts = {};
      for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) {
        const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
        if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0]?.[1]))) {
          problems.push(`TAP summary must contain exactly one valid ${key} count`);
        } else {
          transcriptCounts[key] = Number(matches[0][1]);
        }
      }
    }
    const stderr = regularFile(directory, receipt.test?.stderr_file, problems);
    if (!SHA256.test(receipt.test?.stderr_sha256 ?? '')) {
      problems.push('test stderr SHA-256 is invalid');
    }
    if (stderr && sha256Bytes(fs.readFileSync(stderr)) !== receipt.test?.stderr_sha256) {
      problems.push('test stderr SHA-256 does not match receipt');
    }
    if (receipt.test?.tarball_sha256 !== receipt.package?.tarball_sha256) {
      problems.push('test did not bind the preserved tarball SHA-256');
    }
    if (!isRequiredDistributionCommand(receipt.test?.command, expectedNodeExecutable)) {
      problems.push('receipt does not bind the required distribution test command or expected executable');
    }
    const counts = receipt.test?.counts;
    for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) {
      if (!Number.isSafeInteger(counts?.[key]) || counts[key] < 0) problems.push(`test count ${key} is invalid`);
    }
    const outcomeKeys = ['pass', 'fail', 'skipped', 'cancelled', 'todo'];
    if (Number.isSafeInteger(counts?.tests) &&
        outcomeKeys.every((key) => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)) {
      const total = outcomeKeys.reduce((sum, key) => sum + counts[key], 0);
      if (!Number.isSafeInteger(total) || total !== counts.tests) {
        problems.push('test outcome counts do not form a consistent total');
      }
    }
    if (passing && (!(counts?.tests > 0) || !(counts?.pass > 0))) {
      problems.push('passing receipt must contain at least one executed passing test');
    }
    if (transcriptCounts) {
      for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) {
        if (transcriptCounts[key] !== counts?.[key]) {
          problems.push(`TAP summary ${key} does not match receipt test counts`);
        }
      }
    }
    if (passing && (receipt.test?.exit_code !== 0 || receipt.test?.signal !== null ||
        counts?.fail !== 0 || counts?.cancelled !== 0)) {
      problems.push('passing receipt contains a failing test outcome');
    }
    if (passing && (!Number.isInteger(receipt.cache?.empty_cache_probe_exit_code) ||
        receipt.cache.empty_cache_probe_exit_code === 0)) {
      problems.push('empty-cache offline negative did not fail as required');
    }
    const lockfiles = Array.isArray(receipt.source?.relevant_files)
      ? receipt.source.relevant_files.filter((file) => file?.path === 'package-lock.json') : [];
    if (lockfiles.length !== 1 || !SHA256.test(lockfiles[0]?.sha256 ?? '') ||
        lockfiles[0]?.sha256 !== receipt.cache?.lockfile_sha256) {
      problems.push('source lockfile inventory must bind exactly one cache lockfile SHA-256');
    }
  }
  return { problems, receipt, receiptSha256 };
}
