// T00-03 lease model: pure functions, no file, clock or network; the instant is a parameter and no JSON value makes them throw.
import { createHash } from 'node:crypto';
import { TRACK_ID, isObject, isText, matches, normalizePath, parseScope, scopeCoversPath, scopesOverlap, sortErrors } from './ownership.mjs';

export const LEDGER_SCHEMA = 'bskel.t00-lease-ledger/1';
const SCHEMA_FAMILY = 'bskel.t00-lease-ledger/';
export const CLAIM_STATES = ['ACTIVE', 'RELEASED', 'EXPIRED'];
export const CLAIM_FIELDS = ['claim_id', 'track', 'repository', 'worker', 'worktree', 'base_sha', 'path_scopes', 'issued_at', 'expires_at', 'fencing_token', 'state'];
const SEAL_FIELDS = ['prev_digest', 'entry_digest'];
const LEDGER_MEMBERS = ['schema', 'counters', 'claims', 'head_digest'];
export const GENESIS_DIGEST = '0'.repeat(64);
export const LEDGER_CODES = [
  'LEDGER_SCHEMA', 'INVALID_CLAIM', 'DUPLICATE_CLAIM_ID', 'UNKNOWN_TRACK', 'TRACK_REPO_MISMATCH', 'INVALID_BASE_SHA', 'INVALID_FENCING_TOKEN',
  'INVALID_LEASE_TIME', 'INVALID_LEASE_INTERVAL', 'INVALID_CLAIM_STATE', 'MISSING_PATH_SCOPES', 'INVALID_CLAIM_SCOPE', 'SCOPE_OUTSIDE_OWNERSHIP',
  'FENCING_TOKEN_REGRESSION', 'LEDGER_COUNTER_BEHIND_CLAIM', 'LEASE_EXPIRED', 'LEASE_NOT_STARTED', 'ACTIVE_SCOPE_CONFLICT',
  'LEDGER_VERSION_UNSUPPORTED', 'UNKNOWN_LEDGER_MEMBER', 'INVALID_LEDGER_DIGEST', 'LEDGER_ENTRY_DIGEST_MISMATCH', 'LEDGER_CHAIN_BROKEN',
  'LEDGER_HEAD_DIGEST_MISMATCH', 'LEDGER_HEAD_PIN_MISMATCH',
];
export const RESULT_CODES = [
  'UNKNOWN_CLAIM', 'RESULT_CLAIM_NOT_ACTIVE', 'RESULT_AFTER_LEASE_EXPIRY', 'RESULT_WRONG_HOLDER', 'RESULT_FENCING_TOKEN_MISMATCH', 'RESULT_STALE_FENCING_TOKEN',
  'RESULT_BASE_SHA_MISMATCH', 'INVALID_RESULT_HEAD_SHA', 'INVALID_RESULT_PATH', 'RESULT_PATH_OUTSIDE_CLAIM',
];
export const LEASE_CODES = [...LEDGER_CODES, ...RESULT_CODES];
export const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXAMPLE = 'a UTC instant like 2026-10-09T00:00:00Z';
const isToken = (n) => Number.isSafeInteger(n) && n > 0;
const texts = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const short = (x) => (typeof x === 'string' ? `${x.slice(0, 12)}...` : JSON.stringify(x));
const scalar = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const countersPlain = (counters) => Object.values(counters).every((n) => Number.isSafeInteger(n) && n >= 0);

// Milliseconds of a strict UTC instant, NaN for anything else (a date that does not exist included).
export function parseInstant(text) {
  if (typeof text !== 'string' || !INSTANT.test(text)) return NaN;
  const ms = Date.parse(text);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== text.replace('Z', '.000Z') ? NaN : ms;
}

// True when every path the scope `inner` covers is covered by `outer`. Case counts: a scope that differs in case is outside.
export function scopeWithin(inner, outer) {
  try {
    const a = parseScope(inner);
    const b = parseScope(outer);
    if (!b.dir) return !a.dir && a.path === b.path;
    return a.path.startsWith(`${b.path}/`) || (a.dir && a.path === b.path);
  } catch {
    return false;
  }
}

