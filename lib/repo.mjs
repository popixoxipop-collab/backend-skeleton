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
