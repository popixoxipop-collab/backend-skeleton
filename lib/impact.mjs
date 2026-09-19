// D-cross-feature-impact-graph (D5/D6): `bskel impact check` (report, read-mostly) / `bskel impact
// accept` (decide, advances the baseline) / `bskel impact disposition` (compatible|migrate|waive) /
// `bskel impact ack` (clears a migrate obligation on the DOWNSTREAM side). Mirrors
// lib/cross-feature-collisions.mjs's own check/waive split and lib/field-dependencies.mjs's
// DependencyOperationError pattern exactly -- one shared error vocabulary a CLI caller (and a
// future HTTP caller, per D-http-serving-layer) both derive their own response shape from.
import { readJsonIfExists, sha256File, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { listFeatures } from './featurelifecycle.mjs';
import { withLockSync } from './lock.mjs';
import { requireValidFeatureId } from './featureid.mjs';
import { EXIT_CODES } from './exit-codes.mjs';
import { buildImpactGraph } from './impact-graph.mjs';
import { computeSurface, loadBaseline, saveBaseline, diffSurface } from './impact-surface.mjs';
import { appendDecisionEvent } from './decision-log.mjs';

const REPORT_SCHEMA = 'sbf.impact-report/1';
const RESOLUTION_SCHEMA = 'sbf.impact-resolution/1';

export class ImpactOperationError extends Error {
	constructor(message, { httpStatus = 400, exitCode = EXIT_CODES.BAD_ARGS, reasonCode = 'BAD_ARGS' } = {}) {
		super(message);
		this.name = 'ImpactOperationError';
		this.httpStatus = httpStatus;
		this.exitCode = exitCode;
		this.reasonCode = reasonCode;
	}
}

function requireValidOr400(id) {
	try {
		requireValidFeatureId(id);
	} catch (err) {
		throw new ImpactOperationError(err.message, { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
}

export function impactReportPath(root, featureId) {
	return specPath(root, featureId, 'impact-report.json');
}

export function impactResolutionPath(root, featureId) {
	return specPath(root, featureId, 'impact-resolution.json');
}

export function loadImpactResolution(root, featureId) {
	const p = impactResolutionPath(root, featureId);
	const parsed = readJsonIfExists(p);
	if (parsed === null) return { schema: RESOLUTION_SCHEMA, feature_id: featureId, dispositions: [] };
	const { ok, errors } = validateAgainstSchema('impact-resolution.schema.json', parsed);
	if (!ok) throw new Error(`${p}: does not match schemas/impact-resolution.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	return parsed;
}

function saveImpactResolution(root, featureId, doc) {
	const { ok, errors } = validateAgainstSchema('impact-resolution.schema.json', doc);
	if (!ok) throw new Error(`refusing to write an invalid impact resolution for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	writeFileAtomic(impactResolutionPath(root, featureId), `${JSON.stringify(doc, null, 2)}\n`);
	return doc;
}

function loadImpactReport(root, featureId) {
	return readJsonIfExists(impactReportPath(root, featureId));
}

function saveImpactReport(root, featureId, doc) {
	const { ok, errors } = validateAgainstSchema('impact-report.schema.json', doc);
	if (!ok) throw new Error(`refusing to write an invalid impact report for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	writeFileAtomic(impactReportPath(root, featureId), `${JSON.stringify(doc, null, 2)}\n`);
	return doc;
}

// Every OTHER feature's owner set for a graph node -- a table node's owner is derived from whoever
// maps_to_table it (reverse lookup); every other node type already carries its own feature_id.
function ownerFeaturesOf(graph, nodeId) {
	const node = graph.nodes.find((n) => n.id === nodeId);
	if (!node) return new Set();
	if (node.feature_id) return new Set([node.feature_id]);
	if (node.type === 'table') {
		const owners = new Set();
		for (const e of graph.edges) {
			if (e.relation === 'maps_to_table' && e.target === nodeId) {
				const r = graph.nodes.find((n) => n.id === e.source);
				if (r?.feature_id) owners.add(r.feature_id);
			}
		}
		return owners;
	}
	return new Set();
}

function changeSubjectNodeId(featureId, change) {
	if (change.kind.startsWith('operation_')) return `${featureId}#${change.subject}`;
	if (change.kind === 'field_source_moved') return `${featureId}::${change.subject}`;
	// resource_removed / resource_table_changed -- subject is a bare resourceType
	return `${featureId}::${change.subject}`;
}

// D-cross-feature-impact-graph: walks the graph from ONE change's own node outward one hop, over
// the three relations that can name a real downstream consumer. `derives_from` only counts when
// the changed node is the DEPENDED-ON side (edge.target) -- something reading FROM it, not the
// other way around.
function findOutboundImpacts(graph, subjectNodeId, ownFeatureId) {
	const impacts = [];
	for (const e of graph.edges) {
		let counterpartId = null;
		if (e.relation === 'derives_from' && e.target === subjectNodeId) counterpartId = e.source;
		else if (e.relation === 'fk_references' && (e.source === subjectNodeId || e.target === subjectNodeId)) counterpartId = e.source === subjectNodeId ? e.target : e.source;
		else if (e.relation === 'name_collides_with' && (e.source === subjectNodeId || e.target === subjectNodeId)) counterpartId = e.source === subjectNodeId ? e.target : e.source;
		else continue;
		for (const feat of ownerFeaturesOf(graph, counterpartId)) {
			if (feat === ownFeatureId) continue;
			impacts.push({ downstream_feature: feat, via: e.relation, basis: e.basis, confidence: e.confidence });
		}
	}
	return impacts;
}

function isDispositionActive(d, nowMs) {
	if (d.mode === 'waive') {
		if (!d.expires_at) return false;
		return Date.parse(d.expires_at) > nowMs;
	}
	if (d.mode === 'migrate') return true; // migrate stays "recorded" indefinitely -- clearing the BLOCK is acknowledged, tracked separately
	return true; // compatible
}

function findDisposition(resolution, changeKey, downstreamFeature, nowMs) {
	return (resolution.dispositions ?? []).find((d) => d.change_key === changeKey && d.downstream_feature === downstreamFeature && isDispositionActive(d, nowMs));
}

// D-cross-feature-impact-graph (D5): read-mostly -- computes the current surface, diffs it against
// impact-baseline.json, walks the graph for each change, and writes impact-report.json. Never
// advances the baseline (only acceptImpact() does).
export function checkImpact(root, featureId, { now = new Date() } = {}) {
	requireValidOr400(featureId);
	const graph = buildImpactGraph(root, { nowIso: now.toISOString() });
	const baseline = loadBaseline(root, featureId);
	const currentSurface = computeSurface(root, featureId);
	const changes = diffSurface(baseline?.surface ?? null, currentSurface);
	const resolution = loadImpactResolution(root, featureId);

	const outbound = [];
	for (const change of changes) {
		const subjectNodeId = changeSubjectNodeId(featureId, change);
		for (const impact of findOutboundImpacts(graph, subjectNodeId, featureId)) {
			const disp = findDisposition(resolution, change.change_key, impact.downstream_feature, now.getTime());
			outbound.push({ change_key: change.change_key, downstream_feature: impact.downstream_feature, via: impact.via, basis: impact.basis, confidence: impact.confidence, disposition: disp?.mode ?? null });
		}
	}

	// inbound: every OTHER feature's own resolution naming THIS feature as downstream, mode migrate, not yet acknowledged
	const inbound = [];
	for (const other of listFeatures(root)) {
		if (other.feature_id === featureId) continue;
		const otherResolution = loadImpactResolution(root, other.feature_id);
		for (const d of otherResolution.dispositions ?? []) {
			if (d.mode === 'migrate' && d.downstream_feature === featureId) {
				inbound.push({ upstream_feature: other.feature_id, change_key: d.change_key, mode: 'migrate', tracked_by: d.tracked_by, acknowledged: Boolean(d.acknowledged) });
			}
		}
	}

	const unknowns = [];
	if (!baseline) unknowns.push(`no impact-baseline.json for "${featureId}" yet -- every operation/resource reports as newly added, run \`bskel impact accept --feature ${featureId}\` to capture the first baseline`);

	const report = {
		schema: REPORT_SCHEMA,
		feature_id: featureId,
		generated_at: now.toISOString(),
		baseline: { present: Boolean(baseline), captured_at: baseline?.captured_at ?? null },
		changes,
		outbound,
		inbound,
		unknowns,
	};
	saveImpactReport(root, featureId, report);
	return { report, evaluation: evaluateImpacts(report) };
}

// D-cross-feature-impact-graph (D6): only a PROVEN, undisposed outbound impact blocks -- the
// gate-fatigue control Codex's own review named as the risk to answer directly. An unacknowledged
// inbound migrate obligation also blocks (the two-sided handshake).
export function evaluateImpacts(report) {
	const blockingOutbound = report.outbound.filter((o) => o.confidence === 'proven' && !o.disposition);
	const blockingInbound = report.inbound.filter((i) => !i.acknowledged);
	return {
		blocking: blockingOutbound.length > 0 || blockingInbound.length > 0,
		blockingOutbound,
		blockingInbound,
		heuristicOutbound: report.outbound.filter((o) => o.confidence === 'heuristic'),
	};
}

// D-cross-feature-impact-graph (D5): the DECIDE half -- refuses (AWAITING_DISPOSITION) if any
// proven outbound impact is undisposed or any inbound migration is unacknowledged; otherwise
// atomically rewrites impact-baseline.json from the CURRENT surface. On a feature with no prior
// baseline, `checkImpact` above already reports every operation as `operation_added` with zero
// downstream impacts (nothing can depend on what didn't exist), so this captures trivially -- no
// bootstrap special case.
export function acceptImpact(root, featureId, { now = new Date() } = {}) {
	requireValidOr400(featureId);
	return withLockSync(root, 'state', () => {
		const { report, evaluation } = checkImpact(root, featureId, { now });
		if (evaluation.blocking) {
			throw new ImpactOperationError(
				`"${featureId}" has ${evaluation.blockingOutbound.length} undisposed proven outbound impact(s) and ${evaluation.blockingInbound.length} unacknowledged inbound migration(s) -- run \`bskel impact disposition\`/\`bskel impact ack\` first, or \`bskel gate force impact --feature ${featureId} --reason "..."\` to override (recorded in signed attestations)`,
				{ httpStatus: 409, exitCode: EXIT_CODES.AWAITING_DISPOSITION, reasonCode: 'GATE_AWAITING_DISPOSITION' },
			);
		}
		const surface = computeSurface(root, featureId);
		const baseline = saveBaseline(root, featureId, surface, { capturedAt: now.toISOString() });
		return { baseline, report };
	});
}

// D-cross-feature-impact-graph (D6): records one of {compatible, migrate, waive} for exactly one
// {change_key, downstream_feature} pair -- never a wildcard. `migrate` requires --tracked-by
// (non-empty); `waive` requires --expires-days (a positive integer), reusing the SAME decay
// posture D-waiver-expiry already ships for `contract waive`.
export function recordDisposition(root, { feature, changeKey, downstreamFeature, mode, reason, trackedBy = null, expiresDays = null, now = new Date() }) {
	requireValidOr400(feature);
	requireValidOr400(downstreamFeature);
	if (!reason || !reason.trim()) {
		throw new ImpactOperationError('bskel impact disposition requires --reason "..." -- every disposition must be auditable', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	if (!['compatible', 'migrate', 'waive'].includes(mode)) {
		throw new ImpactOperationError(`--mode must be one of compatible|migrate|waive (got "${mode}")`, { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	if (mode === 'migrate' && (!trackedBy || !trackedBy.trim())) {
		throw new ImpactOperationError('--mode migrate requires --tracked-by "<issue/PR reference>" -- a migrate disposition with nothing to track is a no-op that looks like a decision', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	let expiresAt = null;
	if (mode === 'waive') {
		if (!(Number.isInteger(expiresDays) && expiresDays > 0)) {
			throw new ImpactOperationError('--mode waive requires --expires-days <N> (a positive integer) -- same decay posture as `contract waive --expires`', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
		}
		expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
	}

	return withLockSync(root, 'state', () => {
		const current = loadImpactResolution(root, feature);
		const at = now.toISOString();
		const next = {
			schema: RESOLUTION_SCHEMA,
			feature_id: feature,
			dispositions: [
				...current.dispositions.filter((d) => !(d.change_key === changeKey && d.downstream_feature === downstreamFeature)),
				{
					change_key: changeKey,
					downstream_feature: downstreamFeature,
					mode,
					reason,
					tracked_by: mode === 'migrate' ? trackedBy : null,
					expires_at: expiresAt,
					acknowledged: false,
					acknowledged_at: null,
					acknowledged_reason: null,
					at,
				},
			],
		};
		const saved = saveImpactResolution(root, feature, next);
		appendDecisionEvent(root, feature, {
			kind: 'impact_disposition', action: 'record', at, reason, feature_id: feature,
			subject: { change_key: changeKey, downstream_feature: downstreamFeature },
			mode, expires_at: expiresAt, tracked_by: mode === 'migrate' ? trackedBy : null,
		});
		return saved;
	});
}

// D-cross-feature-impact-graph (D6): the DOWNSTREAM feature's own acknowledgement of a `migrate`
// obligation another feature recorded against it -- flips `acknowledged` on the UPSTREAM feature's
// own resolution record (that's where the obligation lives; ack doesn't create a new file).
export function acknowledgeInbound(root, { feature, from, changeKey, reason, now = new Date() }) {
	requireValidOr400(feature);
	requireValidOr400(from);
	if (!reason || !reason.trim()) {
		throw new ImpactOperationError('bskel impact ack requires --reason "..." -- every acknowledgement must be auditable', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	return withLockSync(root, 'state', () => {
		const upstreamResolution = loadImpactResolution(root, from);
		const match = upstreamResolution.dispositions.find((d) => d.mode === 'migrate' && d.downstream_feature === feature && d.change_key === changeKey);
		if (!match) {
			throw new ImpactOperationError(`no "migrate" disposition from "${from}" targeting "${feature}" for change_key "${changeKey}" -- run \`bskel impact check --feature ${feature}\` to see current inbound obligations`, { httpStatus: 404, exitCode: EXIT_CODES.NOT_PASSED, reasonCode: 'MISSING_ARTIFACT' });
		}
		match.acknowledged = true;
		match.acknowledged_at = now.toISOString();
		match.acknowledged_reason = reason;
		const saved = saveImpactResolution(root, from, upstreamResolution);
		appendDecisionEvent(root, from, {
			kind: 'impact_disposition', action: 'acknowledge', at: match.acknowledged_at, reason, feature_id: from,
			subject: { change_key: changeKey, downstream_feature: feature },
			mode: match.mode, expires_at: match.expires_at ?? null, tracked_by: match.tracked_by ?? null,
		});
		return saved;
	});
}

// D-decision-event-log (D6): forward-only retraction, mirroring `gate revoke`'s own precedent --
// removes the entry (its absence IS the state, matching every other withdraw in this item) and
// appends a `withdraw` event carrying the reason. Never a snapshot restore: a disposition has no
// "previous value" worth restoring once the change it covered has moved on -- see
// D-decision-event-log's own Q4 answer in DECISIONS.md for why this is the correct
// generalization of `gate revoke`, not of `lib/patch-transactions.mjs`'s preimage-blob rollback.
export function withdrawDisposition(root, { feature, changeKey, downstreamFeature, reason, now = new Date() }) {
	requireValidOr400(feature);
	requireValidOr400(downstreamFeature);
	if (!reason || !reason.trim()) {
		throw new ImpactOperationError('bskel impact disposition --withdraw requires --reason "..." -- every withdrawal must be auditable', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	return withLockSync(root, 'state', () => {
		const current = loadImpactResolution(root, feature);
		const match = current.dispositions.find((d) => d.change_key === changeKey && d.downstream_feature === downstreamFeature);
		if (!match) {
			throw new ImpactOperationError(`no disposition recorded for change_key "${changeKey}" -> "${downstreamFeature}" on feature "${feature}" -- nothing to withdraw`, { httpStatus: 404, exitCode: EXIT_CODES.NOT_PASSED, reasonCode: 'MISSING_ARTIFACT' });
		}
		const at = now.toISOString();
		const next = {
			schema: RESOLUTION_SCHEMA,
			feature_id: feature,
			dispositions: current.dispositions.filter((d) => !(d.change_key === changeKey && d.downstream_feature === downstreamFeature)),
		};
		const saved = saveImpactResolution(root, feature, next);
		appendDecisionEvent(root, feature, {
			kind: 'impact_disposition', action: 'withdraw', at, reason, feature_id: feature,
			subject: { change_key: changeKey, downstream_feature: downstreamFeature },
			mode: match.mode, expires_at: match.expires_at ?? null, tracked_by: match.tracked_by ?? null,
		});
		return saved;
	});
}
