// D2 (D-cli-contract): the single, definitive table of every exit code `bskel` (and the bash
// scripts it shells out to) can produce. Existed before this only as 4 values in `lib/gates.mjs`'s
// own `EXIT` plus ~6 more scattered as literals across `bin/bskel.mjs`, plus 3 more (11/12/13)
// defined only inside `scripts/preflight-base-ref.sh` with no JS-side reference at all.
//
// Numbers are NOT renumbered here -- they are already a public contract: SKILL.md documents them
// in several places and existing tests assert specific values (`gate require`/`scan`/`handles
// emit`/`contract validate` etc across 6+ test files). This table only gives the existing numbers
// one name each and one place to look them up. See D-cli-contract in DECISIONS.md.
export const EXIT_CODES = Object.freeze({
	OK: 0,
	CHECK_FAILED: 1,
	NOT_PASSED: 2,
	AWAITING_DISPOSITION: 3,
	STALE: 4,
	NOT_A_REPO: 10,
	STALE_BASE: 11,
	WRONG_DEFAULT: 12,
	DIRTY: 13,
	BAD_ARGS: 14,
	HANDLES_CONFLICT: 15,
	LOW_CONFIDENCE_SCAN: 16,
	MISSING_CAPABILITY: 17,
	REFRESH_FAILED: 18,
});

// `reason` values a `sbf.cli-diagnostic/1` envelope (lib/cli.mjs) can carry. Deliberately does
// NOT introduce new exit codes for the two different things exit 2 has always meant ("a gate
// this command depends on hasn't passed" vs "a referenced resource/adapter/provider doesn't
// exist") -- the number is the stable public contract (see above); `reason` is the "stable but
// supplementary precision" layer on top of it. See D-cli-contract's WHY in DECISIONS.md for why
// renumbering exit 2 was rejected.
export const EXIT_REASONS = Object.freeze({
	BAD_ARGS: EXIT_CODES.BAD_ARGS,
	NOT_A_REPO: EXIT_CODES.NOT_A_REPO,
	MISSING_CAPABILITY: EXIT_CODES.MISSING_CAPABILITY,
	GATE_AWAITING_DISPOSITION: EXIT_CODES.AWAITING_DISPOSITION,
	GATE_STALE: EXIT_CODES.STALE,
	// D-preflight-freshness (S3): `bskel preflight` itself failed to refresh from the remote and
	// no --offline/--no-fetch was given -- a distinct failure class from GATE_STALE (which means
	// "we successfully checked and it IS stale"), so it gets its own exit code rather than reusing
	// STALE_BASE(11) or WRONG_DEFAULT(12), which would blur "we don't know" into "we know, and
	// it's bad".
	REFRESH_FAILED: EXIT_CODES.REFRESH_FAILED,
	// all of the below share exit code NOT_PASSED (2) -- the reason is what tells them apart
	GATE_NOT_PASSED: EXIT_CODES.NOT_PASSED,
	MISSING_ARTIFACT: EXIT_CODES.NOT_PASSED,
	// S5 (D-persistence-integrity): MISSING_ARTIFACT's sibling -- the file exists but fails its
	// own declared schema (hand-edited or externally corrupted), a distinct case from "not there
	// at all". Only used at the CLI-layer read helpers (loadScanReportOrExit/loadContract) that
	// already own a fail() call for the sibling MISSING_ARTIFACT case; lib/state.mjs's own
	// equivalent check throws a plain Error instead (an existing, separate convention -- see its
	// own comment).
	INVALID_ARTIFACT: EXIT_CODES.NOT_PASSED,
	ADAPTER_UNAVAILABLE: EXIT_CODES.NOT_PASSED,
	PROVIDER_UNAVAILABLE: EXIT_CODES.NOT_PASSED,
	UNKNOWN_OPERATION: EXIT_CODES.NOT_PASSED,
	SCAN_FAILED: EXIT_CODES.NOT_PASSED,
	PLAN_FAILED: EXIT_CODES.NOT_PASSED,
});

// `scripts/preflight-base-ref.sh` defines STALE_BASE(11)/WRONG_DEFAULT(12)/DIRTY(13)/
// REFRESH_FAILED(18, D-preflight-freshness/S3) itself (a standalone bash script, "reusable
// outside this skill" per its own header comment -- it cannot import this module). Documented
// here only so this table stays the one place a human looks up what a `bskel preflight` exit
// code means; the script's own literals are the actual source of truth for these four values and
// are not re-derived from here.
