import crypto from 'node:crypto';
import { normalizeKeyType } from './bindings.mjs';

export const GENERATION_HANDOFF_CONTRACT = 'sbf.persistence-generation-handoff/1';
export const GENERATION_HANDOFF_PROVENANCE = 'sbf.persistence-generation-handoff-provenance/1';
const ARTIFACT_REF = 'sbf.artifact-ref/1';
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function nonEmpty(value, label) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function validRevision(value, label) {
	const revision = nonEmpty(value, label);
	if (!GIT_SHA_RE.test(revision)) throw new TypeError(`${label} must be a 40-character lowercase git SHA`);
	return revision;
}

function exactArtifactRef(ref) {
	const keys = ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'];
	if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
	const actual = Object.keys(ref).sort();
	const wanted = [...keys].sort();
	return actual.length === wanted.length
		&& actual.every((key, index) => key === wanted[index])
		&& ref.artifact_ref === ARTIFACT_REF
		&& typeof ref.family === 'string' && ref.family.length > 0
		&& typeof ref.version === 'string' && ref.version.length > 0
		&& typeof ref.media_type === 'string' && ref.media_type.includes('/')
		&& typeof ref.byte_sha256 === 'string' && SHA256_RE.test(ref.byte_sha256)
		&& Number.isSafeInteger(ref.size_bytes) && ref.size_bytes >= 0;
}

function toBytes(value) {
	if (typeof value === 'string') return Buffer.from(value, 'utf8');
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError('handoff_bytes must be a string, Buffer, or Uint8Array');
}

export function buildHandleCompositionHandoff({
	http_provider_id,
	binding,
	producer_revision = null,
	candidate_revision = null,
	profile_id = null,
	execution_ref = null,
}) {
	if (typeof http_provider_id !== 'string' || !http_provider_id) throw new TypeError('http_provider_id is required');
	if (!binding || typeof binding !== 'object') throw new TypeError('binding is required');
	const blockers = [];
	if (!binding.persistence_id) blockers.push({ code:'persistence-id-missing', message:'binding has no persistence_id' });
	if (binding.capabilities?.verified_read_by_primary_key !== true) {
		blockers.push({ code:'persistence-read-not-live-verified', message:'read-by-primary-key has not been verified against live persistence evidence' });
	}
	if (binding.verification?.provider !== 'verified' || !binding.verification?.observed_provider) {
		blockers.push({ code:'live-provider-not-verified', message:'live persistence verifier/provider identity is not bound' });
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(binding.verification?.observed_snapshot_ref ?? '')) {
		blockers.push({ code:'live-snapshot-not-verified', message:'live persistence snapshot identity is not content-addressed and bound' });
	}
	if (binding.capabilities?.key_shape !== 'single') {
		blockers.push({ code:'unsupported-key-shape', message:`handles composition requires a single key, got ${binding.capabilities?.key_shape ?? 'unknown'}` });
	}
	const keyType = normalizeKeyType(binding.capabilities?.effective_key_type ?? binding.capabilities?.key_type);
	if (keyType !== 'uuid') {
		blockers.push({ code:'unsupported-key-type', message:`handles composition currently requires uuid, got ${keyType}` });
	}
	const combinationId = binding.persistence_id
		? `${http_provider_id}+${binding.persistence_id}+${keyType}`
		: null;
	let producerRevision = null;
	let candidateRevision = null;
	let profileId = null;
	let executionRef = null;
	try { producerRevision = validRevision(producer_revision, 'producer_revision'); }
	catch { blockers.push({ code:'producer-revision-missing', message:'exact T10 producer revision is required' }); }
	try { candidateRevision = validRevision(candidate_revision, 'candidate_revision'); }
	catch { blockers.push({ code:'candidate-revision-missing', message:'exact candidate revision is required' }); }
	try { profileId = nonEmpty(profile_id, 'profile_id'); }
	catch { blockers.push({ code:'profile-id-missing', message:'exact target/profile identity is required' }); }
	try { executionRef = nonEmpty(execution_ref, 'execution_ref'); }
	catch { blockers.push({ code:'execution-ref-missing', message:'live verification execution reference is required' }); }

	return {
		contract: GENERATION_HANDOFF_CONTRACT,
		status: blockers.length === 0 ? 'ready' : 'blocked',
		providerId: http_provider_id,
		persistenceId: binding.persistence_id ?? null,
		keyType,
		resourceId: binding.resource_id ?? null,
		entityId: binding.entity_id ?? null,
		combinationId,
		producerRevision,
		candidateRevision,
		profileId,
		executionRef,
		liveProvider: binding.verification?.observed_provider ?? null,
		liveSnapshotRef: binding.verification?.observed_snapshot_ref ?? null,
		blockers,
	};
}

export function bindHandleCompositionHandoffArtifact({ handoff_bytes, artifact_ref }) {
	const bytes = toBytes(handoff_bytes);
	if (!exactArtifactRef(artifact_ref)) throw new TypeError('artifact_ref must be an exact sbf.artifact-ref/1');
	const digest = crypto.createHash('sha256').update(bytes).digest('hex');
	if (artifact_ref.byte_sha256 !== digest || artifact_ref.size_bytes !== bytes.length) {
		throw new TypeError('handoff artifact bytes do not match ArtifactRef');
	}
	let handoff;
	try { handoff = JSON.parse(bytes.toString('utf8')); }
	catch { throw new TypeError('handoff artifact must contain one JSON document'); }
	if (handoff?.contract !== GENERATION_HANDOFF_CONTRACT || handoff?.status !== 'ready') {
		throw new TypeError('handoff artifact is not a ready persistence generation handoff');
	}
	for (const [key, label] of [
		['producerRevision', 'producer revision'],
		['candidateRevision', 'candidate revision'],
	]) {
		if (!GIT_SHA_RE.test(handoff[key] ?? '')) throw new TypeError(`handoff ${label} is invalid`);
	}
	for (const [key, label] of [
		['combinationId', 'combination id'],
		['profileId', 'profile id'],
		['executionRef', 'execution ref'],
		['liveProvider', 'live provider'],
		['liveSnapshotRef', 'live snapshot ref'],
	]) {
		nonEmpty(handoff[key], `handoff ${label}`);
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(handoff.liveSnapshotRef)) throw new TypeError('handoff live snapshot ref is invalid');
	return {
		contract: GENERATION_HANDOFF_PROVENANCE,
		status: 'bound',
		producerRevision: handoff.producerRevision,
		candidateRevision: handoff.candidateRevision,
		combinationId: handoff.combinationId,
		profileId: handoff.profileId,
		executionRef: handoff.executionRef,
		liveProvider: handoff.liveProvider,
		liveSnapshotRef: handoff.liveSnapshotRef,
		artifactRef: { ...artifact_ref },
		note: 'bound proves immutable T10 handoff identity only; independent T19/T14 acceptance is still required',
	};
}
