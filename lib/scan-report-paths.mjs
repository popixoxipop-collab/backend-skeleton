// D-scan-report-portable-paths: every scanner adapter builds `related_modules[].{controllers,
// entities,enums,dtos}[].file` ABSOLUTE (this is deliberate, unchanged -- it is the shape every
// in-memory/direct-API consumer has always expected and still does: `runScan()` called directly
// and handed straight to `provider.plan()`/`planHandles()` is a real, widely-used pattern across
// this project's own test suite, not just the CLI). The ONLY place an absolute `.file` is a real
// problem is once it gets COMMITTED to git as part of `specs/<feature>/brownfield-scan.json`
// (confirmed NOT gitignored for real feature work) -- a value baked in from wherever `bskel scan`
// originally ran is meaningless once that same committed branch is checked out somewhere else (a
// second worktree, a different clone, CI). So the fix lives at exactly the disk-persistence
// boundary, not in the adapters or in every downstream consumer:
//   - `dehydrateScanReportFilePaths()` converts absolute -> repo-relative, called ONCE, right
//     before `bin/bskel.mjs`'s `cmdScan` writes the report to disk (mirrors the adapters' own
//     pre-existing `filesRead` convention -- one `path.relative(repoRoot, f)` call, just applied
//     at the write boundary instead of duplicated across 4 adapters).
//   - `hydrateScanReportFilePaths()` converts back, called at every point something RE-LOADS the
//     on-disk report (`loadHydratedScanReportOrExit`, the `contract` gate, `resolveClassFile`) --
//     `path.isAbsolute(item.file)` doubles as a legacy-shape guard, so a report committed BEFORE
//     this fix (already absolute on disk) passes through as a correct no-op rather than a bug;
//     `bskel scan repair` is the real remedy for a stale-but-still-absolute value from a moved
//     worktree, not this function.
//
// Both functions return a NEW object (via structuredClone), never mutate their input -- `cmdScan`
// needs the SAME in-memory `report` for both the disk write (dehydrated) and the `--json` stdout
// print (left absolute, untouched) from ONE scan; mutating in place would make whichever happened
// first corrupt the other.
import path from 'node:path';

function mapScanReportFiles(report, transform) {
	if (!report) return report;
	const next = structuredClone(report);
	for (const mod of next.related_modules ?? []) {
		for (const key of ['controllers', 'entities', 'enums', 'dtos']) {
			for (const item of mod[key] ?? []) {
				if (item.file) item.file = transform(item.file);
			}
		}
	}
	return next;
}

export function hydrateScanReportFilePaths(report, repoRoot) {
	return mapScanReportFiles(report, (file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file)));
}

export function dehydrateScanReportFilePaths(report, repoRoot) {
	return mapScanReportFiles(report, (file) => (path.isAbsolute(file) ? path.relative(repoRoot, file) : file));
}
