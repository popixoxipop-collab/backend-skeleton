import crypto from 'node:crypto';
import {
  PERMISSION_MANIFEST_DIGEST_FORMAT,
  compilePermissionPolicy,
  permissionManifestDigest,
  selectApprovedEnvironment,
} from './permission-manifest.mjs';

// Enforcement gate for `bskel.trust-permissions/1` manifests.
//
// This is cooperative, in-process mediation. A request reaches the injected host only after the
// compiled manifest policy granted it. It is NOT an operating-system sandbox: it cannot stop code
// that reaches files, sockets or processes by another route, it makes no attestation claim, and
// it does not set the evidence echo `enforced` flag. Every real effect lives in the host object,
// so this module stays free of file, socket and process capabilities (static-purity.test.mjs).
// ENFORCEMENT_GATE.md lists the stated limits.
//
// Host contract (every method is optional; a missing method makes its operation fail closed):
//   realpath(rel, { forWrite }) -> canonical root-relative POSIX path, or null when the real location
//                                  lies outside the host root; may throw when the path cannot be resolved
//   readFile(rel) / writeFile(rel, bytes)        use the canonical path returned by realpath
//   resolve(hostname) -> array of address strings
//   connect({ host, address, port })             `address` is the address the gate checked and pinned;
//                                  it resolves { connected: true } once the connection exists, and any other answer is recorded as failed
//   listen({ host, port })
//   resolveExecutable(basename) -> absolute path from a fixed directory list, never the ambient PATH
//   spawn({ file, executable, args, env, onStdout, onStderr }) -> { pid, kill(signal), done }
//   resolveSecret(ref) / openDevice(deviceClass)

export const ENFORCEMENT_GATE_CONTRACT = 'bskel.trust-enforcement-gate/1';
export const ENFORCEMENT_REPORT_CONTRACT = 'bskel.trust-enforcement-report/1';
export const ENFORCEMENT_AUDIT_CONTRACT = 'bskel.trust-enforcement-audit/1';
export const GATE_MODES = Object.freeze(['enforce', 'shadow']);
export const GATE_OPERATIONS = Object.freeze(['read', 'write', 'connect', 'listen', 'spawn', 'env', 'secret', 'device']);
export const SHADOW_PASS_THROUGH = Object.freeze(['read', 'write', 'connect', 'listen', 'spawn']);
export const UNSUPPORTED_LIMITS = Object.freeze(['cpu_ms', 'memory_bytes', 'pids', 'scratch_bytes']);
export const GATE_LIMITS = Object.freeze([
  { id: 'cooperative-mediation', text: 'Only operations routed through the gate are checked; code that reaches files, sockets or processes by another route is not stopped.' },
  { id: 'no-os-sandbox', text: 'The gate is not an operating-system sandbox: it installs no syscall filter, mount namespace or network namespace.' },
  { id: 'check-use-race', text: 'A path can change between the canonical check and the host open; the host can refuse a symlink in the final component but intermediate directories can still be swapped.' },
  { id: 'children-unmediated', text: 'A process started through the gate runs with the host privileges; its own files, sockets, syscalls and descendant processes are not mediated.' },
  { id: 'resource-limits-unsupported', text: 'cpu_ms, memory_bytes, pids and scratch_bytes are declared by the manifest but cannot be enforced here and are reported unsupported.' },
  { id: 'self-computed-audit', text: 'The audit log is a self-computed hash chain: it detects corruption and naive edits, not a writer that recomputes every hash.' },
  { id: 'no-attestation', text: 'No signed attestation exists or is claimed; the report states attestation present false.' },
  { id: 'echo-enforced-flag-not-set', text: 'The trust evidence echo permission.enforced flag is not set by this layer; in-process mediation is not a claim that a whole run was enforced.' },
  { id: 'shadow-is-not-enforcement', text: 'Shadow mode records would-deny decisions and still forwards read, write, connect, listen and spawn requests; it never enforces those grants.' },
].map((limit) => Object.freeze(limit)));

