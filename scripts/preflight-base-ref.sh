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
set -euo pipefail

MAX_BEHIND=0
NO_FETCH=0
ALLOW_DIRTY=0
JSON=0

while [ $# -gt 0 ]; do
	case "$1" in
		--max-behind) MAX_BEHIND="$2"; shift 2 ;;
		--no-fetch) NO_FETCH=1; shift ;;
		--allow-dirty) ALLOW_DIRTY=1; shift ;;
		--json) JSON=1; shift ;;
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

if [ "$ALLOW_DIRTY" -eq 0 ]; then
	DIRTY=$(git status --porcelain)
	if [ -n "$DIRTY" ]; then
		fail 13 DIRTY "working tree is not clean (pass --allow-dirty to override)"
	fi
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
SRC_SYMREF=""
SRC_SYMREF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##') || true

SRC_REMOTE_SHOW=""
SRC_REMOTE_SHOW=$(git remote show origin 2>/dev/null | sed -n 's/^ *HEAD branch: //p') || true

SRC_GH_API=""
if command -v gh >/dev/null 2>&1 && [ -n "$OWNER_REPO" ]; then
	# Explicit exit-code check, NOT `$(...) || true` -- on a non-2xx response gh can print the
	# error body (e.g. a 404 JSON payload with raw CRLFs) to stdout while exiting non-zero, and
	# `|| true` alone would still let that garbage flow into SRC_GH_API.
	if GH_API_OUT=$(gh api "repos/$OWNER_REPO" --jq .default_branch 2>/dev/null); then
		SRC_GH_API="$GH_API_OUT"
	fi
fi

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

if [ "$NO_FETCH" -eq 0 ]; then
	git fetch origin "$DEFAULT_BRANCH" --quiet 2>/dev/null || true
fi

DEFAULT_REF="origin/$DEFAULT_BRANCH"
git rev-parse --verify --quiet "$DEFAULT_REF" >/dev/null || fail 12 WRONG_DEFAULT "resolved default branch '$DEFAULT_BRANCH' has no ref '$DEFAULT_REF' locally (fetch failed or branch renamed)"

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

VERDICT="PASS"
REASON=""
if [ "$BEHIND" -gt "$MAX_BEHIND" ]; then
	VERDICT="FAIL"
	REASON="STALE_BASE"
fi

EVIDENCE_JSON=$(cat <<EOF
{"default_branch":"$DEFAULT_BRANCH","source_of_truth":{"symbolic_ref":"$SRC_SYMREF","remote_show":"$SRC_REMOTE_SHOW","gh_api":"$SRC_GH_API"},"head_sha":"$HEAD_SHA","merge_base":"$MERGE_BASE","behind":$BEHIND,"ahead":$AHEAD,"base_age_days":$BASE_AGE_DAYS,"worktree_path":"$WORKTREE_PATH","current_branch":"$CURRENT_BRANCH","created_from":$(json_str "$CREATED_FROM")}
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
