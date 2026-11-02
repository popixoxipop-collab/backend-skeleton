import { createHash } from 'node:crypto';
import { sortKeysDeep } from '../lib/gates.mjs';

export const WEBGAME_FINGERPRINT_SCHEMA = 'sbf.webgame-fingerprint/1';

function sha256Canonical(value) {
	const canonical = JSON.stringify(sortKeysDeep(value));
	return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function requiredString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
	return value;
}

function normalizeDigestEntries(entries, name) {
	if (entries == null) return [];
	const list = Array.isArray(entries)
		? entries
		: Object.entries(entries).map(([path, digest]) => ({ path, digest }));
	return list.map((entry, index) => {
		if (!entry || typeof entry !== 'object') throw new Error(`${name}[${index}] must be an object`);
		return {
			path: requiredString(entry.path, `${name}[${index}].path`),
			digest: requiredString(entry.digest, `${name}[${index}].digest`),
		};
	}).sort((a, b) => a.path.localeCompare(b.path) || a.digest.localeCompare(b.digest));
}

function normalizeStrings(values, name) {
	if (values == null) return [];
	if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
	return [...new Set(values.map((value, index) => requiredString(value, `${name}[${index}]`)))].sort();
}

export function buildFingerprintMaterial(input = {}) {
	const runner = input.runner ?? {};
	const browser = input.browser ?? {};
	return sortKeysDeep({
		source_snapshot_digest: requiredString(input.source_snapshot_digest, 'source_snapshot_digest'),
		source_files: normalizeDigestEntries(input.source_files, 'source_files'),
		assets: normalizeDigestEntries(input.assets, 'assets'),
		runtime_contract_digest: requiredString(input.runtime_contract_digest, 'runtime_contract_digest'),
		scenario_digest: requiredString(input.scenario_digest, 'scenario_digest'),
		assertion_policy_digest: requiredString(input.assertion_policy_digest, 'assertion_policy_digest'),
		runner: {
			id: requiredString(runner.id, 'runner.id'),
			version: requiredString(runner.version, 'runner.version'),
		},
		browser: {
			name: requiredString(browser.name, 'browser.name'),
			version: requiredString(browser.version, 'browser.version'),
			revision: requiredString(browser.revision, 'browser.revision'),
		},
		profile_id: requiredString(input.profile_id, 'profile_id'),
		build_artifact_digest: requiredString(input.build_artifact_digest, 'build_artifact_digest'),
		required_capabilities: normalizeStrings(input.required_capabilities, 'required_capabilities'),
	});
}

export function buildWebgameFingerprint(input) {
	const material = buildFingerprintMaterial(input);
	return {
		schema: WEBGAME_FINGERPRINT_SCHEMA,
		digest: sha256Canonical(material),
		material,
	};
}

export function validateWebgameFingerprint(fingerprint) {
	const errors = [];
	if (!fingerprint || typeof fingerprint !== 'object') {
		return { ok: false, errors: ['fingerprint must be an object'] };
	}
	if (fingerprint.schema !== WEBGAME_FINGERPRINT_SCHEMA) errors.push('fingerprint schema mismatch');
	if (!fingerprint.material || typeof fingerprint.material !== 'object') errors.push('fingerprint material missing');
	if (typeof fingerprint.digest !== 'string') errors.push('fingerprint digest missing');
	if (errors.length === 0 && sha256Canonical(fingerprint.material) !== fingerprint.digest) {
		errors.push('fingerprint digest mismatch');
	}
	return { ok: errors.length === 0, errors };
}

export function diffWebgameFingerprints(previous, current) {
	if (!previous?.material || !current?.material) {
		return { current: false, changed_components: null, reason: 'missing_material' };
	}
	const keys = [...new Set([...Object.keys(previous.material), ...Object.keys(current.material)])].sort();
	const changed = keys.filter((key) =>
		JSON.stringify(sortKeysDeep(previous.material[key])) !== JSON.stringify(sortKeysDeep(current.material[key])));
	return {
		current: previous.digest === current.digest && changed.length === 0,
		changed_components: changed,
		reason: changed.length === 0 ? null : 'fingerprint_changed',
	};
}

export function isWebgameFingerprintCurrent(previous, current) {
	return Boolean(
		validateWebgameFingerprint(previous).ok &&
		validateWebgameFingerprint(current).ok &&
		previous.digest === current.digest,
	);
}

export function digestWebgameValue(value) {
	return sha256Canonical(value);
}
