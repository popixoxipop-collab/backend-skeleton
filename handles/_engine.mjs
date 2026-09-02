// G4: shared, safety-critical emit machinery -- extracted from what was originally handles/
// emit.mjs (Java-only, pre-G4) so any codegen provider's own emit() can reuse the exact same
// conflict/manifest/force/orphan logic instead of duplicating it. This is pure code motion --
// the ownership/conflict semantics themselves are unchanged from O2's D-handles-ownership. See
// D-handles-providers (G4) in DECISIONS.md. `handles/providers/java-spring/emit.mjs` is the
// reference caller to compare against if this file's behavior is ever in question.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256File, sha256String } from '../lib/fsutil.mjs';
import { loadManifest, saveManifest, classifyFile, extractResolverOwnerFeatureId, BSKEL_GENERATED_MARKER } from '../lib/handles-manifest.mjs';
// D-patch-transactions: unifiedDiff() moved to lib/diff.mjs (stack/config-apply.mjs needs the
// identical mechanism for its own collateral-diff safety gate) -- re-exported here so every
// existing caller in this file keeps working unchanged.
import { unifiedDiff } from '../lib/diff.mjs';

export { unifiedDiff };

function readIfExists(target) {
	return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

function writeUnit(target, content) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

const DIFFABLE_ACTIONS = new Set(['update', 'conflict', 'adopt-update']);

// O2: refuses --force on a target that isn't safely recoverable from git history -- a --force
// overwrite is only ever reversible if the content it destroys is already committed. Fails
// closed (treats git errors, or a repo where the path can't be resolved, as "dirty") since the
// whole point is to never make an irreversible action look safe by default.
// D-write-safety-phase0 (item 2): exported so stack/apply.mjs can apply the identical
// git-recoverability check before a --force overwrite -- previously private to this file.
export function isDirtyOrUntracked(repoRoot, absPath) {
	try {
		const out = execFileSync('git', ['status', '--porcelain', '--', absPath], { cwd: repoRoot, encoding: 'utf8' });
		return out.trim().length > 0;
	} catch {
		return true;
	}
}

// The provider-neutral core of `bskel handles emit`. Each provider computes its own render/paths,
// then calls this once to do the actual conflict-safe write. See DECISIONS.md D-handles-ownership
// for the full design this preserves unchanged.
//
//   infraUnits:    [{ id, templatePath, targetAbs, rendered }]  -- repo-owned, all-or-nothing
//   resolverUnits: [{ id, resourceType, module, templatePath, targetAbs, rendered,
//                      pristineRenderFor(ownerId) => string }]  -- feature-owned, independent
//   orphanScan:    { dir, module, matchesFile(filename) => bool,
//                     resourceTypeOf(filename, content) => string|null } | null
//                  -- null disables orphan detection entirely (mirrors --resource narrowing)
//   provider:      string, written into every manifest entry this call creates/updates
//   dryRun:        D4 (D-handles-dryrun) -- when true, every actual write (writeUnit/saveManifest)
//                  is skipped, but the exact same classification runs and `written`/`forced`
//                  still record what WOULD have been written. Nothing on disk changes.
//   computeDiff:   D4 -- when true, attaches a real unified diff (git diff --no-index) to every
//                  'update'/'conflict'/'adopt-update' action -- the only 3 where content actually
//                  differs. Off by default since it shells out to git per diffable file.
//   postResolverUnit: D-patch-transactions (Continued) -- an OPTIONAL single unit, { id,
//                  templatePath, targetAbs, render() => string, kind?, ownership?, owner? },
//                  whose correct content can only be computed AFTER resolverUnits above have been
//                  written (e.g. typescript-express's resolvers_index.ts barrel -- its import list
//                  must reflect the resolvers directory's REAL final on-disk listing, including
//                  this run's own just-written resolver files, not just this run's own
//                  resolverUnits -- a 4th infraUnits entry can't do this, since infra is processed
//                  BEFORE resolvers). Reuses the exact same classify/conflict/force/manifest logic
//                  the infra loop above already implements. `kind`/`ownership`/`owner` default to
//                  `'infra'`/`'repo'`/`'_repo'` (the barrel's own shape, unchanged);
//                  D-write-safety-phase0 (item 1) is the first caller to override them, for a
//                  feature-owned unit (java-spring/python-fastapi's migration.sql,
//                  kind: 'migration', ownership: 'feature') whose content does NOT actually depend
//                  on the resolver loop's post-write state -- it just reuses this slot rather than
//                  adding a third one.
//                  null (the default) is a true no-op.
export function emitUnits({ repoRoot, featureId, provider, force = false, reason = '', infraUnits, resolverUnits, orphanScan, dryRun = false, computeDiff = false, postResolverUnits = [] }) {
	const manifest = loadManifest(repoRoot);
	const nowIso = new Date().toISOString();

	const written = [];
	const conflicts = [];
	const orphans = [];
	const notes = [];
	const resolverStubs = [];
	const forced = [];
	const actions = [];
	let manifestChanged = false;

	function recordAction({ relPath, kind, action, resourceType, diskContent, rendered }) {
		const entry = { path: relPath, kind, action };
		if (resourceType) entry.resourceType = resourceType;
		if (computeDiff && DIFFABLE_ACTIONS.has(action)) entry.diff = unifiedDiff(relPath, diskContent, rendered);
		actions.push(entry);
	}

	// ---- infra: repo-owned, all-or-nothing (a half-upgraded infra set is worse than either
	// extreme, so one conflict blocks the whole set unless --force). ----
	const infraPlans = infraUnits.map((u) => {
		const relPath = path.relative(repoRoot, u.targetAbs);
		const diskContent = readIfExists(u.targetAbs);
		const exists = diskContent !== null;
		const diskHash = exists ? sha256String(diskContent) : null;
		const freshRenderHash = sha256String(u.rendered);
		const entry = manifest.files[relPath];
		// Infra is feature-independent, so a pristine render IS the fresh render (no owner-recovery
		// step needed, unlike a resolver's baked-in FEATURE_ID).
		const matchesPristineRender = exists && diskContent === u.rendered;
		const action = classifyFile({ exists, diskHash, manifestEntryHash: entry?.generated_hash ?? null, freshRenderHash, matchesPristineRender });
		return { ...u, relPath, diskContent, freshRenderHash, action };
	});

	const infraHasConflict = infraPlans.some((u) => u.action === 'conflict');
	if (infraHasConflict && !force) {
		for (const u of infraPlans) {
			conflicts.push({ path: u.relPath, kind: 'infra', reason: 'diverged from the last content backend-skeleton generated -- see notes for remediation' });
			recordAction({ relPath: u.relPath, kind: 'infra', action: u.action, diskContent: u.diskContent, rendered: u.rendered });
		}
	} else {
		for (const u of infraPlans) {
			if (u.action === 'conflict') {
				if (isDirtyOrUntracked(repoRoot, u.targetAbs)) {
					conflicts.push({ path: u.relPath, kind: 'infra', reason: 'refusing --force: this file has uncommitted/untracked changes -- commit or stash it first so the overwrite is recoverable' });
					recordAction({ relPath: u.relPath, kind: 'infra', action: u.action, diskContent: u.diskContent, rendered: u.rendered });
					continue;
				}
				if (!dryRun) {
					manifest.files[u.relPath] = {
						kind: 'infra', ownership: 'repo', owner: '_repo', provider, template: u.id,
						template_hash: sha256File(u.templatePath), generated_hash: u.freshRenderHash,
						updated_at: nowIso, last_force: { reason, at: nowIso },
					};
					manifestChanged = true;
					writeUnit(u.targetAbs, u.rendered);
					// D-write-safety-phase0 (item 3): persist per-unit, not once at the end of the whole
					// loop -- a crash after this write but before a later unit's own write must not
					// leave THIS file's real provenance unrecorded.
					saveManifest(repoRoot, manifest);
				}
				written.push(u.relPath);
				forced.push(u.relPath);
				recordAction({ relPath: u.relPath, kind: 'infra', action: u.action, diskContent: u.diskContent, rendered: u.rendered });
				continue;
			}
			if (u.action === 'unchanged') {
				recordAction({ relPath: u.relPath, kind: 'infra', action: u.action });
				continue;
			}
			// 'adopt-unchanged' means disk content already IS the correct bytes (a pristine,
			// no-manifest-entry file) -- record the manifest entry so future runs see it as
			// 'unchanged', but don't rewrite bytes that are already correct, and don't claim we
			// "wrote" a file whose content didn't actually change.
			if (u.action !== 'adopt-unchanged') {
				if (!dryRun) writeUnit(u.targetAbs, u.rendered);
				written.push(u.relPath);
			}
			if (!dryRun) {
				manifest.files[u.relPath] = {
					kind: 'infra', ownership: 'repo', owner: '_repo', provider, template: u.id,
					template_hash: sha256File(u.templatePath), generated_hash: u.freshRenderHash,
					updated_at: nowIso,
				};
				manifestChanged = true;
				// D-write-safety-phase0 (item 3): see the comment at this loop's first saveManifest() call.
				saveManifest(repoRoot, manifest);
			}
			recordAction({ relPath: u.relPath, kind: 'infra', action: u.action, diskContent: u.diskContent, rendered: u.rendered });
		}
	}

	// ---- resolvers: feature-owned, independent per file. "Regenerate when provably untouched"
	// rather than "create once" -- a live-derived value (e.g. a required-authority string) is
	// re-derived every run, and "once" would strand a stale value in a security-relevant file. ----
	const generatedTypesThisRun = new Set();

	for (const u of resolverUnits) {
		resolverStubs.push(u.resourceType);

		const relPath = path.relative(repoRoot, u.targetAbs);
		generatedTypesThisRun.add(u.resourceType);

		const diskContent = readIfExists(u.targetAbs);
		const exists = diskContent !== null;
		const diskHash = exists ? sha256String(diskContent) : null;
		const freshRenderHash = sha256String(u.rendered);
		const entry = manifest.files[relPath];

		let matchesPristineRender = false;
		let recoveredOwner = null;
		if (exists) {
			recoveredOwner = extractResolverOwnerFeatureId(diskContent);
			if (recoveredOwner) {
				matchesPristineRender = u.pristineRenderFor(recoveredOwner) === diskContent;
			}
		}
		const action = classifyFile({ exists, diskHash, manifestEntryHash: entry?.generated_hash ?? null, freshRenderHash, matchesPristineRender });

		if (action === 'conflict') {
			if (force) {
				if (isDirtyOrUntracked(repoRoot, u.targetAbs)) {
					conflicts.push({ path: relPath, kind: 'resolver', resourceType: u.resourceType, reason: 'refusing --force: this file has uncommitted/untracked changes -- commit or stash it first so the overwrite is recoverable' });
					recordAction({ relPath, kind: 'resolver', action, resourceType: u.resourceType, diskContent, rendered: u.rendered });
					continue;
				}
				if (!dryRun) {
					writeUnit(u.targetAbs, u.rendered);
					manifest.files[relPath] = {
						kind: 'resolver', ownership: 'feature', owner: featureId, resource_type: u.resourceType, module: u.module, provider,
						template: u.id, template_hash: sha256File(u.templatePath), generated_hash: freshRenderHash,
						updated_at: nowIso, last_force: { reason, at: nowIso, overwritten_hash: diskHash },
					};
					manifestChanged = true;
					// D-write-safety-phase0 (item 3): persist per-unit -- the resolver loop is where this
					// matters most (potentially many resolvers per feature, one saveManifest() call at
					// the end previously meant a crash partway through left every already-written
					// resolver this run unrecorded, not just the interrupted one).
					saveManifest(repoRoot, manifest);
				}
				written.push(relPath);
				forced.push(relPath);
				recordAction({ relPath, kind: 'resolver', action, resourceType: u.resourceType, diskContent, rendered: u.rendered });
				continue;
			}
			conflicts.push({
				path: relPath, kind: 'resolver', resourceType: u.resourceType,
				reason: 'diverged from the last content backend-skeleton generated -- if you have not edited this file, this may be expected after a template upgrade or a security-relevant source change. If you HAVE edited it (e.g. finished a stubbed-out method), leave it -- nothing else in this run depends on it.',
			});
			recordAction({ relPath, kind: 'resolver', action, resourceType: u.resourceType, diskContent, rendered: u.rendered });
			continue;
		}

		const priorOwner = entry?.owner ?? recoveredOwner;
		if (priorOwner && priorOwner !== featureId) {
			notes.push(`ownership transfer: ${relPath} was generated by feature "${priorOwner}", now generated by "${featureId}"`);
		}

		if (action !== 'unchanged') {
			if (action !== 'adopt-unchanged') {
				if (!dryRun) writeUnit(u.targetAbs, u.rendered);
				written.push(relPath);
			}
			if (!dryRun) {
				manifest.files[relPath] = {
					kind: 'resolver', ownership: 'feature', owner: featureId, resource_type: u.resourceType, module: u.module, provider,
					template: u.id, template_hash: sha256File(u.templatePath), generated_hash: freshRenderHash,
					updated_at: nowIso,
				};
				manifestChanged = true;
				// D-write-safety-phase0 (item 3): see the comment at this loop's first saveManifest() call.
				saveManifest(repoRoot, manifest);
			}
		}
		recordAction({ relPath, kind: 'resolver', action, resourceType: u.resourceType, diskContent, rendered: u.rendered });
	}

	// ---- post-resolver units: an array of units whose correct content can only be computed AFTER
	// the resolver loop above has finished writing (e.g. typescript-express's resolvers_index.ts
	// barrel -- its import list must reflect the resolvers directory's REAL on-disk listing,
	// including THIS run's own just-written resolver files, not just this run's own
	// resolverUnits). Reuses the EXACT SAME classify/conflict/force/manifest logic the infra loop
	// above already implements, applied to each unit independently. `render()` is called HERE, not
	// earlier, precisely so it observes this run's own writes (still true for a unit whose content
	// doesn't actually need that timing, like migration.sql -- it just reuses this array rather
	// than adding a third mechanism). Empty array (the default) is a true no-op.
	// D-typescript-express-registry-parity: was a single optional `postResolverUnit` object
	// (D-write-safety-phase0's own kind/ownership/owner generalization) until typescript-express
	// needed TWO units here at once (resolvers_index.ts, repo-owned, AND migration.sql,
	// feature-owned, once this item gave it one) -- widened to an array, same per-unit logic,
	// nothing else about the mechanism changed. See D-patch-transactions (Continued) in
	// DECISIONS.md for why this couldn't just be infraUnits/resolverUnits entries. ----
	for (const u of postResolverUnits) {
		// D-write-safety-phase0 (item 1): generalized from a hardcoded infra/repo/_repo triple so a
		// feature-owned single unit (java-spring/python-fastapi's migration.sql) can reuse this exact
		// classify/conflict/force/manifest cycle too, not just typescript-express's repo-owned
		// resolvers_index.ts barrel. Defaults preserve the original hardcoded values byte-for-byte, so
		// the barrel caller (which never sets these) is unaffected.
		const unitKind = u.kind ?? 'infra';
		const unitOwnership = u.ownership ?? 'repo';
		const unitOwner = u.owner ?? '_repo';
		const rendered = u.render();
		const relPath = path.relative(repoRoot, u.targetAbs);
		const diskContent = readIfExists(u.targetAbs);
		const exists = diskContent !== null;
		const diskHash = exists ? sha256String(diskContent) : null;
		const freshRenderHash = sha256String(rendered);
		const entry = manifest.files[relPath];
		const matchesPristineRender = exists && diskContent === rendered;
		const action = classifyFile({ exists, diskHash, manifestEntryHash: entry?.generated_hash ?? null, freshRenderHash, matchesPristineRender });

		if (action === 'conflict' && !force) {
			conflicts.push({ path: relPath, kind: unitKind, reason: 'diverged from the last content backend-skeleton generated -- see notes for remediation' });
			recordAction({ relPath, kind: unitKind, action, diskContent, rendered });
		} else if (action === 'conflict') {
			if (isDirtyOrUntracked(repoRoot, u.targetAbs)) {
				conflicts.push({ path: relPath, kind: unitKind, reason: 'refusing --force: this file has uncommitted/untracked changes -- commit or stash it first so the overwrite is recoverable' });
				recordAction({ relPath, kind: unitKind, action, diskContent, rendered });
			} else {
				if (!dryRun) {
					manifest.files[relPath] = {
						kind: unitKind, ownership: unitOwnership, owner: unitOwner, provider, template: u.id,
						template_hash: sha256File(u.templatePath), generated_hash: freshRenderHash,
						updated_at: nowIso, last_force: { reason, at: nowIso },
					};
					manifestChanged = true;
					writeUnit(u.targetAbs, rendered);
					// D-write-safety-phase0 (item 3): see the infra loop's first saveManifest() call above.
					saveManifest(repoRoot, manifest);
				}
				written.push(relPath);
				forced.push(relPath);
				recordAction({ relPath, kind: unitKind, action, diskContent, rendered });
			}
		} else if (action === 'unchanged') {
			recordAction({ relPath, kind: unitKind, action });
		} else {
			if (action !== 'adopt-unchanged') {
				if (!dryRun) writeUnit(u.targetAbs, rendered);
				written.push(relPath);
			}
			if (!dryRun) {
				manifest.files[relPath] = {
					kind: unitKind, ownership: unitOwnership, owner: unitOwner, provider, template: u.id,
					template_hash: sha256File(u.templatePath), generated_hash: freshRenderHash,
					updated_at: nowIso,
				};
				manifestChanged = true;
				// D-write-safety-phase0 (item 3): see the infra loop's first saveManifest() call above.
				saveManifest(repoRoot, manifest);
			}
			recordAction({ relPath, kind: unitKind, action, diskContent, rendered });
		}
	}

	// ---- orphan detection: a resolver this feature's CURRENT plan no longer generates, left
	// untouched and never deleted -- same conservative bias as D-migration-scope/D-config-patch.
	// Suppressed entirely under --resource (orphanScan === null), since every resource outside the
	// filter would otherwise look orphaned. ----
	if (orphanScan) {
		const seenOrphanPaths = new Set();
		for (const [relPath, entry] of Object.entries(manifest.files)) {
			// `entry.provider` is absent on a manifest written before G4 -- treat that as
			// "java-spring" so orphan detection for existing target repos keeps working exactly as
			// before this item, rather than silently going blind on their first post-G4 run.
			const entryProvider = entry.provider ?? 'java-spring';
			if (entry.kind !== 'resolver' || entry.module !== orphanScan.module || entryProvider !== provider || generatedTypesThisRun.has(entry.resource_type)) continue;
			orphans.push({ path: relPath, resourceType: entry.resource_type, reason: 'manifest tracks this resolver but the current plan no longer generates it -- left on disk untouched' });
			seenOrphanPaths.add(relPath);
		}
		if (fs.existsSync(orphanScan.dir)) {
			for (const file of fs.readdirSync(orphanScan.dir)) {
				if (!orphanScan.matchesFile(file)) continue;
				const absPath = path.join(orphanScan.dir, file);
				const relPath = path.relative(repoRoot, absPath);
				if (seenOrphanPaths.has(relPath)) continue;
				const content = readIfExists(absPath);
				if (!content || !content.includes(BSKEL_GENERATED_MARKER)) continue;
				const resourceType = orphanScan.resourceTypeOf(file, content);
				if (!resourceType || generatedTypesThisRun.has(resourceType)) continue;
				orphans.push({ path: relPath, resourceType, reason: 'file carries the backend-skeleton marker but the current plan no longer generates it -- left on disk untouched' });
			}
		}
	}

	// D-write-safety-phase0 (item 3): every mutation site above already calls saveManifest()
	// itself, incrementally, right after its own write -- this is now a defensive backstop, not
	// the primary persistence mechanism (a no-op resave of already-current content in the normal
	// case), kept so a future mutation site added without its own incremental save still ends up
	// correct at the end of a run that completes normally. It is NOT what makes this item's own
	// crash-safety property hold -- that comes entirely from the per-unit calls above.
	if (!dryRun && manifestChanged) saveManifest(repoRoot, manifest);

	// D-resolver-policy-split: two units (Resolver + Policy) now share one resourceType, so
	// resolverStubs.push above runs twice per resource -- dedupe here rather than at every push site.
	return { written, resolverStubs: [...new Set(resolverStubs)], conflicts, orphans, notes, forced, blocked: conflicts.length > 0, actions };
}