// What a track may lease, from a verified ownership map: its repository and every scope it owns.
export function leasePolicy(map) {
  const policy = {};
  for (const t of isObject(map) && Array.isArray(map.tracks) ? map.tracks : []) {
    if (!isObject(t) || !matches(TRACK_ID, t.track)) continue;
    policy[t.track] = { repository: t.repository, scopes: [...texts(t.plan_scopes), ...texts(t.suite_scopes), ...texts(t.extra_scopes)] };
  }
  return policy;
}

export const leaseCounts = (ledger) => ({ claims: ledger.claims.length, active: ledger.claims.filter((c) => c.state === 'ACTIVE').length });

// The digests. A claim is hashed as the JSON text of its eleven fields and its prev_digest, in this order, without spaces; a
// member the claim lacks is left out. entry_digest is not part of its own hash. The head covers the schema, the number of
// claims, the entry_digest of the last claim (GENESIS_DIGEST when there is none) and the counters as [track, counter] pairs.
const sealedMembers = [...CLAIM_FIELDS, 'prev_digest'];
const hashable = (claim) => sealedMembers.every((k) => !Object.hasOwn(claim, k) || scalar(claim[k]) || (Array.isArray(claim[k]) && claim[k].every(scalar)));
export function entryDigest(claim) {
  const ordered = {};
  for (const key of sealedMembers) if (Object.hasOwn(claim, key)) ordered[key] = claim[key];
  return sha256(JSON.stringify(ordered));
}
export const headDigest = (counters, count, tip) => sha256(JSON.stringify([LEDGER_SCHEMA, count, tip, Object.keys(counters).sort().map((track) => [track, counters[track]])]));

// Writes the digests: prev_digest and entry_digest of every claim in ledger order, then head_digest. Returns { ledger } or
// { problem }. Sealing signs what it is given and judges nothing; it is how an edit is made on purpose, and anyone who can seal
// can seal a rewrite, which only a head digest kept outside the file (the pin) can tell from the original.
export function sealLedger(ledger) {
  if (!isObject(ledger) || ledger.schema !== LEDGER_SCHEMA || !isObject(ledger.counters) || !Array.isArray(ledger.claims)) {
    return { problem: `expected an object with schema ${LEDGER_SCHEMA}, an object counters and an array claims` };
  }
  const strayLedger = Object.keys(ledger).find((k) => !LEDGER_MEMBERS.includes(k));
  if (strayLedger !== undefined) return { problem: `${JSON.stringify(strayLedger)} is not a member of a ledger` };
  if (!countersPlain(ledger.counters)) return { problem: 'a counter is not a non-negative integer' };
  const claims = [];
  let tip = GENESIS_DIGEST;
  for (const [index, claim] of ledger.claims.entries()) {
    if (!isObject(claim) || !hashable(claim)) return { problem: `claims[${index}] is not an object whose members are plain values` };
    const stray = Object.keys(claim).find((k) => !CLAIM_FIELDS.includes(k) && !SEAL_FIELDS.includes(k));
    if (stray !== undefined) return { problem: `claims[${index}] has the member ${JSON.stringify(stray)}, which a claim does not have` };
    const sealed = {};
    for (const key of CLAIM_FIELDS) if (Object.hasOwn(claim, key)) sealed[key] = claim[key];
    sealed.prev_digest = tip;
    sealed.entry_digest = entryDigest(sealed);
    tip = sealed.entry_digest;
    claims.push(sealed);
  }
  return { ledger: { schema: LEDGER_SCHEMA, counters: { ...ledger.counters }, claims, head_digest: headDigest(ledger.counters, claims.length, tip) } };
}

