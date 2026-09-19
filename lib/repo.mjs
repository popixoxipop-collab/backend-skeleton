import { execFileSync } from 'node:child_process';

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function repoRoot(cwd = process.cwd()) {
	try {
		return git(['rev-parse', '--show-toplevel'], cwd);
	} catch {
		return null;
	}
}

export function headSha(cwd = process.cwd()) {
	return git(['rev-parse', 'HEAD'], cwd);
}

// Cheap, local-only re-check of the default branch (no network) -- used to build the
// `preflight` gate's re-verifiable token inputs, NOT as a replacement for the full 3-way
// cross-check scripts/preflight-base-ref.sh does at actual preflight time.
export function localDefaultBranch(cwd = process.cwd()) {
	try {
		return git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd).replace(/^origin\//, '');
	} catch {
		return null;
	}
}

// D-preflight-freshness (S3): the SHA the LOCAL `origin/<branch>` remote-tracking ref currently
// points at -- purely local (`git rev-parse`, no network), same "cheap, local-only re-check"
// class as `localDefaultBranch()` above. Lets `require` notice when something else (an IDE's
// auto-fetch, a manual `git fetch`) has already pulled a newer remote tip into this local repo,
// without `require` itself ever fetching -- see D-preflight-freshness in DECISIONS.md for why
// this deliberately does NOT mean "the remote tip is guaranteed current": if nothing has fetched
// since the ref was last updated, this returns the same stale value it always did.
export function remoteTrackingTip(cwd = process.cwd(), branch) {
	if (!branch) return null;
	try {
		return git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], cwd);
	} catch {
		return null;
	}
}

// D-contract-history: the chronological commit list touching one file, oldest first (reversed
// from git's own newest-first `log` order -- a caller building a diff-over-time view wants to
// walk forward). `--follow` survives a rename (specs/<feature>/ is renamed wholesale by `bskel
// feature rename`, see D6). Empty array (not an error) when the path was never committed --
// `specs/` is a TARGET repo's own file, entirely outside bskel's control whether it's tracked at
// all, so an empty result is a normal, expected outcome here, not a failure.
export function fileHistory(cwd, relPath) {
	let raw;
	try {
		raw = git(['log', '--follow', '--format=%H%x1f%aI%x1f%s', '--', relPath], cwd);
	} catch {
		return [];
	}
	if (!raw) return [];
	return raw.split('\n').map((line) => {
		const [sha, date, subject] = line.split('\x1f');
		return { sha, date, subject };
	}).reverse();
}

// The file's exact content at one historical revision -- `git show <sha>:<path>`, not a working-
// tree read, so this is safe to call across arbitrary history without touching the checkout.
// Returns null (not a throw) when the path didn't exist at that revision, matching fileHistory()'s
// own "absence is a normal outcome, not a failure" posture.
export function showFileAtRevision(cwd, sha, relPath) {
	try {
		return git(['show', `${sha}:${relPath}`], cwd);
	} catch {
		return null;
	}
}

// D-gate-export: the CURRENTLY checked-out branch name (`git rev-parse --abbrev-ref HEAD`) --
// deliberately distinct from `localDefaultBranch()` above, which answers "what does origin/HEAD
// point at," not "what is checked out right now." `HEAD` (detached) is a real, valid return value,
// not an error -- callers that care should check for it explicitly rather than this function
// papering over it.
export function currentBranch(cwd = process.cwd()) {
	try {
		return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
	} catch {
		return null;
	}
}

// D-gate-export: whether the working tree has any uncommitted change (`git status --porcelain`
// non-empty) -- provenance context for a report that claims to describe "what this repo's gate
// history shows," since an uncommitted change means the working tree no longer matches HEAD.
export function isDirty(cwd = process.cwd()) {
	try {
		return git(['status', '--porcelain'], cwd).length > 0;
	} catch {
		return null;
	}
}

// D-attestation-payload-completeness (K2): the CONTENT identity of HEAD, distinct from its commit
// identity (headSha() above) -- `git rev-parse HEAD^{tree}`. Two commits with identical tree
// content (e.g. one only changes the commit message, or is an empty --amend) share this value,
// which is the right identity for "what code was this attestation actually about". null on
// failure, same convention as every other helper in this file.
export function headTreeSha(cwd = process.cwd()) {
	try {
		return git(['rev-parse', 'HEAD^{tree}'], cwd);
	} catch {
		return null;
	}
}

// D-attestation-payload-completeness (K2): a sorted, capped, structured view of
// `git status --porcelain=v1 -z` -- makes `isDirty()`'s bare boolean actionable inside a signed
// payload (D4's dirty-tree refusal needs to SHOW what's dirty, not just assert that it is).
// Returns null on git failure, matching isDirty()'s own null-on-failure posture. `-z` + NUL-split
// is used (not the newline-delimited default) specifically because a renamed/copied path's
// porcelain line legitimately contains no separator between old and new path other than NUL.
export function worktreeStatus(cwd = process.cwd(), { cap = 200 } = {}) {
	let raw;
	try {
		raw = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd, encoding: 'utf8' });
	} catch {
		return null;
	}
	const fields = raw.split('\0').filter((f) => f.length > 0);
	const entries = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		const status = field.slice(0, 2);
		const path = field.slice(3);
		// A rename/copy status ('R'/'C' in either column) is followed by a SEPARATE NUL-delimited
		// field holding the ORIGINAL path -- consumed here (and dropped) so it isn't misread as its
		// own status line; only the new path is reported, since `status` already discloses the move.
		if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++;
		entries.push({ status, path });
	}
	// Locale-independent, deterministic ordering -- Array.prototype.sort()'s default (UTF-16 code
	// unit comparison) rather than localeCompare(), which varies by ICU data/host locale and would
	// make the same repo state canonicalize to different signed bytes on different machines.
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const truncated = entries.length > cap;
	return { count: entries.length, truncated, entries: entries.slice(0, cap) };
}
