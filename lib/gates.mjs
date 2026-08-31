// Gate primitives shared by every `bskel <verb>` that needs to read or write a gate.
// A gate is "passed" only if a token recomputed from the CURRENT inputs matches the token
// that was stored when the gate last passed. If HEAD moved, or spec.md changed, or anything
// else in the gate's declared input set changed, the token mismatches and the gate reports
// `stale` -- it cannot be satisfied once and then silently drift out of sync with reality.
import { createHash } from 'node:crypto';
import { getGate, setGate } from './state.mjs';
import { getGateDefinition, gateScopeId, gateInputs } from './gate-definitions.mjs';
import { EXIT_CODES } from './exit-codes.mjs';

// D2: re-exported under these names (unchanged) from the single exit-code table in
// lib/exit-codes.mjs -- every existing `EXIT.*` reference across bin/bskel.mjs and the test
// suite keeps working unmodified.
export const EXIT = Object.freeze({
	PASS: EXIT_CODES.OK,
	NOT_PASSED: EXIT_CODES.NOT_PASSED,
	AWAITING_DISPOSITION: EXIT_CODES.AWAITING_DISPOSITION,
	STALE: EXIT_CODES.STALE,
});

// S2: why a stale gate couldn't say WHICH input changed until now -- see diffInputs()/
// explainStaleness() below.
export const STALE_REASON = Object.freeze({
	INPUTS_CHANGED: 'inputs_changed',
	NO_RECORDED_INPUTS: 'no_recorded_inputs',
	RECORDED_INPUTS_MISMATCH: 'recorded_inputs_mismatch',
	UNKNOWN: 'unknown',
	// D-preflight-freshness (S3): a gate whose token still matches current inputs, but whose pass
	// is simply too OLD -- see checkFreshness() below.
	TTL_EXPIRED: 'ttl_expired',
	INVALID_TIMESTAMP: 'invalid_timestamp',
});

export function computeToken(inputs) {
	const canonical = JSON.stringify(sortKeysDeep(inputs));
	return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// D-gate-attestation-signing: exported once a second real consumer (lib/attest.mjs's
// canonicalize(), which needs the SAME deep-sort applied to an entire gate-export report, not
// just one gate's `inputs`) needed the identical function -- no behavior change to any existing
// caller in this file.
export function sortKeysDeep(value) {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]),
		);
	}
	return value;
}

// S2: `computeToken()` collapses an entire inputs object to one sha256 string -- once both sides
// of a comparison are hashed down like that, there is nothing left to diff. Reporting exactly
// which input changed requires comparing the PRE-hash objects, key by key, which is what this
// does (given both objects, not gate state -- kept pure/fs-free so it's directly unit-testable).
// Top-level keys only, by design: a gate whose real inputs are file-manifest-shaped (e.g. one
// hash per applied file) must flatten them into prefixed keys in its own recompute() (see
// `stack`'s `applied_file:<relpath>` convention in lib/gate-definitions.mjs) -- that's what lets
// this diff name an exact file instead of just "some nested value changed".
const ABSENT = Symbol('absent');

export function diffInputs(storedInputs, currentInputs) {
	const stored = storedInputs ?? {};
	const current = currentInputs ?? {};
	const keys = [...new Set([...Object.keys(stored), ...Object.keys(current)])].sort();
	return keys.filter((key) => {
		// A key present on only one side (a gate DEFINITION change -- an input added/removed by a
		// bskel upgrade) must count as changed even when the other side's value is `null` (the
		// common sha256File-on-a-missing-file case) -- comparing against `undefined` directly would
		// let that collapse to "no diff" and report an empty changed_inputs list on a real change.
		const a = Object.hasOwn(stored, key) ? JSON.stringify(sortKeysDeep(stored[key])) : ABSENT;
		const b = Object.hasOwn(current, key) ? JSON.stringify(sortKeysDeep(current[key])) : ABSENT;
		return a !== b;
	});
}

function explainStaleness(record, currentInputs) {
	if (!record.inputs || typeof record.inputs !== 'object') {
		// A gate record written before S2 shipped -- still definitively stale (the token really did
		// move), just without a pre-hash snapshot to diff against. The next real re-run of the
		// underlying command writes a record WITH inputs, so this heals itself; there is no attempt
		// to fabricate a retroactive snapshot (that would just fail the mismatch check below).
		return { changed_inputs: null, stale_reason: STALE_REASON.NO_RECORDED_INPUTS };
	}
	if (computeToken(record.inputs) !== record.token) {
		// The stored inputs snapshot doesn't even reproduce the token stored right next to it --
		// e.g. .sbf state was hand-edited. Diffing against an unverified snapshot here would be a
		// confident-sounding lie, so report the integrity failure instead of a key list.
		return { changed_inputs: null, stale_reason: STALE_REASON.RECORDED_INPUTS_MISMATCH };
	}
	const changed = diffInputs(record.inputs, currentInputs);
	// Unreachable by construction -- computeToken(record.inputs) matching record.token, plus
	// currentToken having already failed to match record.token (the only place this is called
	// from), means diffInputs must find at least one changed key. Kept as a defensive fallback so
	// a future bug in either function degrades to "I don't know" instead of a confident empty list.
	if (changed.length === 0) return { changed_inputs: [], stale_reason: STALE_REASON.UNKNOWN };
	return { changed_inputs: changed, stale_reason: STALE_REASON.INPUTS_CHANGED };
}

