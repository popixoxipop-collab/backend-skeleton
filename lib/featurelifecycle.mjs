// D6 (D-feature-lifecycle): everything beyond `feature init` -- list/show/rename/link/archive
// over specs/<feature_id>/ and .sbf/feature-index.json. See DECISIONS.md for the full rename
// blast-radius grounding and why `link` is index-only, never a state merge.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists, writeFileAtomic } from './fsutil.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { specDir } from './paths.mjs';
import { statePath, historyPath } from './state.mjs';
import { loadManifest, saveManifest } from './handles-manifest.mjs';

const FEATURE_SCHEMA = 'sbf.feature/1';
const FEATURE_INDEX_SCHEMA = 'sbf.feature-index/1';

export function featureIndexPath(root) {
	return path.join(root, '.sbf', 'feature-index.json');
}

export function loadFeatureIndex(root) {
	const file = featureIndexPath(root);
	const parsed = readJsonIfExists(file);
	if (!parsed) return { schema: FEATURE_INDEX_SCHEMA, by_uid: {} };
	if (parsed.schema !== FEATURE_INDEX_SCHEMA) {
		throw new Error(`${file}: unrecognized feature-index schema "${parsed.schema}" (expected ${FEATURE_INDEX_SCHEMA})`);
	}
	const { ok, errors } = validateAgainstSchema('feature-index.schema.json', parsed);
	if (!ok) {
		throw new Error(`${file}: does not match schemas/feature-index.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveFeatureIndex(root, index) {
	const { ok, errors } = validateAgainstSchema('feature-index.schema.json', index);
	if (!ok) {
		throw new Error(`refusing to write an invalid feature-index record:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(featureIndexPath(root), `${JSON.stringify(index, null, 2)}\n`);
}

function featureFilePath(root, featureId) {
	return path.join(specDir(root, featureId), 'feature.json');
}

export function loadFeatureFile(root, featureId) {
	const file = featureFilePath(root, featureId);
	const parsed = readJsonIfExists(file);
	if (!parsed) return null;
	if (parsed.schema !== FEATURE_SCHEMA) {
		throw new Error(`${file}: unrecognized feature schema "${parsed.schema}" (expected ${FEATURE_SCHEMA})`);
	}
	const { ok, errors } = validateAgainstSchema('feature.schema.json', parsed);
	if (!ok) {
		throw new Error(`${file}: does not match schemas/feature.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveFeatureFile(root, featureId, record) {
	const { ok, errors } = validateAgainstSchema('feature.schema.json', record);
	if (!ok) {
		throw new Error(`refusing to write an invalid feature record for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(featureFilePath(root, featureId), `${JSON.stringify(record, null, 2)}\n`);
}

// Scans specs/*/feature.json directly, not the index -- by_uid never held more than one id per
// uid until this item, so it was never a "list every feature" source (lib/workflow.mjs's own
// comment already established this). O6-style determinism: sorted by feature_id.
export function listFeatures(root, { includeArchived = false } = {}) {
	const specsRoot = path.join(root, 'specs');
	if (!fs.existsSync(specsRoot)) return [];
	const ids = fs.readdirSync(specsRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	const records = [];
	for (const id of ids) {
		let record;
		try {
			record = loadFeatureFile(root, id);
		} catch {
			continue; // a corrupt/foreign feature.json shouldn't take down `feature list` -- bskel status already surfaces read errors for the feature a user actually asked about
		}
		if (!record) continue; // a specs/ dir with no feature.json isn't a real feature
		if (record.archived_at && !includeArchived) continue;
		records.push(record);
	}
	return records;
}

export function currentFeatureIdForUid(index, uid) {
	const ids = index.by_uid[uid];
	return ids && ids.length > 0 ? ids[ids.length - 1] : null;
}

export function uidForFeatureId(index, featureId) {
	for (const [uid, ids] of Object.entries(index.by_uid)) {
		if (ids.includes(featureId)) return uid;
	}
	return null;
}

// True if `id` is already a real specs/ directory OR already appears anywhere in the index
// (including a retired id from an earlier rename) -- a rename target must collide with neither.
export function featureIdInUse(root, index, id) {
	return fs.existsSync(specDir(root, id)) || uidForFeatureId(index, id) !== null;
}

function rewriteFeatureIdField(jsonPath, oldId, newId) {
	const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	if (parsed.feature_id !== oldId) return;
	parsed.feature_id = newId;
	writeFileAtomic(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

// D6: the full migration a rename needs -- every featureId-keyed persisted artifact, traced by
// direct exploration before writing this, not assumed: specs/<id>/ (the whole directory, plus 3
// featureId-PREFIXED filenames inside contracts/ -- brownfield-scan.{json,md} use a fixed name,
// not prefixed, so they move for free with the directory rename and need no rename here),
// .sbf/<id>.json (filename AND its own feature_id field), .sbf/<id>.history.jsonl (filename
// only -- gate-event lines never carry feature_id), .sbf/handles-manifest.json's resolver-entry
// `owner` fields (`owner:'_repo'` infra entries are untouched -- not a feature id at all).
//
// Deliberately does NOT rewrite already-generated application code (a resolver .java/.py file's
// own doc-comment keeps the OLD feature id baked in, and specs/<id>/handles/migration.sql keeps
// the old id in its rendered SQL) -- cosmetic staleness, not a safety issue: classifyFile()'s
// real conflict check is the manifest's content-hash, which IS updated here, and rewriting
// already-generated files outside the normal emit path is exactly the class of thing this
// project has repeatedly chosen not to do (D-migration-scope, D-config-patch).
export function renameFeatureArtifacts(root, oldId, newId) {
	const oldDir = specDir(root, oldId);
	const newDir = specDir(root, newId);
	fs.renameSync(oldDir, newDir);

	// Rename featureId-prefixed filenames under contracts/ -- FILENAME ONLY, content is left
	// byte-identical on purpose. Found live, not designed in from the start: an early draft also
	// rewrote each file's own `feature_id` field, and a real `handles emit --check` against the
	// just-renamed id immediately reported the contract gate as stale -- lib/gate-definitions.mjs's
	// contract/handles gates hash these files' FULL CONTENT for their token (contract_hash/
	// resolution_hash/openapi_snapshot_hash), so rewriting even one field inside them silently
	// invalidates an already-passed gate's stored token, forcing a phantom re-verification of
	// content that never actually changed. Same "cosmetic staleness accepted" principle already
	// applied to a resolver's own doc-comment and migration.sql -- extended here to every
	// gate-token-hashed artifact, not just already-generated application code.
	const contractsDir = path.join(newDir, 'contracts');
	if (fs.existsSync(contractsDir)) {
		for (const name of fs.readdirSync(contractsDir)) {
			if (!name.startsWith(`${oldId}.`)) continue;
			fs.renameSync(path.join(contractsDir, name), path.join(contractsDir, newId + name.slice(oldId.length)));
		}
	}
	// brownfield-scan.{json,md} use a fixed name (not featureId-prefixed) -- they move for free
	// with the directory rename above and are, for the identical reason, never rewritten either
	// (scan_report_hash hashes brownfield-scan.json's full content too).

	// feature.json is the one specs/ artifact that is NOT hashed as input to any gate token --
	// it's the authoritative CURRENT-identity record, safe (and correct) to rewrite in place.
	rewriteFeatureIdField(path.join(newDir, 'feature.json'), oldId, newId);

	const oldStatePath = statePath(root, oldId);
	if (fs.existsSync(oldStatePath)) {
		const newStatePath = statePath(root, newId);
		fs.renameSync(oldStatePath, newStatePath);
		rewriteFeatureIdField(newStatePath, oldId, newId);
	}
	const oldHistoryPath = historyPath(root, oldId);
	if (fs.existsSync(oldHistoryPath)) {
		fs.renameSync(oldHistoryPath, historyPath(root, newId));
	}

	const manifest = loadManifest(root);
	let manifestChanged = false;
	for (const entry of Object.values(manifest.files)) {
		if (entry.owner === oldId) {
			entry.owner = newId;
			manifestChanged = true;
		}
	}
	if (manifestChanged) saveManifest(root, manifest);
}

// D6: soft-delete only -- sets archived_at/archived_reason on feature.json in place, no
// filesystem move. Every other command still works unmodified against an archived feature if a
// human explicitly targets it; only listFeatures()'s default view hides it.
export function archiveFeature(root, featureId, reason) {
	const record = loadFeatureFile(root, featureId);
	if (!record) return null;
	const updated = { ...record, archived_at: new Date().toISOString(), archived_reason: reason };
	saveFeatureFile(root, featureId, updated);
	return updated;
}

// D6: index-only -- records that `aliasId` (its own feature, its own feature_uid, created via
// its own `feature init`) should be treated as an alias for `keepId` going forward. Deliberately
// separate from by_uid (which tracks ONE feature_uid's own rename history) -- aliasId's uid is
// genuinely different from keepId's, this is a cross-reference, not a rename record. Does NOT
// touch aliasId's own specs/.sbf/ artifacts or attempt to merge scan/contract/handles state --
// genuinely ambiguous which side should win, the same never-auto-resolve-ambiguity discipline
// D-config-patch already established for config patching. A human decides what to do with the
// two features' actual content; this only records the cross-reference.
export function linkFeature(index, keepId, aliasId) {
	index.merged_into = { ...(index.merged_into ?? {}), [aliasId]: keepId };
	return index;
}
