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