// All errors of a ledger at the instant `at`. With currency false an ACTIVE claim that has expired, or has not started, is not
// an error but reserves nothing; a result is then judged against its own claim only. `pin` is a head digest the caller kept
// outside the ledger file.
export function checkLedger(ledger, policy, at, { currency = true, pin } = {}) {
  const errors = [];
  const add = (code, subject, detail) => errors.push({ code, subject, detail });
  const now = parseInstant(at);
  if (Number.isNaN(now)) {
    add('INVALID_LEASE_TIME', 'at', `${JSON.stringify(at)} is not ${EXAMPLE}`);
    return errors;
  }
  if (isObject(ledger) && typeof ledger.schema === 'string' && ledger.schema.startsWith(SCHEMA_FAMILY) && ledger.schema !== LEDGER_SCHEMA) {
    add('LEDGER_VERSION_UNSUPPORTED', 'ledger', `schema ${JSON.stringify(ledger.schema)} is another version; this gate reads ${LEDGER_SCHEMA} only and judges nothing else of that ledger`);
    return errors;
  }
  if (!isObject(ledger) || ledger.schema !== LEDGER_SCHEMA || !isObject(ledger.counters) || !Array.isArray(ledger.claims)) {
    add('LEDGER_SCHEMA', 'ledger', `expected an object with schema ${LEDGER_SCHEMA}, an object counters and an array claims`);
    return errors;
  }
  for (const key of Object.keys(ledger)) if (!LEDGER_MEMBERS.includes(key)) add('UNKNOWN_LEDGER_MEMBER', key, `a ledger has the members ${LEDGER_MEMBERS.join(', ')} only`);
  for (const [track, n] of Object.entries(ledger.counters)) {
    if (!Object.hasOwn(policy, track)) add('UNKNOWN_TRACK', `counters.${track}`, 'the ownership map holds no such track');
    if (!Number.isSafeInteger(n) || n < 0) add('LEDGER_SCHEMA', `counters.${track}`, 'a counter is a non-negative integer');
  }
  const seen = new Set();
  const last = new Map();
  const live = [];
  let tip = GENESIS_DIGEST; // the entry_digest the next claim must name as prev_digest; null after a claim without a usable one
  ledger.claims.forEach((claim, index) => {
    if (!isObject(claim)) {
      add('INVALID_CLAIM', `claims[${index}]`, 'a claim must be an object');
      return;
    }
    const id = matches(CLAIM_ID, claim.claim_id) ? claim.claim_id : '';
    const label = id || `claims[${index}]`;
    const bad = (code, detail) => add(code, label, detail);
    if (!id) bad('INVALID_CLAIM', 'claim_id is missing or outside [A-Za-z0-9._-]');
    else if (seen.has(id)) bad('DUPLICATE_CLAIM_ID', 'another claim has this id');
    if (id) seen.add(id);
    for (const key of Object.keys(claim)) if (!CLAIM_FIELDS.includes(key) && !SEAL_FIELDS.includes(key)) bad('UNKNOWN_LEDGER_MEMBER', `${key} is not a member of a claim`);
    for (const key of ['worker', 'worktree']) if (!isText(claim[key])) bad('INVALID_CLAIM', `${key} is missing or empty`);
    const known = matches(TRACK_ID, claim.track) && Object.hasOwn(policy, claim.track);
    if (!known) bad('UNKNOWN_TRACK', `track ${JSON.stringify(claim.track)} is not a track of the ownership map`);
    else if (claim.repository !== policy[claim.track].repository) {
      bad('TRACK_REPO_MISMATCH', `repository is ${JSON.stringify(claim.repository)}, the ownership map has ${JSON.stringify(policy[claim.track].repository)} for ${claim.track}`);
    }
    if (!matches(SHA, claim.base_sha)) bad('INVALID_BASE_SHA', 'base_sha must be 40 lowercase hex digits');
    const token = isToken(claim.fencing_token);
    if (!token) bad('INVALID_FENCING_TOKEN', 'fencing_token must be a positive integer');
    const issued = parseInstant(claim.issued_at);
    const expires = parseInstant(claim.expires_at);
    if (Number.isNaN(issued)) bad('INVALID_LEASE_TIME', `issued_at must be ${EXAMPLE}`);
    if (Number.isNaN(expires)) bad('INVALID_LEASE_TIME', `expires_at must be ${EXAMPLE}`);
    const timed = !Number.isNaN(issued) && !Number.isNaN(expires);
    if (timed && expires <= issued) bad('INVALID_LEASE_INTERVAL', 'expires_at must be after issued_at');
    if (!CLAIM_STATES.includes(claim.state)) bad('INVALID_CLAIM_STATE', `state must be one of ${CLAIM_STATES.join(', ')}`);
    const scopes = Array.isArray(claim.path_scopes) ? claim.path_scopes : [];
    if (scopes.length === 0) bad('MISSING_PATH_SCOPES', 'path_scopes must list at least one scope');
    const valid = [];
    for (const scope of scopes) {
      try {
        parseScope(scope);
      } catch (e) {
        bad('INVALID_CLAIM_SCOPE', `${JSON.stringify(scope)}: ${e.message}`);
        continue;
      }
      valid.push(scope);
      if (known && !policy[claim.track].scopes.some((owned) => scopeWithin(scope, owned))) bad('SCOPE_OUTSIDE_OWNERSHIP', `${scope} is inside no scope of ${claim.track}`);
    }
    if (known && token) {
      const prev = last.get(claim.track);
      if (prev && claim.fencing_token <= prev.token) bad('FENCING_TOKEN_REGRESSION', `token ${claim.fencing_token} is not greater than ${prev.token} of ${prev.label}`);
      if (!prev || claim.fencing_token > prev.token) last.set(claim.track, { token: claim.fencing_token, label });
      const counter = ledger.counters[claim.track];
      if (!(Number.isSafeInteger(counter) && counter >= claim.fencing_token)) bad('LEDGER_COUNTER_BEHIND_CLAIM', `counters.${claim.track} is ${JSON.stringify(counter)}, below token ${claim.fencing_token}`);
    }
    const prevOk = matches(DIGEST, claim.prev_digest);
    const entryOk = matches(DIGEST, claim.entry_digest);
    if (!prevOk) bad('INVALID_LEDGER_DIGEST', 'prev_digest must be 64 lowercase hex digits');
    if (!entryOk) bad('INVALID_LEDGER_DIGEST', 'entry_digest must be 64 lowercase hex digits');
    if (prevOk && tip !== null && claim.prev_digest !== tip) bad('LEDGER_CHAIN_BROKEN', `prev_digest is ${short(claim.prev_digest)}, the claim before it ends at ${short(tip)}; a claim was removed, added or moved`);
    if (prevOk && entryOk && hashable(claim) && entryDigest(claim) !== claim.entry_digest) {
      bad('LEDGER_ENTRY_DIGEST_MISMATCH', `entry_digest is ${short(claim.entry_digest)}, the claim hashes to ${short(entryDigest(claim))}; it was edited after it was sealed`);
    }
    tip = entryOk ? claim.entry_digest : null;
    if (claim.state === 'ACTIVE' && timed) {
      if (now < issued) {
        if (currency) bad('LEASE_NOT_STARTED', `issued_at is after ${at}`);
      } else if (now >= expires) {
        if (currency) bad('LEASE_EXPIRED', `expires_at is not after ${at}; mark the claim EXPIRED or RELEASED`);
      } else live.push({ label, repository: claim.repository, scopes: valid });
    }
  });
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      if (live[i].repository !== live[j].repository) continue;
      const hit = live[i].scopes.flatMap((a) => live[j].scopes.filter((b) => scopesOverlap(a, b)).map((b) => [a, b]))[0];
      if (hit) add('ACTIVE_SCOPE_CONFLICT', live[j].label, `${hit[1]} overlaps ${hit[0]} of the active claim ${live[i].label}`);
    }
  }
  if (!matches(DIGEST, ledger.head_digest)) add('INVALID_LEDGER_DIGEST', 'head_digest', 'head_digest must be 64 lowercase hex digits');
  else if (tip !== null && countersPlain(ledger.counters)) {
    const want = headDigest(ledger.counters, ledger.claims.length, tip);
    if (want !== ledger.head_digest) {
      add('LEDGER_HEAD_DIGEST_MISMATCH', 'head_digest', `head_digest is ${short(ledger.head_digest)}, the schema, ${ledger.claims.length} claims, the last entry_digest and the counters hash to ${short(want)}`);
    }
  }
  if (pin !== undefined && ledger.head_digest !== pin) add('LEDGER_HEAD_PIN_MISMATCH', 'head_digest', `the ledger has head_digest ${short(ledger.head_digest)}, the pin is ${short(pin)}`);
  return sortErrors(errors);
}

