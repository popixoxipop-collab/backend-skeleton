// Gate primitives shared by every `bskel <verb>` that needs to read or write a gate.
// A gate is "passed" only if a token recomputed from the CURRENT inputs matches the token
// that was stored when the gate last passed. If HEAD moved, or spec.md changed, or anything
// else in the gate's declared input set changed, the token mismatches and the gate reports
// `stale` -- it cannot be satisfied once and then silently drift out of sync with reality.
import { createHash } from 'node:crypto';
import { getGate, setGate } from './state.mjs';
import { gateScopeId, gateInputs } from './gate-definitions.mjs';

export const EXIT = Object.freeze({
	PASS: 0,
	NOT_PASSED: 2,
	AWAITING_DISPOSITION: 3,
	STALE: 4,
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

export function passGate(repoRoot, featureId, gateName, inputs, evidence = {}) {
	const token = computeToken(inputs);
	return setGate(repoRoot, featureId, gateName, {
		status: 'pass',
		token,
		at: new Date().toISOString(),
		evidence,
	});
}

export function awaitDispositionGate(repoRoot, featureId, gateName, inputs, evidence = {}) {
	const token = computeToken(inputs);
	return setGate(repoRoot, featureId, gateName, {
		status: 'awaiting_disposition',
		token,
		at: new Date().toISOString(),
		evidence,
	});
}

export function forceGate(repoRoot, featureId, gateName, reason) {
	if (!reason || !reason.trim()) {
		throw new Error('gate force requires --reason "..." -- every bypass must be auditable');
	}
	return setGate(repoRoot, featureId, gateName, {
		status: 'pass',
		token: computeToken({ forced: true, reason }),
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
		return { code: EXIT.STALE, status: 'stale', record, currentToken };
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
