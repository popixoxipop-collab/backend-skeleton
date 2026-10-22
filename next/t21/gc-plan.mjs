// Read-only opt-in planning observation. The historical GC implementation is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST = /^[0-9a-f]{64}$/;
function integer(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}
function add(a, b) { return integer('aggregate bytes', a + b); }
function directory(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('store layout must use real directories');
  return true;
}

/**
 * Observe a quiescent, caller-owned store. Never deletes, changes mtimes, or writes receipts.
 * Limits bound the candidate prefix, not traversal cost. This is not an atomic snapshot,
 * a content-integrity check, or an authorization to apply deletion to a live store.
 */
export function observeGarbagePlan(storeRoot, {
  reachable = [], dryRun = true, minAgeMs = 0, nowMs = Date.now(),
  maxDeleteCount = 10_000, maxDeleteBytes = 1024 * 1024 * 1024,
} = {}) {
  if (typeof storeRoot !== 'string' || !path.isAbsolute(storeRoot)) throw new TypeError('absolute storeRoot required');
  if (dryRun !== true) throw new TypeError('observation is read-only; dryRun must be true');
  integer('minAgeMs', minAgeMs); integer('maxDeleteCount', maxDeleteCount); integer('maxDeleteBytes', maxDeleteBytes);
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  const roots = new Set();
  for (const entry of reachable) {
    const digest = typeof entry === 'string' ? entry : entry?.digest;
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new TypeError('reachable must contain SHA-256 identities');
    roots.add(digest);
  }
  const root = path.resolve(storeRoot);
  directory(root);
  const blobsDir = path.join(root, 'blobs');
  const shaDir = path.join(blobsDir, 'sha256');
  const eligible = [], unexpected = [];
  let totalBlobs = 0, protectedBlobs = 0, youngBlobs = 0, eligibleBytes = 0;
  if (directory(blobsDir, true) && directory(shaDir, true)) {
    for (const prefix of fs.readdirSync(shaDir).sort()) {
      const prefixPath = path.join(shaDir, prefix);
      const prefixStat = fs.lstatSync(prefixPath);
      if (!/^[0-9a-f]{2}$/.test(prefix) || !prefixStat.isDirectory()) {
        unexpected.push(prefix); continue;
      }
      for (const name of fs.readdirSync(prefixPath).sort()) {
        const stat = fs.lstatSync(path.join(prefixPath, name));
        const relative = prefix + '/' + name;
        if (!DIGEST.test(name) || !name.startsWith(prefix) || !stat.isFile()) {
          unexpected.push(relative); continue;
        }
        integer('blob size', stat.size);
        if (!Number.isFinite(stat.mtimeMs)) throw new TypeError('invalid blob mtime');
        totalBlobs++;
        if (roots.has(name)) { protectedBlobs++; continue; }
        if (nowMs - stat.mtimeMs < minAgeMs) { youngBlobs++; continue; }
        eligible.push({ digest: name, size: stat.size, relative_path: relative });
        eligibleBytes = add(eligibleBytes, stat.size);
      }
    }
  }
  const candidates = [];
  let candidateBytes = 0, stopReason = null;
  for (const blob of eligible) {
    if (candidates.length >= maxDeleteCount) { stopReason = 'max_delete_count'; break; }
    if (blob.size > maxDeleteBytes - candidateBytes) { stopReason = 'max_delete_bytes'; break; }
    candidates.push(blob); candidateBytes = add(candidateBytes, blob.size);
  }
  const deferredCount = eligible.length - candidates.length;
  const selectionComplete = deferredCount === 0;
  const inventoryComplete = unexpected.length === 0;
  return {
    schema: 'sbf.artifact-gc-observation/1',
    status: selectionComplete && inventoryComplete ? 'complete' : 'partial',
    dry_run: true, deletion_authorized: false, content_integrity_verified: false,
    selection_policy: 'digest-ordered-prefix',
    selection_complete: selectionComplete, inventory_complete: inventoryComplete,
    stop_reason: stopReason,
    limits: { max_delete_count: maxDeleteCount, max_delete_bytes: maxDeleteBytes },
    reachable: roots.size, total_blobs: totalBlobs,
    protected_blobs: protectedBlobs, young_blobs: youngBlobs,
    eligible_count: eligible.length, eligible_bytes: eligibleBytes,
    candidates, candidate_bytes: candidateBytes,
    deferred_count: deferredCount, deferred_bytes: eligibleBytes - candidateBytes,
    first_deferred: eligible[candidates.length] ?? null,
    deleted: [], unexpected,
  };
}

function main(args) {
  const storeRoot = args.shift();
  const options = {};
  const names = new Map([['--max-count', 'maxDeleteCount'], ['--max-bytes', 'maxDeleteBytes']]);
  while (args.length) {
    const flag = args.shift(), name = names.get(flag), value = args.shift();
    if (!name || Object.hasOwn(options, name) || !/^(0|[1-9][0-9]*)$/.test(value ?? '')) {
      throw new TypeError('usage: gc-plan.mjs /absolute/store [--max-count N] [--max-bytes N]');
    }
    options[name] = Number(value);
  }
  console.log(JSON.stringify(observeGarbagePlan(storeRoot, options)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