const MAX_ARGS = 1024;
const MAX_ARG_LENGTH = 65536;
const MAX_PATH_LENGTH = 4096;
const MAX_TIMER_MS = 2_147_483_647;
const DECISIONS = new Set(['allow', 'deny', 'would-deny']);
const HOST_METHODS = Object.freeze({
  read: ['realpath', 'readFile'],
  write: ['realpath', 'writeFile'],
  connect: ['connect'],
  listen: ['listen'],
  spawn: ['resolveExecutable', 'spawn'],
  env: [],
  secret: ['resolveSecret'],
  device: ['openDevice'],
});

export class EnforcementDenied extends Error {
  constructor(operation, reason, seq) {
    super(`${operation} denied by the enforcement gate: ${reason}`);
    this.name = 'EnforcementDenied';
    this.code = 'PERMISSION_DENIED';
    this.operation = operation;
    this.reason = reason;
    this.audit_seq = seq;
  }
}

class InvalidRequest extends Error {}

function configError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function genesisHash(manifestDigest) {
  return sha256(`${ENFORCEMENT_AUDIT_CONTRACT}\n${PERMISSION_MANIFEST_DIGEST_FORMAT}\n${manifestDigest}`);
}

function entryHash(entry) {
  const body = { ...entry };
  delete body.sha256;
  return sha256(canonicalJson(body));
}

function enforcedFor(mode, operation) {
  return mode === 'enforce' || !SHADOW_PASS_THROUGH.includes(operation);
}

export function verifyAuditLog(entries, { manifestDigest, expectedEntries, expectedHeadSha256, inFlight = [] } = {}) {
  const errors = [];
  const push = (code, seq, message) => errors.push({ code, seq, message });
  if (!Array.isArray(entries)) return { ok: false, errors: [{ code: 'AUDIT_NOT_ARRAY', seq: null, message: 'audit log must be an array' }] };
  if (typeof manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifestDigest)) {
    return { ok: false, errors: [{ code: 'AUDIT_MANIFEST_DIGEST_REQUIRED', seq: null, message: 'the manifest digest that seeds the chain is required' }] };
  }
  const genesis = genesisHash(manifestDigest);
  let previous = genesis;
  const owed = [];
  const settled = new Set();
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      push('AUDIT_ENTRY_INVALID', index, 'entry must be an object');
      return;
    }
    if (entry.contract !== ENFORCEMENT_AUDIT_CONTRACT) push('AUDIT_ENTRY_INVALID', index, 'unsupported audit contract');
    if (entry.seq !== index) push('AUDIT_SEQ_MISMATCH', index, `entry carries seq ${entry.seq}`);
    if (entry.prev_sha256 !== previous) push('AUDIT_CHAIN_BROKEN', index, 'prev_sha256 does not match the previous entry');
    if (entry.sha256 !== entryHash(entry)) push('AUDIT_HASH_MISMATCH', index, 'entry content does not match its sha256');
    if (!GATE_MODES.includes(entry.mode)) push('AUDIT_ENTRY_INVALID', index, 'mode must be enforce or shadow');
    if (entry.phase === 'decision') {
      if (!DECISIONS.has(entry.decision)) push('AUDIT_DECISION_INVALID', index, 'decision must be allow, deny or would-deny');
      else if (entry.decision === 'deny' && entry.enforced !== true) push('AUDIT_INCONSISTENT', index, 'a deny must be enforced');
      else if (entry.decision === 'would-deny' && (entry.mode !== 'shadow' || entry.enforced !== false)) push('AUDIT_INCONSISTENT', index, 'would-deny exists only in shadow mode and is never enforced');
      else if (entry.decision === 'allow' && entry.enforced !== enforcedFor(entry.mode, entry.operation)) push('AUDIT_INCONSISTENT', index, 'allow carries an enforced flag that does not match the mode');
      if ((entry.decision === 'allow' || entry.decision === 'would-deny') && entry.operation !== 'env') owed.push(index);
    } else if (entry.phase === 'outcome') {
      const ref = Number.isInteger(entry.decision_seq) ? entries[entry.decision_seq] : undefined;
      if (!ref || entry.decision_seq >= index || ref.phase !== 'decision' || ref.decision === 'deny' || ref.operation !== entry.operation) {
        push('AUDIT_OUTCOME_ORPHAN', index, 'outcome must follow a non-denied decision of the same operation');
      } else {
        settled.add(entry.decision_seq);
      }
    } else {
      push('AUDIT_PHASE_INVALID', index, 'phase must be decision or outcome');
    }
    previous = typeof entry.sha256 === 'string' ? entry.sha256 : previous;
  });
  // Every allowed or would-deny decision except an environment read has exactly one host effect and so owes an outcome.
  // `inFlight` lists the decisions the caller knows are still running; an exported log has none.
  const open = new Set(Array.isArray(inFlight) ? inFlight : []);
  for (const seq of owed) {
    if (!settled.has(seq) && !open.has(seq)) push('AUDIT_OUTCOME_MISSING', seq, 'an allow or would-deny decision has no outcome entry');
  }
  if (expectedEntries !== undefined && entries.length !== expectedEntries) push('AUDIT_TRUNCATED', null, `expected ${expectedEntries} entries, found ${entries.length}`);
  if (expectedHeadSha256 !== undefined) {
    const head = entries.length === 0 ? genesis : entries[entries.length - 1]?.sha256;
    if (head !== expectedHeadSha256) push('AUDIT_HEAD_MISMATCH', null, 'chain head differs from the expected head');
  }
  return { ok: errors.length === 0, errors };
}

