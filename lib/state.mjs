// D1: gate state lives on disk as content-hash tokens, not as prose the agent is asked to honor.
//   WHY: the spec-kit trial proved agent-honored steps are luck; spec-kit's own `optional:false`
//        hooks are just text injected into the agent's context, not a process gate.
//   COST: extra files per feature; stale-token friction when the spec changes mid-session.
//   EXIT: `bskel gate force <name> --reason "..."` records the bypass so it's auditable, not silent.
import fs from 'node:fs';
import path from 'node:path';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { withLockSync } from './lock.mjs';

const STATE_SCHEMA = 'sbf.state/1';

export function sbfDir(repoRoot) {
	return path.join(repoRoot, '.sbf');
}

export function statePath(repoRoot, featureId) {
	return path.join(sbfDir(repoRoot), `${featureId}.json`);
}

// S4 (D-gate-history): sibling to statePath's own .sbf/<featureId>.json -- the append-only event
// log for the same scope, same naming convention (suffix swapped, not a different directory).
export function historyPath(repoRoot, featureId) {
	return path.join(sbfDir(repoRoot), `${featureId}.history.jsonl`);
}

export function loadState(repoRoot, featureId) {
	const file = statePath(repoRoot, featureId);
	if (!fs.existsSync(file)) {
		return { schema: STATE_SCHEMA, feature_id: featureId, gates: {} };
	}
	const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (parsed.schema !== STATE_SCHEMA) {
		throw new Error(`${file}: unrecognized state schema "${parsed.schema}" (expected ${STATE_SCHEMA})`);
	}
	// S5: the schema-const check above already covered "is this even a state file"; this covers
	// everything else the schema declares (gate record shape, token format, etc.) -- catches a
	// hand-edited or externally-corrupted .sbf/<feature>.json that still happens to carry the
	// right `schema` value. A plain Error, same as the check above -- main()'s catch-all in
	// bin/bskel.mjs already treats "a malformed-state read" as its own documented case (exit 14).
	const { ok, errors } = validateAgainstSchema('state.schema.json', parsed);
	if (!ok) {
		throw new Error(`${file}: does not match schemas/state.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

// Atomic write (temp + rename) so a mid-write crash never leaves a half-written state.json
// that a later `gate require` would parse as valid — same technique as archify's validator writer.
export function saveState(repoRoot, featureId, state) {
	// S5: validated before it ever touches disk -- a bskel bug producing an invalid state object
	// should fail loudly right here, not get persisted and surface later as a confusing read-side
	// error somewhere else entirely.
	const { ok, errors } = validateAgainstSchema('state.schema.json', state);
	if (!ok) {
		throw new Error(`refusing to write an invalid state record for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	const dir = sbfDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	const file = statePath(repoRoot, featureId);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	fs.renameSync(tmp, file);
	return file;
}

// S4 (D-gate-history): derives which of the 4 real write-time events `gateRecord` represents --
// no separate event-type parameter needed, the record's own shape already says which one it is.
// Deliberately no "stale" event: staleness is derived at READ time (requireGate(), never
// written to disk -- see state.schema.json's own status-enum comment), so there is nothing to
// log an event for; logging on every `require`/`verify` read would turn this into read-path
// noise, not a history of state CHANGES.
function gateEventType(gateRecord) {
	if (gateRecord.status === 'awaiting_disposition') return 'awaiting_disposition';
	if (gateRecord.status === 'revoked') return 'revoke';
	if (gateRecord.forced) return 'force';
	return 'pass';
}

// S4: validated the same way every other persistence boundary is (S5's lib/schema-validate.mjs)
// before it touches disk. Append-only -- fs.appendFileSync, never rewritten -- so a single line's
// corruption (a partial write from a crash mid-append) can't take down the rest of the log; the
// reader (bin/bskel.mjs's cmdGateHistory) is expected to skip an unparseable/invalid line with a
// warning rather than fail the whole read, matching JSONL's own resilience rationale.
function appendGateEvent(repoRoot, featureId, gateName, gateRecord) {
	const line = {
		schema: 'sbf.gate-event/1',
		event: gateEventType(gateRecord),
		gate: gateName,
		at: gateRecord.at,
		status: gateRecord.status,
		token: gateRecord.token ?? null,
		forced: gateRecord.forced ?? false,
		reason: gateRecord.reason ?? null,
	};
	const { ok, errors } = validateAgainstSchema('gate-event.schema.json', line);
	if (!ok) {
		throw new Error(`refusing to append an invalid gate-history event for "${featureId}"/"${gateName}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	fs.mkdirSync(sbfDir(repoRoot), { recursive: true });
	fs.appendFileSync(historyPath(repoRoot, featureId), `${JSON.stringify(line)}\n`);
}

// S5: load -> modify -> save under an exclusive per-repo lock -- passGate/awaitDispositionGate/
// forceGate/revokeGate (lib/gates.mjs) all funnel through this one function, so this single
// change closes the lost-update race for every gate write in the codebase. Confirmed live
// before this fix existed: two processes racing this exact load-modify-save sequence silently
// dropped one process's gate write. See lib/lock.mjs for why the lock itself is synchronous.
// S4: also appends the same write to the per-feature history log, inside the same lock, so the
// snapshot and the log can never observe each other's writes out of order.
export function setGate(repoRoot, featureId, gateName, gateRecord) {
	return withLockSync(repoRoot, 'state', () => {
		const state = loadState(repoRoot, featureId);
		state.gates[gateName] = gateRecord;
		saveState(repoRoot, featureId, state);
		appendGateEvent(repoRoot, featureId, gateName, gateRecord);
		return state;
	});
}

export function getGate(repoRoot, featureId, gateName) {
	const state = loadState(repoRoot, featureId);
	return state.gates[gateName] ?? null;
}
