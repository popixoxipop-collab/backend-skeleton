// T20 opt-in consumer of the real runScan. Reads pass through the T20 gate;
// the stable CLI remains untouched. This is not an OS sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createEnforcementGate } from './enforcement-gate.mjs';
import { runScan } from '../../scanners/index.mjs';

export const GATED_SCAN_CONTRACT = 'bskel.gated-product-scan/1';
const MAX_FILES = 2048;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_SINGLE_BYTES = 2 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function deny(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function inside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
function portable(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 512 &&
    !path.posix.isAbsolute(rel) && !rel.includes('\\') &&
    !/[^\x20-\x7e]/.test(rel) &&
    rel.split('/').every((part) => part && part !== '.' && part !== '..' &&
      part !== '.git' && part !== 'node_modules' && !part.startsWith('.'));
}
export function createSourceReadHost(root) {
  const realRoot = fs.realpathSync(root);
  const calls = [];
  return Object.freeze({
    calls,
    async realpath(rel) {
      calls.push({ method: 'realpath', path: rel });
      const full = path.resolve(realRoot, rel);
      if (inside(realRoot, full) === null) return null;
      return inside(realRoot, await fs.promises.realpath(full));
    },
    async readFile(rel) {
      calls.push({ method: 'readFile', path: rel });
      const full = path.resolve(realRoot, rel);
      if (inside(realRoot, full) === null) deny('T20_SOURCE_ESCAPE', 'read escaped source root');
      const handle = await fs.promises.open(full, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_SINGLE_BYTES)
          deny('T20_FILE_LIMIT', 'source must be regular and within byte budget');
        const data = await handle.readFile();
        if (data.length > MAX_SINGLE_BYTES) deny('T20_FILE_LIMIT', 'file exceeds byte budget');
        return data;
      } finally { await handle.close(); }
    },
  });
}

export async function runGatedProductScan({
  repoRoot, manifest, files, terms = [], rgAvailable = true,
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot || !fs.statSync(repoRoot).isDirectory())
    deny('T20_REPO_REQUIRED', 'existing source directory is required');
  if (!manifest || typeof manifest !== 'object')
    deny('T20_MANIFEST_REQUIRED', 'explicit permission manifest required');
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES ||
      files.some((f) => !portable(f)) || new Set(files).size !== files.length)
    deny('T20_SOURCE_LIST_INVALID', 'unique portable source paths are required');
  if (!Array.isArray(terms) || terms.length > 32 ||
      terms.some((t) => typeof t !== 'string' || t.length > 80))
    deny('T20_TERMS_INVALID', 'terms must be a bounded string list');
  if (rgAvailable !== true)
    deny('T20_RG_REQUIRED', 'this consumer requires ripgrep');
  const realRoot = fs.realpathSync(repoRoot);
  const host = createSourceReadHost(realRoot);
  // No network/process/secret/listener capability is exposed by this host.
  const gate = createEnforcementGate({ manifest, host, mode: 'enforce',
    maxAuditEntries: 2 * MAX_FILES + 32 });
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bskel-t20-product-'));
  const snapshot = path.join(scratch, 'source');
  const observed = [];
  let totalBytes = 0;
  try {
    fs.mkdirSync(snapshot, { mode: 0o700 });
    for (const name of [...files].sort()) {
      const bytes = Buffer.from(await gate.read(name));
      totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES)
        deny('T20_SOURCE_BUDGET', 'total gated source bytes exceeded budget');
      const dest = path.join(snapshot, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
      observed.push({ path: name, sha256: sha(bytes), bytes: bytes.length });
    }
    const audit = gate.verifyAudit();
    const report = gate.report();
    if (!audit.ok || report.mode !== 'enforce' || !report.enforcing)
      deny('T20_AUDIT_INVALID', 'the source-read audit did not verify');
    // Invoke the ACTUAL first-party scanner, not a mocked adapter. It sees the
    // gated temporary copy only. Explicitly disable DB and runtime execution.
    const scanned = runScan({
      repoRoot: snapshot, terms, includeDb: false, runtimeRoutes: false,
      rgAvailable: true,
    });
    return {
      schema: GATED_SCAN_CONTRACT,
      scan_report: rewriteReport(scanned, snapshot, realRoot),
      source_files: observed,
      source_bytes: totalBytes,
      source_coverage: "caller_subset_unverified",
      permission_digest: gate.permissionDigest,
      gate_audit_valid: audit.ok,
      gate_audit_entries: report.audit.entries,
      gate_enforced_source_reads: observed.length,
      execution: 'real runScan on gated snapshot, opt-in only',
      stable_cli_changed: false,
      os_sandbox: false,
      production_approved: false,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function rewriteReport(report, snapshot, realRoot) {
  return JSON.parse(JSON.stringify(report, (_key, value) =>
    typeof value === 'string' && value.startsWith(snapshot + path.sep)
      ? realRoot + value.slice(snapshot.length) : value));
}