function parseIPv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match || match.slice(1).some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIPv6(input) {
  if (!/^[0-9a-fA-F:.]+$/.test(input)) return null;
  let text = input;
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const v4 = cut < 0 ? null : parseIPv4(text.slice(cut + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parts = (half) => (half === '' ? [] : half.split(':'));
  const left = parts(halves[0]);
  const right = halves.length === 2 ? parts(halves[1]) : [];
  const groups = [...left, ...right];
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;
  const fill = halves.length === 2 ? new Array(8 - groups.length).fill(0) : [];
  return [...left.map((g) => parseInt(g, 16)), ...fill, ...right.map((g) => parseInt(g, 16))];
}

function classifyIPv4(octets) {
  const [a, b, c] = octets;
  if (a === 0) return 'unspecified';
  if (a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

// Classes: public, loopback, private, link-local, unspecified, multicast, reserved, invalid.
// A resolved name that maps to anything but `public` is refused unless the manifest names that address.
export function classifyAddress(address) {
  if (typeof address !== 'string') return 'invalid';
  const v4 = parseIPv4(address);
  if (v4) return classifyIPv4(v4);
  const h = parseIPv6(address);
  if (!h) return 'invalid';
  const embedded = (hi, lo) => classifyIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  // IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses only wrap an IPv4 address. They are not
  // global unicast, so they are never public. They keep the class of the wrapped address when that class says why they are
  // refused (private, loopback, link-local, ...); a wrapped public address is reserved. Grant the literal to allow one.
  const wrapped = (hi, lo) => {
    const inner = embedded(hi, lo);
    return inner === 'public' ? 'reserved' : inner;
  };
  if (h.every((x) => x === 0)) return 'unspecified';
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'loopback';
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return wrapped(h[6], h[7]);
  if (h.slice(0, 6).every((x) => x === 0)) return 'reserved';
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return wrapped(h[6], h[7]);
  if (h[0] === 0x2002) return wrapped(h[1], h[2]);
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfec0) return 'private';
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((h[0] & 0xff00) === 0xff00) return 'multicast';
  // Public means global unicast: 2000::/3 minus the IANA special-purpose blocks inside it (2001::/23, 2001:db8::/32, 3fff::/20;
  // 2002::/16 is handled above). Everything outside 2000::/3 is reserved, so an unknown range is never public by default.
  const special = (h[0] === 0x2001 && (h[1] < 0x0200 || h[1] === 0x0db8)) || (h[0] === 0x3fff && h[1] < 0x1000);
  if ((h[0] & 0xe000) !== 0x2000 || special) return 'reserved';
  return 'public';
}

function addressLiteral(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return /^[0-9.]+$/.test(hostname) ? hostname : null;
}

function policyHost(address) {
  return address.includes(':') ? `[${address}]` : address;
}

function requireString(value, name, max = MAX_PATH_LENGTH) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new InvalidRequest(`${name} must be a non-empty NUL-free string of at most ${max} characters`);
  }
  return value;
}

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export function createEnforcementGate({ manifest, host, mode = 'enforce', clock = Date.now, maxAuditEntries = 100_000 } = {}) {
  if (!GATE_MODES.includes(mode)) throw configError('INVALID_GATE_MODE', `gate mode must be one of ${GATE_MODES.join(', ')}`);
  if (host === null || typeof host !== 'object') throw configError('INVALID_GATE_HOST', 'gate requires a host object');
  if (typeof clock !== 'function') throw configError('INVALID_GATE_CLOCK', 'gate requires a clock function');
  if (!Number.isSafeInteger(maxAuditEntries) || maxAuditEntries < 2) throw configError('INVALID_GATE_OPTIONS', 'maxAuditEntries must be an integer of at least 2');
  const policy = compilePermissionPolicy(manifest);
  const spec = policy.manifest;
  const manifestDigest = permissionManifestDigest(spec);
  const entries = [];
  // Decisions that still owe an outcome entry. Each one holds a reserved slot, so every capacity check counts it.
  const pending = new Set();
  let activeChildren = 0;

  const hostSupports = (operation) => HOST_METHODS[operation].every((name) => typeof host[name] === 'function');

  function append(fields) {
    if (entries.length >= maxAuditEntries) throw new EnforcementDenied(fields.operation, 'AUDIT_FULL', null);
    const at = clock();
    if (!Number.isSafeInteger(at)) throw configError('INVALID_GATE_CLOCK', 'clock must return a safe integer');
    const prev = entries.length === 0 ? genesisHash(manifestDigest) : entries[entries.length - 1].sha256;
    const body = { contract: ENFORCEMENT_AUDIT_CONTRACT, seq: entries.length, prev_sha256: prev, at, mode, ...fields };
    const entry = deepFreeze({ ...body, sha256: sha256(canonicalJson(body)) });
    entries.push(entry);
    return entry;
  }

  // A request that reaches the host needs two slots, its decision and its outcome, reserved before the host is called;
  // a refusal needs one. A log without room refuses the request (AUDIT_FULL) instead of letting an effect happen that
  // cannot be recorded. No await separates this check from the append that follows it.
  function reserve(operation, slots) {
    if (entries.length + pending.size + slots > maxAuditEntries) throw new EnforcementDenied(operation, 'AUDIT_FULL', null);
  }

  // Only an environment read has no host effect and therefore no outcome entry.
  function owe(entry) {
    if (entry.operation !== 'env') pending.add(entry.seq);
    return entry;
  }

  function refuse(operation, reason, target) {
    reserve(operation, 1);
    const entry = append({ phase: 'decision', operation, decision: 'deny', reason, enforced: true, target });
    throw new EnforcementDenied(operation, reason, entry.seq);
  }

  // A failed grant is refused in enforce mode. In shadow mode a pass-through operation is recorded
  // as would-deny and the caller continues; every other operation is still refused.
  function grantFailure(operation, reason, target) {
    if (enforcedFor(mode, operation)) refuse(operation, reason, target);
    reserve(operation, 2);
    return owe(append({ phase: 'decision', operation, decision: 'would-deny', reason, enforced: false, target }));
  }

  function allow(operation, target) {
    reserve(operation, operation === 'env' ? 1 : 2);
    return owe(append({ phase: 'decision', operation, decision: 'allow', reason: 'GRANTED', enforced: enforcedFor(mode, operation), target }));
  }

  function outcome(decision, fields) {
    try {
      return append({ phase: 'outcome', operation: decision.operation, decision_seq: decision.seq, ...fields });
    } finally {
      // In flight means the gate is still waiting on the host. If the entry could not be written the decision is no longer
      // in flight, so verifyAudit() reports the missing outcome instead of excusing it.
      pending.delete(decision.seq);
    }
  }

  async function finish(decision, action, describe) {
    try {
      const value = await action();
      outcome(decision, { ok: true, ...describe(value) });
      return value;
    } catch (error) {
      outcome(decision, { ok: false, error_code: String(error?.code ?? 'HOST_ERROR').slice(0, 64) });
      throw error;
    }
  }

  // Lexical grant check, then canonicalisation by the host, then the grant check again on the
  // canonical path. The canonical path is the one used, so a symlink cannot widen the grant.
  async function checkedPath(operation, path, can, target) {
    if (!can(path)) return { decision: grantFailure(operation, 'NOT_GRANTED', target), use: path };
    let canonical;
    try {
      canonical = await host.realpath(path, { forWrite: operation === 'write' });
    } catch {
      return { decision: grantFailure(operation, 'PATH_UNRESOLVABLE', target), use: path };
    }
    if (canonical === null) return { decision: grantFailure(operation, 'PATH_ESCAPES_ROOT', target), use: path };
    if (typeof canonical !== 'string' || canonical === '' || canonical.includes('\0')) {
      return { decision: grantFailure(operation, 'PATH_UNRESOLVABLE', target), use: path };
    }
    if (!can(canonical)) {
      return { decision: grantFailure(operation, 'PATH_ESCAPES_GRANT', { ...target, canonical: canonical.slice(0, 256) }), use: path };
    }
    return { decision: allow(operation, { ...target, canonical: canonical.slice(0, 256) }), use: canonical };
  }

  async function runRead(path) {
    const { decision, use } = await checkedPath('read', path, policy.canRead, { path: path.slice(0, 256) });
    return finish(decision, () => host.readFile(use), (value) => ({ bytes: toBuffer(value).length }));
  }

  async function runWrite(path, data) {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new InvalidRequest('data must be a string or bytes');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const { decision, use } = await checkedPath('write', path, policy.canWrite, { path: path.slice(0, 256), bytes: bytes.length });
    return finish(decision, async () => {
      await host.writeFile(use, bytes);
      return { path: use, bytes: bytes.length };
    }, (value) => ({ bytes: value.bytes }));
  }

  // The address that passes the check is the address that is connected: the name is resolved once.
  async function pinAddress(hostname, port, target) {
    const literal = addressLiteral(hostname);
    if (literal !== null) {
      if (classifyAddress(literal) === 'invalid') return { entry: grantFailure('connect', 'INVALID_ADDRESS_LITERAL', target), address: null };
      return { entry: null, address: literal };
    }
    if (typeof host.resolve !== 'function') refuse('connect', 'HOST_CAPABILITY_MISSING', target);
    let addresses;
    try {
      addresses = await host.resolve(hostname);
    } catch {
      return { entry: grantFailure('connect', 'RESOLVE_FAILED', target), address: null };
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((x) => typeof x !== 'string')) {
      return { entry: grantFailure('connect', 'RESOLVE_FAILED', target), address: null };
    }
    const blocked = addresses.filter((address) => classifyAddress(address) !== 'public' && !policy.canConnect(policyHost(address), port));
    if (blocked.length > 0) {
      const classes = [...new Set(blocked.map(classifyAddress))].sort();
      return { entry: grantFailure('connect', 'RESOLVES_TO_NON_PUBLIC_ADDRESS', { ...target, address_classes: classes }), address: addresses[0] };
    }
    return { entry: null, address: addresses[0] };
  }

  // Shadow mode only. A host name the manifest does not grant is still connected to, so it is resolved once here and the
  // answer is pinned like a granted one. Without an address nothing is passed through. Enforce mode never gets here, so an
  // ungranted name is never resolved.
  async function shadowAddress(name) {
    const literal = addressLiteral(name);
    if (literal !== null) return classifyAddress(literal) === 'invalid' ? { address: null, why: 'INVALID_ADDRESS_LITERAL' } : { address: literal, why: null };
    if (typeof host.resolve !== 'function') return { address: null, why: 'HOST_CAPABILITY_MISSING' };
    try {
      const answers = await host.resolve(name);
      if (Array.isArray(answers) && answers.length > 0 && answers.every((x) => typeof x === 'string')) return { address: answers[0], why: null };
    } catch { /* the name does not resolve */ }
    return { address: null, why: 'RESOLVE_FAILED' };
  }

  // A host call that resolves has not necessarily done the work: an answer that does not affirm it is a failure.
  async function affirmed(attempt, key, code) {
    const result = await attempt;
    if (result === null || typeof result !== 'object' || result[key] !== true) {
      const error = new Error(`the host did not report ${key}`);
      error.code = code;
      throw error;
    }
    return result;
  }

  async function runConnect(hostname, port) {
    requireString(hostname, 'host', 255);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidRequest('port must be an integer in 1..65535');
    const name = hostname.toLowerCase();
    const target = { host: name, port };
    let decision;
    let address = null;
    let unreachable = null;
    if (!policy.canConnect(hostname, port)) {
      decision = grantFailure('connect', 'NOT_GRANTED', target);
      ({ address, why: unreachable } = await shadowAddress(name));
    } else {
      const pinned = await pinAddress(name, port, target);
      address = pinned.address;
      decision = pinned.entry ?? allow('connect', { ...target, address });
      unreachable = decision.reason;
    }
    // Shadow mode only: a would-deny without a pinned address cannot be passed through, so the attempt is recorded as
    // not executed and the host is not called.
    if (address === null) {
      outcome(decision, { ok: false, error_code: unreachable });
      throw new EnforcementDenied('connect', unreachable, decision.seq);
    }
    return finish(decision, () => affirmed(host.connect({ host: name, address, port }), 'connected', 'NOT_CONNECTED'), () => ({ address }));
  }

  async function runListen(hostname, port) {
    requireString(hostname, 'host', 255);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidRequest('port must be an integer in 0..65535');
    const name = hostname.toLowerCase();
    const target = { host: name, port };
    const decision = policy.canListen(hostname, port) ? allow('listen', target) : grantFailure('listen', 'NOT_GRANTED', target);
    return finish(decision, () => host.listen({ host: name, port }), () => ({}));
  }

  async function resolveFile(executable) {
    try {
      const file = await host.resolveExecutable(executable);
      return typeof file === 'string' && file !== '' ? file : null;
    } catch {
      return null;
    }
  }

  async function runSpawn(executable, args, ambientEnv) {
    requireString(executable, 'executable', 255);
    if (!Array.isArray(args) || args.length > MAX_ARGS) throw new InvalidRequest(`args must be an array of at most ${MAX_ARGS} strings`);
    if (args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0'))) throw new InvalidRequest('every argument must be a NUL-free string');
    if (!isPlainObject(ambientEnv)) throw new InvalidRequest('ambientEnv must be a plain object');
    let approved;
    try {
      approved = selectApprovedEnvironment(spec, ambientEnv);
    } catch (error) {
      throw new InvalidRequest(`ambient environment rejected: ${error.code ?? 'ERROR'}`);
    }
    const target = { executable, argc: args.length, args_sha256: sha256(canonicalJson(args)), env_names: Object.keys(approved).sort() };
    const granted = policy.canExecute(executable);
    let file = granted ? await resolveFile(executable) : null;
    let reason = null;
    if (!granted) reason = 'NOT_GRANTED';
    else if (file === null) reason = 'EXECUTABLE_NOT_RESOLVED';
    else if (activeChildren >= spec.process.max_children) reason = 'PROCESS_CAPACITY_EXCEEDED';
    const decision = reason === null ? allow('spawn', { ...target, file }) : grantFailure('spawn', reason, target);
    // Shadow mode only: the request continues after a would-deny, so it still needs a path to run.
    file ??= await resolveFile(executable);
    if (file === null) {
      outcome(decision, { ok: false, error_code: 'EXECUTABLE_NOT_RESOLVED' });
      throw new EnforcementDenied('spawn', 'EXECUTABLE_NOT_RESOLVED', decision.seq);
    }
    // No await separates the capacity check, the decision entry and this reservation.
    activeChildren += 1;
    const state = { out: [], err: [], outBytes: 0, errBytes: 0, outCut: false, errCut: false, killedFor: null, timedOut: false };
    let handle = null;
    let timer = null;
    const stop = (why) => {
      if (state.killedFor === null) state.killedFor = why;
      try { handle?.kill('SIGKILL'); } catch { /* the child is already gone */ }
    };
    const keep = (kind, cap) => (chunk) => {
      const bytes = toBuffer(chunk);
      const used = kind === 'out' ? state.outBytes : state.errBytes;
      const room = Math.max(0, cap - used);
      if (bytes.length > 0) state[kind].push(bytes.subarray(0, room));
      state[`${kind}Bytes`] = used + Math.min(room, bytes.length);
      if (bytes.length > room) {
        state[`${kind}Cut`] = true;
        stop(kind === 'out' ? 'stdout_bytes' : 'stderr_bytes');
      }
    };
    try {
      handle = host.spawn({ file, executable, args: [...args], env: { ...approved }, onStdout: keep('out', spec.limits.stdout_bytes), onStderr: keep('err', spec.limits.stderr_bytes) });
      if (state.killedFor !== null) stop(state.killedFor);
      timer = setTimeout(() => { state.timedOut = true; stop('wall_ms'); }, Math.min(spec.limits.wall_ms, MAX_TIMER_MS));
      const exit = await handle.done;
      const result = {
        exit_code: exit?.exit_code ?? null,
        signal: exit?.signal ?? null,
        stdout: Buffer.concat(state.out),
        stderr: Buffer.concat(state.err),
        timed_out: state.timedOut,
        stdout_truncated: state.outCut,
        stderr_truncated: state.errCut,
        killed_for: state.killedFor,
        pid: handle.pid ?? null,
      };
      outcome(decision, { ok: true, exit_code: result.exit_code, signal: result.signal, timed_out: result.timed_out, killed_for: result.killed_for, stdout_bytes: state.outBytes, stderr_bytes: state.errBytes, stdout_truncated: state.outCut, stderr_truncated: state.errCut });
      return result;
    } catch (error) {
      outcome(decision, { ok: false, error_code: String(error?.code ?? 'HOST_ERROR').slice(0, 64) });
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      activeChildren -= 1;
    }
  }

  function runEnv(name, ambientEnv) {
    requireString(name, 'name', 256);
    if (!isPlainObject(ambientEnv)) throw new InvalidRequest('ambientEnv must be a plain object');
    if (!policy.canReadEnv(name)) refuse('env', 'NOT_GRANTED', { name });
    const value = Object.prototype.hasOwnProperty.call(ambientEnv, name) ? ambientEnv[name] : undefined;
    if (value !== undefined && (typeof value !== 'string' || value.includes('\0'))) throw new InvalidRequest('environment value must be a NUL-free string');
    allow('env', { name, present: value !== undefined });
    return value;
  }

  async function runSecret(ref, use) {
    requireString(ref, 'ref', 128);
    if (typeof use !== 'function') throw new InvalidRequest('use must be a function');
    if (!policy.canUseSecret(ref)) refuse('secret', 'NOT_GRANTED', { ref });
    const decision = allow('secret', { ref });
    return finish(decision, async () => use(await host.resolveSecret(ref)), () => ({}));
  }

  async function runDevice(deviceClass) {
    requireString(deviceClass, 'device class', 64);
    if (!policy.canUseDevice(deviceClass)) refuse('device', 'NOT_GRANTED', { device: deviceClass });
    const decision = allow('device', { device: deviceClass });
    return finish(decision, () => host.openDevice(deviceClass), () => ({}));
  }

  async function invoke(operation, request = {}) {
    if (!GATE_OPERATIONS.includes(operation)) refuse(String(operation).slice(0, 64), 'UNKNOWN_OPERATION', {});
    if (!hostSupports(operation)) refuse(operation, 'HOST_CAPABILITY_MISSING', {});
    // Precheck, not the reservation: a request that can reach the host needs a free slot for its decision and one for its
    // outcome, so with fewer than two the first host call (canonicalisation, resolution) is not made either. Awaits separate
    // this line from the append, so the binding reservation is the one made where the decision is appended.
    if (operation !== 'env') reserve(operation, 2);
    try {
      if (!isPlainObject(request)) throw new InvalidRequest('request must be a plain object');
      switch (operation) {
        case 'read': return await runRead(requireString(request.path, 'path'));
        case 'write': return await runWrite(requireString(request.path, 'path'), request.data);
        case 'connect': return await runConnect(request.host, request.port);
        case 'listen': return await runListen(request.host, request.port);
        case 'spawn': return await runSpawn(request.executable, request.args ?? [], request.ambientEnv ?? {});
        case 'env': return runEnv(request.name, request.ambientEnv ?? {});
        case 'secret': return await runSecret(request.ref, request.use);
        default: return await runDevice(request.device);
      }
    } catch (error) {
      if (error instanceof InvalidRequest) refuse(operation, 'INVALID_ARGUMENT', {});
      throw error;
    }
  }

  function report() {
    const available = (operation, status) => (hostSupports(operation) ? status : 'unavailable');
    const gated = mode === 'enforce' ? 'mediated' : 'observed';
    const head = entries.length === 0 ? genesisHash(manifestDigest) : entries[entries.length - 1].sha256;
    return deepFreeze({
      contract: ENFORCEMENT_REPORT_CONTRACT,
      gate_contract: ENFORCEMENT_GATE_CONTRACT,
      mode,
      enforcing: mode === 'enforce',
      scope: 'in-process-mediation',
      os_sandbox: false,
      attestation: { present: false, reason: 'self-computed report; no signed attestation exists and none is claimed' },
      permission_digest: { format: PERMISSION_MANIFEST_DIGEST_FORMAT, sha256: manifestDigest },
      dimensions: {
        fs_read: available('read', gated),
        fs_write: available('write', gated),
        network_connect: available('connect', gated),
        network_listen: available('listen', gated),
        process_spawn: available('spawn', gated),
        process_max_children: available('spawn', gated),
        environment: 'mediated',
        secrets: available('secret', 'mediated'),
        devices: available('device', 'mediated'),
        wall_ms: available('spawn', 'mediated'),
        stdout_bytes: available('spawn', 'mediated'),
        stderr_bytes: available('spawn', 'mediated'),
        ...Object.fromEntries(UNSUPPORTED_LIMITS.map((name) => [name, 'unsupported'])),
      },
      audit: { entries: entries.length, in_flight: pending.size, genesis_sha256: genesisHash(manifestDigest), head_sha256: head },
      limits: GATE_LIMITS,
    });
  }

  return Object.freeze({
    contract: ENFORCEMENT_GATE_CONTRACT,
    mode,
    manifest: spec,
    permissionDigest: manifestDigest,
    invoke,
    read: (path) => invoke('read', { path }),
    write: (path, data) => invoke('write', { path, data }),
    connect: (hostname, port) => invoke('connect', { host: hostname, port }),
    listen: (hostname, port) => invoke('listen', { host: hostname, port }),
    spawn: (executable, args = [], ambientEnv = {}) => invoke('spawn', { executable, args, ambientEnv }),
    readEnv: (name, ambientEnv) => invoke('env', { name, ambientEnv }),
    useSecret: (ref, use) => invoke('secret', { ref, use }),
    useDevice: (device) => invoke('device', { device }),
    audit: () => entries.slice(),
    verifyAudit: () => verifyAuditLog(entries, { manifestDigest, expectedEntries: entries.length, inFlight: [...pending] }),
    report,
  });
}
