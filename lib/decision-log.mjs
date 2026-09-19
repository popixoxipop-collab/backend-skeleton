// D-decision-event-log: an append-only audit trail for the four spec-side decision files
// (contract waivers, cross-feature waivers, impact dispositions, patch approvals) -- mirrors
// lib/state.mjs's appendGateEvent()/readGateHistory() shape exactly (same file family, same
// schema-validated-JSONL contract, same corrupt-line-is-skipped-not-fatal resilience). A sibling
// to .sbf/<featureId>.history.jsonl, not a replacement for it -- gates keep their own log.
//   WHY: F2 (found during this item's own grounding) -- all four decision files silently
//   OVERWRITE the prior decision (reason/actor/timestamp) on re-decision, and none of the four had
//   any retraction command. `gate revoke` is the only retraction primitive in the whole tool.
//   COST: one more .sbf/ file per feature. Machine-local, gitignored-by-convention -- this log is
//   NOT tamper-evident on its own (see schemas/decision-event.schema.json's own description);
//   its evidentiary value comes from being rolled into a SIGNED gate-export attestation.
//   EXIT: no cross-feature aggregate view; per-feature only, matching gate history's own scoping.
import fs from 'node:fs';
import { sbfDir } from './state.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';

export function decisionLogPath(repoRoot, featureId) {
	return `${sbfDir(repoRoot)}/${featureId}.decisions.jsonl`;
}

// Called from inside the SAME withLockSync(root, 'state', ...) each of the four write paths
// already holds -- never opens its own lock, so the decision write and the log append can never
// observe each other out of order (same discipline setGate() already applies to gate writes).
export function appendDecisionEvent(repoRoot, featureId, event) {
	const line = { schema: 'sbf.decision-event/1', ...event };
	const { ok, errors } = validateAgainstSchema('decision-event.schema.json', line);
	if (!ok) {
		throw new Error(`refusing to append an invalid decision event for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	fs.mkdirSync(sbfDir(repoRoot), { recursive: true });
	fs.appendFileSync(decisionLogPath(repoRoot, featureId), `${JSON.stringify(line)}\n`);
}

// Mirrors lib/gate-export.mjs's readGateHistory() resilience contract exactly: a corrupt/invalid
// line is skipped with a warning, never a hard failure.
export function readDecisionLog(repoRoot, featureId, { kind = null, onWarning } = {}) {
	const file = decisionLogPath(repoRoot, featureId);
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
	const events = [];
	for (const [i, line] of lines.entries()) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			onWarning?.(`${file}:${i + 1}: not valid JSON, skipped`);
			continue;
		}
		const { ok, errors } = validateAgainstSchema('decision-event.schema.json', parsed);
		if (!ok) {
			onWarning?.(`${file}:${i + 1}: does not match schemas/decision-event.schema.json, skipped`, errors);
			continue;
		}
		if (kind && parsed.kind !== kind) continue;
		events.push(parsed);
	}
	return events;
}
