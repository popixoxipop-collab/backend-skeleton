// D1: gate state lives on disk as content-hash tokens, not as prose the agent is asked to honor.
//   WHY: the spec-kit trial proved agent-honored steps are luck; spec-kit's own `optional:false`
//        hooks are just text injected into the agent's context, not a process gate.
//   COST: extra files per feature; stale-token friction when the spec changes mid-session.
//   EXIT: `bskel gate force <name> --reason "..."` records the bypass so it's auditable, not silent.
import fs from 'node:fs';
import path from 'node:path';

const STATE_SCHEMA = 'sbf.state/1';

export function sbfDir(repoRoot) {
	return path.join(repoRoot, '.sbf');
}

export function statePath(repoRoot, featureId) {
	return path.join(sbfDir(repoRoot), `${featureId}.json`);
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
	return parsed;
}

// Atomic write (temp + rename) so a mid-write crash never leaves a half-written state.json
// that a later `gate require` would parse as valid — same technique as archify's validator writer.
export function saveState(repoRoot, featureId, state) {
	const dir = sbfDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	const file = statePath(repoRoot, featureId);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	fs.renameSync(tmp, file);
	return file;
}

export function setGate(repoRoot, featureId, gateName, gateRecord) {
	const state = loadState(repoRoot, featureId);
	state.gates[gateName] = gateRecord;
	saveState(repoRoot, featureId, state);
	return state;
}

export function getGate(repoRoot, featureId, gateName) {
	const state = loadState(repoRoot, featureId);
	return state.gates[gateName] ?? null;
}
