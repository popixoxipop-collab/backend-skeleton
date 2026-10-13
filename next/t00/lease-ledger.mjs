// T00-03 lease model: pure functions, no file, clock or network; the instant is a parameter and no JSON value makes them throw.
import { TRACK_ID, isObject, isText, matches, normalizePath, parseScope, scopeCoversPath, scopesOverlap, sortErrors } from './ownership.mjs';

export const LEDGER_SCHEMA = 'bskel.t00-lease-ledger/1';
export const CLAIM_STATES = ['ACTIVE', 'RELEASED', 'EXPIRED'];
export const LEDGER_CODES = [
  'LEDGER_SCHEMA', 'INVALID_CLAIM', 'DUPLICATE_CLAIM_ID', 'UNKNOWN_TRACK', 'TRACK_REPO_MISMATCH', 'INVALID_BASE_SHA', 'INVALID_FENCING_TOKEN',
  'INVALID_LEASE_TIME', 'INVALID_LEASE_INTERVAL', 'INVALID_CLAIM_STATE', 'MISSING_PATH_SCOPES', 'INVALID_CLAIM_SCOPE', 'SCOPE_OUTSIDE_OWNERSHIP',
  'FENCING_TOKEN_REGRESSION', 'LEDGER_COUNTER_BEHIND_CLAIM', 'LEASE_EXPIRED', 'LEASE_NOT_STARTED', 'ACTIVE_SCOPE_CONFLICT',
];
export const RESULT_CODES = [
  'UNKNOWN_CLAIM', 'RESULT_CLAIM_NOT_ACTIVE', 'RESULT_AFTER_LEASE_EXPIRY', 'RESULT_FENCING_TOKEN_MISMATCH', 'RESULT_STALE_FENCING_TOKEN',
  'RESULT_BASE_SHA_MISMATCH', 'INVALID_RESULT_HEAD_SHA', 'INVALID_RESULT_PATH', 'RESULT_PATH_OUTSIDE_CLAIM',
];
export const LEASE_CODES = [...LEDGER_CODES, ...RESULT_CODES];
export const SHA = /^[0-9a-f]{40}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXAMPLE = 'a UTC instant like 2026-10-09T00:00:00Z';
const isToken = (n) => Number.isSafeInteger(n) && n > 0;
const texts = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);

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

// All errors of a ledger at the instant `at`. With currency false an ACTIVE claim that has expired, or has not started, is not
// an error but reserves nothing; a result is then judged against its own claim only.
export function checkLedger(ledger, policy, at, { currency = true } = {}) {
  const errors = [];
  const add = (code, subject, detail) => errors.push({ code, subject, detail });
  const now = parseInstant(at);
  if (Number.isNaN(now)) {
    add('INVALID_LEASE_TIME', 'at', `${JSON.stringify(at)} is not ${EXAMPLE}`);
    return errors;
  }
  if (!isObject(ledger) || ledger.schema !== LEDGER_SCHEMA || !isObject(ledger.counters) || !Array.isArray(ledger.claims)) {
    add('LEDGER_SCHEMA', 'ledger', `expected an object with schema ${LEDGER_SCHEMA}, an object counters and an array claims`);
    return errors;
  }
  for (const [track, n] of Object.entries(ledger.counters)) {
    if (!Object.hasOwn(policy, track)) add('UNKNOWN_TRACK', `counters.${track}`, 'the ownership map holds no such track');
    if (!Number.isSafeInteger(n) || n < 0) add('LEDGER_SCHEMA', `counters.${track}`, 'a counter is a non-negative integer');
  }
  const seen = new Set();
  const last = new Map();
  const live = [];
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
  return sortErrors(errors);
}

const covers = (scope, rel, fold) => {
  try {
    return scopeCoversPath(scope, rel, { fold });
  } catch {
    return false;
  }
};

// All errors of a result `{ claim_id, fencing_token, base_sha, head_sha, paths }` against the claim it names. The caller has
// verified the ledger; a missing or repeated claim id fails here as UNKNOWN_CLAIM.
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
