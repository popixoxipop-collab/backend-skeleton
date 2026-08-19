#!/usr/bin/env bash
# D2: bash (not POSIX dash, not Node) for the preflight core.
#   WHY: reusable outside this skill (drop into any repo or CI job) with zero package deps;
#        bash is present on every machine/CI image we target, and the string/array handling
#        needed for the 3-way default-branch cross-check is painful in strict POSIX sh.
#   COST: won't run under `sh` on a minimal container without bash installed.
#   EXIT: `bskel preflight --native` (lib/) reimplements this in Node if that ever bites.
#
# Verifies the current checkout is actually based on the repo's real default branch, not a
# stale/abandoned one. Written after EnterWorktree's "fresh" mode branched a worktree off a
# 658-commit-stale `origin/main` in a repo whose real default branch is `develop` -- this
# script is the regression check for exactly that failure mode.
#
# Exit codes: 0 PASS | 10 NOT_A_REPO | 11 STALE_BASE | 12 WRONG_DEFAULT | 13 DIRTY | 14 BAD_ARGS
#           | 18 REFRESH_FAILED (D-preflight-freshness, S3)
set -euo pipefail

MAX_BEHIND=0
OFFLINE=0
ALLOW_DIRTY=0
JSON=0
FETCH_TIMEOUT=60

while [ $# -gt 0 ]; do
	case "$1" in
		--max-behind) MAX_BEHIND="$2"; shift 2 ;;
		# D-preflight-freshness (S3): --offline is the real name -- it means "I explicitly accept
		# a local-only verdict, even if that means not knowing whether the remote has moved."
		# --no-fetch is kept as an exact alias: it predates this item, is already documented in
		# SKILL.md, this script's own header says it's "reusable outside this skill" (so an
		# external caller may already depend on the old name), and 5 existing tests use it --
		# removing it would be a needless breaking rename for a flag whose meaning didn't change.
		--offline|--no-fetch) OFFLINE=1; shift ;;
		--allow-dirty) ALLOW_DIRTY=1; shift ;;
		--json) JSON=1; shift ;;
		--fetch-timeout-seconds) FETCH_TIMEOUT="$2"; shift 2 ;;
		*) echo "unknown argument: $1" >&2; exit 14 ;;
	esac
done

# D-cli-contract (D2): a non-numeric --max-behind used to make the `[ "$BEHIND" -gt "$MAX_BEHIND" ]`
# comparison below fail with a bash arithmetic error (status 2) rather than raise -- under
# `set -euo pipefail` that error is INSIDE a conditional test, so the shell does not exit, and the
# comparison is simply treated as false. That silently disabled this script's entire reason for
# existing (the stale-base check) instead of refusing the bad argument. `bskel preflight` itself
# now validates --max-behind before ever invoking this script, but this script is documented as
# "reusable outside this skill" (see the file header) and must not rely on that caller alone.
case "$MAX_BEHIND" in
	''|*[!0-9]*) echo "--max-behind must be a non-negative whole number, got: $MAX_BEHIND" >&2; exit 14 ;;
esac
case "$FETCH_TIMEOUT" in
	''|*[!0-9]*) echo "--fetch-timeout-seconds must be a non-negative whole number, got: $FETCH_TIMEOUT" >&2; exit 14 ;;
esac

# Minimal JSON string escaper (backslash, double-quote, control chars) so this script has
# zero external deps -- not a general JSON encoder, just enough for the strings *this* script
# builds itself (branch names, paths, our own messages).
json_str() {
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\n'/\\n}"
	s="${s//$'\t'/\\t}"
	printf '"%s"' "$s"
}

fail() {
	code="$1"; reason="$2"; message="$3"
	if [ "$JSON" -eq 1 ]; then
		printf '{"verdict":"FAIL","reason":"%s","message":%s}\n' "$reason" "$(json_str "$message")"
	else
		echo "FAIL ($reason): $message" >&2
	fi
	exit "$code"
}

TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || fail 10 NOT_A_REPO "not inside a git repository"
cd "$TOPLEVEL"

# D-preflight-freshness (S3): computed unconditionally now (previously skipped entirely under
# --allow-dirty) so evidence can honestly distinguish "clean tree, passed" from "dirty tree,
# --allow-dirty overrode it" -- both used to look identical in the recorded evidence.
DIRTY_STATUS=$(git status --porcelain)
WORKTREE_DIRTY="false"
[ -n "$DIRTY_STATUS" ] && WORKTREE_DIRTY="true"
if [ "$ALLOW_DIRTY" -eq 0 ] && [ "$WORKTREE_DIRTY" = "true" ]; then
	fail 13 DIRTY "working tree is not clean (pass --allow-dirty to override)"
fi

REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
# Only extract an owner/repo pair when the remote is actually github.com -- a local path or
# non-GitHub host must not be passed to `gh api`, both because it's meaningless and because
# (found by test/preflight.test.mjs) `gh api` on a bogus path returns a 404 error BODY on
# stdout with an exit code we must check, not just swallow with `|| true`.
OWNER_REPO=""
case "$REMOTE_URL" in
	git@github.com:*) OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's#^git@github\.com:##; s#\.git$##') ;;
	https://github.com/*) OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's#^https://github\.com/##; s#\.git$##') ;;
esac

# Three independent sources for "what is the real default branch" -- never assume `main`.
# D-preflight-freshness (S3): each source's OUTCOME is now tracked explicitly (ok/failed/empty/
# unavailable), not just its value -- a network failure silently produced the same empty string
# as "this source doesn't apply here" before, so a repo whose only working source happened to be
# the (possibly stale) local symbolic-ref cache could look identical to a repo that was properly
# cross-checked. This does not turn a single-source resolution into a hard failure (see
# D-preflight-freshness's EXIT in DECISIONS.md for why) -- it only makes that fact observable.
SRC_SYMREF=""
SYMREF_STATUS="absent"
if SRC_SYMREF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##') && [ -n "$SRC_SYMREF" ]; then
	SYMREF_STATUS="ok"
else
	SRC_SYMREF=""
fi

SRC_REMOTE_SHOW=""
REMOTE_SHOW_STATUS="failed"
if REMOTE_SHOW_OUT=$(git remote show origin 2>/dev/null); then
	SRC_REMOTE_SHOW=$(printf '%s\n' "$REMOTE_SHOW_OUT" | sed -n 's/^ *HEAD branch: //p')
	if [ -n "$SRC_REMOTE_SHOW" ]; then REMOTE_SHOW_STATUS="ok"; else REMOTE_SHOW_STATUS="empty"; fi
fi

SRC_GH_API=""
GH_API_STATUS="unavailable"
if command -v gh >/dev/null 2>&1 && [ -n "$OWNER_REPO" ]; then
	# Explicit exit-code check, NOT `$(...) || true` -- on a non-2xx response gh can print the
	# error body (e.g. a 404 JSON payload with raw CRLFs) to stdout while exiting non-zero, and
	# `|| true` alone would still let that garbage flow into SRC_GH_API.
	if GH_API_OUT=$(gh api "repos/$OWNER_REPO" --jq .default_branch 2>/dev/null); then
		SRC_GH_API="$GH_API_OUT"
		GH_API_STATUS="ok"
	else
		GH_API_STATUS="failed"
	fi
fi

SOURCES_OK=0
for s in "$SYMREF_STATUS" "$REMOTE_SHOW_STATUS" "$GH_API_STATUS"; do
	[ "$s" = "ok" ] && SOURCES_OK=$((SOURCES_OK + 1))
done
CROSS_CHECK_JSON=$(printf '{"sources_ok":%d,"symbolic_ref":"%s","remote_show":"%s","gh_api":"%s"}' "$SOURCES_OK" "$SYMREF_STATUS" "$REMOTE_SHOW_STATUS" "$GH_API_STATUS")

CANDIDATES=""
for c in "$SRC_SYMREF" "$SRC_REMOTE_SHOW" "$SRC_GH_API"; do
	[ -n "$c" ] && CANDIDATES="$CANDIDATES $c"
done
UNIQUE=$(echo "$CANDIDATES" | tr ' ' '\n' | sed '/^$/d' | sort -u)
UNIQUE_COUNT=$(echo "$UNIQUE" | sed '/^$/d' | wc -l | tr -d ' ')

if [ "$UNIQUE_COUNT" -eq 0 ]; then
	fail 12 WRONG_DEFAULT "could not determine default branch from origin/HEAD, 'git remote show origin', or 'gh api' -- refusing to assume 'main'"
elif [ "$UNIQUE_COUNT" -gt 1 ]; then
	fail 12 WRONG_DEFAULT "default-branch sources disagree: symbolic-ref='$SRC_SYMREF' remote-show='$SRC_REMOTE_SHOW' gh-api='$SRC_GH_API' -- resolve the discrepancy before proceeding, never guess"
fi
DEFAULT_BRANCH="$UNIQUE"