const covers = (scope, rel, fold) => {
  try {
    return scopeCoversPath(scope, rel, { fold });
  } catch {
    return false;
  }
};

// All errors of a result `{ claim_id, worker, worktree, fencing_token, base_sha, head_sha, paths }` against the claim it names.
// The caller has verified the ledger; a missing or repeated claim id fails here as UNKNOWN_CLAIM.
export function checkResult(ledger, packet, at) {
  const errors = [];
  const add = (code, subject, detail) => errors.push({ code, subject, detail });
  const now = parseInstant(at);
  if (Number.isNaN(now)) {
    add('INVALID_LEASE_TIME', 'at', `${JSON.stringify(at)} is not ${EXAMPLE}`);
    return errors;
  }
  const p = isObject(packet) ? packet : {};
  const found = isObject(ledger) && Array.isArray(ledger.claims) ? ledger.claims.filter((c) => isObject(c) && c.claim_id === p.claim_id) : [];
  if (found.length !== 1) {
    add('UNKNOWN_CLAIM', String(p.claim_id), found.length ? 'the claim id is not unique in the ledger' : 'the ledger holds no claim with this id');
    return errors;
  }
  const [claim] = found;
  const bad = (code, detail) => add(code, claim.claim_id, detail);
  if (claim.state !== 'ACTIVE') bad('RESULT_CLAIM_NOT_ACTIVE', `the claim is ${JSON.stringify(claim.state)}, not ACTIVE`);
  const issued = parseInstant(claim.issued_at);
  const expires = parseInstant(claim.expires_at);
  if (!Number.isNaN(issued) && now < issued) bad('LEASE_NOT_STARTED', `the lease starts after ${at}`);
  if (!Number.isNaN(expires) && now >= expires) bad('RESULT_AFTER_LEASE_EXPIRY', `the lease expired at ${claim.expires_at}, the result is judged at ${at}`);
  for (const key of ['worker', 'worktree']) {
    if (p[key] !== claim[key]) bad('RESULT_WRONG_HOLDER', `the result names ${key} ${JSON.stringify(p[key])}, the lease is held by ${key} ${JSON.stringify(claim[key])}`);
  }
  if (p.fencing_token !== claim.fencing_token) bad('RESULT_FENCING_TOKEN_MISMATCH', `the result carries token ${JSON.stringify(p.fencing_token)}, the claim has ${JSON.stringify(claim.fencing_token)}`);
  const counter = isObject(ledger.counters) ? ledger.counters[claim.track] : undefined;
  if (Number.isSafeInteger(p.fencing_token) && Number.isSafeInteger(counter) && p.fencing_token < counter) {
    bad('RESULT_STALE_FENCING_TOKEN', `token ${p.fencing_token} is below ${counter}, the last token issued to ${claim.track}`);
  }
  if (!matches(SHA, p.base_sha)) bad('INVALID_BASE_SHA', 'the result base must be 40 lowercase hex digits');
  else if (p.base_sha !== claim.base_sha) bad('RESULT_BASE_SHA_MISMATCH', 'the result was made on another base than the lease');
  if (!matches(SHA, p.head_sha)) bad('INVALID_RESULT_HEAD_SHA', 'the result head must be 40 lowercase hex digits');
  const scopes = texts(claim.path_scopes);
  const paths = Array.isArray(p.paths) ? p.paths : [];
  if (paths.length === 0) add('INVALID_RESULT_PATH', 'paths', 'a result names at least one changed path');
  for (const raw of paths) {
    let rel;
    try {
      rel = normalizePath(raw, { backslash: 'reject' });
    } catch (e) {
      add('INVALID_RESULT_PATH', String(raw), e.message);
      continue;
    }
    if (scopes.some((s) => covers(s, rel, false))) continue;
    add('RESULT_PATH_OUTSIDE_CLAIM', rel, scopes.some((s) => covers(s, rel, true)) ? `matches a scope of ${claim.claim_id} only when case is ignored` : `inside no path scope of ${claim.claim_id}`);
  }
  return sortErrors(errors);
}
