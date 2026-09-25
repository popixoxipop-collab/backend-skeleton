import fs from 'node:fs';

function err(code, details = {}) { return { code, ...details }; }

export function normalizeScopePattern(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('scope must be a non-empty string');
  if (value.startsWith('/') || value.includes('\\')) throw new Error(`invalid repo-relative scope: ${value}`);
  const glob = value.endsWith('/**');
  const raw = glob ? value.slice(0, -3) : value;
  const parts = raw.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`invalid repo-relative scope: ${value}`);
  if (raw.includes('*')) throw new Error(`only a trailing /** wildcard is supported: ${value}`);
  return glob ? `${raw}/**` : raw;
}

function parts(pattern) {
  const glob = pattern.endsWith('/**');
  const root = glob ? pattern.slice(0, -3) : pattern;
  return { glob, root };
}

export function scopeContains(container, candidate) {
  container = normalizeScopePattern(container);
  candidate = normalizeScopePattern(candidate);
  const a = parts(container);
  const b = parts(candidate);
  if (!a.glob) return !b.glob && a.root === b.root;
  return b.root === a.root || b.root.startsWith(`${a.root}/`);
}

export function scopesOverlap(left, right) {
  left = normalizeScopePattern(left);
  right = normalizeScopePattern(right);
  return scopeContains(left, right) || scopeContains(right, left);
}

function validSha(s) { return typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s); }
function validIso(s) { return typeof s === 'string' && Number.isFinite(Date.parse(s)); }
function nowMs(at) { const n = Date.parse(at); if (!Number.isFinite(n)) throw new Error(`invalid --at timestamp: ${at}`); return n; }

export function validatePolicy(policy) {
  const errors = [];
  if (policy?.schema !== 'bskel.scale-ownership-policy/1') errors.push(err('BAD_POLICY_SCHEMA'));
  const tracks = policy?.tracks ?? {};
  for (const [track, cfg] of Object.entries(tracks)) {
    if (!cfg.repo) errors.push(err('MISSING_TRACK_REPO', { track }));
    if (!Array.isArray(cfg.allowed_scopes) || cfg.allowed_scopes.length === 0) errors.push(err('MISSING_ALLOWED_SCOPES', { track }));
    for (const scope of cfg.allowed_scopes ?? []) {
      try { normalizeScopePattern(scope); } catch (e) { errors.push(err('INVALID_ALLOWED_SCOPE', { track, scope, message: e.message })); }
    }
  }
  return { ok: errors.length === 0, errors };
}

function active(claim, atMs) {
  return claim.state === 'ACTIVE' && validIso(claim.expires_at) && Date.parse(claim.expires_at) > atMs;
}

export function checkClaim(policy, ledger, claim, at) {
  const errors = [];
  const atMs = nowMs(at);
  const cfg = policy?.tracks?.[claim?.track];
  if (!cfg) errors.push(err('UNKNOWN_TRACK', { track: claim?.track ?? null }));
  if (!claim?.claim_id) errors.push(err('MISSING_CLAIM_ID'));
  if (!claim?.worker) errors.push(err('MISSING_WORKER'));
  if (!claim?.worktree) errors.push(err('MISSING_WORKTREE'));
  if (!validSha(claim?.base_sha)) errors.push(err('INVALID_BASE_SHA'));
  if (!Number.isInteger(claim?.fencing_token) || claim.fencing_token <= 0) errors.push(err('INVALID_FENCING_TOKEN'));
  if (!validIso(claim?.issued_at) || !validIso(claim?.expires_at)) errors.push(err('INVALID_LEASE_TIME'));
  if (validIso(claim?.issued_at) && validIso(claim?.expires_at) && Date.parse(claim.issued_at) >= Date.parse(claim.expires_at)) errors.push(err('INVALID_LEASE_INTERVAL'));
  if (validIso(claim?.issued_at) && atMs < Date.parse(claim.issued_at)) errors.push(err('LEASE_NOT_STARTED'));
  if (validIso(claim?.expires_at) && atMs >= Date.parse(claim.expires_at)) errors.push(err('LEASE_EXPIRED'));
  if (!Array.isArray(claim?.path_scopes) || claim.path_scopes.length === 0) errors.push(err('MISSING_PATH_SCOPES'));

  if (cfg) {
    if (claim.repo !== cfg.repo) errors.push(err('TRACK_REPO_MISMATCH', { expected: cfg.repo, actual: claim.repo ?? null }));
    for (const scope of claim.path_scopes ?? []) {
      let normalized;
      try { normalized = normalizeScopePattern(scope); }
      catch (e) { errors.push(err('INVALID_CLAIM_SCOPE', { scope, message: e.message })); continue; }
      if (!(cfg.allowed_scopes ?? []).some((allowed) => scopeContains(allowed, normalized))) {
        errors.push(err('SCOPE_OUTSIDE_OWNERSHIP', { track: claim.track, scope: normalized }));
      }
    }
  }

  const last = ledger?.last_fencing_token?.[claim?.track] ?? 0;
  if (Number.isInteger(claim?.fencing_token) && claim.fencing_token <= last) {
    errors.push(err('FENCING_TOKEN_REGRESSION', { track: claim.track, last, proposed: claim.fencing_token }));
  }

  for (const existing of ledger?.claims ?? []) {
    if (!active(existing, atMs)) continue;
    if (existing.repo !== claim.repo) continue;
    if (existing.claim_id === claim.claim_id) continue;
    for (const a of existing.path_scopes ?? []) for (const b of claim.path_scopes ?? []) {
      try {
        if (scopesOverlap(a, b)) errors.push(err('ACTIVE_SCOPE_CONFLICT', { with_claim: existing.claim_id, existing_scope: a, proposed_scope: b }));
      } catch {}
    }
  }
  return { ok: errors.length === 0, errors };
}