# D-preflight-freshness (S3): fetch failure used to be swallowed entirely (`2>/dev/null || true`)
# -- a genuinely offline/unreachable remote left this script computing `behind`/`ahead` against
# whatever stale local `origin/<branch>` ref happened to already exist, and still reporting PASS.
# Now: fetch is attempted unless --offline was given, and a failed attempt fails closed instead of
# silently falling through to the (possibly very stale) cached ref. `http.lowSpeedLimit`/
# `http.lowSpeedTime` bound a slow-but-connected transfer; a fully hung connection (or a non-http
# transport that ignores those config keys, e.g. a local path or ssh remote) is bounded by the
# Node-side `execFileSync` timeout in `bin/bskel.mjs::cmdPreflight` instead -- this script has no
# portable `timeout(1)` to rely on (not present on macOS by default).
FETCH_OUTCOME="skipped"
FETCH_STATUS=""
FETCH_STDERR=""
if [ "$OFFLINE" -eq 0 ]; then
	if FETCH_ERR=$(git -c "http.lowSpeedLimit=1000" -c "http.lowSpeedTime=$FETCH_TIMEOUT" fetch origin "$DEFAULT_BRANCH" --quiet 2>&1); then
		FETCH_OUTCOME="ok"
	else
		FETCH_STATUS=$?
		FETCH_STDERR=$(printf '%s\n' "$FETCH_ERR" | head -1)
		fail 18 REFRESH_FAILED "could not refresh '$DEFAULT_BRANCH' from origin (git fetch exited $FETCH_STATUS: ${FETCH_STDERR:-no output}) -- fix connectivity, or re-run with --offline to accept a local-only verdict (it will be recorded as such)"
	fi
fi

DEFAULT_REF="origin/$DEFAULT_BRANCH"
git rev-parse --verify --quiet "$DEFAULT_REF" >/dev/null || fail 12 WRONG_DEFAULT "resolved default branch '$DEFAULT_BRANCH' has no ref '$DEFAULT_REF' locally (fetch failed or branch renamed)"
ORIGIN_TIP_SHA=$(git rev-parse --verify --quiet "$DEFAULT_REF")

HEAD_SHA=$(git rev-parse HEAD)
BEHIND=$(git rev-list --count "HEAD..$DEFAULT_REF")
AHEAD=$(git rev-list --count "$DEFAULT_REF..HEAD")
MERGE_BASE=$(git merge-base HEAD "$DEFAULT_REF")
DEFAULT_TIP_DATE=$(git log -1 --format=%ct "$DEFAULT_REF")
MERGE_BASE_DATE=$(git log -1 --format=%ct "$MERGE_BASE")
BASE_AGE_DAYS=$(( (DEFAULT_TIP_DATE - MERGE_BASE_DATE) / 86400 ))

CURRENT_BRANCH=$(git branch --show-current)
WORKTREE_PATH="$TOPLEVEL"
CREATED_FROM=$(git reflog show "$CURRENT_BRANCH" 2>/dev/null | tail -1 || echo "")
CHECKED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

POLICY_JSON=$(printf '{"max_behind":%d,"allow_dirty":%s,"offline":%s,"fetch_timeout_seconds":%d}' "$MAX_BEHIND" "$([ "$ALLOW_DIRTY" -eq 1 ] && echo true || echo false)" "$([ "$OFFLINE" -eq 1 ] && echo true || echo false)" "$FETCH_TIMEOUT")

VERDICT="PASS"
REASON=""
if [ "$BEHIND" -gt "$MAX_BEHIND" ]; then
	VERDICT="FAIL"
	REASON="STALE_BASE"
fi

EVIDENCE_JSON=$(cat <<EOF
{"default_branch":"$DEFAULT_BRANCH","source_of_truth":{"symbolic_ref":"$SRC_SYMREF","remote_show":"$SRC_REMOTE_SHOW","gh_api":"$SRC_GH_API"},"head_sha":"$HEAD_SHA","merge_base":"$MERGE_BASE","behind":$BEHIND,"ahead":$AHEAD,"base_age_days":$BASE_AGE_DAYS,"worktree_path":"$WORKTREE_PATH","current_branch":"$CURRENT_BRANCH","created_from":$(json_str "$CREATED_FROM"),"origin_tip_sha":$([ -n "$ORIGIN_TIP_SHA" ] && json_str "$ORIGIN_TIP_SHA" || echo null),"checked_at":"$CHECKED_AT","worktree_dirty":$WORKTREE_DIRTY,"fetch":"$FETCH_OUTCOME","policy":$POLICY_JSON,"cross_check":$CROSS_CHECK_JSON}
EOF
)

if [ "$VERDICT" = "FAIL" ]; then
	MSG="HEAD is $BEHIND commits behind $DEFAULT_REF (base is $BASE_AGE_DAYS days stale). Remediation: git worktree add <path> -b <branch> $DEFAULT_REF   (or, in-place: git rebase $DEFAULT_REF)"
	if [ "$JSON" -eq 1 ]; then
		printf '{"verdict":"FAIL","reason":"STALE_BASE","message":%s,"evidence":%s}\n' "$(json_str "$MSG")" "$EVIDENCE_JSON"
	else
		echo "FAIL (STALE_BASE): $MSG" >&2
		echo "evidence: $EVIDENCE_JSON" >&2
	fi
	exit 11
fi

if [ "$JSON" -eq 1 ]; then
	printf '{"verdict":"PASS","evidence":%s}\n' "$EVIDENCE_JSON"
else
	echo "PASS: HEAD is up to date with $DEFAULT_REF (behind=$BEHIND, ahead=$AHEAD)"
fi
exit 0