// D-preflight-freshness (S3): a pass whose token still matches current inputs can still be too
// OLD to trust -- e.g. preflight's `origin_tip_sha` input only moves if something else already
// fetched into this repo; nothing forces that to happen on its own. Judged entirely separately
// from diffInputs()/explainStaleness() above, which only ever compare input VALUES -- age lives
// in the gate record's own `at` timestamp, never inside `inputs` itself (putting a timestamp
// there would make every single require() call report a change, since "now" is never equal to
// the recorded instant -- see D-preflight-freshness in DECISIONS.md, confirmed by direct
// execution before this was written).
//
// S4 (D-gate-history): a FORCED record never inherits the underlying gate's own `def.freshness`
// policy (e.g. preflight's 30-minute default) -- that policy exists to judge naturally-earned
// evidence, not a human's explicit override. A forced pass only gets a TTL when the human asked
// for one (`bskel gate force <name> --max-age-minutes N`, recorded the same way passGate already
// records `evidence.freshness.max_age_minutes`) -- same "explicit, auditable" philosophy as
// `--max-age-minutes 0` disabling preflight's own TTL.
//
// Returns null (fresh, or freshness not applicable) or `{ stale_reason, age_seconds,
// max_age_seconds }`. Reads the max age from the PASS's own recorded evidence first (so a gate
// that changes its default later doesn't retroactively judge an already-passed gate by a
// different policy than the one it was passed under), falling back to the gate definition's
// `defaultMaxAgeMinutes`. A max age of 0 (either source) disables the TTL entirely -- an explicit,
// auditable choice (`bskel preflight --max-age-minutes 0`), not a silent bypass.
function checkFreshness(def, record) {
	const maxAgeMinutes = record.forced
		? record.evidence?.freshness?.max_age_minutes
		: (record.evidence?.freshness?.max_age_minutes ?? def?.freshness?.defaultMaxAgeMinutes);
	if (!(maxAgeMinutes > 0)) return null;
	const maxAgeSeconds = maxAgeMinutes * 60;
	const passedAt = Date.parse(record.at);
	if (!Number.isFinite(passedAt)) {
		return { stale_reason: STALE_REASON.INVALID_TIMESTAMP, age_seconds: null, max_age_seconds: maxAgeSeconds };
	}
	// Clock rewind (a passed-at instant in the future) clamps to 0 rather than going negative --
	// treated as "as fresh as possible", never as extra-stale.
	const ageSeconds = Math.max(0, Math.round((Date.now() - passedAt) / 1000));
	if (ageSeconds <= maxAgeSeconds) return null;
	return { stale_reason: STALE_REASON.TTL_EXPIRED, age_seconds: ageSeconds, max_age_seconds: maxAgeSeconds };
}

// S2: `inputs` is stored alongside `token` (canonically sorted, same form the token was computed
// from) -- purely additive, so this invariant holds for every record this module ever writes:
// computeToken(record.inputs) === record.token. That invariant is what makes explainStaleness()'s
// integrity check meaningful rather than a guess.
export function passGate(repoRoot, featureId, gateName, inputs, evidence = {}) {
	const token = computeToken(inputs);
	return setGate(repoRoot, featureId, gateName, {
		status: 'pass',
		token,
		inputs: sortKeysDeep(inputs),
		at: new Date().toISOString(),
		evidence,
	});
}

export function awaitDispositionGate(repoRoot, featureId, gateName, inputs, evidence = {}) {
	const token = computeToken(inputs);
	return setGate(repoRoot, featureId, gateName, {
		status: 'awaiting_disposition',
		token,
		inputs: sortKeysDeep(inputs),
		at: new Date().toISOString(),
		evidence,
	});
}

// S4 (D-gate-history): `currentInputs` is now the gate's REAL current inputs (same shape
// passGate() would bind to), not a synthetic {forced,reason} placeholder -- token/inputs bind to
// what was actually true at force time, so a LATER input change (including HEAD moving, since
// every gate but `stack` includes head_sha in its own inputs -- see D-gate-precision) makes this
// record go stale exactly the way a real pass would, closing "a forced gate passes forever
// regardless of changed inputs" without a separate commit-tracking mechanism. `maxAgeMinutes`
// (opt-in, `bskel gate force <name> --max-age-minutes N`) is the OTHER independent axis --
// checkFreshness() above never lets a forced record inherit the underlying gate's own TTL policy.
export function forceGate(repoRoot, featureId, gateName, reason, currentInputs, { maxAgeMinutes = null } = {}) {
	if (!reason || !reason.trim()) {
		throw new Error('gate force requires --reason "..." -- every bypass must be auditable');
	}
	return setGate(repoRoot, featureId, gateName, {
		status: 'pass',
		token: computeToken(currentInputs),
		inputs: sortKeysDeep(currentInputs),
		at: new Date().toISOString(),
		forced: true,
		reason,
		evidence: maxAgeMinutes != null ? { freshness: { max_age_minutes: maxAgeMinutes } } : {},
	});
}