export function checkResult(policy, ledger, result, at) {
  const errors = [];
  const atMs = nowMs(at);
  const claim = (ledger?.claims ?? []).find((x) => x.claim_id === result?.claim_id);
  if (!claim) return { ok: false, errors: [err('UNKNOWN_CLAIM', { claim_id: result?.claim_id ?? null })] };
  if (!active(claim, atMs)) errors.push(err('RESULT_AFTER_LEASE_EXPIRY', { claim_id: claim.claim_id }));
  const last = ledger?.last_fencing_token?.[claim.track] ?? 0;
  if (result?.fencing_token !== claim.fencing_token) errors.push(err('RESULT_FENCING_TOKEN_MISMATCH', { expected: claim.fencing_token, actual: result?.fencing_token ?? null }));
  if (claim.fencing_token < last) errors.push(err('RESULT_STALE_FENCING_TOKEN', { claim_token: claim.fencing_token, last }));
  if (result?.base_sha !== claim.base_sha) errors.push(err('RESULT_BASE_SHA_MISMATCH', { expected: claim.base_sha, actual: result?.base_sha ?? null }));
  if (!validSha(result?.head_sha)) errors.push(err('INVALID_RESULT_HEAD_SHA'));
  const cfg = policy?.tracks?.[claim.track];
  if (!cfg || cfg.repo !== claim.repo) errors.push(err('CLAIM_POLICY_DRIFT', { track: claim.track }));
  for (const path of result?.changed_paths ?? []) {
    let normalized;
    try { normalized = normalizeScopePattern(path); }
    catch (e) { errors.push(err('INVALID_RESULT_PATH', { path, message: e.message })); continue; }
    if (!(claim.path_scopes ?? []).some((scope) => scopeContains(scope, normalized))) {
      errors.push(err('RESULT_PATH_OUTSIDE_CLAIM', { path: normalized }));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function verifyLedger(policy, ledger, at) {
  const errors = [...validatePolicy(policy).errors];
  const atMs = nowMs(at);
  const ids = new Set();
  for (const claim of ledger?.claims ?? []) {
    if (ids.has(claim.claim_id)) errors.push(err('DUPLICATE_CLAIM_ID', { claim_id: claim.claim_id }));
    ids.add(claim.claim_id);
    if (!['ACTIVE','RELEASED','EXPIRED'].includes(claim.state)) errors.push(err('INVALID_CLAIM_STATE', { claim_id: claim.claim_id }));
    const last = ledger?.last_fencing_token?.[claim.track] ?? 0;
    if (Number.isInteger(claim.fencing_token) && claim.fencing_token > last) errors.push(err('LEDGER_COUNTER_BEHIND_CLAIM', { track: claim.track, token: claim.fencing_token, last }));
  }
  const actives = (ledger?.claims ?? []).filter((x) => active(x, atMs));
  for (let i = 0; i < actives.length; i++) for (let j = i + 1; j < actives.length; j++) {
    if (actives[i].repo !== actives[j].repo) continue;
    for (const a of actives[i].path_scopes ?? []) for (const b of actives[j].path_scopes ?? []) {
      try { if (scopesOverlap(a,b)) errors.push(err('LEDGER_ACTIVE_SCOPE_CONFLICT', { left: actives[i].claim_id, right: actives[j].claim_id, left_scope:a, right_scope:b })); } catch {}
    }
  }
  return { ok: errors.length === 0, errors };
}

function read(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
function argAt(argv) { const i=argv.indexOf('--at'); return i>=0 ? argv[i+1] : null; }

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const at = argAt(argv);
  if (!at) { console.error('missing --at <ISO timestamp>'); process.exit(1); }
  let out;
  if (cmd === 'verify-ledger') out = verifyLedger(read(argv[0]), read(argv[1]), at);
  else if (cmd === 'check-claim') out = checkClaim(read(argv[0]), read(argv[1]), read(argv[2]), at);
  else if (cmd === 'check-result') out = checkResult(read(argv[0]), read(argv[1]), read(argv[2]), at);
  else { console.error('usage: lease-ledger.mjs <verify-ledger|check-claim|check-result> ... --at <ISO>'); process.exit(1); }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
