// Gate primitives shared by every `bskel <verb>` that needs to read or write a gate.
// A gate is "passed" only if a token recomputed from the CURRENT inputs matches the token
// that was stored when the gate last passed. If HEAD moved, or spec.md changed, or anything
// else in the gate's declared input set changed, the token mismatches and the gate reports
// `stale` -- it cannot be satisfied once and then silently drift out of sync with reality.
import { createHash } from 'node:crypto';
import { getGate, setGate } from './state.mjs';
import { gateScopeId, gateInputs } from './gate-definitions.mjs';
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
});

export function computeToken(inputs) {
	const canonical = JSON.stringify(sortKeysDeep(inputs));
	return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sortKeysDeep(value) {
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

export function forceGate(repoRoot, featureId, gateName, reason) {
	if (!reason || !reason.trim()) {
		throw new Error('gate force requires --reason "..." -- every bypass must be auditable');
	}
	const inputs = { forced: true, reason };
	return setGate(repoRoot, featureId, gateName, {
		status: 'pass',
		token: computeToken(inputs),
		inputs: sortKeysDeep(inputs),
		at: new Date().toISOString(),
		forced: true,
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
		return { code: EXIT.NOT_PASSED, status: record.status, record };
	}
	if (record.forced) {
		// A forced gate has no meaningful "current inputs" to compare against -- it was an
		// explicit human override, so it stays passed until the feature is re-scanned/re-planned.
		return { code: EXIT.PASS, status: 'pass (forced)', record };
	}
	const currentToken = computeToken(currentInputs);
	if (currentToken !== record.token) {
		return { code: EXIT.STALE, status: 'stale', record, currentToken, ...explainStaleness(record, currentInputs) };
	}
	return { code: EXIT.PASS, status: 'pass', record };
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