// S4 (D-gate-history): un-passes a gate with an explicit, auditable reason -- distinct from
// "never ran" (`not_run`) so a human/agent reading `bskel gate show` can tell "this was
// deliberately pulled back" from "nobody has checked this yet". `currentInputs`' token is stored
// for schema consistency with every other record shape (state.schema.json requires `token`), not
// because anything ever compares against it -- requireGate() short-circuits on `status !==
// 'pass'`/`'awaiting_disposition'` before token comparison would even run.
export function revokeGate(repoRoot, featureId, gateName, reason, currentInputs) {
	if (!reason || !reason.trim()) {
		throw new Error('gate revoke requires --reason "..." -- every revocation must be auditable');
	}
	return setGate(repoRoot, featureId, gateName, {
		status: 'revoked',
		token: computeToken(currentInputs),
		at: new Date().toISOString(),
		reason,
	});
}

// Recomputes the token from `currentInputs` and compares it to what's on disk.
// Returns { code, status, record } where code is one of EXIT.*.
export function requireGate(repoRoot, featureId, gateName, currentInputs) {
	const record = getGate(repoRoot, featureId, gateName);
	if (!record) {
		return { code: EXIT.NOT_PASSED, status: 'not_run', record: null };
	}
	if (record.status === 'awaiting_disposition') {
		return { code: EXIT.AWAITING_DISPOSITION, status: 'awaiting_disposition', record };
	}
	if (record.status !== 'pass') {
		// S4: covers 'revoked' (and anything else non-pass) generically -- no separate branch
		// needed, `record.status` is already the right string and NOT_PASSED the right code.
		return { code: EXIT.NOT_PASSED, status: record.status, record };
	}
	// S4: forced records now flow through the SAME staleness/freshness pipeline as a real pass --
	// no more early-return special case. `token`/`inputs` were bound to the real current inputs at
	// force time (forceGate() above), so this naturally catches "the input this was forced past
	// has since changed"; checkFreshness() separately refuses to apply the underlying gate's own
	// TTL policy to a forced record (see its own comment) so this doesn't silently start expiring
	// forces that were never given an explicit --max-age-minutes.
	const currentToken = computeToken(currentInputs);
	if (currentToken !== record.token) {
		return { code: EXIT.STALE, status: 'stale', record, currentToken, ...explainStaleness(record, currentInputs) };
	}
	// D-preflight-freshness (S3): checked only once the token has ALREADY matched -- an input
	// that actually changed is always the more specific, more actionable answer, and takes
	// priority over "also, it happens to be old".
	const freshness = checkFreshness(getGateDefinition(gateName), record);
	if (freshness) {
		return { code: EXIT.STALE, status: 'stale', record, currentToken, changed_inputs: [], ...freshness };
	}
	return { code: EXIT.PASS, status: record.forced ? 'pass (forced)' : 'pass', record };
}

// S1: name-based layer over the primitives above. A caller that only knows a gate's NAME
// (not its scope or its token inputs) can pass/await/require it without reaching into
// lib/gate-definitions.mjs itself -- the scope and recomputed inputs come from the gate's own
// declaration, so a call site can no longer hand-assemble the wrong inputs or write to the
// wrong scope by mistake.
export function passNamedGate(repoRoot, gateName, featureId, evidence = {}) {
	return passGate(repoRoot, gateScopeId(gateName, featureId), gateName, gateInputs(repoRoot, gateName, featureId), evidence);
}

export function awaitNamedGateDisposition(repoRoot, gateName, featureId, evidence = {}) {
	return awaitDispositionGate(repoRoot, gateScopeId(gateName, featureId), gateName, gateInputs(repoRoot, gateName, featureId), evidence);
}

export function requireNamedGate(repoRoot, gateName, featureId) {
	return requireGate(repoRoot, gateScopeId(gateName, featureId), gateName, gateInputs(repoRoot, gateName, featureId));
}

// S4: same named-layer pattern -- forceGate/revokeGate now need the gate's real current inputs
// too (to bind the token), so they get the same treatment passGate/requireGate already have.
export function forceNamedGate(repoRoot, gateName, featureId, reason, options = {}) {
	return forceGate(repoRoot, gateScopeId(gateName, featureId), gateName, reason, gateInputs(repoRoot, gateName, featureId), options);
}

export function revokeNamedGate(repoRoot, gateName, featureId, reason) {
	return revokeGate(repoRoot, gateScopeId(gateName, featureId), gateName, reason, gateInputs(repoRoot, gateName, featureId));
}
